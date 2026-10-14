-- Revoca di 20261025000000_catalog.sql: toglie prezzi, disponibilità, funzioni del catalogo e catalogo pubblico.
--
-- Non allarga diritti (i prezzi non concedono nulla), ma cancellerebbe il listino: si ferma, PRIMA di cambiare
-- qualcosa, se esistono prezzi pubblicati o archiviati (storia dei prezzi da conservare). Le sole bozze si perdono.
-- Tutto in una transazione: o si applica per intero o non cambia nulla.
begin;
set local lock_timeout = '10s';
lock table products, product_prices in access exclusive mode;

do $$
declare v_prices bigint;
begin
  select count(*) into v_prices from product_prices where status <> 'draft';
  if v_prices > 0 then
    raise exception 'REVOCA CATALOGO interrotta, nulla è stato modificato: % prezzi pubblicati o archiviati. Esportali prima di tornare indietro.', v_prices;
  end if;
end $$;

drop function if exists public_catalog(text);
drop function if exists studio_prices_publish(text);
drop function if exists studio_price_draft(uuid, integer);
drop function if exists studio_product_save(text, jsonb);
drop function if exists studio_catalog(text);
drop trigger if exists products_activation_guard_trg on products;
drop function if exists products_activation_guard();
drop function if exists catalog_problem(uuid);
drop function if exists catalog_problem_of(text, text, uuid, uuid);
drop trigger if exists products_delete_guard_trg on products;
drop function if exists products_delete_guard();
drop table if exists product_prices;
drop function if exists product_prices_guard();
drop index if exists products_one_explore;
drop index if exists products_one_route;
alter table products drop column if exists availability, drop column if exists sort_order;

commit;
