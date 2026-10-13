-- Bucket pubblico «bundles»: niente elenco anonimo dei file e pulizia delle versioni superate.
--
-- 1. Lettura delle righe di storage.objects (elenco dei file, metadati) solo a chi pubblica quel territorio.
--    Il bucket resta pubblico: i file si scaricano dall'indirizzo pubblico (/storage/v1/object/public/bundles/…,
--    servito dall'app come /pub/…), che per i bucket pubblici non passa dalle policy. Senza la regola precedente
--    (bundles_public_read, 20261014000000) nessuno, nemmeno anonimo, può più elencare le versioni vecchie.
-- 2. Chi pubblica può cancellare le versioni superate del proprio territorio (le precedenti, gratuite, conterrebbero
--    ancora contenuti oggi a pagamento): solo quelle che l'indice servito non può più usare (punto 4).
--    Media, manifest della struttura precedente e indici non si cancellano.
-- 3. Una pubblicazione alla volta per territorio (studio_publication_claim).
-- 4. Pubblicazioni immutabili (R2): ogni pubblicazione scrive manifest e contenuti in una cartella propria
--    (<territorio>/<lingua>-full/<id pubblicazione>/), e solo finché la tiene in carico; i media restano condivisi
--    (impronta nel nome, mai cancellati); nessun file del bucket si sovrascrive. L'indice pubblico è una serie di
--    fotografie numerate e immutabili (index/<numero>.json): l'app legge quella col numero più alto.
--
-- Limiti che nessuna policy risolve (vedi docs/v0.3-platform/ACCESSO-CONTENUTI.md): chi conosce già l'indirizzo
-- di un file lo scarica finché il file esiste; le cache (CDN, browser, dispositivi che l'hanno scaricato) possono
-- conservarne una copia anche dopo la cancellazione.

drop policy if exists bundles_public_read on storage.objects;
create policy bundles_files_publisher_read on storage.objects for select to authenticated
  using (bucket_id = 'bundles' and (
    (name <> 'index.json' and public.can_publish_pack((storage.foldername(name))[1]))
    or (name = 'index.json' and public.studio_can_publish_any())));

-- Cartella di una pubblicazione: cancellabile solo se la pubblicazione è «morta»: fallita (mai in linea), oppure
-- pubblicata e sostituita da una più recente dello stesso territorio che è già nell'indice servito. Non basta che
-- la sostituta sia registrata nel database: se il suo indice non è stato caricato, l'app serve ancora un indice
-- che punta alla vecchia. Per questo l'esito riuscito registra (report.indexGeneration, sotto il blocco della
-- numerazione) l'ultimo numero emesso g; ogni indice con numero > g è stato fotografato dopo l'esito e la contiene.
-- L'app serve l'indice col numero più alto: se ne esiste uno > g, quello servito non punta più alla vecchia, oggi
-- e in futuro (gli indici non si cancellano). La condizione, una volta vera, resta vera per sempre: nessuna
-- cancellazione, anche tardiva, tocca la versione servita o una pubblicazione in corso.
-- Contenuti della struttura precedente (<lingua>-full/content.*.json): cancellabili solo quando il territorio ha
-- una pubblicazione nella struttura nuova già nell'indice servito (da allora la struttura precedente non torna più
-- in linea). Media, manifest della struttura precedente e indici non si cancellano.
create or replace function studio_index_reflects(p_generation bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select p_generation is not null and exists (
    select 1 from storage.objects
    where bucket_id = 'bundles' and name ~ '^index/[0-9]{20}\.json$' and substring(name from 7 for 20)::numeric > p_generation);
$$;

create or replace function studio_publication_dead(p_pack text, p_pub text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_pub ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and exists (
    select 1 from publications x
    where x.id = p_pub::uuid and x.pack_id = p_pack
      and (x.status = 'failed'
           or (x.status = 'published' and exists (
                 select 1 from publications y
                 where y.pack_id = p_pack and y.status = 'published' and y.finished_at > x.finished_at
                   and studio_index_reflects((y.report ->> 'indexGeneration')::bigint)))));
$$;

-- Pubblicazioni «morte» di un territorio (le cui cartelle si possono cancellare): per la pulizia della pipeline.
create or replace function studio_publication_dead_ids(p_pack text)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(x.id order by x.created_at), '{}') from publications x
  where x.pack_id = p_pack and can_publish_pack(p_pack) and studio_publication_dead(p_pack, x.id::text);
$$;

create or replace function studio_legacy_layout_dead(p_pack text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from publications p, jsonb_array_elements(coalesce(p.report -> 'entries', '[]')) e
    where p.pack_id = p_pack and p.status = 'published'
      and studio_index_reflects((p.report ->> 'indexGeneration')::bigint)
      and e ->> 'manifest' ~ ('^/pub/' || replace(p_pack, '.', '\.')
                              || '/[a-z]{2}-full/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/manifest\.json$'));
$$;

create policy bundles_files_publisher_delete on storage.objects for delete to authenticated
  using (bucket_id = 'bundles' and public.can_publish_pack((storage.foldername(name))[1]) and (
    (name ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}-full/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(manifest\.json|content\.[0-9a-f]{8,64}\.json)$'
     and public.studio_publication_dead((storage.foldername(name))[1], (storage.foldername(name))[3]))
    or (name ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}-full/content\.[0-9a-f]{8,64}\.json$'
        and public.studio_legacy_layout_dead((storage.foldername(name))[1]))));

-- ---------------------------------------------------------------- scritture: solo file nuovi (R2)
-- Nomi ammessi nel bucket (sostituisce la versione di 20261021000000): struttura precedente, cartelle delle
-- pubblicazioni e indici numerati.
create or replace function bundle_object_name_ok(p_name text)
returns boolean language sql immutable as $$
  select p_name = 'index.json'
      or p_name ~ '^index/[0-9]{20}\.json$'
      or p_name ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}-full/(manifest\.json|content\.[0-9a-f]{8,64}\.json|media/[0-9a-f]{16}\.(jpg|jpeg|png|webp|mp4|webm|mp3|m4a))$'
      or p_name ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}-full/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(manifest\.json|content\.[0-9a-f]{8,64}\.json)$';
$$;

-- La cartella di una pubblicazione la scrive solo chi l'ha presa in carico, e solo finché è in corso: chi l'ha
-- persa (scaduta, sostituita) non scrive più nulla, nemmeno nella propria cartella; nella cartella di un'altra
-- pubblicazione non scrive mai (il nome della cartella è l'identificativo della pubblicazione).
create or replace function studio_publication_writable(p_pack text, p_pub text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_pub ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and exists (
    select 1 from publications
    where id = p_pub::uuid and pack_id = p_pack and status = 'building' and requested_by = auth.uid());
$$;

-- Numeri degli indici: una sequenza (nessuna tabella). Un file index/<numero>.json si accetta solo con un numero
-- già assegnato da studio_index_snapshot: nessuno può «prenotare» un numero più alto di quelli emessi.
create sequence if not exists public_index_generation;
create or replace function studio_index_issued(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_last bigint; v_called boolean;
begin
  if p_name !~ '^index/[0-9]{20}\.json$' then return false; end if;
  select last_value, is_called into v_last, v_called from public_index_generation;
  -- numeric: venti cifre possono superare bigint, e il confronto deve dire «no», non andare in errore.
  return substring(p_name from 7 for 20)::numeric between 1 and (case when v_called then v_last else 0 end);
end;
$$;

-- Inserimento (sostituisce 20261021000000): media della destinazione, file della propria pubblicazione in corso,
-- indici numerati già emessi. Niente più manifest, contenuti o index.json nella struttura precedente: lo Studio
-- precedente non può più pubblicare (vedi la finestra di transizione in ACCESSO-CONTENUTI.md).
-- Nessun aggiornamento: senza policy di UPDATE nessun file del bucket si sovrascrive (niente upsert).
drop policy if exists bundles_files_publisher_insert on storage.objects;
drop policy if exists bundles_files_publisher_update on storage.objects;
create policy bundles_files_publisher_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bundles' and (
    (name ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}-full/media/[0-9a-f]{16}\.(jpg|jpeg|png|webp|mp4|webm|mp3|m4a)$'
     and public.can_publish_pack((storage.foldername(name))[1]))
    or (name ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}-full/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(manifest\.json|content\.[0-9a-f]{8,64}\.json)$'
        and public.can_publish_pack((storage.foldername(name))[1])
        and public.studio_publication_writable((storage.foldername(name))[1], (storage.foldername(name))[3]))
    or (public.studio_index_issued(name) and public.studio_can_publish_any())));

-- Gli indici numerati sono pubblici come index.json: chiunque li elenca (serve a trovare il più recente).
create policy bundles_index_public_list on storage.objects for select to anon, authenticated
  using (bucket_id = 'bundles' and name ~ '^index/[0-9]{20}\.json$');

-- ---------------------------------------------------------------- una pubblicazione alla volta per territorio
-- La cancellazione dei contenuti superati è sicura solo se nessun'altra pubblicazione dello stesso territorio sta
-- caricando file nella stessa cartella: altrimenti cancellerebbe il contenuto che l'altra sta per pubblicare (o ha
-- appena pubblicato). La pipeline (lib/studio/server.ts) prende quindi la propria richiesta in carico («building»)
-- prima di toccare il bucket; se un'altra è già in corso si ferma e la propria richiesta risulta fallita.
-- L'esito si registra solo per identificativo, sulla pubblicazione presa in carico da chi chiama
-- (studio_publication_finish con p_publication): una pubblicazione scaduta non tocca quella che l'ha sostituita.
-- Prima di ogni manifest e di ogni cancellazione la pipeline rinnova la presa in carico (studio_publication_renew):
-- chi l'ha persa non sovrascrive i manifest e non cancella i file di chi l'ha sostituita.
-- Nessuna tabella o colonna nuova: lo stato «building» esiste dal 20261014000000; l'ora di inizio sta nel report.
-- Una compilazione rimasta a metà (server interrotto) non blocca per sempre: dopo 15 minuti si considera fallita.

create or replace function studio_publication_claim(p_pack text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pub uuid;
begin
  perform studio_require(can_publish_pack(p_pack), 'non hai i permessi per pubblicare questo territorio');
  -- Serializza le prese in carico concorrenti dello stesso territorio.
  perform 1 from destinations where pack_id = p_pack for update;
  select id into v_pub from publications
  where pack_id = p_pack and status = 'requested' and requested_by = auth.uid()
  order by created_at desc limit 1;
  if v_pub is null then raise exception 'nessuna pubblicazione richiesta per %', p_pack; end if;

  update publications set status = 'failed', finished_at = now(),
    report = coalesce(report, '{}') || jsonb_build_object('pipeline',
      jsonb_build_object('errors', jsonb_build_array('compilazione interrotta: nessun esito entro 15 minuti')))
  where pack_id = p_pack and status = 'building'
    and coalesce((report ->> 'buildingSince')::timestamptz, created_at) < now() - interval '15 minutes';

  if exists (select 1 from publications where pack_id = p_pack and status = 'building') then
    update publications set status = 'failed', finished_at = now(),
      report = coalesce(report, '{}') || jsonb_build_object('pipeline',
        jsonb_build_object('errors', jsonb_build_array('un''altra pubblicazione dello stesso territorio era in corso')))
    where id = v_pub;
    return jsonb_build_object('ok', false, 'publication', v_pub, 'reason', 'busy');
  end if;
  update publications set status = 'building', report = coalesce(report, '{}') || jsonb_build_object('buildingSince', now())
  where id = v_pub;
  return jsonb_build_object('ok', true, 'publication', v_pub);
end;
$$;
revoke execute on function studio_publication_claim(text) from public, anon;
grant execute on function studio_publication_claim(text) to authenticated, service_role;

-- Rinnovo della presa in carico (R2): la pipeline lo chiede subito prima di ogni operazione che cambia i file già
-- pubblicati (ogni manifest, ogni cancellazione) e dopo ogni gruppo di caricamenti. Vale solo per la pubblicazione
-- indicata, di questo territorio, presa in carico da chi chiama e ancora in corso; altrimenti risponde false senza
-- cambiare nulla e la pipeline si ferma. Il rinnovo e la scadenza decisa da studio_publication_claim passano dalla
-- stessa riga bloccata: o vince il rinnovo (e chi arriva dopo trova la pubblicazione in corso) o vince la
-- sostituzione (e il rinnovo risponde false). Un controllo vale solo per l'operazione che lo segue.
create or replace function studio_publication_renew(p_pack text, p_publication uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v publications;
begin
  perform studio_require(can_publish_pack(p_pack), 'non hai i permessi per pubblicare questo territorio');
  select * into v from publications where id = p_publication for update;
  if v.id is null or v.pack_id is distinct from p_pack or v.requested_by is distinct from auth.uid() or v.status <> 'building' then
    return false;
  end if;
  update publications set report = coalesce(report, '{}') || jsonb_build_object('buildingSince', now()) where id = v.id;
  return true;
end;
$$;
revoke execute on function studio_publication_renew(text, uuid) from public, anon;
grant execute on function studio_publication_renew(text, uuid) to authenticated, service_role;

-- Fotografia numerata dell'indice pubblico (R2). Il lock serializza le fotografie: il numero si assegna sotto il
-- lock e la fotografia si prende subito dopo (istruzione successiva, nuova istantanea), e il lock resta fino alla
-- fine della transazione. Quindi numero più alto ⇒ fotografia presa dopo, che vede almeno tutto ciò che vedeva
-- quella col numero più basso: l'indice servito (il numero più alto caricato) non torna mai indietro, anche se un
-- processo sospeso carica tardi la sua fotografia. Senza il lock la sola sequenza non basta (un numero alto può
-- avere una fotografia più vecchia: provato in locale).
create or replace function studio_index_snapshot()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_n bigint;
begin
  perform studio_require(studio_can_publish_any(), 'l''indice dell''app lo aggiorna lo staff della piattaforma');
  perform pg_advisory_xact_lock(hashtext('public_index_generation'));
  v_n := nextval('public_index_generation');
  return jsonb_build_object('generation', v_n, 'name', 'index/' || lpad(v_n::text, 20, '0') || '.json',
                            'index', public_bundle_index());
end;
$$;
revoke execute on function studio_index_snapshot() from public, anon;
grant execute on function studio_index_snapshot() to authenticated, service_role;

-- Esito di una pubblicazione: registrazione comune (bundle, voci dell'indice, stato). Solo per uso interno: la
-- chiamano le due forme di studio_publication_finish qui sotto, dopo aver scelto e bloccato la riga giusta.
create or replace function studio_publication_record(p_pub uuid, p_pack text, p_ok boolean, p_report jsonb, p_bundles jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[] := '{}';
  v_id uuid;
  v_gen bigint;
  b jsonb;
begin
  if not p_ok then
    update publications set status = 'failed', finished_at = now(),
      report = coalesce(report, '{}') || jsonb_build_object('pipeline', p_report)
    where id = p_pub;
    return jsonb_build_object('publication', p_pub, 'status', 'failed');
  end if;

  if jsonb_typeof(p_bundles) is distinct from 'array' or jsonb_array_length(p_bundles) = 0 then
    raise exception 'una pubblicazione riuscita ha almeno un bundle';
  end if;
  for b in select value from jsonb_array_elements(p_bundles) loop
    if b -> 'manifest' ->> 'destination' is distinct from p_pack or b -> 'entry' ->> 'destination' is distinct from p_pack then
      raise exception 'bundle di un altro territorio';
    end if;
    if coalesce(b ->> 'url', '') !~ ('^/pub/' || replace(p_pack, '.', '\.') || '/') then
      raise exception 'indirizzo del bundle fuori dalla cartella del territorio: %', b ->> 'url';
    end if;
    -- R2: manifest e contenuto stanno nella cartella di questa pubblicazione. Una pubblicazione che puntasse ai
    -- file di un'altra ne dipenderebbe, e la pulizia delle pubblicazioni superate potrebbe cancellarli.
    if b ->> 'url' is distinct from ('/pub/' || p_pack || '/' || (b ->> 'locale') || '-full/' || p_pub || '/manifest.json')
       or b -> 'entry' ->> 'manifest' is distinct from b ->> 'url'
       or coalesce(b -> 'manifest' ->> 'content', '') !~ ('^' || p_pub || '/content\.[0-9a-f]{8,64}\.json$') then
      raise exception 'bundle fuori dalla cartella della pubblicazione: %', b ->> 'url';
    end if;
    insert into bundles (pack_id, locale, flavor, version, schema_version, min_app_version, kb_hash, manifest, total_bytes, url)
    values (p_pack, b ->> 'locale', 'full',
            coalesce((select max(version) from bundles where pack_id = p_pack and locale = b ->> 'locale' and flavor = 'full'), 0) + 1,
            (b -> 'manifest' ->> 'bundleSchemaVersion')::smallint, b -> 'manifest' ->> 'minAppVersion',
            b -> 'manifest' ->> 'kbHash', b -> 'manifest', (b -> 'manifest' ->> 'totalBytes')::bigint, b ->> 'url')
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  -- Ultimo numero d'indice emesso, letto sotto lo stesso blocco di studio_index_snapshot: ogni indice con numero
  -- più alto è fotografato dopo questo esito (vedi studio_publication_dead).
  perform pg_advisory_xact_lock(hashtext('public_index_generation'));
  select case when is_called then last_value else 0 end into v_gen from public_index_generation;
  update publications set status = 'published', finished_at = now(), bundle_ids = v_ids,
    report = coalesce(report, '{}') || jsonb_build_object('pipeline', p_report,
      'entries', (select jsonb_agg(value -> 'entry') from jsonb_array_elements(p_bundles)),
      'indexGeneration', v_gen)
  where id = p_pub;
  return jsonb_build_object('publication', p_pub, 'status', 'published', 'bundles', to_jsonb(v_ids));
end;
$$;
revoke execute on function studio_publication_record(uuid, text, boolean, jsonb, jsonb) from public, anon, authenticated;

-- Esito della pubblicazione presa in carico, indicata per identificativo (quello restituito da
-- studio_publication_claim). Si rifiuta, senza cambiare nulla, se la pubblicazione non è di questo territorio, non
-- l'ha richiesta chi chiama o non è più in corso: una pubblicazione scaduta (chiusa da chi l'ha sostituita) non può
-- più completare, fallire o toccare quella successiva.
create or replace function studio_publication_finish(p_pack text, p_ok boolean, p_report jsonb, p_bundles jsonb, p_publication uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v publications;
begin
  perform studio_require(can_publish_pack(p_pack), 'non hai i permessi per pubblicare questo territorio');
  select * into v from publications where id = p_publication for update;
  if v.id is null or v.pack_id is distinct from p_pack or v.requested_by is distinct from auth.uid() then
    raise exception 'pubblicazione % non trovata tra le tue di %: esito non registrato', p_publication, p_pack using errcode = '42501';
  end if;
  if v.status <> 'building' then
    raise exception 'la pubblicazione % non è più in corso (stato %): esito non registrato', p_publication, v.status;
  end if;
  return studio_publication_record(v.id, p_pack, p_ok, p_report, coalesce(p_bundles, '[]'));
end;
$$;
revoke execute on function studio_publication_finish(text, boolean, jsonb, jsonb, uuid) from public, anon;
grant execute on function studio_publication_finish(text, boolean, jsonb, jsonb, uuid) to authenticated, service_role;

-- Forma senza identificativo (20261020000000), per i server che non prendono in carico: chiude solo l'ultima
-- richiesta non presa in carico («requested»), e solo come fallita. Le pubblicazioni «building» appartengono a chi
-- le ha prese in carico e si chiudono solo con l'identificativo; nessuna pubblicazione va in linea senza presa in
-- carico (R2: la promozione è protetta dalla presa in carico).
create or replace function studio_publication_finish(p_pack text, p_ok boolean, p_report jsonb, p_bundles jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_pub uuid;
begin
  perform studio_require(can_publish_pack(p_pack), 'non hai i permessi per pubblicare questo territorio');
  if p_ok then
    raise exception 'una pubblicazione va in linea solo con la presa in carico: pubblica con lo Studio aggiornato';
  end if;
  select id into v_pub from publications
  where pack_id = p_pack and status = 'requested' order by created_at desc limit 1 for update;
  if v_pub is null then raise exception 'nessuna pubblicazione in corso per %', p_pack; end if;
  return studio_publication_record(v_pub, p_pack, p_ok, p_report, p_bundles);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['studio_index_reflects(bigint)', 'studio_publication_dead(text, text)', 'studio_legacy_layout_dead(text)', 'studio_publication_dead_ids(text)',
                           'studio_publication_writable(text, text)', 'studio_index_issued(text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
