-- Luoghi principali e sottoluoghi (decisione del 2026-10-22). Un sottoluogo è un luogo che fa parte di un altro luogo
-- della stessa destinazione (colonna già esistente places.part_of_node_id, «partOf» nel Territory Pack); un solo
-- livello. Si vende il luogo principale (1,99 € proposto): sblocca i suoi racconti e quelli dei suoi sottoluoghi;
-- la sua panoramica (racconto d'apertura) resta gratuita nel bundle pubblico. I sottoluoghi non si vendono da soli.
-- Nessuna tabella nuova, nessun dato cancellato: i prodotti già creati per luoghi che diventano sottoluoghi passano a
-- «ritirato» solo con «Metti in vendita i luoghi principali» (amministratore). Chi ha già comprato un sottoluogo
-- riceve il file del suo luogo principale. Vedi docs/v0.3-platform/ACCESSO-CONTENUTI.md, «Luoghi principali e
-- sottoluoghi».

-- ---------------------------------------------------------------- gerarchia
-- Luogo principale di un luogo: il luogo della stessa destinazione di cui fa parte; null se è principale (anche se
-- partOf indica un territorio o un luogo di un altro pack).
create or replace function place_parent(p_place uuid)
returns uuid language sql stable set search_path = public as $$
  select pl.part_of_node_id
  from places pl
  join nodes n on n.id = pl.node_id
  join nodes p on p.id = pl.part_of_node_id and p.kind = 'place' and p.pack_id = n.pack_id
  where pl.node_id = p_place and pl.part_of_node_id <> pl.node_id;
$$;
grant execute on function place_parent(uuid) to anon, authenticated, service_role;

-- Spunta «È un sottoluogo di …» dello Studio: p_parent = slug del luogo principale, null per toglierla.
-- Un solo livello: il principale non può essere un sottoluogo, e un luogo con sottoluoghi non può diventarlo.
create or replace function studio_set_place_parent(p_pack text, p_slug text, p_parent text)
returns jsonb language plpgsql set search_path = public, extensions as $$
declare
  v_node uuid;
  v_parent uuid;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per modificare i luoghi di questo territorio');
  select n.id into v_node from nodes n join places pl on pl.node_id = n.id where n.pack_id = p_pack and n.slug = p_slug;
  if v_node is null then raise exception 'luogo non trovato: %', p_slug; end if;
  if coalesce(trim(p_parent), '') = '' then
    -- Si toglie solo l'appartenenza a un luogo di questa destinazione (un partOf verso un territorio resta).
    update places set part_of_node_id = null where node_id = v_node and place_parent(v_node) is not null;
  else
    select n.id into v_parent from nodes n join places pl on pl.node_id = n.id where n.pack_id = p_pack and n.slug = trim(p_parent);
    if v_parent is null then raise exception 'luogo principale non trovato: %', p_parent; end if;
    if v_parent = v_node then raise exception 'un luogo non può essere sottoluogo di sé stesso'; end if;
    if place_parent(v_parent) is not null then
      raise exception '«%» è già un sottoluogo: scegli un luogo principale', trim(p_parent);
    end if;
    if exists (select 1 from places pl where pl.part_of_node_id = v_node and place_parent(pl.node_id) = v_node) then
      raise exception '«%» ha dei sottoluoghi: non può diventare a sua volta un sottoluogo', p_slug;
    end if;
    update places set part_of_node_id = v_parent where node_id = v_node;
  end if;
  update nodes set updated_at = now() where id = v_node;
  return studio_place(p_pack, p_slug);
end;
$$;
revoke execute on function studio_set_place_parent(text, text, text) from public, anon;
grant execute on function studio_set_place_parent(text, text, text) to authenticated, service_role;

-- Elenco e scheda dei luoghi dello Studio: con il luogo principale (parent) e i sottoluoghi (children).
create or replace function studio_places(p_pack text)
returns jsonb language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', n.slug,
    'name', studio_node_name(n.id),
    'placeKind', pl.place_kind,
    'categories', to_jsonb(pl.categories),
    'importance', pl.importance,
    'coordinateStatus', pl.coordinate_status,
    'media', (select count(*) from media_subjects ms where ms.node_id = n.id),
    'parent', (select p.slug from nodes p where p.id = place_parent(n.id))) order by studio_node_name(n.id)), '[]')
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
    'parent', (select p.slug from nodes p where p.id = place_parent(n.id)),
    'children', coalesce((select jsonb_agg(c.slug order by c.slug) from places cp join nodes c on c.id = cp.node_id
                          where cp.part_of_node_id = n.id and place_parent(cp.node_id) = n.id), '[]'),
    'canEdit', can_edit_pack(p_pack))
  from nodes n join places pl on pl.node_id = n.id
  where n.pack_id = p_pack and n.slug = p_slug;
$$;

-- ---------------------------------------------------------------- vendita
-- Perché un luogo non si può vendere (null se si può): esplorazione gratuita, luogo gratuito, o sottoluogo (si vende
-- con il suo principale). Un luogo introduttivo ora si vende: della sua panoramica gratuita resta pubblica solo
-- l'apertura, come per ogni luogo principale.
create or replace function catalog_problem_place(p_pack text, p_place uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il luogo è già gratuito'
    when coalesce(pk.config -> 'access' -> 'freePlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo gratuito (pagina Vendita): non si vende', (select slug from nodes where id = p_place))
    when place_parent(p_place) is not null
      then format('«%s» è un sottoluogo di «%s»: si vende con il suo luogo principale',
                  (select slug from nodes where id = p_place), (select slug from nodes where id = place_parent(p_place)))
  end
  from packs pk where pk.id = p_pack;
$$;

-- «Metti in vendita i luoghi principali»: per ogni luogo principale vendibile senza prodotto (non ritirato) crea il
-- prodotto attivo «Luogo» con il prezzo in bozza indicato (in centesimi, 199 se non indicato); i prodotti attivi di
-- luoghi che sono diventati sottoluoghi passano a «ritirato» (restano nello storico e negli ordini). I prezzi valgono
-- dopo «Pubblica i prezzi». Restituisce { created, retired }.
drop function studio_places_on_sale(text, integer);
create function studio_places_on_sale(p_pack text, p_amount integer default 199)
returns jsonb language plpgsql set search_path = public as $$
declare
  k packs;
  r record;
  v_id uuid;
  v_slug text;
  n integer := 0;
  v_retired integer;
begin
  perform studio_require(is_platform_admin(), 'il catalogo lo gestisce l''amministratore della piattaforma');
  select * into k from packs where id = p_pack;
  if k.id is null or k.kind <> 'destination' then raise exception 'si vende solo una destinazione'; end if;
  if p_amount is null or p_amount < 50 or p_amount > 99900 then raise exception 'prezzo fuori dai limiti: da 0,50 € a 999 €'; end if;
  update products p set status = 'retired'
  where p.pack_id = k.id and p.kind = 'place' and p.status <> 'retired' and place_parent(p.place_id) is not null;
  get diagnostics v_retired = row_count;
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
  return jsonb_build_object('created', n, 'retired', v_retired);
end;
$$;
revoke execute on function studio_places_on_sale(text, integer) from public, anon;
grant execute on function studio_places_on_sale(text, integer) to authenticated;

-- Catalogo dello Studio: per ogni luogo anche il principale e quanti sottoluoghi comprende.
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
               'sellable', catalog_problem_place(k.id, n.id) is null,
               'parent', (select p.slug from nodes p where p.id = place_parent(n.id)),
               'subPlaces', (select count(*) from places cp where cp.part_of_node_id = n.id and place_parent(cp.node_id) = n.id))
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

-- ---------------------------------------------------------------- diritti
-- Diritto «place» su un luogo principale: apre il suo file (che contiene anche i sottoluoghi). Chi aveva comprato un
-- luogo prima che diventasse un sottoluogo riceve il file del suo principale: l'acquisto non va perso.
create or replace function has_place_right(p_pack text, p_place uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from entitlements e
    where e.user_id = auth.uid() and e.status = 'active' and e.scope = 'place' and e.pack_id = p_pack
      and (e.place_id = p_place or place_parent(e.place_id) = p_place)
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now()));
$$;
revoke execute on function has_place_right(text, uuid) from public, anon;
grant execute on function has_place_right(text, uuid) to authenticated, service_role;
