-- Condivisione su Instagram (decisione del 2026-11-07): ogni destinazione può indicare il proprio account Instagram
-- da taggare e gli hashtag suggeriti; la guida li propone nella scheda di ogni luogo («Racconta … su Instagram»).
--
-- Nessuna tabella nuova: la configurazione sta in packs.config -> 'social' -> 'instagram' (stesso formato di
-- config.yaml dei Territory Pack: {"handle": "...", "hashtags": [...]}), che passa già da import_pack() e
-- pack_snapshot() e arriva al bundle con la pubblicazione. Cambiare la configurazione resta di chi pubblica
-- (packs_guard, 20261022000000), come per il resto di packs.config.
-- Nessun dato di Instagram entra nel database: niente raccolta di post, niente token.

create or replace function studio_social(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'handle', coalesce(pk.config #>> '{social,instagram,handle}', ''),
    'hashtags', coalesce(pk.config #> '{social,instagram,hashtags}', '[]'),
    'isDestination', pk.kind = 'destination',
    'canEdit', can_publish_pack(pk.id))
  from packs pk where pk.id = p_pack;
$$;

-- p = {"handle": "portovenere_com", "hashtags": ["Portovenere"]}; «@» e «#» iniziali si tolgono. Account vuoto = nessun
-- invito a condividere (la chiave «social» sparisce e la configurazione torna com'era).
create or replace function studio_set_social(p_pack text, p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  k record;
  v_handle text := btrim(coalesce(p ->> 'handle', ''));
  v_tags text[];
  v_bad text;
begin
  perform studio_require(can_publish_pack(p_pack), 'l''account Instagram lo cambia chi pubblica il territorio');
  select * into k from packs where id = p_pack;
  if k.id is null then raise exception 'territorio non trovato: %', p_pack; end if;
  if k.kind <> 'destination' then raise exception 'la condivisione sui social si configura solo sulle destinazioni'; end if;
  if jsonb_typeof(coalesce(p -> 'hashtags', '[]')) <> 'array' then raise exception 'gli hashtag sono un elenco'; end if;

  v_handle := regexp_replace(v_handle, '^@', '');
  if v_handle = '' then
    update packs set config = config - 'social', updated_at = now() where id = p_pack;
    return studio_social(p_pack);
  end if;
  -- Come Instagram: fino a 30 caratteri tra lettere, cifre, punti e trattini bassi; niente punto all'inizio, alla
  -- fine o doppio (la stessa regola di INSTAGRAM_HANDLE_PATTERN in packages/domain/src/pack-schema.ts).
  if v_handle !~ '^[A-Za-z0-9._]{1,30}$' or v_handle ~ '^\.|\.$|\.\.' then
    raise exception 'account Instagram non valido: «%» (lettere, cifre, punti e trattini bassi, al massimo 30)', v_handle;
  end if;

  -- Hashtag: senza «#», senza spazi né punteggiatura (tranne «_»), almeno una lettera; doppioni tolti (maiuscole
  -- comprese), nell'ordine dato, al massimo 5.
  select array_agg(t order by i) into v_tags from (
    select distinct on (lower(t)) t, i
    from (select regexp_replace(btrim(x), '^#', '') t, i
          from jsonb_array_elements_text(coalesce(p -> 'hashtags', '[]')) with ordinality as a(x, i)) s
    where t <> ''
    order by lower(t), i) d;
  v_tags := coalesce(v_tags, '{}');
  select t into v_bad from unnest(v_tags) t
  where char_length(t) > 60 or replace(t, '_', '') !~ '^[^[:space:][:punct:][:cntrl:]]+$' or t !~ '[^0-9_]'
  limit 1;
  if v_bad is not null then
    raise exception 'hashtag non valido: «%» (lettere, cifre e trattini bassi, senza spazi)', v_bad;
  end if;
  if cardinality(v_tags) > 5 then raise exception 'al massimo 5 hashtag'; end if;

  update packs set
    config = config || jsonb_build_object('social', jsonb_build_object('instagram',
               jsonb_build_object('handle', v_handle, 'hashtags', to_jsonb(v_tags)))),
    updated_at = now()
  where id = p_pack;
  return studio_social(p_pack);
end;
$$;

revoke execute on function studio_social(text), studio_set_social(text, jsonb) from public, anon;
grant execute on function studio_social(text), studio_set_social(text, jsonb) to authenticated, service_role;
