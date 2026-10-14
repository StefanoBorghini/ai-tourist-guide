-- Ordini e pagamenti con Stripe (PIANO-COMMERCIALE.md §4, migrazione 2; docs/v0.3-platform/PAGAMENTI.md).
--
-- Flusso:
-- - checkout_open (utente autenticato, con la propria identità): controlla prodotto, prezzo pubblicato, destinazione
--   pubblicata e che l'utente non lo possieda già; crea l'ordine «pending» con la COPIA di prezzo e prodotto. Il
--   browser invia solo l'id del prodotto: importo, valuta e utente li decide il database;
-- - il server crea la Checkout Session di Stripe con quell'importo e la collega all'ordine (checkout_attach);
-- - il webhook (ruolo di servizio, dopo la verifica della firma) registra l'evento una volta sola
--   (payment_event_begin/end) e applica gli esiti con una macchina a stati monotona: un evento ripetuto o arrivato
--   fuori ordine non annulla un pagamento né duplica i diritti;
-- - i diritti nascono solo dal pagamento confermato (grant_order), dalla copia nell'ordine: un pacchetto cambiato
--   dopo l'acquisto non cambia ciò che è stato comprato.
--
-- Rimborsi e contestazioni (decisione D2): rimborso totale → diritti revocati; parziale → nessuna revoca automatica;
-- contestazione aperta → diritti sospesi; vinta → ripristinati; persa → revocati.
-- Nessun dato di carte: solo gli identificativi di Stripe per la riconciliazione.

-- ---------------------------------------------------------------- ordini (purchases)
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'purchases'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%' loop
    execute format('alter table purchases drop constraint %I', c);
  end loop;
end $$;
alter table purchases
  add constraint purchases_status_check check (status in
    ('pending', 'completed', 'failed', 'expired', 'canceled', 'refunded', 'partially_refunded', 'disputed')),
  add column unit_amount integer check (unit_amount between 50 and 99900),
  add column currency text check (currency = 'EUR'),
  add column price_id uuid references product_prices (id),
  add column product_snapshot jsonb,
  add column amount_total integer,
  add column amount_refunded integer not null default 0 check (amount_refunded >= 0),
  add column stripe_checkout_session_id text unique,
  add column stripe_payment_intent_id text unique,
  add column stripe_customer_id text,
  add column paid_at timestamptz,
  add column refunded_at timestamptz,
  add column note text,
  add constraint purchases_stripe_copy check (provider <> 'stripe'
    or (unit_amount is not null and currency is not null and price_id is not null and product_snapshot is not null));
create index purchases_user_idx on purchases (user_id, created_at desc);

-- Ordini e diritti li scrive solo il server (funzioni qui sotto): nessuna scrittura diretta dall'API.
revoke insert, update, delete on purchases from anon, authenticated;

-- Diritti sospesi durante una contestazione.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'entitlements'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''revoked''%' loop
    execute format('alter table entitlements drop constraint %I', c);
  end loop;
end $$;
alter table entitlements add constraint entitlements_status_check check (status in ('active', 'suspended', 'revoked', 'expired'));

-- ---------------------------------------------------------------- eventi di Stripe (idempotenza e diagnosi)
create table payment_events (
  stripe_event_id text primary key check (stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  type            text not null check (length(type) <= 100),
  purchase_id     uuid references purchases (id),
  status          text not null default 'received' check (status in ('received', 'processed', 'ignored', 'error')),
  error           text check (length(error) <= 500),
  attempts        integer not null default 1,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
alter table payment_events enable row level security;
create policy payment_events_admin_read on payment_events for select using (is_platform_admin());
revoke all on payment_events from anon, authenticated;
grant select on payment_events to authenticated;

-- ---------------------------------------------------------------- apertura del checkout (utente)
-- Possiede già quello che il prodotto vende? Un acquisto valido dello stesso prodotto, oppure tutti i diritti attivi
-- che il prodotto concederebbe (per esempio un percorso ricevuto in omaggio).
create or replace function order_already_owned(p_user uuid, p_product uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from purchases where user_id = p_user and product_id = p_product
                 and status in ('completed', 'partially_refunded', 'disputed'))
      or (select case p.kind
            when 'explore' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                        and e.scope = 'explore' and e.pack_id = p.pack_id)
            when 'route' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                      and e.scope = 'route' and e.route_id = p.route_id)
            else not exists (select 1 from product_routes pr where pr.product_id = p.id and not exists (
                   select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                   and e.scope = 'route' and e.route_id = pr.route_id))
          end
          from products p where p.id = p_product);
$$;

-- Crea l'ordine. Restituisce {order, amount, currency, name, supersede}: «supersede» sono le sessioni di Stripe
-- di ordini precedenti dello stesso prodotto ancora aperte, che il server deve far scadere (doppio clic, ritorno
-- indietro): un solo checkout aperto per prodotto e utente. Gli errori sono messaggi per il visitatore.
create or replace function checkout_open(p_product uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  p products;
  v_price product_prices;
  v_id uuid := gen_random_uuid();
  v_snapshot jsonb;
  v_supersede jsonb;
begin
  perform studio_require(v_user is not null, 'accedi per acquistare');
  -- Due richieste dello stesso utente per lo stesso prodotto passano una alla volta.
  perform pg_advisory_xact_lock(hashtext('checkout:' || v_user::text || ':' || p_product::text));
  select * into p from products where id = p_product;
  if p.id is null or p.status <> 'active' or p.availability = 'hidden' then raise exception 'prodotto non in vendita'; end if;
  if p.availability = 'sold_out' then raise exception 'prodotto esaurito'; end if;
  if catalog_problem(p.id) is not null then raise exception 'prodotto non in vendita'; end if;
  if not exists (select 1 from destinations where pack_id = p.pack_id and status = 'published') then
    raise exception 'destinazione non ancora pubblicata';
  end if;
  select * into v_price from product_prices where product_id = p.id and status = 'published' and currency = 'EUR';
  if v_price.id is null then raise exception 'prodotto senza prezzo pubblicato'; end if;
  if order_already_owned(v_user, p.id) then raise exception 'hai già acquistato questo contenuto'; end if;

  select coalesce(jsonb_agg(stripe_checkout_session_id) filter (where stripe_checkout_session_id is not null), '[]')
  into v_supersede from purchases
  where user_id = v_user and product_id = p.id and status = 'pending' and provider = 'stripe';
  update purchases set status = 'canceled', note = 'sostituito da un nuovo checkout', updated_at = now()
  where user_id = v_user and product_id = p.id and status = 'pending' and provider = 'stripe';

  v_snapshot := jsonb_build_object(
    'kind', p.kind, 'slug', p.slug, 'pack', p.pack_id, 'labels', p.labels,
    'route', (select jsonb_build_object('id', r.id, 'slug', r.slug) from routes r where r.id = p.route_id),
    'routes', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'slug', r.slug) order by r.slug)
                        from product_routes pr join routes r on r.id = pr.route_id where pr.product_id = p.id), '[]'));
  insert into purchases (id, user_id, product_id, provider, provider_ref, status, unit_amount, currency, price_id, product_snapshot)
  values (v_id, v_user, p.id, 'stripe', v_id::text, 'pending', v_price.unit_amount, v_price.currency, v_price.id, v_snapshot);
  return jsonb_build_object('order', v_id, 'amount', v_price.unit_amount, 'currency', v_price.currency,
    'name', coalesce(p.labels #>> '{it,name}', p.slug), 'supersede', v_supersede);
end;
$$;

-- Collega la sessione di Stripe all'ordine appena creato (una volta sola, solo i propri ordini in attesa).
create or replace function checkout_attach(p_order uuid, p_session text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform studio_require(auth.uid() is not null, 'accedi per acquistare');
  if p_session !~ '^cs_(test|live)_[A-Za-z0-9]{1,250}$' then raise exception 'sessione di pagamento non valida'; end if;
  update purchases set stripe_checkout_session_id = p_session, updated_at = now()
  where id = p_order and user_id = auth.uid() and status = 'pending' and stripe_checkout_session_id is null;
  if not found then raise exception 'ordine non trovato o già avviato'; end if;
end;
$$;

-- La sessione non si è potuta creare: l'ordine si chiude senza effetti.
create or replace function checkout_abandon(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update purchases set status = 'canceled', note = 'checkout non avviato', updated_at = now()
  where id = p_order and user_id = auth.uid() and status = 'pending' and stripe_checkout_session_id is null;
end;
$$;

-- ---------------------------------------------------------------- webhook (solo ruolo di servizio)
-- Registra l'evento: 'new' la prima volta, 'retry' se un tentativo precedente non è finito (errore o interruzione),
-- 'done' se è già stato applicato o ignorato: in quel caso il webhook risponde 200 senza rifare nulla.
create or replace function payment_event_begin(p_event text, p_type text)
returns text language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  insert into payment_events (stripe_event_id, type) values (p_event, p_type) on conflict do nothing;
  if found then return 'new'; end if;
  update payment_events set attempts = attempts + 1 where stripe_event_id = p_event and status in ('received', 'error')
  returning status into v_status;
  return case when v_status is null then 'done' else 'retry' end;
end;
$$;

create or replace function payment_event_end(p_event text, p_status text, p_purchase uuid default null, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('processed', 'ignored', 'error') then raise exception 'esito non valido: %', p_status; end if;
  update payment_events set status = p_status, purchase_id = coalesce(p_purchase, purchase_id),
    error = left(p_error, 500), processed_at = case when p_status = 'error' then null else now() end
  where stripe_event_id = p_event;
end;
$$;

-- Diritti di un ordine pagato, dalla copia del prodotto nell'ordine. Idempotente: l'indice unico per ordine e ambito
-- impedisce doppioni e non fa rivivere diritti revocati o sospesi. Un percorso eliminato dopo l'acquisto non
-- crea nulla (decisione D11: rimborso su richiesta). Restituisce il numero di diritti creati.
create or replace function grant_order(p_order uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare o purchases; s jsonb; n integer := 0; k integer;
begin
  select * into o from purchases where id = p_order for update;
  if o.id is null or o.status <> 'completed' or o.user_id is null or o.product_snapshot is null then return 0; end if;
  s := o.product_snapshot;
  if s ->> 'kind' = 'explore' then
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id)
    select o.user_id, o.product_id, 'purchase', o.id, 'explore', s ->> 'pack'
    where exists (select 1 from packs where id = s ->> 'pack')
    on conflict do nothing;
    get diagnostics n = row_count;
  else
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, route_id)
    select o.user_id, o.product_id, 'purchase', o.id, 'route', s ->> 'pack', r.id
    from routes r
    where r.pack_id = s ->> 'pack'
      and r.id in (select (x ->> 'id')::uuid from jsonb_array_elements(
                     case when s ->> 'kind' = 'route' then jsonb_build_array(s -> 'route') else s -> 'routes' end) x)
    on conflict do nothing;
    get diagnostics k = row_count;
    n := k;
  end if;
  return n;
end;
$$;

-- Transizioni ammesse: un esito arrivato tardi o ripetuto non torna mai indietro.
create or replace function order_transition_allowed(p_from text, p_to text)
returns boolean language sql immutable as $$
  select case p_to
    -- Il pagamento confermato da Stripe vale anche su un ordine sostituito o scaduto nel frattempo: i soldi ci sono.
    when 'completed' then p_from in ('pending', 'canceled', 'expired', 'failed', 'disputed')
    when 'failed' then p_from = 'pending'
    when 'expired' then p_from = 'pending'
    when 'partially_refunded' then p_from in ('completed', 'partially_refunded', 'disputed')
    when 'refunded' then p_from in ('completed', 'partially_refunded', 'disputed')
    when 'disputed' then p_from in ('completed', 'partially_refunded')
    else false end;
$$;

-- Pagamento confermato (sessione letta da Stripe con payment_status = paid). Controlla che importo e valuta siano
-- quelli dell'ordine; altrimenti non concede nulla e lo segnala (revisione manuale).
create or replace function payment_paid(p_order uuid, p_session text, p_payment_intent text, p_customer text,
                                        p_amount_total integer, p_currency text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o purchases; v_granted integer := 0;
begin
  select * into o from purchases where id = p_order for update;
  if o.id is null then raise exception 'ordine sconosciuto: %', p_order; end if;
  if o.stripe_checkout_session_id is not null and o.stripe_checkout_session_id <> p_session then
    raise exception 'la sessione di pagamento non è quella dell''ordine';
  end if;
  if p_amount_total is distinct from o.unit_amount or upper(coalesce(p_currency, '')) <> o.currency then
    update purchases set note = format('importo pagato %s %s diverso da quello dell''ordine: verifica manuale', p_amount_total, p_currency),
      updated_at = now() where id = o.id;
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false, 'problem', 'importo diverso');
  end if;
  update purchases set stripe_checkout_session_id = coalesce(stripe_checkout_session_id, p_session),
    stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
    stripe_customer_id = coalesce(stripe_customer_id, p_customer), amount_total = p_amount_total, updated_at = now()
  where id = o.id;
  if o.status = 'disputed' or not order_transition_allowed(o.status, 'completed') then
    -- Già pagato (o in un esito successivo al pagamento): niente da cambiare. I diritti si ricontrollano comunque,
    -- nel caso un tentativo precedente si sia interrotto tra il pagamento e la concessione.
    if o.status = 'completed' then v_granted := grant_order(o.id); end if;
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false, 'granted', v_granted);
  end if;
  update purchases set status = 'completed', paid_at = coalesce(paid_at, now()), note = null, updated_at = now() where id = o.id;
  v_granted := grant_order(o.id);
  return jsonb_build_object('order', o.id, 'status', 'completed', 'changed', true, 'granted', v_granted);
end;
$$;

-- Sessione non pagata: pagamento asincrono fallito ('failed') o sessione scaduta ('expired').
create or replace function payment_unpaid(p_order uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o purchases;
begin
  if p_status not in ('failed', 'expired') then raise exception 'esito non valido: %', p_status; end if;
  select * into o from purchases where id = p_order for update;
  if o.id is null then raise exception 'ordine sconosciuto: %', p_order; end if;
  if not order_transition_allowed(o.status, p_status) then
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false);
  end if;
  update purchases set status = p_status, updated_at = now() where id = o.id;
  return jsonb_build_object('order', o.id, 'status', p_status, 'changed', true);
end;
$$;

-- Rimborso (importo totale rimborsato letto da Stripe). Totale → revoca dei diritti; parziale → nessuna revoca.
create or replace function payment_refunded(p_payment_intent text, p_amount_refunded integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o purchases; v_to text; n integer := 0;
begin
  select * into o from purchases where stripe_payment_intent_id = p_payment_intent for update;
  if o.id is null then return jsonb_build_object('order', null, 'changed', false); end if;
  if p_amount_refunded <= o.amount_refunded then
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false);
  end if;
  v_to := case when p_amount_refunded >= coalesce(o.amount_total, o.unit_amount) then 'refunded' else 'partially_refunded' end;
  update purchases set amount_refunded = p_amount_refunded, updated_at = now() where id = o.id;
  if not order_transition_allowed(o.status, v_to) then
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false);
  end if;
  update purchases set status = v_to, refunded_at = case when v_to = 'refunded' then now() else refunded_at end where id = o.id;
  if v_to = 'refunded' then
    update entitlements set status = 'revoked', note = coalesce(note || ' · ', '') || 'revocato: rimborso'
    where purchase_id = o.id and status in ('active', 'suspended');
    get diagnostics n = row_count;
  end if;
  return jsonb_build_object('order', o.id, 'status', v_to, 'changed', true, 'revoked', n);
end;
$$;

-- Contestazione: 'open' sospende, 'won' ripristina, 'lost' revoca.
create or replace function payment_dispute(p_payment_intent text, p_state text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o purchases; v_to text;
begin
  if p_state not in ('open', 'won', 'lost') then raise exception 'esito non valido: %', p_state; end if;
  select * into o from purchases where stripe_payment_intent_id = p_payment_intent for update;
  if o.id is null then return jsonb_build_object('order', null, 'changed', false); end if;
  v_to := case p_state when 'open' then 'disputed' when 'lost' then 'refunded'
          else case when o.amount_refunded > 0 then 'partially_refunded' else 'completed' end end;
  if p_state <> 'open' and o.status <> 'disputed' then
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false);
  end if;
  if not order_transition_allowed(o.status, v_to) then
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false);
  end if;
  update purchases set status = v_to, updated_at = now(),
    refunded_at = case when v_to = 'refunded' then now() else refunded_at end where id = o.id;
  if p_state = 'open' then
    update entitlements set status = 'suspended' where purchase_id = o.id and status = 'active';
  elsif p_state = 'won' then
    update entitlements set status = 'active' where purchase_id = o.id and status = 'suspended';
    perform grant_order(o.id);
  else
    update entitlements set status = 'revoked', note = coalesce(note || ' · ', '') || 'revocato: contestazione persa'
    where purchase_id = o.id and status in ('active', 'suspended');
  end if;
  return jsonb_build_object('order', o.id, 'status', v_to, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------- dati personali: anche gli ordini nell'esportazione
create or replace function export_my_data()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) from profiles p where p.user_id = auth.uid()),
    'favorites', coalesce((select jsonb_agg(to_jsonb(f)) from favorites f where f.user_id = auth.uid()), '[]'),
    'route_progress', coalesce((select jsonb_agg(to_jsonb(r)) from route_progress r where r.user_id = auth.uid()), '[]'),
    'consents', coalesce((select jsonb_agg(to_jsonb(c)) from consents c where c.user_id = auth.uid()), '[]'),
    'entitlements', coalesce((select jsonb_agg(to_jsonb(e)) from entitlements e where e.user_id = auth.uid()), '[]'),
    'purchases', coalesce((select jsonb_agg(jsonb_build_object(
        'id', pu.id, 'status', pu.status, 'product', pu.product_snapshot, 'unit_amount', pu.unit_amount,
        'currency', pu.currency, 'amount_refunded', pu.amount_refunded, 'created_at', pu.created_at,
        'paid_at', pu.paid_at, 'refunded_at', pu.refunded_at) order by pu.created_at)
      from purchases pu where pu.user_id = auth.uid()), '[]')
  );
$$;

-- ---------------------------------------------------------------- permessi
revoke execute on function order_already_owned(uuid, uuid) from public, anon, authenticated;
revoke execute on function order_transition_allowed(text, text) from public, anon, authenticated;
revoke execute on function checkout_open(uuid), checkout_attach(uuid, text), checkout_abandon(uuid) from public, anon;
grant execute on function checkout_open(uuid), checkout_attach(uuid, text), checkout_abandon(uuid) to authenticated;
revoke execute on function payment_event_begin(text, text), payment_event_end(text, text, uuid, text), grant_order(uuid),
  payment_paid(uuid, text, text, text, integer, text), payment_unpaid(uuid, text), payment_refunded(text, integer),
  payment_dispute(text, text) from public, anon, authenticated;
grant execute on function payment_event_begin(text, text), payment_event_end(text, text, uuid, text), grant_order(uuid),
  payment_paid(uuid, text, text, text, integer, text), payment_unpaid(uuid, text), payment_refunded(text, integer),
  payment_dispute(text, text) to service_role;
