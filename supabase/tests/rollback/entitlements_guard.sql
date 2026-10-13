-- Revoca di 20261024000000_entitlements.sql con dati commerciali presenti (M3): preparazione.
-- run.sh esegue poi la revoca, che deve fermarsi con un messaggio esplicito, e entitlements_guard_check.sql, che
-- verifica che nulla sia cambiato (dati, permessi, risposte di accesso) e pulisce.
\set ON_ERROR_STOP 1
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zh.eta', 'destination', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{"it":"Eta"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":["g1"]}}');
insert into destinations (pack_id) values ('zh.eta');
insert into routes (id, pack_id, slug, duration_min, labels) values
  ('9a000000-0000-0000-0000-0000000000a1', 'zh.eta', 'g1', 30, '{"it":{"name":"G1"}}'),
  ('9a000000-0000-0000-0000-0000000000a2', 'zh.eta', 'g2', 30, '{"it":{"name":"G2"}}');
insert into products (id, slug, kind, pack_id, status) values
  ('9a000000-0000-0000-0000-0000000000e1', 'eta-esplora', 'explore', 'zh.eta', 'active');
insert into auth.users (id, email, raw_user_meta_data) values ('9a000000-0000-0000-0000-000000000001', 'eta@prova.test', '{}');
insert into purchases (id, user_id, product_id, provider, provider_ref, status) values
  ('9a000000-0000-0000-0000-0000000000c1', '9a000000-0000-0000-0000-000000000001', '9a000000-0000-0000-0000-0000000000e1', 'test', 'g1', 'completed');
set role service_role;
select grant_product('9a000000-0000-0000-0000-000000000001', '9a000000-0000-0000-0000-0000000000e1', 'purchase', '9a000000-0000-0000-0000-0000000000c1');
reset role;

-- Stato prima della revoca: diritti, prodotti e risposte di accesso (l'esplorazione non concede il percorso g1).
create table public.revoca_guardia (k text primary key, v text);
insert into public.revoca_guardia values
  ('diritti', (select string_agg(concat_ws('|', id, user_id, product_id, scope, pack_id, route_id, status), ';' order by id) from entitlements)),
  ('prodotti', (select string_agg(concat_ws('|', id, kind, pack_id, route_id, status), ';' order by id) from products));
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$ begin
  if not can_access_explore('zh.eta') or can_access_route('9a000000-0000-0000-0000-0000000000a1')
     or not can_access_route('9a000000-0000-0000-0000-0000000000a2') then
    raise exception 'FALLITO: preparazione della prova di revoca';
  end if;
end $$;
reset role;
