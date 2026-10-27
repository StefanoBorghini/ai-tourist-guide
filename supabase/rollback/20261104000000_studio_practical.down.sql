-- Revoca di 20261104000000_studio_practical.sql: torna la scheda del luogo senza le informazioni pratiche e sparisce
-- la funzione che le scrive dallo Studio. Non tocca dati: le informazioni pratiche già salvate restano in
-- places.practical (c'erano già prima) e continuano a passare da import_pack() e pack_snapshot().
drop function if exists studio_set_practical(text, text, jsonb);

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
