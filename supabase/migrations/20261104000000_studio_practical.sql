-- Informazioni pratiche dei luoghi dallo Studio (orari, accesso, biglietti, trasporti, permessi, sicurezza).
-- Stanno già in places.practical (jsonb, una lista nel formato del Territory Pack: practicalInfoSchema in
-- packages/domain/src/pack-schema.ts) e passano già da import_pack() e pack_snapshot(); mancava solo il modo di
-- scriverle dallo Studio. Nessuna tabella nuova, nessun dato cambiato.
-- Gaia le usa come dati datati (fase F1, docs/v0.4-gaia/CONDIZIONI.md): «è aperto» solo con un'informazione ancora
-- valida (checkedAt + recheckAfterDays). Vedi anche docs/v0.3-platform/TERRITORI-DAL-CMS.md.

-- Sostituisce l'elenco delle informazioni pratiche del luogo. Ogni elemento:
--   { id (slug, unico nel luogo), kind (opening_hours | access | tickets | transport | permission | safety),
--     text { <lingua>: testo } (almeno la lingua principale del territorio), checkedAt (AAAA-MM-GG, non nel futuro),
--     recheckAfterDays (1–730, 90 se manca), source (slug di una fonte del territorio, facoltativa) }
-- Le stesse regole dello schema del Territory Pack: ciò che si salva qui si esporta e si valida senza errori.
create or replace function studio_set_practical(p_pack text, p_slug text, p_items jsonb)
returns jsonb language plpgsql set search_path = public, extensions as $$
declare
  v_node uuid;
  v_default text;
  v_out jsonb := '[]';
  v_ids text[] := '{}';
  v_texts jsonb;
  v_checked date;
  v_days int;
  v_source text;
  e jsonb;
  i int := 0;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per modificare i luoghi di questo territorio');
  select n.id into v_node from nodes n join places pl on pl.node_id = n.id where n.pack_id = p_pack and n.slug = p_slug;
  if v_node is null then raise exception 'luogo non trovato: %', p_slug; end if;
  select default_locale into v_default from packs where id = p_pack;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'informazioni pratiche: serve un elenco'; end if;
  if jsonb_array_length(p_items) > 30 then raise exception 'al massimo 30 informazioni pratiche per luogo'; end if;

  for e in select value from jsonb_array_elements(p_items) loop
    i := i + 1;
    if jsonb_typeof(e) <> 'object' then raise exception 'informazione pratica %: formato non valido', i; end if;
    if coalesce(e ->> 'id', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
      raise exception 'informazione pratica %: identificativo non valido (solo minuscole, cifre e trattini)', i;
    end if;
    if (e ->> 'id') = any (v_ids) then raise exception 'informazione pratica «%» ripetuta', e ->> 'id'; end if;
    v_ids := v_ids || (e ->> 'id');
    if coalesce(e ->> 'kind', '') not in ('opening_hours', 'access', 'tickets', 'transport', 'permission', 'safety') then
      raise exception 'informazione pratica «%»: tipo non valido', e ->> 'id';
    end if;
    v_texts := studio_clean_texts(e -> 'text');
    if not v_texts ? v_default then
      raise exception 'informazione pratica «%»: manca il testo in %', e ->> 'id', v_default;
    end if;
    if exists (select 1 from jsonb_each_text(v_texts) t where length(t.value) > 600) then
      raise exception 'informazione pratica «%»: testo troppo lungo (al massimo 600 caratteri)', e ->> 'id';
    end if;
    begin
      v_checked := (e ->> 'checkedAt')::date;
    exception when others then
      raise exception 'informazione pratica «%»: data del controllo non valida (AAAA-MM-GG)', e ->> 'id';
    end;
    if v_checked is null or (e ->> 'checkedAt') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'informazione pratica «%»: data del controllo non valida (AAAA-MM-GG)', e ->> 'id';
    end if;
    -- Un giorno di margine per i fusi orari: la data è quella del territorio, il server è in UTC.
    if v_checked > current_date + 1 then
      raise exception 'informazione pratica «%»: la data del controllo è nel futuro', e ->> 'id';
    end if;
    v_days := coalesce((e ->> 'recheckAfterDays')::int, 90);
    if v_days not between 1 and 730 then
      raise exception 'informazione pratica «%»: da ricontrollare dopo 1–730 giorni', e ->> 'id';
    end if;
    v_source := nullif(trim(coalesce(e ->> 'source', '')), '');
    if v_source is not null and not exists (select 1 from sources s where s.pack_id = p_pack and s.slug = v_source) then
      raise exception 'informazione pratica «%»: fonte non trovata in questo territorio: %', e ->> 'id', v_source;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'id', e ->> 'id', 'kind', e ->> 'kind', 'text', v_texts, 'source', v_source,
      'checkedAt', to_char(v_checked, 'YYYY-MM-DD'), 'recheckAfterDays', v_days)));
  end loop;

  update places set practical = v_out where node_id = v_node;
  update nodes set updated_at = now() where id = v_node;
  return studio_place(p_pack, p_slug);
end;
$$;
revoke execute on function studio_set_practical(text, text, jsonb) from public, anon;
grant execute on function studio_set_practical(text, text, jsonb) to authenticated, service_role;

-- Scheda del luogo dello Studio: con le informazioni pratiche (practical), il resto come prima (20261101000000).
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
    'practical', case when jsonb_typeof(pl.practical) = 'array' then pl.practical else '[]' end,
    'canEdit', can_edit_pack(p_pack))
  from nodes n join places pl on pl.node_id = n.id
  where n.pack_id = p_pack and n.slug = p_slug;
$$;
