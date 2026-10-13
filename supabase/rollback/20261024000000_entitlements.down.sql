-- Revoca di 20261024000000_entitlements.sql: torna il modello precedente (pack_access/route_access/feature, diritti
-- senza ambito, can_access_route che concede tutti i percorsi a chi ha pack_access e legge routes.access_tier).
--
-- Il modello precedente non sa rappresentare i diritti attuali senza allargarli: un'esplorazione diventerebbe
-- pack_access (tutti i percorsi), un diritto perderebbe l'ambito, un percorso premium configurato in
-- config.access.premiumRoutes risulterebbe libero (access_tier vale 'free'), i diritti tornerebbero scrivibili
-- dall'amministratore senza grant_product(). Per questo la revoca si ferma, PRIMA di cambiare dati o permessi, se
-- esistono prodotti, diritti o percorsi premium configurati: vanno rivisti a mano (e i diritti revocati con il loro
-- motivo) prima di tornare indietro. Senza nulla di tutto ciò la revoca non toglie né concede niente a nessuno.
-- Tutto in una transazione: o si applica per intero o non cambia nulla.
--
-- Scritture concorrenti (R6): prima del controllo si bloccano le tabelle che il controllo legge e la revoca cambia,
-- così nessuno può aggiungere prodotti, diritti o percorsi premium tra il controllo e le modifiche (chi scrive in
-- quel momento aspetta la fine della revoca, e allora il modello per ambito non c'è più). Il livello è ACCESS
-- EXCLUSIVE perché la revoca lo prende comunque su tutte (modifiche di tabelle e chiavi esterne verso packs e
-- routes): preso subito e sempre nello stesso ordine, non va alzato a metà, che è la causa tipica di deadlock.
-- Per la durata della revoca (pochi secondi) anche le letture di queste tabelle aspettano. lock_timeout evita di
-- restare in coda a lungo bloccando le richieste dell'app: se una tabella è occupata per più di 10 secondi la
-- revoca si ferma senza aver cambiato nulla e va ripetuta.
begin;
set local lock_timeout = '10s';
lock table packs, routes, products, product_routes, entitlements in access exclusive mode;

do $$
declare v_products bigint; v_rights bigint; v_routes bigint;
begin
  select count(*) into v_products from products;
  select count(*) into v_rights from entitlements;
  select count(*) into v_routes from packs
  where jsonb_typeof(config -> 'access' -> 'premiumRoutes') = 'array' and jsonb_array_length(config -> 'access' -> 'premiumRoutes') > 0;
  if v_products > 0 or v_rights > 0 or v_routes > 0 then
    raise exception 'REVOCA DIRITTI interrotta, nulla è stato modificato: il modello precedente allargherebbe i diritti (prodotti: %, diritti: %, destinazioni con percorsi premium: %). Rivederli e toglierli a mano prima di tornare indietro.',
      v_products, v_rights, v_routes;
  end if;
end $$;

drop function if exists can_access_explore(text);
drop function if exists admin_grant_product(uuid, uuid, text);
drop function if exists grant_product(uuid, uuid, text, uuid, text);
drop function if exists revoke_purchase(uuid, text);
drop trigger if exists entitlements_guard_trg on entitlements;
drop function if exists entitlements_guard();
drop index if exists entitlements_scope_idx;
drop index if exists entitlements_purchase_scope_key;
alter table entitlements drop constraint if exists entitlements_scope_target;
alter table entitlements drop column if exists route_id, drop column if exists pack_id, drop column if exists scope;
create policy entitlements_admin_write on entitlements for all using (is_platform_admin()) with check (is_platform_admin());
grant insert, update, delete on entitlements to authenticated;

drop table if exists product_routes;
drop trigger if exists products_guard_trg on products;
drop function if exists products_guard();
drop function if exists product_routes_guard();
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'products'::regclass and contype = 'c' loop
    execute format('alter table products drop constraint %I', c);
  end loop;
end $$;
alter table products
  add constraint products_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  add constraint products_status_check check (status in ('draft', 'active', 'retired')),
  add constraint products_kind_check check (kind in ('pack_access', 'route_access', 'feature')),
  add check ((kind = 'pack_access') = (pack_id is not null and route_id is null)),
  add check ((kind = 'route_access') = (route_id is not null)),
  add check ((kind = 'feature') = (feature is not null));

create or replace function can_access_route(p_route uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select r.access_tier = 'free'
        or exists (
          select 1 from products p
          where p.status = 'active'
            and (p.route_id = r.id or (p.kind = 'pack_access' and p.pack_id = r.pack_id))
            and has_entitlement(p.id))
    from routes r where r.id = p_route
  ), false);
$$;
drop function if exists has_active_right(text, text, uuid);

commit;
