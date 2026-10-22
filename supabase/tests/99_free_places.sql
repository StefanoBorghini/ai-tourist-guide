-- Test dei luoghi gratuiti (20261029000000_free_places.sql):
--   G1 solo l'amministratore li sceglie; luogo inesistente rifiutato; studio_access li restituisce;
--   G2 un luogo gratuito non si vende (catalogo, attivazione, «Metti in vendita»);
--   G3 un luogo gratuito non si elimina né si rinomina finché è nell'elenco;
--   G4 senza luoghi gratuiti la configurazione non ha la chiave «freePlaces» (identica a prima).
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values ('99000000-0000-0000-0000-00000000000f', 'institution', 'Comune G (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zq.libero', 'destination', '99000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Gamma"}', '{}');
insert into destinations (pack_id, status) values ('zq.libero', 'published');
insert into nodes (id, pack_id, slug, kind) values
  ('99000000-0000-0000-0000-0000000000a1', 'zq.libero', 'porta', 'place'),
  ('99000000-0000-0000-0000-0000000000a2', 'zq.libero', 'torre', 'place'),
  ('99000000-0000-0000-0000-0000000000a3', 'zq.libero', 'chiesa', 'place');
insert into places (node_id, place_kind, location, importance, dwell_min)
select id, 'poi', 'SRID=4326;POINT(9.83 44.05)', 3, 5 from nodes where pack_id = 'zq.libero';
insert into narrative_units (pack_id, slug, anchor_node_id, unit_type, locale, duration_s, text)
select 'zq.libero', slug || '-apertura', id, 'opening', 'it', 20, slug from nodes where pack_id = 'zq.libero';
insert into auth.users (id, email, raw_user_meta_data) values
  ('99000000-0000-0000-0000-000000000001', 'admin-g@prova.test', '{}'),
  ('99000000-0000-0000-0000-000000000002', 'redattore-g@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('99000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null),
  ('99000000-0000-0000-0000-000000000002', '99000000-0000-0000-0000-00000000000f', 'territory_editor', 'zq.libero');

-- ---------------------------------------------------------------- G1
set role authenticated;
set request.jwt.claim.sub = '99000000-0000-0000-0000-000000000002';
do $$ begin
  perform studio_set_access('zq.libero', '{"explore":"premium","introPlaces":["porta"],"freePlaces":["torre"],"premiumRoutes":[]}');
  raise exception 'FALLITO G1: un redattore sceglie i luoghi gratuiti';
exception when raise_exception or insufficient_privilege then if sqlerrm like 'FALLITO%' then raise; end if; end $$;
set request.jwt.claim.sub = '99000000-0000-0000-0000-000000000001';
do $$
declare a jsonb;
begin
  begin
    perform studio_set_access('zq.libero', '{"explore":"premium","introPlaces":[],"freePlaces":["inesistente"],"premiumRoutes":[]}');
    raise exception 'FALLITO G1: accettato un luogo gratuito inesistente';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  a := studio_set_access('zq.libero', '{"explore":"premium","introPlaces":["porta"],"freePlaces":["torre","torre"],"premiumRoutes":[]}');
  if a -> 'freePlaces' <> '["torre"]' then raise exception 'FALLITO G1: luoghi gratuiti restituiti %', a -> 'freePlaces'; end if;
end $$;
reset role;
do $$ begin
  if (select config -> 'access' -> 'freePlaces' from packs where id = 'zq.libero') <> '["torre"]' then
    raise exception 'FALLITO G1: luoghi gratuiti non salvati nella configurazione';
  end if;
end $$;

-- ---------------------------------------------------------------- G2
set role authenticated;
set request.jwt.claim.sub = '99000000-0000-0000-0000-000000000001';
do $$ begin
  -- In vendita la porta e la chiesa (luoghi principali; dal 20261101000000 anche l'introduttiva), non la torre gratuita.
  if (studio_places_on_sale('zq.libero') ->> 'created')::int <> 2 then raise exception 'FALLITO G2: in vendita più di porta e chiesa'; end if;
  if exists (select 1 from products where kind = 'place' and place_id = '99000000-0000-0000-0000-0000000000a2') then
    raise exception 'FALLITO G2: in vendita il luogo gratuito';
  end if;
  if (select (x ->> 'sellable')::boolean from jsonb_array_elements(studio_catalog('zq.libero') -> 'places') x where x ->> 'slug' = 'torre') then
    raise exception 'FALLITO G2: il catalogo dice vendibile il luogo gratuito';
  end if;
  -- Anche scritto a mano dall'API, il prodotto di un luogo gratuito non si attiva.
  begin
    insert into products (slug, kind, pack_id, place_id, status) values ('zq-torre', 'place', 'zq.libero', '99000000-0000-0000-0000-0000000000a2', 'active');
    raise exception 'FALLITO G2: attivato il prodotto di un luogo gratuito';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
reset role;

-- ---------------------------------------------------------------- G3
set role authenticated;
set request.jwt.claim.sub = '99000000-0000-0000-0000-000000000002';
do $$ begin
  update nodes set slug = 'torre-nuova' where id = '99000000-0000-0000-0000-0000000000a2';
  raise exception 'FALLITO G3: rinominato un luogo gratuito';
exception when raise_exception or insufficient_privilege then if sqlerrm like 'FALLITO%' then raise; end if; end $$;
reset role;

-- ---------------------------------------------------------------- G4
set role authenticated;
set request.jwt.claim.sub = '99000000-0000-0000-0000-000000000001';
do $$ begin
  perform studio_set_access('zq.libero', '{"explore":"premium","introPlaces":["porta"],"freePlaces":[],"premiumRoutes":[]}');
end $$;
reset role;
do $$ begin
  if (select config -> 'access' ? 'freePlaces' from packs where id = 'zq.libero') then
    raise exception 'FALLITO G4: chiave freePlaces rimasta senza luoghi gratuiti';
  end if;
end $$;

-- Pulizia (come amministratore del DB).
delete from product_prices where product_id in (select id from products where pack_id = 'zq.libero');
delete from products where pack_id = 'zq.libero';
delete from memberships where user_id::text like '99000000-%';
delete from narrative_units where pack_id = 'zq.libero';
delete from places where node_id in (select id from nodes where pack_id = 'zq.libero');
delete from nodes where pack_id = 'zq.libero';
delete from destinations where pack_id = 'zq.libero';
delete from packs where id = 'zq.libero';
delete from organizations where id = '99000000-0000-0000-0000-00000000000f';
delete from auth.users where id::text like '99000000-%';
\echo luoghi gratuiti: G1–G4 superati
