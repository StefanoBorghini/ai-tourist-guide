-- Verifica delle migrazioni e delle regole di sicurezza su un progetto Supabase reale.
-- Si incolla tutto nel SQL Editor del progetto e si esegue una volta (Run).
--
-- Crea dati di prova (territori, utenti, contenuti), prova ogni ruolo e alla fine ANNULLA tutto:
-- nel database non resta nulla, nemmeno se un controllo fallisce.
-- Esito: una tabella con «superato»; se qualcosa non va, un errore che inizia con «FALLITO».
-- Colonne: esito, dati di prova rimasti (atteso 0), amministratori della piattaforma, controlli NON verificati
-- (atteso «nessuno»: altrimenti l'elenco dice cosa va verificato a mano, e quei controlli non sono superati).
-- Presuppone le migrazioni fino a 20261102000000 (… → 30 → 31 → 32 → 33): senza, si ferma con «FALLITO: funzione assente».
-- Non verificabile da SQL: lo scaricamento pubblico da /pub/ e la Storage API (qui si provano le regole sulle righe
-- di storage.objects, non il servizio HTTP).
-- Gli stessi controlli girano in locale con `npm run db:check` (10_platform_security.sql e seguenti).
--
-- Esiti: FALLITO = proprietà verificata e non rispettata (lo script si ferma con l'errore); controllo NON
-- VERIFICATO = non eseguibile in sicurezza qui (elencato nell'ultima colonna, e l'esito diventa «incompleto», mai
-- «superato»); «superato» = tutti i controlli eseguiti e rispettati.
-- Verifiche che SQL non può fare e vanno fatte a parte: scaricamento pubblico da /pub/ e operazioni della Storage
-- API (upload, elenco, cancellazione via HTTP); funzioni effettivamente esposte o nascoste da PostgREST via HTTP.
do $$ begin perform set_config('remote_check.non_verificati', 'non eseguito', false); end $$;
do $$
declare
  a uuid;
  p uuid;
  d jsonb;
  r jsonb;
  f record;
  pub uuid := 'e0000000-0000-0000-0000-00000000000a';
  x uuid := 'e0000000-0000-0000-0000-00000000000b';
  w uuid := 'e0000000-0000-0000-0000-00000000000c';
  z uuid := 'e0000000-0000-0000-0000-00000000000d';
  ok boolean;
  nv text[] := '{}';
begin
  begin
    -- ------------------------------------------------------------ installazione
    if not exists (select 1 from pg_extension where extname = 'postgis') then
      raise exception 'FALLITO: estensione PostGIS assente';
    end if;
    if (select public from storage.buckets where id = 'media') is distinct from false then
      raise exception 'FALLITO: bucket media assente o pubblico';
    end if;
    if (select public from storage.buckets where id = 'bundles') is distinct from true then
      raise exception 'FALLITO: bucket bundles assente o non pubblico';
    end if;
    -- Migrazioni presupposte, nell'ordine 22 → 23 → 24: se ne manca una ci si ferma subito, dicendo quale.
    for f in select * from (values
        ('20261022000000_access', 'studio_set_access(text,jsonb)'),
        ('20261023000000_bundles_storage', 'studio_publication_claim(text)'),
        ('20261023000000_bundles_storage', 'studio_publication_renew(text,uuid)'),
        ('20261023000000_bundles_storage', 'studio_publication_finish(text,boolean,jsonb,jsonb,uuid)'),
        ('20261023000000_bundles_storage', 'studio_index_snapshot()'),
        ('20261023000000_bundles_storage', 'studio_index_reflects(bigint)'),
        ('20261024000000_entitlements', 'grant_product(uuid,uuid,text,uuid,text)'),
        ('20261024000000_entitlements', 'can_access_explore(text)'),
        ('20261025000000_catalog', 'studio_prices_publish(text)'),
        ('20261025000000_catalog', 'public_catalog(text)'),
        ('20261026000000_orders', 'checkout_open(uuid)'),
        ('20261026000000_orders', 'payment_paid(uuid,text,text,text,integer,text)'),
        ('20261027000000_premium_storage', 'premium_object_readable(text)'),
        ('20261028000000_place_products', 'has_place_right(text,uuid)'),
        ('20261028000000_place_products', 'studio_places_on_sale(text,integer)'),
        ('20261031000000_local_events', 'public_local_events(text,date,date,text)'),
        ('20261031000000_local_events', 'studio_save_local_event(text,uuid,jsonb,boolean)'),
        ('20261101000000_sub_places', 'place_parent(uuid)'),
        ('20261101000000_sub_places', 'studio_set_place_parent(text,text,text)'),
        ('20261103000000_question_gaps', 'gap_record(text,text,text,text,text,text,text,text,jsonb,text,text)'),
        ('20261103000000_question_gaps', 'studio_question_gaps(text)')
      ) as t(migration, sig) loop
      if to_regprocedure(f.sig) is null then
        raise exception 'FALLITO: migrazione % non applicata (manca %)', f.migration, f.sig;
      end if;
    end loop;
    for f in select * from (values
        ('20261023000000_bundles_storage', 'bundles_files_publisher_read'),
        ('20261023000000_bundles_storage', 'bundles_files_publisher_delete'),
        ('20261023000000_bundles_storage', 'bundles_index_public_list'),
        ('20261027000000_premium_storage', 'premium_files_entitled_read'),
        ('20261027000000_premium_storage', 'premium_files_publisher_insert')
      ) as t(migration, pol) loop
      if not exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = f.pol) then
        raise exception 'FALLITO: migrazione % non applicata (manca la policy % su storage.objects)', f.migration, f.pol;
      end if;
    end loop;
    -- 20261029000000 cambia solo funzioni esistenti: si riconosce dai luoghi gratuiti nel loro testo.
    if (select prosrc from pg_proc where oid = 'catalog_problem_place(text,uuid)'::regprocedure) not like '%freePlaces%' then
      raise exception 'FALLITO: migrazione 20261029000000_free_places non applicata (catalog_problem_place senza luoghi gratuiti)';
    end if;
    if (select prosrc from pg_proc where oid = 'catalog_problem_place(text,uuid)'::regprocedure) like '%non ha racconti%' then
      raise exception 'FALLITO: migrazione 20261030000000_places_without_stories non applicata (i luoghi senza racconti non si vendono)';
    end if;
    -- 20261102000000 cambia solo catalog_problem_place: un principale gratuito con sottoluoghi a pagamento si vende.
    if (select prosrc from pg_proc where oid = 'catalog_problem_place(text,uuid)'::regprocedure) not like '%senza sottoluoghi a pagamento%' then
      raise exception 'FALLITO: migrazione 20261102000000_free_principal_sale non applicata (un luogo principale gratuito non si vende per i suoi sottoluoghi)';
    end if;
    -- 20261101000000: «Metti in vendita» restituisce quanti prodotti ha creato e quanti ha ritirato.
    if (select prorettype from pg_proc where oid = 'studio_places_on_sale(text,integer)'::regprocedure) <> 'jsonb'::regtype then
      raise exception 'FALLITO: migrazione 20261101000000_sub_places incompleta (studio_places_on_sale non restituisce jsonb)';
    end if;
    -- 20261103000000: le domande senza risposta le scrive solo il ruolo di servizio, con gap_record; nessun privilegio
    -- diretto sulle tabelle, e il browser (anon) non esegue nessuna delle funzioni.
    if has_function_privilege('anon', 'gap_record(text,text,text,text,text,text,text,text,jsonb,text,text)', 'execute')
       or has_function_privilege('authenticated', 'gap_record(text,text,text,text,text,text,text,text,jsonb,text,text)', 'execute')
       or has_function_privilege('anon', 'studio_question_gaps(text)', 'execute')
       or has_table_privilege('anon', 'question_gaps', 'select') or has_table_privilege('anon', 'question_gaps', 'insert')
       or has_table_privilege('authenticated', 'question_gaps', 'insert') or has_table_privilege('authenticated', 'question_gaps', 'update')
       or has_table_privilege('service_role', 'question_gaps', 'insert') or has_table_privilege('service_role', 'question_gaps', 'select') then
      raise exception 'FALLITO: migrazione 20261104000000_question_gaps con permessi troppo larghi sulle domande senza risposta';
    end if;
    if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'bundles_public_read') then
      raise exception 'FALLITO: migrazione 20261023000000_bundles_storage incompleta (resta la policy bundles_public_read)';
    end if;
    -- Pubblicazioni immutabili (R2): nessuna policy di aggiornamento sul bucket «bundles» (niente upsert).
    if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'bundles_files_publisher_update') then
      raise exception 'FALLITO: migrazione 20261023000000_bundles_storage incompleta (resta la policy bundles_files_publisher_update: i file si sovrascriverebbero)';
    end if;
    if to_regclass('public.product_routes') is null
       or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'entitlements' and column_name = 'scope') then
      raise exception 'FALLITO: migrazione 20261024000000_entitlements incompleta (mancano product_routes o entitlements.scope)';
    end if;
    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname <> 'spatial_ref_sys'
    ) then
      raise exception 'FALLITO: tabelle senza RLS: %', (
        select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname <> 'spatial_ref_sys');
    end if;

    -- ------------------------------------------------------------ dati di prova
    insert into organizations (id, kind, name) values ('00000000-0000-0000-0000-0000000000aa', 'platform', 'Prova');
    insert into packs (id, kind, organization_id, default_locale, locales) values
      ('it.test.alfa', 'destination', '00000000-0000-0000-0000-0000000000aa', 'it', '{it,en}'),
      ('it.test.beta', 'destination', '00000000-0000-0000-0000-0000000000aa', 'it', '{it}');
    insert into destinations (pack_id, slug) values ('it.test.alfa', 'alfa'), ('it.test.beta', 'beta');
    insert into auth.users (id, email, raw_user_meta_data) values
      ('a0000000-0000-0000-0000-000000000001', 'admin@prova.test', '{}'),
      ('a0000000-0000-0000-0000-000000000002', 'editor-alfa@prova.test', '{}'),
      ('a0000000-0000-0000-0000-000000000003', 'esperto-alfa@prova.test', '{}'),
      ('a0000000-0000-0000-0000-000000000004', 'turista1@prova.test', '{"locale":"en"}'),
      ('a0000000-0000-0000-0000-000000000005', 'turista2@prova.test', '{}');
    insert into memberships (user_id, organization_id, role, pack_scope) values
      ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 'platform_admin', null),
      ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000aa', 'territory_editor', 'it.test.alfa'),
      ('a0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'expert', 'it.test.alfa');
    insert into nodes (id, pack_id, slug, kind) values
      ('b0000000-0000-0000-0000-00000000000a', 'it.test.alfa', 'luogo-a', 'place'),
      ('b0000000-0000-0000-0000-00000000000b', 'it.test.beta', 'luogo-b', 'place');
    insert into places (node_id, place_kind, location, importance, dwell_min) values
      ('b0000000-0000-0000-0000-00000000000a', 'poi', 'SRID=4326;POINT(9.83 44.05)', 3, 5),
      ('b0000000-0000-0000-0000-00000000000b', 'poi', 'SRID=4326;POINT(9.84 44.06)', 3, 5);
    insert into routes (id, pack_id, slug, duration_min, labels, access_tier) values
      ('c0000000-0000-0000-0000-00000000000a', 'it.test.alfa', 'giro-libero', 30, '{"it":{"name":"Giro"}}', 'free'),
      ('c0000000-0000-0000-0000-00000000000b', 'it.test.alfa', 'giro-premium', 60, '{"it":{"name":"Giro lungo"}}', 'premium');
    -- Percorso premium: dichiarato nell'accesso della destinazione (20261022000000), non più con access_tier.
    update packs set config = config || '{"access":{"explore":"free","introPlaces":[],"premiumRoutes":["giro-premium"]}}' where id = 'it.test.alfa';

    if (select preferred_locale from profiles where user_id = 'a0000000-0000-0000-0000-000000000004') is distinct from 'en' then
      raise exception 'FALLITO: profilo creato con la lingua della registrazione';
    end if;
    if (select count(*) from profiles where user_id::text like 'a0000000-0000-0000-0000-00000000000_') <> 5 then
      raise exception 'FALLITO: un profilo per ogni account';
    end if;

    -- ------------------------------------------------------------ anonimo
    set local role anon;
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    begin
      if exists (select 1 from nodes) or exists (select 1 from assertions) or exists (select 1 from profiles) then
        raise exception 'FALLITO: un anonimo non legge contenuti redazionali né profili';
      end if;
    exception when insufficient_privilege then null; end;
    begin
      if exists (select 1 from organizations) then
        raise exception 'FALLITO: un anonimo non legge le organizzazioni';
      end if;
    exception when insufficient_privilege then null; end;
    begin
      insert into organizations (kind, name) values ('partner', 'Intruso');
      raise exception 'FALLITO: un anonimo non scrive nel database';
    exception when insufficient_privilege then null; end;
    begin
      update predicates set label_it = 'Intruso';
      if found then raise exception 'FALLITO: un anonimo non modifica i vocabolari'; end if;
    exception when insufficient_privilege then null; end;
    begin
      if exists (select 1 from storage.objects where bucket_id = 'media') then
        raise exception 'FALLITO: un anonimo non legge gli originali dei media';
      end if;
    exception when insufficient_privilege then null; end;
    reset role;

    -- ------------------------------------------------------------ turista
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
    if exists (select 1 from nodes) then raise exception 'FALLITO: un turista non legge le bozze del CMS'; end if;
    if (select count(*) from profiles) <> 1 then raise exception 'FALLITO: un turista vede solo il proprio profilo'; end if;
    update profiles set display_name = 'Turista', listening = '{"mode":"ask","rate":1.25}' where user_id = 'a0000000-0000-0000-0000-000000000004';
    if not found then raise exception 'FALLITO: il turista aggiorna il proprio profilo'; end if;
    update profiles set display_name = 'Intruso' where user_id = 'a0000000-0000-0000-0000-000000000005';
    if found then raise exception 'FALLITO: un turista non modifica il profilo altrui'; end if;
    insert into favorites (user_id, pack_id, place_id) values ('a0000000-0000-0000-0000-000000000004', 'it.test.alfa', 'b0000000-0000-0000-0000-00000000000a');
    insert into route_progress (user_id, route_id, reached) values ('a0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-00000000000a', '{b0000000-0000-0000-0000-00000000000a}');
    insert into consents (user_id, kind, granted, version) values ('a0000000-0000-0000-0000-000000000004', 'sync', true, '2026-10');
    begin
      insert into favorites (user_id, pack_id, place_id) values ('a0000000-0000-0000-0000-000000000005', 'it.test.alfa', 'b0000000-0000-0000-0000-00000000000a');
      raise exception 'FALLITO: un turista non scrive preferiti per altri';
    exception when insufficient_privilege then null; end;
    begin
      insert into products (slug, kind, pack_id, route_id, status) values ('furbo', 'route', 'it.test.alfa', 'c0000000-0000-0000-0000-00000000000b', 'active');
      raise exception 'FALLITO: un turista non crea prodotti';
    exception when insufficient_privilege then null; end;
    if can_access_route('c0000000-0000-0000-0000-00000000000a') is not true then raise exception 'FALLITO: percorso gratuito accessibile'; end if;
    if can_access_route('c0000000-0000-0000-0000-00000000000b') is not false then raise exception 'FALLITO: percorso premium senza diritto bloccato'; end if;
    reset role;

    -- L'altro turista non vede nulla del primo.
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
    if exists (select 1 from favorites) or exists (select 1 from route_progress) or exists (select 1 from consents) then
      raise exception 'FALLITO: i dati di un turista sono invisibili agli altri';
    end if;
    reset role;

    -- ------------------------------------------------------------ editor del territorio alfa
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
    update nodes set attributes = '{"categoria":"chiesa"}' where slug = 'luogo-a';
    if not found then raise exception 'FALLITO: l''editor modifica il proprio territorio'; end if;
    update nodes set attributes = '{"categoria":"intruso"}' where slug = 'luogo-b';
    if found then raise exception 'FALLITO: l''editor non modifica un altro territorio'; end if;
    if exists (select 1 from nodes where pack_id = 'it.test.beta') then raise exception 'FALLITO: l''editor non vede un altro territorio'; end if;
    -- Coordinate: non con un UPDATE diretto (20261021000000_cms_hardening.sql), sì dallo Studio indicando il metodo.
    begin
      update places set location = 'SRID=4326;POINT(9.8301 44.0501)' where node_id = 'b0000000-0000-0000-0000-00000000000a';
      raise exception 'FALLITO: coordinate cambiate senza passare dallo Studio';
    exception when raise_exception then
      if sqlerrm like 'FALLITO%' then raise; end if;
    end;
    perform studio_update_place('it.test.alfa', 'luogo-a', '{"location": [9.8301, 44.0501], "coordinateMethod": "rilievo GPS"}');
    if (select coordinate_method from places where node_id = 'b0000000-0000-0000-0000-00000000000a') is distinct from 'rilievo GPS' then
      raise exception 'FALLITO: l''editor corregge le coordinate del proprio territorio dallo Studio';
    end if;

    insert into assertions (pack_id, slug, subject_id, predicate_id, type, certainty, status, authored_by)
    values ('it.test.alfa', 'fatto-1', 'b0000000-0000-0000-0000-00000000000a', 'described_as', 'fact', 'established', 'draft', 'chiunque')
    returning id into a;
    if (select authored_by from assertions where id = a) <> 'a0000000-0000-0000-0000-000000000002' then
      raise exception 'FALLITO: l''autore è sempre l''utente reale, non quello dichiarato';
    end if;
    update assertions set status = 'in_review' where id = a;
    begin
      update assertions set status = 'verified' where id = a;
      raise exception 'FALLITO: un editor non verifica un''affermazione';
    exception when raise_exception then
      if sqlerrm like 'FALLITO%' then raise; end if;
    end;
    begin
      insert into assertions (pack_id, slug, subject_id, predicate_id, type, status, authored_by)
      values ('it.test.alfa', 'leggenda-1', 'b0000000-0000-0000-0000-00000000000a', 'described_as', 'legend', 'verified', 'x');
      raise exception 'FALLITO: un''affermazione non nasce verificata dal CMS';
    exception when raise_exception then
      if sqlerrm like 'FALLITO%' then raise; end if;
    end;
    begin
      insert into assertions (pack_id, slug, subject_id, predicate_id, type, status, authored_by)
      values ('it.test.beta', 'fatto-b', 'b0000000-0000-0000-0000-00000000000b', 'described_as', 'tradition', 'draft', 'x');
      raise exception 'FALLITO: un editor non scrive affermazioni in un altro territorio';
    exception when insufficient_privilege then null; end;

    -- Il file c'è prima della registrazione (media_assets_guard).
    insert into storage.objects (bucket_id, name, owner) values ('media', 'it.test.alfa/foto-1.jpg', 'a0000000-0000-0000-0000-000000000002');
    insert into media_assets (pack_id, slug, kind, storage_path, sha256, source, author, license, mime_type, bytes)
    values ('it.test.alfa', 'foto-1', 'image', 'it.test.alfa/foto-1.jpg', 'x', 'own_photo', 'Redazione', 'own', 'image/jpeg', 200000);
    begin
      insert into media_assets (pack_id, slug, kind, storage_path, sha256, source, author, license, mime_type, bytes)
      values ('it.test.alfa', 'enorme', 'image', 'it.test.alfa/enorme.jpg', 'x', 'own_photo', 'Redazione', 'own', 'image/jpeg', 99000000);
      raise exception 'FALLITO: immagini oltre il limite di dimensione rifiutate';
    -- Rifiutata dal vincolo, o prima ancora perché il file non è nel bucket (media_assets_guard).
    exception when check_violation or raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    begin
      insert into media_assets (pack_id, slug, kind, storage_path, sha256, source, author, license, mime_type, bytes)
      values ('it.test.alfa', 'formato', 'audio', 'it.test.alfa/x.exe', 'x', 'own_photo', 'Redazione', 'own', 'application/x-msdownload', 100);
      raise exception 'FALLITO: formati non ammessi rifiutati';
    -- Rifiutata dal vincolo, o prima ancora perché il file non è nel bucket (media_assets_guard).
    exception when check_violation or raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    begin
      insert into storage.objects (bucket_id, name, owner) values ('media', 'it.test.beta/intruso.jpg', 'a0000000-0000-0000-0000-000000000002');
      raise exception 'FALLITO: un editor non carica file in un altro territorio';
    exception when insufficient_privilege then null; end;
    -- Bundle: chi pubblica un territorio ne carica i media, non quelli di altri; i manifest e i contenuti della
    -- struttura precedente non si scrivono più (20261023000000: solo nella cartella della pubblicazione in corso).
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'it.test.alfa/it-full/media/0123456789abcdef.jpg', 'a0000000-0000-0000-0000-000000000002');
    begin
      insert into storage.objects (bucket_id, name, owner) values ('bundles', 'it.test.alfa/it-full/manifest.json', 'a0000000-0000-0000-0000-000000000002');
      raise exception 'FALLITO: manifest scritto nella struttura precedente (sovrascrivibile)';
    exception when insufficient_privilege then null; end;
    begin
      insert into storage.objects (bucket_id, name, owner) values ('bundles', 'it.test.beta/it-full/manifest.json', 'a0000000-0000-0000-0000-000000000002');
      raise exception 'FALLITO: un editor non scrive i bundle di un altro territorio';
    exception when insufficient_privilege then null; end;

    -- Pubblicazione: non con UPDATE o INSERT diretti, solo dallo Studio con controllo e blocchi (20261021000000_cms_hardening.sql).
    begin
      update destinations set status = 'published' where pack_id = 'it.test.alfa';
      raise exception 'FALLITO: stato «pubblicato» con un UPDATE diretto';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    begin
      insert into publications (pack_id, requested_by) values ('it.test.alfa', 'a0000000-0000-0000-0000-000000000002');
      raise exception 'FALLITO: richiesta di pubblicazione con un INSERT diretto';
    exception when insufficient_privilege then null; end;
    begin
      perform studio_set_pack_status('it.test.alfa', 'in_review');
      perform studio_set_pack_status('it.test.alfa', 'published', '{"ok": true}');
      raise exception 'FALLITO: un territorio senza contenuti si pubblica';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    begin
      insert into publications (pack_id, requested_by) values ('it.test.beta', 'a0000000-0000-0000-0000-000000000002');
      raise exception 'FALLITO: nessuna pubblicazione su territori non autorizzati';
    exception when insufficient_privilege then null; end;
    begin
      insert into memberships (user_id, organization_id, role, pack_scope)
      values ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000aa', 'platform_admin', null);
      raise exception 'FALLITO: un editor non si promuove amministratore';
    exception when insufficient_privilege then null; end;
    reset role;

    -- ------------------------------------------------------------ esperto del territorio alfa
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
    update assertions set status = 'verified' where slug = 'fatto-1';
    if not found then raise exception 'FALLITO: l''esperto verifica'; end if;
    if (select verified_by from assertions where slug = 'fatto-1') <> 'a0000000-0000-0000-0000-000000000003' then
      raise exception 'FALLITO: il verificatore registrato è l''utente reale';
    end if;
    reset role;

    -- L'autore che modifica un fatto verificato lo riporta in revisione.
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
    update assertions set certainty = 'probable' where slug = 'fatto-1';
    if (select status from assertions where slug = 'fatto-1') <> 'in_review' then
      raise exception 'FALLITO: un fatto verificato modificato torna in revisione';
    end if;
    reset role;

    -- ------------------------------------------------------------ amministratore
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
    if not exists (select 1 from nodes where pack_id = 'it.test.beta') then raise exception 'FALLITO: l''amministratore vede ogni territorio'; end if;
    insert into products (slug, kind, pack_id, route_id, status) values ('giro-premium', 'route', 'it.test.alfa', 'c0000000-0000-0000-0000-00000000000b', 'active') returning id into p;
    perform admin_grant_product('a0000000-0000-0000-0000-000000000004', p, 'prova');
    reset role;

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
    if can_access_route('c0000000-0000-0000-0000-00000000000b') is not true then raise exception 'FALLITO: diritto di accesso riconosciuto'; end if;
    -- Nessuna scrittura diretta sui diritti (20261024000000): rifiutata, non solo senza effetto.
    begin
      update entitlements set valid_until = now() + interval '1 year';
      raise exception 'FALLITO: un turista non modifica i propri diritti';
    exception when insufficient_privilege then null; end;
    reset role;

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
    if can_access_route('c0000000-0000-0000-0000-00000000000b') then raise exception 'FALLITO: il diritto di un utente non vale per un altro'; end if;
    reset role;

    -- ------------------------------------------------------------ funzioni di 20261023000000 e 20261024000000
    -- Esistono, chi può eseguirle (anon, authenticated, service_role; null = non rilevante) e, poiché girano con i
    -- privilegi del proprietario, con search_path fissato.
    for f in select * from (values
        ('studio_publication_claim(text)', false, true, true),
        ('studio_publication_renew(text,uuid)', false, true, true),
        ('studio_publication_finish(text,boolean,jsonb,jsonb,uuid)', false, true, true),
        ('studio_publication_finish(text,boolean,jsonb,jsonb)', false, true, true),
        ('studio_publication_record(uuid,text,boolean,jsonb,jsonb)', false, false, null),
        ('studio_index_snapshot()', false, true, true),
        ('studio_index_issued(text)', false, true, true),
        ('studio_publication_writable(text,text)', false, true, true),
        ('studio_index_reflects(bigint)', false, true, true),
        ('studio_publication_dead(text,text)', false, true, true),
        ('studio_publication_dead_ids(text)', false, true, true),
        ('studio_legacy_layout_dead(text)', false, true, true),
        ('grant_product(uuid,uuid,text,uuid,text)', false, false, true),
        ('revoke_purchase(uuid,text)', false, false, true),
        ('admin_grant_product(uuid,uuid,text)', false, true, null),
        ('has_active_right(text,text,uuid)', false, true, true),
        ('can_access_explore(text)', null, true, null),
        ('products_guard()', null, null, null),
        ('product_routes_guard()', null, null, null),
        ('entitlements_guard()', null, null, null)
      ) as t(sig, anon_exec, auth_exec, service_exec) loop
      if to_regprocedure(f.sig) is null then
        raise exception 'FALLITO: funzione assente: % (applicate le migrazioni 22 → 23 → 24?)', f.sig;
      end if;
      if f.anon_exec is not null and has_function_privilege('anon', f.sig, 'execute') is distinct from f.anon_exec then
        raise exception 'FALLITO: privilegi di %: anon %', f.sig, case when f.anon_exec then 'deve poterla eseguire' else 'non deve poterla eseguire' end;
      end if;
      if f.auth_exec is not null and has_function_privilege('authenticated', f.sig, 'execute') is distinct from f.auth_exec then
        raise exception 'FALLITO: privilegi di %: authenticated %', f.sig, case when f.auth_exec then 'deve poterla eseguire' else 'non deve poterla eseguire' end;
      end if;
      if f.service_exec is not null and has_function_privilege('service_role', f.sig, 'execute') is distinct from f.service_exec then
        raise exception 'FALLITO: privilegi di %: service_role %', f.sig, case when f.service_exec then 'deve poterla eseguire' else 'non deve poterla eseguire' end;
      end if;
      -- Tutte queste funzioni sono definite con SECURITY DEFINER e «set search_path = public»: si confronta il valore.
      if not exists (select 1 from pg_proc where oid = to_regprocedure(f.sig) and prosecdef) then
        raise exception 'FALLITO: % deve girare con i privilegi del proprietario (SECURITY DEFINER)', f.sig;
      end if;
      if (select proconfig from pg_proc where oid = to_regprocedure(f.sig)) is distinct from array['search_path=public'] then
        raise exception 'FALLITO: search_path di % diverso da quello della migrazione (atteso search_path=public, trovato %)',
          f.sig, coalesce((select array_to_string(proconfig, ', ') from pg_proc where oid = to_regprocedure(f.sig)), 'nessuno');
      end if;
    end loop;
    -- Indice unico: tabella, unicità, colonne nell'ordine della migrazione e predicato (un acquisto concede ogni ambito
    -- una volta sola).
    select jsonb_build_object(
             'unico', i.indisunique, 'tabella', i.indrelid::regclass::text,
             'colonne', (select jsonb_agg(pg_get_indexdef(i.indexrelid, k, true) order by k) from generate_series(1, i.indnatts) k),
             'predicato', pg_get_expr(i.indpred, i.indrelid))
      into r
    from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'entitlements_purchase_scope_key';
    if r is null then raise exception 'FALLITO: indice entitlements_purchase_scope_key assente (un acquisto concederebbe due volte)'; end if;
    if r is distinct from jsonb_build_object('unico', true, 'tabella', 'entitlements',
         'colonne', jsonb_build_array('purchase_id', 'scope', 'COALESCE(route_id, ''00000000-0000-0000-0000-000000000000''::uuid)'),
         'predicato', '(purchase_id IS NOT NULL)') then
      raise exception 'FALLITO: indice entitlements_purchase_scope_key diverso dalla migrazione: %', r;
    end if;
    -- Trigger: presenti, attivi nelle sessioni normali (O = sempre tranne in replica, A = sempre; R e D non scattano),
    -- legati alla funzione giusta, BEFORE INSERT OR UPDATE per riga (tgtype 23). Più sotto si prova che scattano.
    for f in select * from (values ('products_guard_trg', 'products', 'products_guard()'),
                                   ('product_routes_guard_trg', 'product_routes', 'product_routes_guard()'),
                                   ('entitlements_guard_trg', 'entitlements', 'entitlements_guard()')) as t(tg, tab, fn) loop
      if not exists (select 1 from pg_trigger where tgname = f.tg and tgrelid = f.tab::regclass and not tgisinternal) then
        raise exception 'FALLITO: trigger % su % assente', f.tg, f.tab;
      end if;
      if (select tgenabled from pg_trigger where tgname = f.tg and tgrelid = f.tab::regclass) not in ('O', 'A') then
        raise exception 'FALLITO: trigger % su % non attivo nelle sessioni normali (stato %)', f.tg, f.tab,
          (select tgenabled from pg_trigger where tgname = f.tg and tgrelid = f.tab::regclass);
      end if;
      if (select tgfoid from pg_trigger where tgname = f.tg and tgrelid = f.tab::regclass) <> to_regprocedure(f.fn)
         or (select tgtype from pg_trigger where tgname = f.tg and tgrelid = f.tab::regclass) <> 23 then
        raise exception 'FALLITO: trigger % su % diverso dalla migrazione (funzione o eventi)', f.tg, f.tab;
      end if;
    end loop;
    if has_table_privilege('authenticated', 'entitlements', 'insert') or has_table_privilege('authenticated', 'entitlements', 'update')
       or has_table_privilege('authenticated', 'entitlements', 'delete') or has_table_privilege('anon', 'entitlements', 'insert') then
      raise exception 'FALLITO: i client scrivono direttamente nella tabella dei diritti';
    end if;

    -- ------------------------------------------------------------ bucket «bundles» (20261023000000)
    -- Due pubblicazioni di alfa: X fallita (morta), W in corso (dell'editor di alfa). Righe create qui (come
    -- amministratore del database), poi si prova cosa ciascun ruolo vede, scrive e cancella.
    insert into publications (id, pack_id, requested_by, status, report, finished_at) values
      (x, 'it.test.alfa', 'a0000000-0000-0000-0000-000000000002', 'failed', '{}', now()),
      (w, 'it.test.alfa', 'a0000000-0000-0000-0000-000000000002', 'building', '{}', null);
    insert into storage.objects (bucket_id, name, owner) values
      ('bundles', 'it.test.alfa/it-full/content.aaaaaaaaaaaaaaaa.json', null),
      ('bundles', 'it.test.beta/it-full/content.bbbbbbbbbbbbbbbb.json', null),
      ('bundles', 'it.test.alfa/it-full/' || x || '/content.cccccccccccccccc.json', null),
      ('bundles', 'it.test.alfa/it-full/' || w || '/content.dddddddddddddddd.json', null),
      ('bundles', 'index/00000000000000000000.json', null);
    -- Elenco: anonimi e visitatori vedono solo gli indici numerati (per trovare il più recente), nient'altro.
    set local role anon;
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    begin
      if exists (select 1 from storage.objects where bucket_id = 'bundles' and name !~ '^index/[0-9]{20}\.json$') then
        raise exception 'FALLITO: un anonimo elenca i file dei bundle';
      end if;
      if not exists (select 1 from storage.objects where bucket_id = 'bundles' and name = 'index/00000000000000000000.json') then
        raise exception 'FALLITO: un anonimo non trova gli indici numerati (l''app non saprebbe quale indice leggere)';
      end if;
    exception when insufficient_privilege then
      raise exception 'FALLITO: un anonimo non può elencare gli indici numerati';
    end;
    reset role;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
    if exists (select 1 from storage.objects where bucket_id = 'bundles' and name !~ '^index/[0-9]{20}\.json$') then
      raise exception 'FALLITO: un visitatore elenca i file dei bundle';
    end if;
    reset role;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
    if not exists (select 1 from storage.objects where bucket_id = 'bundles' and name = 'it.test.alfa/it-full/content.aaaaaaaaaaaaaaaa.json') then
      raise exception 'FALLITO: chi pubblica non vede i file del proprio territorio';
    end if;
    if exists (select 1 from storage.objects where bucket_id = 'bundles' and name like 'it.test.beta/%') then
      raise exception 'FALLITO: chi pubblica vede i file di un altro territorio';
    end if;
    -- Scritture: solo file nuovi, e nella cartella di una pubblicazione solo mentre è in corso e di chi la tiene.
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'it.test.alfa/it-full/' || w || '/manifest.json', auth.uid());
    begin
      insert into storage.objects (bucket_id, name, owner) values ('bundles', 'it.test.alfa/it-full/' || x || '/manifest.json', auth.uid());
      raise exception 'FALLITO: scrittura nella cartella di una pubblicazione non più in corso';
    exception when insufficient_privilege then null; end;
    -- Un numero mai emesso (il più alto possibile): in un progetto che ha già pubblicato i numeri bassi sono emessi
    -- davvero e scriverli è permesso a chi pubblica; qui si prova che nessuno si prenota un numero futuro.
    begin
      insert into storage.objects (bucket_id, name, owner) values ('bundles', 'index/' || repeat('9', 20) || '.json', auth.uid());
      raise exception 'FALLITO: un editor scrive un indice pubblico con un numero mai emesso';
    exception when insufficient_privilege then null; end;
    update storage.objects set name = name where bucket_id = 'bundles' and name = 'it.test.alfa/it-full/' || w || '/manifest.json';
    if found then raise exception 'FALLITO: un file del bucket si può sovrascrivere (upsert)'; end if;
    -- Cancellazione: solo cartelle di pubblicazioni morte (X), mai una in corso (W), mai i contenuti della struttura
    -- precedente finché non c'è una pubblicazione nella struttura nuova. Se il progetto vieta le cancellazioni
    -- dirette in SQL (le fa solo la Storage API), il controllo resta da verificare e lo si dice nell'esito.
    ok := true;
    begin
      delete from storage.objects where bucket_id = 'bundles'
        and name in ('it.test.alfa/it-full/' || x || '/content.cccccccccccccccc.json', 'it.test.alfa/it-full/' || w || '/content.dddddddddddddddd.json',
                     'it.test.alfa/it-full/content.aaaaaaaaaaaaaaaa.json', 'it.test.beta/it-full/content.bbbbbbbbbbbbbbbb.json',
                     'it.test.alfa/it-full/media/0123456789abcdef.jpg', 'index/00000000000000000000.json');
    exception when others then
      ok := false;
      nv := nv || format('cancellazione nel bucket bundles (%s): verificarla dalla Storage API', sqlerrm);
    end;
    reset role;
    if ok then
      if exists (select 1 from storage.objects where name = 'it.test.alfa/it-full/' || x || '/content.cccccccccccccccc.json') then
        raise exception 'FALLITO: chi pubblica non cancella la cartella di una pubblicazione morta';
      end if;
      if (select count(*) from storage.objects where name in ('it.test.alfa/it-full/' || w || '/content.dddddddddddddddd.json',
            'it.test.alfa/it-full/content.aaaaaaaaaaaaaaaa.json', 'it.test.beta/it-full/content.bbbbbbbbbbbbbbbb.json',
            'it.test.alfa/it-full/media/0123456789abcdef.jpg', 'index/00000000000000000000.json')) <> 5 then
        raise exception 'FALLITO: cancellati file di una pubblicazione in corso, della struttura precedente, di un altro territorio, media o indici';
      end if;
      -- Z, di alfa, in linea nella struttura nuova: finché nessun indice caricato la contiene (numero > quello
      -- registrato al suo esito), l'indice servito può ancora puntare alla struttura precedente, che non si cancella.
      insert into publications (id, pack_id, requested_by, status, report, finished_at) values
        (z, 'it.test.alfa', 'a0000000-0000-0000-0000-000000000002', 'published',
         jsonb_build_object('entries', jsonb_build_array(jsonb_build_object('manifest', '/pub/it.test.alfa/it-full/' || z || '/manifest.json')),
                            'indexGeneration', (select case when is_called then last_value else 0 end from public_index_generation)), now());
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
      perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
      delete from storage.objects where bucket_id = 'bundles' and name = 'it.test.alfa/it-full/content.aaaaaaaaaaaaaaaa.json';
      reset role;
      if not exists (select 1 from storage.objects where name = 'it.test.alfa/it-full/content.aaaaaaaaaaaaaaaa.json') then
        raise exception 'FALLITO: cancellati contenuti che l''indice servito può ancora usare';
      end if;
    end if;

    -- Indice numerato: solo lo staff della piattaforma, solo con un numero già emesso; numeri crescenti.
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
    r := studio_index_snapshot();
    if (studio_index_snapshot() ->> 'generation')::bigint <= (r ->> 'generation')::bigint then
      raise exception 'FALLITO: i numeri dell''indice non crescono';
    end if;
    if r ->> 'name' !~ '^index/[0-9]{20}\.json$' or jsonb_typeof(r -> 'index' -> 'bundles') <> 'array' then
      raise exception 'FALLITO: fotografia dell''indice non valida: %', r;
    end if;
    insert into storage.objects (bucket_id, name, owner) values ('bundles', r ->> 'name', auth.uid());
    begin
      insert into storage.objects (bucket_id, name, owner) values ('bundles', 'index/99999999999999999999.json', auth.uid());
      raise exception 'FALLITO: accettato un indice con un numero mai emesso (bloccherebbe l''indice per sempre)';
    exception when insufficient_privilege then null; end;
    reset role;

    -- Ora un indice caricato contiene Z: i contenuti della struttura precedente di alfa si cancellano.
    if ok then
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
      perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
      delete from storage.objects where bucket_id = 'bundles' and name = 'it.test.alfa/it-full/content.aaaaaaaaaaaaaaaa.json';
      reset role;
      if exists (select 1 from storage.objects where name = 'it.test.alfa/it-full/content.aaaaaaaaaaaaaaaa.json') then
        raise exception 'FALLITO: contenuti della struttura precedente non cancellabili dopo un indice con la struttura nuova';
      end if;
    end if;
    update publications set status = 'failed', finished_at = now() where id = w;

    -- ------------------------------------------------------------ pubblicazione presa in carico (20261023000000)
    insert into publications (id, pack_id, requested_by, status, report) values
      (pub, 'it.test.alfa', 'a0000000-0000-0000-0000-000000000002', 'requested', '{"ok":true}');
    set local role anon;
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    begin
      perform studio_publication_claim('it.test.alfa');
      raise exception 'FALLITO: un anonimo prende in carico una pubblicazione';
    exception when insufficient_privilege then null; end;
    reset role;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
    r := studio_publication_claim('it.test.alfa');
    if (r ->> 'ok')::boolean is not true or (r ->> 'publication')::uuid is distinct from pub then
      raise exception 'FALLITO: presa in carico della propria richiesta: %', r;
    end if;
    if studio_publication_renew('it.test.alfa', pub) is not true then raise exception 'FALLITO: rinnovo della propria presa in carico'; end if;
    -- La forma senza identificativo non manda nulla in linea (R2: niente promozione senza presa in carico).
    begin
      perform studio_publication_finish('it.test.alfa', true, '{}', '[]');
      raise exception 'FALLITO: la forma senza identificativo manda in linea una pubblicazione';
    exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like '%presa in carico%' then raise; end if; end;
    -- La forma senza identificativo non chiude una pubblicazione presa in carico.
    begin
      perform studio_publication_finish('it.test.alfa', false, '{}');
      raise exception 'FALLITO: la forma senza identificativo chiude una pubblicazione presa in carico';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    if (select status from publications where id = pub) <> 'building' then
      raise exception 'FALLITO: la forma senza identificativo ha cambiato la pubblicazione presa in carico';
    end if;
    if studio_publication_finish('it.test.alfa', false, '{"errors":["verifica"]}', '[]', pub) ->> 'status' <> 'failed' then
      raise exception 'FALLITO: esito per identificativo';
    end if;
    if studio_publication_renew('it.test.alfa', pub) is not false then raise exception 'FALLITO: rinnovo di una pubblicazione chiusa'; end if;
    begin
      perform studio_publication_finish('it.test.alfa', true, '{}', '[]', pub);
      raise exception 'FALLITO: secondo esito sulla stessa pubblicazione';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    reset role;

    -- ------------------------------------------------------------ diritti (20261024000000)
    -- L'esplorazione a pagamento si apre solo con il diritto «explore», che non apre i percorsi premium.
    update packs set config = jsonb_set(config, '{access,explore}', '"premium"') where id = 'it.test.alfa';
    set local role anon;
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    if can_access_explore('it.test.alfa') is not false then raise exception 'FALLITO: esplorazione a pagamento aperta a un anonimo'; end if;
    if can_access_explore('it.test.beta') is not true then raise exception 'FALLITO: esplorazione gratuita chiusa a un anonimo'; end if;
    reset role;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
    insert into products (slug, kind, pack_id, status) values ('alfa-esplora', 'explore', 'it.test.alfa', 'active') returning id into a;
    perform admin_grant_product('a0000000-0000-0000-0000-000000000005', a, 'verifica');
    reset role;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
    if can_access_explore('it.test.alfa') is not true then raise exception 'FALLITO: diritto «explore» non riconosciuto'; end if;
    if can_access_route('c0000000-0000-0000-0000-00000000000b') then raise exception 'FALLITO: il diritto «explore» apre un percorso premium'; end if;
    begin
      perform grant_product('a0000000-0000-0000-0000-000000000005', a, 'grant');
      raise exception 'FALLITO: un client chiama grant_product';
    exception when insufficient_privilege then null; end;
    reset role;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
    if can_access_explore('it.test.alfa') then raise exception 'FALLITO: il diritto su un percorso apre l''esplorazione'; end if;
    reset role;
    -- Il server (service_role): un acquisto concede una volta sola; poi il prodotto acquistato non cambia percorso.
    insert into purchases (id, user_id, product_id, provider, provider_ref, status) values
      ('e0000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-000000000005', p, 'verifica', 'verifica-remote-check', 'completed');
    ok := true;
    begin
      set local role service_role;
    exception when others then
      ok := false;
      nv := nv || format('concessione da service_role (%s): verificarla con la chiave di servizio', sqlerrm);
    end;
    if ok then
      if grant_product('a0000000-0000-0000-0000-000000000005', p, 'purchase', 'e0000000-0000-0000-0000-0000000000c1') <> 1
         or grant_product('a0000000-0000-0000-0000-000000000005', p, 'purchase', 'e0000000-0000-0000-0000-0000000000c1') <> 0 then
        raise exception 'FALLITO: lo stesso acquisto concede i diritti più di una volta';
      end if;
      -- Revoca di un acquisto: revoca i suoi diritti, conserva il motivo, e un evento ripetuto non li fa rivivere.
      if revoke_purchase('e0000000-0000-0000-0000-0000000000c1', 'verifica') <> 1 then
        raise exception 'FALLITO: revoke_purchase non revoca il diritto dell''acquisto';
      end if;
      if grant_product('a0000000-0000-0000-0000-000000000005', p, 'purchase', 'e0000000-0000-0000-0000-0000000000c1') <> 0 then
        raise exception 'FALLITO: un evento ripetuto fa rivivere un diritto revocato';
      end if;
      reset role;
      if exists (select 1 from entitlements where purchase_id = 'e0000000-0000-0000-0000-0000000000c1'
                 and (status <> 'revoked' or coalesce(note, '') not like '%revocato: verifica%')) then
        raise exception 'FALLITO: revoke_purchase lascia diritti attivi o senza motivo';
      end if;
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
      perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
      if can_access_route('c0000000-0000-0000-0000-00000000000b') then raise exception 'FALLITO: diritto revocato ancora valido'; end if;
      begin
        perform revoke_purchase('e0000000-0000-0000-0000-0000000000c1', 'intruso');
        raise exception 'FALLITO: un client chiama revoke_purchase';
      exception when insufficient_privilege then null; end;
      reset role;
    end if;
    -- Trigger operativi (non solo presenti): rifiutano davvero ciò che devono rifiutare.
    begin
      update products set route_id = 'c0000000-0000-0000-0000-00000000000a' where id = p;
      raise exception 'FALLITO: cambiato il percorso di un prodotto già acquistato (products_guard)';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    begin
      insert into products (slug, kind, pack_id, route_id, status) values ('percorso-altrui', 'route', 'it.test.beta', 'c0000000-0000-0000-0000-00000000000a', 'draft');
      raise exception 'FALLITO: prodotto con il percorso di un''altra destinazione (products_guard)';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    insert into products (slug, kind, pack_id, status) values ('pacchetto-verifica', 'bundle', 'it.test.beta', 'draft') returning id into a;
    begin
      insert into product_routes (product_id, route_id) values (a, 'c0000000-0000-0000-0000-00000000000a');
      raise exception 'FALLITO: pacchetto con il percorso di un''altra destinazione (product_routes_guard)';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    begin
      insert into product_routes (product_id, route_id) values (p, 'c0000000-0000-0000-0000-00000000000a');
      raise exception 'FALLITO: percorsi aggiunti a un prodotto che non è un pacchetto (product_routes_guard)';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;

    -- ------------------------------------------------------------ storico e cancellazione
    if (select count(*) from content_revisions where table_name = 'assertions' and row_id = (select id::text from assertions where slug = 'fatto-1')) < 4 then
      raise exception 'FALLITO: ogni modifica di un''affermazione resta nello storico';
    end if;
    if (select actor_id from content_revisions where table_name = 'nodes' and operation = 'UPDATE' order by id desc limit 1) is distinct from 'a0000000-0000-0000-0000-000000000002' then
      raise exception 'FALLITO: lo storico registra chi ha modificato';
    end if;

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
    d := export_my_data();
    if jsonb_array_length(d -> 'favorites') <> 1 or jsonb_array_length(d -> 'entitlements') <> 1 then
      raise exception 'FALLITO: esportazione completa dei propri dati';
    end if;
    perform delete_my_account();
    reset role;
    if exists (select 1 from auth.users where id = 'a0000000-0000-0000-0000-000000000004')
       or exists (select 1 from profiles where user_id = 'a0000000-0000-0000-0000-000000000004')
       or exists (select 1 from favorites where user_id = 'a0000000-0000-0000-0000-000000000004')
       or exists (select 1 from route_progress where user_id = 'a0000000-0000-0000-0000-000000000004')
       or exists (select 1 from entitlements where user_id = 'a0000000-0000-0000-0000-000000000004') then
      raise exception 'FALLITO: la cancellazione dell''account rimuove i dati personali';
    end if;

    -- ------------------------------------------------------------ catalogo (20261025000000)
    -- L'amministratore pubblica un prezzo; la storia dei prezzi non si riscrive; il listino è pubblico, le bozze no.
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
    a := (select id from products where slug = 'alfa-esplora');
    perform studio_price_draft(a, 499);
    perform studio_prices_publish('it.test.alfa');
    perform studio_price_draft(a, 599);
    begin
      update product_prices set unit_amount = 1 where product_id = a and status = 'published';
      raise exception 'FALLITO: cambiato l''importo di un prezzo pubblicato (product_prices_guard)';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    reset role;
    set local role anon;
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    if not public_catalog('it.test.alfa') @> '[{"slug":"alfa-esplora","price":{"amount":499}}]' then
      raise exception 'FALLITO: prezzo pubblicato assente dal catalogo pubblico';
    end if;
    if exists (select 1 from product_prices where product_id = a and status <> 'published') then
      raise exception 'FALLITO: un anonimo legge i prezzi in bozza';
    end if;
    reset role;

    -- ------------------------------------------------------------ ordini (20261026000000)
    -- Il checkout copia il prezzo pubblicato; nessuno scrive ordini o diritti dall'API; il webhook (service_role)
    -- concede una volta sola.
    for f in select * from (values
        ('checkout_open(uuid)', false, true, null),
        ('checkout_attach(uuid,text)', false, true, null),
        ('checkout_abandon(uuid)', false, true, null),
        ('order_already_owned(uuid,uuid)', false, false, null),
        ('payment_event_begin(text,text)', false, false, true),
        ('payment_event_end(text,text,uuid,text)', false, false, true),
        ('grant_order(uuid)', false, false, true),
        ('payment_paid(uuid,text,text,text,integer,text)', false, false, true),
        ('payment_unpaid(uuid,text)', false, false, true),
        ('payment_refunded(text,integer)', false, false, true),
        ('payment_dispute(text,text)', false, false, true)
      ) as t(sig, anon_exec, auth_exec, service_exec) loop
      if f.anon_exec is not null and has_function_privilege('anon', f.sig, 'execute') is distinct from f.anon_exec then
        raise exception 'FALLITO: privilegi di %: anon %', f.sig, case when f.anon_exec then 'deve poterla eseguire' else 'non deve poterla eseguire' end;
      end if;
      if f.auth_exec is not null and has_function_privilege('authenticated', f.sig, 'execute') is distinct from f.auth_exec then
        raise exception 'FALLITO: privilegi di %: authenticated %', f.sig, case when f.auth_exec then 'deve poterla eseguire' else 'non deve poterla eseguire' end;
      end if;
      if f.service_exec is not null and has_function_privilege('service_role', f.sig, 'execute') is distinct from f.service_exec then
        raise exception 'FALLITO: privilegi di %: service_role %', f.sig, case when f.service_exec then 'deve poterla eseguire' else 'non deve poterla eseguire' end;
      end if;
    end loop;
    if has_table_privilege('authenticated', 'purchases', 'insert') or has_table_privilege('authenticated', 'purchases', 'update') then
      raise exception 'FALLITO: authenticated può scrivere gli ordini';
    end if;
    a := (select id from products where slug = 'alfa-esplora');
    insert into auth.users (id, email, raw_user_meta_data) values ('a0000000-0000-0000-0000-000000000006', 'cliente@prova.test', '{}');
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000006', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
    begin
      perform checkout_open(a);
      raise exception 'FALLITO: venduta una destinazione non pubblicata';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    reset role;
    update destinations set status = 'published' where pack_id = 'it.test.alfa';
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000006', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
    perform set_config('remote_check.ordine', checkout_open(a) ->> 'order', true);
    if (select unit_amount from purchases where id = current_setting('remote_check.ordine')::uuid) is distinct from 499 then
      raise exception 'FALLITO: l''ordine non copia il prezzo pubblicato';
    end if;
    begin
      update purchases set status = 'completed' where id = current_setting('remote_check.ordine')::uuid;
      raise exception 'FALLITO: un cliente segna pagato il proprio ordine';
    exception when insufficient_privilege then null; end;
    begin
      perform payment_paid(current_setting('remote_check.ordine')::uuid, 'cs_test_remotecheck', 'pi_remotecheck', null, 499, 'eur');
      raise exception 'FALLITO: un cliente chiama le funzioni del webhook';
    exception when insufficient_privilege then null; end;
    reset role;
    ok := true;
    begin
      set local role service_role;
    exception when others then
      ok := false;
      nv := nv || format('pagamento da service_role (%s): verificarlo con un pagamento di prova di Stripe', sqlerrm);
    end;
    if ok then
      if payment_paid(current_setting('remote_check.ordine')::uuid, 'cs_test_remotecheck', 'pi_remotecheck', null, 499, 'eur') ->> 'status' <> 'completed'
         or (payment_paid(current_setting('remote_check.ordine')::uuid, 'cs_test_remotecheck', 'pi_remotecheck', null, 499, 'eur') ->> 'changed')::boolean then
        raise exception 'FALLITO: pagamento non applicato o applicato due volte';
      end if;
      reset role;
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000006', true);
      perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
      if can_access_explore('it.test.alfa') is not true then raise exception 'FALLITO: esplorazione pagata ma chiusa'; end if;
      reset role;
    end if;

    -- ------------------------------------------------------------ contenuti a pagamento (20261027000000)
    -- V1 senza diritti nessun file; V2 un diritto non apre altro; V4 il rimborso chiude; V5 bucket privato, nessuno
    -- scrive tranne la pipeline, niente file a pagamento nel bucket pubblico. (V3, i racconti nel file del percorso,
    -- è una proprietà della compilazione: test del bundle.)
    if (select public from storage.buckets where id = 'premium') is distinct from false then
      raise exception 'FALLITO: bucket premium assente o pubblico';
    end if;
    if has_function_privilege('anon', 'premium_object_readable(text)', 'execute') then
      raise exception 'FALLITO: anon può eseguire premium_object_readable';
    end if;
    insert into storage.objects (bucket_id, name, owner) values
      ('premium', 'it.test.alfa/it/e0000000-0000-0000-0000-0000000000ee/explore.aaaaaaaaaaaaaaaa.json', null),
      ('premium', 'it.test.alfa/it/e0000000-0000-0000-0000-0000000000ee/route-giro-premium.bbbbbbbbbbbbbbbb.json', null);
    set local role anon;
    if exists (select 1 from storage.objects where bucket_id = 'premium') then raise exception 'FALLITO: un anonimo vede file a pagamento'; end if;
    reset role;
    insert into auth.users (id, email, raw_user_meta_data) values ('a0000000-0000-0000-0000-000000000007', 'senza-diritti@prova.test', '{}');
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000007', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
    if exists (select 1 from storage.objects where bucket_id = 'premium') then raise exception 'FALLITO: un visitatore senza diritti vede file a pagamento'; end if;
    begin
      insert into storage.objects (bucket_id, name) values ('premium', 'it.test.alfa/it/e0000000-0000-0000-0000-0000000000ee/explore.cccccccccccccccc.json');
      raise exception 'FALLITO: un visitatore scrive nel bucket premium';
    exception when insufficient_privilege then null; end;
    reset role;
    if ok then
      -- Chi ha pagato l'esplorazione (sopra) vede solo il file dell'esplorazione, non quello del percorso.
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000006', true);
      perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
      if (select array_agg(name order by name) from storage.objects where bucket_id = 'premium')
         is distinct from array['it.test.alfa/it/e0000000-0000-0000-0000-0000000000ee/explore.aaaaaaaaaaaaaaaa.json'] then
        raise exception 'FALLITO: con il diritto sull''esplorazione si vedono i file sbagliati';
      end if;
      reset role;
      perform revoke_purchase(current_setting('remote_check.ordine')::uuid, 'verifica remote-check');
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000006', true);
      perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000006","role":"authenticated"}', true);
      if exists (select 1 from storage.objects where bucket_id = 'premium') then raise exception 'FALLITO: dopo il rimborso il file resta leggibile'; end if;
      reset role;
    else
      nv := nv || 'lettura dei file a pagamento con diritto e dopo il rimborso: serve service_role (vedi sopra)'::text;
    end if;
    -- Singolo luogo (20261028000000): il diritto su un luogo apre solo il file di quel luogo, il rimborso lo richiude.
    if has_function_privilege('anon', 'has_place_right(text,uuid)', 'execute') then
      raise exception 'FALLITO: anon può eseguire has_place_right';
    end if;
    -- Sottoluoghi (20261101000000): la gerarchia la cambia solo chi modifica il territorio, mai un anonimo.
    if has_function_privilege('anon', 'studio_set_place_parent(text,text,text)', 'execute') then
      raise exception 'FALLITO: anon può eseguire studio_set_place_parent';
    end if;
    insert into storage.objects (bucket_id, name, owner) values
      ('premium', 'it.test.alfa/it/e0000000-0000-0000-0000-0000000000ee/place-luogo-a.cccccccccccccccc.json', null);
    insert into narrative_units (pack_id, slug, anchor_node_id, unit_type, locale, duration_s, text) values
      ('it.test.alfa', 'remote-check-luogo-a', 'b0000000-0000-0000-0000-00000000000a', 'opening', 'it', 20, 'Prova.');
    insert into products (id, slug, kind, pack_id, place_id, status) values
      ('e0000000-0000-0000-0000-0000000000f1', 'remote-check-luogo-a', 'place', 'it.test.alfa', 'b0000000-0000-0000-0000-00000000000a', 'active');
    insert into purchases (id, user_id, product_id, provider, provider_ref, status) values
      ('e0000000-0000-0000-0000-0000000000f2', 'a0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-0000000000f1',
       'verifica', 'verifica-remote-check-luogo', 'completed');
    perform grant_product('a0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-0000000000f1', 'purchase',
                          'e0000000-0000-0000-0000-0000000000f2', null);
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000007', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
    if (select array_agg(name order by name) from storage.objects where bucket_id = 'premium')
       is distinct from array['it.test.alfa/it/e0000000-0000-0000-0000-0000000000ee/place-luogo-a.cccccccccccccccc.json'] then
      raise exception 'FALLITO: con il diritto su un luogo si vedono i file sbagliati';
    end if;
    if can_access_explore('it.test.alfa') then raise exception 'FALLITO: il diritto su un luogo apre l''esplorazione'; end if;
    reset role;
    perform revoke_purchase('e0000000-0000-0000-0000-0000000000f2', 'verifica remote-check');
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000007', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000007","role":"authenticated"}', true);
    if exists (select 1 from storage.objects where bucket_id = 'premium') then raise exception 'FALLITO: dopo il rimborso il luogo resta leggibile'; end if;
    reset role;
    -- Un file a pagamento non entra nel bucket pubblico, nemmeno da chi pubblica.
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
    begin
      insert into storage.objects (bucket_id, name) values ('bundles', 'it.test.alfa/it/e0000000-0000-0000-0000-0000000000ee/explore.dddddddddddddddd.json');
      raise exception 'FALLITO: un file a pagamento entra nel bucket pubblico';
    exception when insufficient_privilege then null; end;
    reset role;

    -- ------------------------------------------------------------ eventi del giorno (20261031000000)
    -- Nessun accesso diretto per anon; lettura pubblica solo con public_local_events (definer, search_path fissato).
    if has_table_privilege('anon', 'local_events', 'select') or has_table_privilege('anon', 'local_events', 'insert') then
      raise exception 'FALLITO: anon ha privilegi sulla tabella degli eventi';
    end if;
    if not has_function_privilege('anon', 'public_local_events(text,date,date,text)', 'execute')
       or has_function_privilege('anon', 'studio_save_local_event(text,uuid,jsonb,boolean)', 'execute') then
      raise exception 'FALLITO: privilegi delle funzioni degli eventi';
    end if;
    if not (select prosecdef from pg_proc where oid = 'public_local_events(text,date,date,text)'::regprocedure)
       or (select proconfig from pg_proc where oid = 'public_local_events(text,date,date,text)'::regprocedure) is distinct from array['search_path=public'] then
      raise exception 'FALLITO: public_local_events deve girare come proprietario con search_path=public';
    end if;
    update destinations set status = 'published' where pack_id = 'it.test.alfa';
    insert into local_events (pack_id, slug, labels, category, start_date, start_time, venue_name, source_url,
                              verified_at, verified_by, publication, verification_note)
    values ('it.test.alfa', 'remote-check-bozza', '{"it":{"title":"Bozza"}}', 'culture', (now() at time zone 'Europe/Rome')::date + 1, '18:00',
            'Piazza', null, null, null, 'draft', null),
           ('it.test.alfa', 'remote-check-pubblicato', '{"it":{"title":"Pubblicato"}}', 'culture', (now() at time zone 'Europe/Rome')::date + 1, '20:00',
            'Piazza', 'https://example.org/evento', now(), 'a0000000-0000-0000-0000-000000000002', 'published', 'nota interna di verifica');
    set local role anon;
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    begin
      perform 1 from local_events limit 1;
      raise exception 'FALLITO: anon legge la tabella degli eventi';
    exception when insufficient_privilege then null; end;
    r := public_local_events('it.test.alfa');
    if (select array_agg(ev.value ->> 'slug') from jsonb_array_elements(r -> 'events') ev) is distinct from array['remote-check-pubblicato'] then
      raise exception 'FALLITO: eventi pubblici %', r -> 'events';
    end if;
    if r::text like '%nota interna di verifica%' or r::text like '%a0000000-0000-0000-0000-000000000002%' then
      raise exception 'FALLITO: dati interni degli eventi nella risposta pubblica';
    end if;
    begin
      perform public_local_events('it.test.alfa', (now() at time zone 'Europe/Rome')::date, (now() at time zone 'Europe/Rome')::date + 14);
      raise exception 'FALLITO: accettato un periodo di 15 giorni';
    exception when invalid_parameter_value then null; end;
    reset role;
    -- L'esperto del territorio è staff ma non legge le bozze degli eventi; il redattore le legge solo nel suo territorio.
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
    if exists (select 1 from local_events) then raise exception 'FALLITO: l''esperto legge gli eventi'; end if;
    reset role;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
    if (select count(*) from local_events where pack_id = 'it.test.alfa') <> 2 then raise exception 'FALLITO: il redattore non vede gli eventi del suo territorio'; end if;
    begin
      perform studio_set_local_event_publication((select id from local_events where slug = 'remote-check-bozza'), 'published');
      raise exception 'FALLITO: pubblicato un evento senza fonte';
    exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
    begin
      update local_events set publication = 'published' where slug = 'remote-check-bozza';
      raise exception 'FALLITO: evento pubblicato con un UPDATE diretto';
    exception when insufficient_privilege then null; end;
    begin
      perform studio_save_local_event('it.test.beta', null, '{"slug":"intruso","category":"culture","startDate":"2030-01-01","labels":{"it":{"title":"I"}},"venueName":"P"}');
      raise exception 'FALLITO: il redattore crea eventi in un altro territorio';
    exception when insufficient_privilege then null; end;
    reset role;

    -- Verifica dell'autore solo per l'amministratore (20261104000000_admin_self_verify.sql).
    if not exists (select 1 from information_schema.columns where table_name = 'assertions' and column_name = 'self_verified')
       or not exists (select 1 from pg_constraint where conrelid = 'assertions'::regclass and conname = 'assertions_four_eyes')
       or not exists (select 1 from pg_constraint where conrelid = 'assertions'::regclass and conname = 'assertions_self_verified_consistent')
       or pg_get_functiondef('studio_review_assertion(text, text, text, text)'::regprocedure) not like '%not is_platform_admin()%'
       or pg_get_functiondef('editorial_assertion_guard()'::regprocedure) not like '%self_verified%' then
      raise exception 'FALLITO: manca la migrazione 20261104000000_admin_self_verify.sql (verifica dell''autore)';
    end if;

    -- Directory delle attività locali (20261105000000_local_businesses.sql).
    if to_regclass('public.local_businesses') is null
       or not has_function_privilege('anon', 'public_local_businesses(text, text)', 'execute')
       or has_table_privilege('anon', 'local_businesses', 'select')
       or has_function_privilege('anon', 'studio_save_local_business(text, uuid, jsonb, boolean)', 'execute')
       or not exists (select 1 from pg_constraint where conrelid = 'local_businesses'::regclass and contype = 'c'
                      and pg_get_constraintdef(oid) like '%published%verified_at%') then
      raise exception 'FALLITO: manca la migrazione 20261105000000_local_businesses.sql (attività locali) o i suoi permessi';
    end if;

    -- Tutto superato: si annullano i dati di prova uscendo con un errore intercettato qui sotto, che porta fuori
    -- l'elenco dei controlli non verificati.
    raise exception 'VERIFICA_SUPERATA|%', array_to_string(nv, '; ');
  exception when raise_exception then
    if sqlerrm not like 'VERIFICA_SUPERATA|%' then raise; end if;
    perform set_config('remote_check.non_verificati', coalesce(nullif(substr(sqlerrm, length('VERIFICA_SUPERATA|') + 1), ''), 'nessuno'), false);
  end;
end
$$;

-- Arriva qui solo se nessun controllo è FALLITO (i dati di prova sono già stati annullati). «superato» solo se
-- tutti i controlli sono stati eseguiti; con controlli non verificati l'esito è «incompleto».
select case current_setting('remote_check.non_verificati', true) when 'nessuno' then 'superato' else 'incompleto' end as esito,
       (select count(*) from organizations where id = '00000000-0000-0000-0000-0000000000aa') as dati_di_prova_rimasti,
       (select count(*) from memberships where role = 'platform_admin') as amministratori,
       current_setting('remote_check.non_verificati', true) as non_verificati;
