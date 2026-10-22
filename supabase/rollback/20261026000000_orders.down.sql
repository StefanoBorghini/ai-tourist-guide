-- Revoca di 20261026000000_orders.sql: toglie ordini Stripe, eventi di pagamento e funzioni di checkout e webhook.
--
-- Cancellerebbe ordini e la loro storia: si ferma, PRIMA di cambiare qualcosa, se esistono ordini Stripe, eventi di
-- pagamento o diritti sospesi. Tutto in una transazione: o si applica per intero o non cambia nulla.
begin;
set local lock_timeout = '10s';
lock table purchases, entitlements in access exclusive mode;

do $$
declare v_orders bigint; v_events bigint; v_suspended bigint;
begin
  select count(*) into v_orders from purchases where provider = 'stripe';
  select count(*) into v_events from payment_events;
  select count(*) into v_suspended from entitlements where status = 'suspended';
  if v_orders + v_events + v_suspended > 0 then
    raise exception 'REVOCA ORDINI interrotta, nulla è stato modificato: % ordini Stripe, % eventi di pagamento, % diritti sospesi. Esportali prima di tornare indietro.',
      v_orders, v_events, v_suspended;
  end if;
  if exists (select 1 from purchases where status not in ('pending', 'completed', 'refunded', 'failed', 'disputed')) then
    raise exception 'REVOCA ORDINI interrotta, nulla è stato modificato: ordini con stati introdotti da questa migrazione.';
  end if;
end $$;

drop function if exists payment_dispute(text, text);
drop function if exists payment_refunded(text, integer);
drop function if exists payment_unpaid(uuid, text);
drop function if exists payment_paid(uuid, text, text, text, integer, text);
drop function if exists order_transition_allowed(text, text);
drop function if exists grant_order(uuid);
drop function if exists payment_event_end(text, text, uuid, text);
drop function if exists payment_event_begin(text, text);
drop function if exists checkout_abandon(uuid);
drop function if exists checkout_attach(uuid, text);
drop function if exists checkout_open(uuid);
drop function if exists order_already_owned(uuid, uuid);
drop table if exists payment_events;

-- Esportazione dei dati come prima (senza gli ordini).
create or replace function export_my_data()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) from profiles p where p.user_id = auth.uid()),
    'favorites', coalesce((select jsonb_agg(to_jsonb(f)) from favorites f where f.user_id = auth.uid()), '[]'),
    'route_progress', coalesce((select jsonb_agg(to_jsonb(r)) from route_progress r where r.user_id = auth.uid()), '[]'),
    'consents', coalesce((select jsonb_agg(to_jsonb(c)) from consents c where c.user_id = auth.uid()), '[]'),
    'entitlements', coalesce((select jsonb_agg(to_jsonb(e)) from entitlements e where e.user_id = auth.uid()), '[]')
  );
$$;

alter table entitlements drop constraint if exists entitlements_status_check;
alter table entitlements add constraint entitlements_status_check check (status in ('active', 'revoked', 'expired'));

drop index if exists purchases_user_idx;
alter table purchases drop constraint if exists purchases_stripe_copy;
alter table purchases drop constraint if exists purchases_status_check;
alter table purchases
  drop column if exists unit_amount, drop column if exists currency, drop column if exists price_id,
  drop column if exists product_snapshot, drop column if exists amount_total, drop column if exists amount_refunded,
  drop column if exists stripe_checkout_session_id, drop column if exists stripe_payment_intent_id,
  drop column if exists stripe_customer_id, drop column if exists paid_at, drop column if exists refunded_at,
  drop column if exists note;
alter table purchases add constraint purchases_status_check check (status in ('pending', 'completed', 'refunded', 'failed', 'disputed'));
-- Come prima: i privilegi predefiniti dello schema (le policy RLS continuano a impedire le scritture).
grant insert, update, delete on purchases to anon, authenticated;

commit;
