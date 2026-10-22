-- Revoca di 20261101000000_sub_places.sql: tornano le versioni precedenti delle funzioni (luoghi venduti uno per uno,
-- introduttivi gratuiti, «Metti in vendita» a 0,50 € che restituisce un numero). Non tocca dati: la gerarchia dei
-- luoghi (places.part_of_node_id, che esisteva già) resta; i prodotti ritirati restano ritirati (un prodotto ritirato
-- non si riattiva: se servono, «Metti in vendita» ne crea di nuovi).
drop function if exists studio_set_place_parent(text, text, text);


create or replace function studio_places(p_pack text)
returns jsonb language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', n.slug,
    'name', studio_node_name(n.id),
    'placeKind', pl.place_kind,
    'categories', to_jsonb(pl.categories),
    'importance', pl.importance,
    'coordinateStatus', pl.coordinate_status,
    'media', (select count(*) from media_subjects ms where ms.node_id = n.id)) order by studio_node_name(n.id)), '[]')
  from nodes n join places pl on pl.node_id = n.id
  where n.pack_id = p_pack;
$$;

create or replace function studio_place(p_pack text, p_slug text)
returns jsonb language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'slug', n.slug,
    'labels', pack_node_labels(n.id),
    'placeKind', pl.place_kind,
    'categories', to_jsonb(pl.categories),
    'location', pack_lnglat(pl.location),
    'importance', pl.importance,
    'dwellMin', pl.dwell_min,
    'walkable', pl.walkable,
    'coordinates', jsonb_build_object(
      'status', pl.coordinate_status, 'method', pl.coordinate_method,
      'verifiedAt', pl.coordinate_verified_at, 'verifiedBy', pl.coordinate_verified_by,
      'mapVerifiedAt', pl.coordinate_map_verified_at, 'previousLocation', pack_lnglat(pl.previous_location)),
    'storyStatus', pl.story_status,
    'fieldNotes', to_jsonb(pl.field_notes),
    'media', coalesce((select jsonb_agg(jsonb_build_object(
                         'slug', m.slug, 'kind', m.kind, 'path', m.storage_path, 'poster', m.poster_path,
                         'alt', (select alt from media_labels l where l.media_id = m.id order by (l.locale <> 'it'), l.locale limit 1),
                         'author', m.author, 'license', m.license) order by ms.position, m.slug)
                       from media_subjects ms join media_assets m on m.id = ms.media_id where ms.node_id = n.id), '[]'),
    'canEdit', can_edit_pack(p_pack))
  from nodes n join places pl on pl.node_id = n.id
  where n.pack_id = p_pack and n.slug = p_slug;
$$;

create or replace function catalog_problem_place(p_pack text, p_place uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il luogo è già gratuito'
    when coalesce(pk.config -> 'access' -> 'introPlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo introduttivo: è già gratuito', (select slug from nodes where id = p_place))
    when coalesce(pk.config -> 'access' -> 'freePlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo gratuito (pagina Vendita): non si vende', (select slug from nodes where id = p_place))
  end
  from packs pk where pk.id = p_pack;
$$;

drop function studio_places_on_sale(text, integer);
create function studio_places_on_sale(p_pack text, p_amount integer default 50)
returns integer language plpgsql set search_path = public as $$
declare
  k packs;
  r record;
  v_id uuid;
  v_slug text;
  n integer := 0;
begin
  perform studio_require(is_platform_admin(), 'il catalogo lo gestisce l''amministratore della piattaforma');
  select * into k from packs where id = p_pack;
  if k.id is null or k.kind <> 'destination' then raise exception 'si vende solo una destinazione'; end if;
  if p_amount is null or p_amount < 50 or p_amount > 99900 then raise exception 'prezzo fuori dai limiti: da 0,50 € a 999 €'; end if;
  for r in
    select n2.id, n2.slug,
           coalesce((select nl.name from node_labels nl where nl.node_id = n2.id and nl.locale = 'it'), n2.slug) as name_it,
           (select nl.name from node_labels nl where nl.node_id = n2.id and nl.locale = 'en') as name_en
    from nodes n2
    where n2.pack_id = k.id and n2.kind = 'place' and catalog_problem_place(k.id, n2.id) is null
      and not exists (select 1 from products p where p.place_id = n2.id and p.kind = 'place' and p.status <> 'retired')
    order by n2.slug
  loop
    v_slug := regexp_replace(k.id, '[^a-z0-9]+', '-', 'g') || '-luogo-' || r.slug;
    if exists (select 1 from products where slug = v_slug) then
      v_slug := v_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;
    insert into products (slug, kind, pack_id, place_id, labels, status)
    values (v_slug, 'place', k.id, r.id,
            jsonb_strip_nulls(jsonb_build_object('it', jsonb_build_object('name', r.name_it),
                                                 'en', case when r.name_en is not null then jsonb_build_object('name', r.name_en) end)),
            'active')
    returning id into v_id;
    insert into product_prices (product_id, unit_amount, created_by) values (v_id, p_amount, auth.uid());
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function studio_places_on_sale(text, integer) from public, anon;
grant execute on function studio_places_on_sale(text, integer) to authenticated;

create or replace function studio_catalog(p_pack text)
returns jsonb language plpgsql stable set search_path = public as $$
declare k packs;
begin
  perform studio_require(is_platform_admin(), 'il catalogo lo gestisce l''amministratore della piattaforma');
  select * into k from packs where id = p_pack;
  if k.id is null then raise exception 'territorio non trovato: %', p_pack; end if;
  return jsonb_build_object(
    'isDestination', k.kind = 'destination',
    'explore', coalesce(k.config #>> '{access,explore}', 'free'),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'slug', r.slug, 'name', coalesce(r.labels #>> '{it,name}', r.labels #>> '{en,name}', r.slug),
               'premium', coalesce(k.config -> 'access' -> 'premiumRoutes' ? r.slug, false))
             order by r.slug)
      from routes r where r.pack_id = k.id), '[]'),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'slug', n.slug,
               'name', coalesce((select nl.name from node_labels nl where nl.node_id = n.id and nl.locale = 'it'), n.slug),
               'sellable', catalog_problem_place(k.id, n.id) is null)
             order by n.slug)
      from nodes n where n.pack_id = k.id and n.kind = 'place'), '[]'),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'slug', p.slug, 'kind', p.kind, 'labels', p.labels, 'status', p.status,
               'availability', p.availability, 'sortOrder', p.sort_order,
               'route', (select jsonb_build_object('id', r.id, 'slug', r.slug) from routes r where r.id = p.route_id),
               'place', (select jsonb_build_object('id', n.id, 'slug', n.slug) from nodes n where n.id = p.place_id),
               'routes', coalesce((select jsonb_agg(r.slug order by r.slug) from product_routes pr join routes r on r.id = pr.route_id
                                   where pr.product_id = p.id), '[]'),
               'published', (select jsonb_build_object('amount', pp.unit_amount, 'at', pp.published_at) from product_prices pp
                             where pp.product_id = p.id and pp.status = 'published'),
               'draft', (select jsonb_build_object('amount', pp.unit_amount) from product_prices pp
                         where pp.product_id = p.id and pp.status = 'draft'),
               'paidOrders', (select count(*) from purchases pu where pu.product_id = p.id and pu.status = 'completed'),
               'problem', catalog_problem(p.id))
             order by p.status = 'retired', p.sort_order, p.kind, p.slug)
      from products p where p.pack_id = k.id), '[]'),
    'drafts', (select count(*) from product_prices pp join products p on p.id = pp.product_id
               where p.pack_id = k.id and pp.status = 'draft'));
end;
$$;

create or replace function has_place_right(p_pack text, p_place uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from entitlements e
    where e.user_id = auth.uid() and e.status = 'active' and e.scope = 'place' and e.pack_id = p_pack and e.place_id = p_place
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now()));
$$;
revoke execute on function has_place_right(text, uuid) from public, anon;
grant execute on function has_place_right(text, uuid) to authenticated, service_role;

drop function if exists place_parent(uuid);
