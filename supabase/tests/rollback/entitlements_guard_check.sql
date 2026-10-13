-- Dopo la revoca fermata (M3): nulla è cambiato. Poi i dati di prova si tolgono.
\set ON_ERROR_STOP 1
do $$ begin
  if (select v from public.revoca_guardia where k = 'diritti')
     is distinct from (select string_agg(concat_ws('|', id, user_id, product_id, scope, pack_id, route_id, status), ';' order by id) from entitlements) then
    raise exception 'FALLITO: la revoca fermata ha cambiato i diritti';
  end if;
  if (select v from public.revoca_guardia where k = 'prodotti')
     is distinct from (select string_agg(concat_ws('|', id, kind, pack_id, route_id, status), ';' order by id) from products) then
    raise exception 'FALLITO: la revoca fermata ha cambiato i prodotti';
  end if;
  if to_regprocedure('grant_product(uuid, uuid, text, uuid, text)') is null or to_regprocedure('can_access_explore(text)') is null
     or to_regclass('public.product_routes') is null then
    raise exception 'FALLITO: la revoca fermata ha tolto funzioni o tabelle';
  end if;
  if exists (select 1 from pg_policies where tablename = 'entitlements' and policyname = 'entitlements_admin_write')
     or has_table_privilege('authenticated', 'entitlements', 'insert')
     or has_table_privilege('authenticated', 'entitlements', 'update') then
    raise exception 'FALLITO: la revoca fermata ha ridato le scritture dirette sui diritti';
  end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$ begin
  if not can_access_explore('zh.eta') or can_access_route('9a000000-0000-0000-0000-0000000000a1') then
    raise exception 'FALLITO: dopo la revoca fermata l''accesso è cambiato';
  end if;
end $$;
reset role;

drop table public.revoca_guardia;
delete from entitlements where pack_id = 'zh.eta';
delete from purchases where product_id = '9a000000-0000-0000-0000-0000000000e1';
delete from products where pack_id = 'zh.eta';
delete from routes where pack_id = 'zh.eta';
delete from destinations where pack_id = 'zh.eta';
delete from packs where id = 'zh.eta';
delete from auth.users where id = '9a000000-0000-0000-0000-000000000001';
