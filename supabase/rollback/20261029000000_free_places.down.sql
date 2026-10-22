-- Revoca di 20261029000000_free_places.sql: si ferma senza cambiare nulla se un territorio ha luoghi gratuiti
-- (le funzioni precedenti non li conoscono: toglierli prima dalla pagina Vendita).
do $$ begin
  if exists (select 1 from packs where jsonb_array_length(coalesce(config -> 'access' -> 'freePlaces', '[]')) > 0) then
    raise exception 'revoca fermata: ci sono luoghi gratuiti (toglili prima dalla pagina Vendita)';
  end if;
end $$;

create or replace function access_refs_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  v_list text := case tg_table_name when 'routes' then 'premiumRoutes' else 'introPlaces' end;
begin
  if current_user <> 'authenticated' then return old; end if;
  if tg_op = 'UPDATE' and new.slug = old.slug then return new; end if;
  if exists (select 1 from packs where id = old.pack_id and config -> 'access' -> v_list ? old.slug) then
    raise exception '«%» è tra i contenuti a pagamento: toglilo prima dalla pagina Accesso', old.slug;
  end if;
  return case tg_op when 'DELETE' then old else new end;
end;
$$;

create or replace function studio_access(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'explore', coalesce(pk.config #>> '{access,explore}', 'free'),
    'introPlaces', coalesce(pk.config #> '{access,introPlaces}', '[]'),
    'premiumRoutes', coalesce(pk.config #> '{access,premiumRoutes}', '[]'),
    'isDestination', pk.kind = 'destination',
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', n.slug, 'name', studio_node_name(n.id),
               'openings', coalesce((select jsonb_agg(distinct u.locale) from narrative_units u
                                     where u.anchor_node_id = n.id and u.unit_type = 'opening'), '[]'))
             order by studio_node_name(n.id))
      from nodes n join places pl on pl.node_id = n.id where n.pack_id = pk.id), '[]'),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', r.slug, 'name', coalesce(r.labels #>> '{it,name}', r.labels #>> '{en,name}', r.slug),
               'durationMin', r.duration_min)
             order by r.slug)
      from routes r where r.pack_id = pk.id), '[]'),
    'locales', to_jsonb(pk.locales),
    'canEdit', is_platform_admin())
  from packs pk where pk.id = p_pack;
$$;

create or replace function studio_set_access(p_pack text, p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  k record;
  v_explore text := coalesce(p ->> 'explore', 'free');
  v_intro text[];
  v_routes text[];
  v_bad text;
begin
  perform studio_require(is_platform_admin(), 'i contenuti a pagamento li decide l''amministratore della piattaforma');
  select * into k from packs where id = p_pack;
  if k.id is null then raise exception 'territorio non trovato: %', p_pack; end if;
  if k.kind <> 'destination' then raise exception 'l''accesso a pagamento si configura solo sulle destinazioni'; end if;
  if v_explore not in ('free', 'premium') then raise exception 'esplorazione: free o premium'; end if;
  if jsonb_typeof(coalesce(p -> 'introPlaces', '[]')) <> 'array' or jsonb_typeof(coalesce(p -> 'premiumRoutes', '[]')) <> 'array' then
    raise exception 'luoghi introduttivi e percorsi premium sono elenchi';
  end if;
  v_intro := array(select distinct x from jsonb_array_elements_text(coalesce(p -> 'introPlaces', '[]')) x order by x);
  v_routes := array(select distinct x from jsonb_array_elements_text(coalesce(p -> 'premiumRoutes', '[]')) x order by x);
  if cardinality(v_intro) > 3 then raise exception 'al massimo 3 luoghi introduttivi'; end if;

  select x into v_bad from unnest(v_intro) x
  where not exists (select 1 from nodes n join places pl on pl.node_id = n.id where n.pack_id = p_pack and n.slug = x) limit 1;
  if v_bad is not null then raise exception 'luogo introduttivo inesistente: %', v_bad; end if;
  select x into v_bad from unnest(v_routes) x
  where not exists (select 1 from routes r where r.pack_id = p_pack and r.slug = x) limit 1;
  if v_bad is not null then raise exception 'percorso inesistente: %', v_bad; end if;

  -- Tutto gratuito e nessuna scelta: la configurazione torna com'era (nessuna chiave «access»).
  update packs set
    config = case when v_explore = 'free' and cardinality(v_intro) = 0 and cardinality(v_routes) = 0
                  then config - 'access'
                  else config || jsonb_build_object('access', jsonb_build_object(
                         'explore', v_explore, 'introPlaces', to_jsonb(v_intro), 'premiumRoutes', to_jsonb(v_routes)))
             end,
    updated_at = now()
  where id = p_pack;
  return studio_access(p_pack);
end;
$$;

create or replace function catalog_problem_place(p_pack text, p_place uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il luogo è già gratuito'
    when coalesce(pk.config -> 'access' -> 'introPlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo introduttivo: è già gratuito', (select slug from nodes where id = p_place))
    when not exists (select 1 from narrative_units u where u.anchor_node_id = p_place)
      then format('«%s» non ha racconti: non c''è niente da vendere', (select slug from nodes where id = p_place))
  end
  from packs pk where pk.id = p_pack;
$$;
