-- Accesso ai contenuti: esplorazione gratuita o a pagamento, luoghi introduttivi, percorsi premium.
--
-- La configurazione sta in packs.config -> 'access' (stesso formato di config.yaml dei Territory Pack), quindi
-- passa già da import_pack() e pack_snapshot() senza modifiche. La pipeline di pubblicazione la legge e tiene i
-- contenuti a pagamento fuori dai bundle pubblici (packages/bundle/src/build.ts).
--
-- Regole:
-- - la decide solo l'amministratore della piattaforma (D9), anche con richieste dirette al database;
-- - un luogo introduttivo o un percorso premium non si elimina né si rinomina finché è nella configurazione
--   (D11: un contenuto venduto si toglie prima dal catalogo). Le funzioni con i privilegi del proprietario
--   (eliminazione di un intero territorio, importazioni) non sono soggette al controllo.
--
-- Le colonne routes.access_tier e narrative_units.access_tier (20261014000000) restano inutilizzate: la fonte è
-- la configurazione del territorio.

-- ---------------------------------------------------------------- territori: l'accesso lo cambia l'amministratore
create or replace function packs_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' or is_platform_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if new.kind = 'core' then raise exception 'solo l''amministratore crea territori di tipo core'; end if;
    if new.config ? 'access' then
      raise exception 'i contenuti a pagamento li decide l''amministratore della piattaforma' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.organization_id is distinct from old.organization_id then
    raise exception 'solo l''amministratore della piattaforma cambia l''organizzazione di un territorio';
  end if;
  if new.kind is distinct from old.kind then raise exception 'la tipologia di un territorio non cambia'; end if;
  if new.fictional is distinct from old.fictional then raise exception 'solo l''amministratore cambia «fittizio»'; end if;
  if new.config -> 'access' is distinct from old.config -> 'access' then
    raise exception 'i contenuti a pagamento li decide l''amministratore della piattaforma' using errcode = '42501';
  end if;
  if (new.release_stage is distinct from old.release_stage and 'production' in (new.release_stage::text, old.release_stage::text))
     or new.config is distinct from old.config or new.quality_tier is distinct from old.quality_tier then
    perform studio_require(can_publish_pack(new.id), 'stadio di produzione, configurazione e livello di qualità li cambia chi pubblica');
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- contenuti venduti: prima si tolgono dal catalogo
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
create trigger routes_access_guard_trg before update or delete on routes
  for each row execute function access_refs_guard();
create trigger nodes_access_guard_trg before update or delete on nodes
  for each row when (old.kind = 'place') execute function access_refs_guard();

-- ---------------------------------------------------------------- Studio
-- Stato dell'accesso di una destinazione, con i luoghi e i percorsi tra cui scegliere.
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

-- Imposta l'accesso: esplorazione «free»/«premium», fino a 3 luoghi introduttivi, percorsi premium.
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

revoke execute on function studio_access(text), studio_set_access(text, jsonb) from public, anon;
grant execute on function studio_access(text), studio_set_access(text, jsonb) to authenticated;
