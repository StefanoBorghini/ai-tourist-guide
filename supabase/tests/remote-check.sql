-- Verifica delle migrazioni e delle regole di sicurezza su un progetto Supabase reale.
-- Si incolla tutto nel SQL Editor del progetto e si esegue una volta (Run).
--
-- Crea dati di prova (territori, utenti, contenuti), prova ogni ruolo e alla fine ANNULLA tutto:
-- nel database non resta nulla, nemmeno se un controllo fallisce.
-- Esito: una tabella con «superato»; se qualcosa non va, un errore che inizia con «FALLITO».
-- Gli stessi controlli girano in locale con `npm run db:check` (10_platform_security.sql).
do $$
declare
  a uuid;
  p uuid;
  d jsonb;
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
      insert into products (slug, kind, route_id, status) values ('furbo', 'route_access', 'c0000000-0000-0000-0000-00000000000b', 'active');
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
    update places set location = 'SRID=4326;POINT(9.8301 44.0501)' where node_id = 'b0000000-0000-0000-0000-00000000000a';
    if not found then raise exception 'FALLITO: l''editor corregge le coordinate del proprio territorio'; end if;

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

    insert into media_assets (pack_id, slug, kind, storage_path, sha256, source, author, license, mime_type, bytes)
    values ('it.test.alfa', 'foto-1', 'image', 'it.test.alfa/foto-1.jpg', 'x', 'own_photo', 'Redazione', 'own', 'image/jpeg', 200000);
    begin
      insert into media_assets (pack_id, slug, kind, storage_path, sha256, source, author, license, mime_type, bytes)
      values ('it.test.alfa', 'enorme', 'image', 'it.test.alfa/enorme.jpg', 'x', 'own_photo', 'Redazione', 'own', 'image/jpeg', 99000000);
      raise exception 'FALLITO: immagini oltre il limite di dimensione rifiutate';
    exception when check_violation then null; end;
    begin
      insert into media_assets (pack_id, slug, kind, storage_path, sha256, source, author, license, mime_type, bytes)
      values ('it.test.alfa', 'formato', 'audio', 'it.test.alfa/x.exe', 'x', 'own_photo', 'Redazione', 'own', 'application/x-msdownload', 100);
      raise exception 'FALLITO: formati non ammessi rifiutati';
    exception when check_violation then null; end;
    insert into storage.objects (bucket_id, name, owner) values ('media', 'it.test.alfa/foto-1.jpg', 'a0000000-0000-0000-0000-000000000002');
    begin
      insert into storage.objects (bucket_id, name, owner) values ('media', 'it.test.beta/intruso.jpg', 'a0000000-0000-0000-0000-000000000002');
      raise exception 'FALLITO: un editor non carica file in un altro territorio';
    exception when insufficient_privilege then null; end;
    -- Bundle: chi pubblica un territorio ne scrive i file, non quelli di altri (20261020000000_publication.sql).
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'it.test.alfa/it-full/manifest.json', 'a0000000-0000-0000-0000-000000000002');
    begin
      insert into storage.objects (bucket_id, name, owner) values ('bundles', 'it.test.beta/it-full/manifest.json', 'a0000000-0000-0000-0000-000000000002');
      raise exception 'FALLITO: un editor non scrive i bundle di un altro territorio';
    exception when insufficient_privilege then null; end;

    update destinations set status = 'published' where pack_id = 'it.test.alfa';
    if not found then raise exception 'FALLITO: l''editor pubblica il proprio territorio'; end if;
    insert into publications (pack_id, requested_by) values ('it.test.alfa', 'a0000000-0000-0000-0000-000000000002');
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
    insert into products (slug, kind, route_id, status) values ('giro-premium', 'route_access', 'c0000000-0000-0000-0000-00000000000b', 'active') returning id into p;
    insert into entitlements (user_id, product_id, source, note) values ('a0000000-0000-0000-0000-000000000004', p, 'grant', 'prova');
    reset role;

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000004', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
    if can_access_route('c0000000-0000-0000-0000-00000000000b') is not true then raise exception 'FALLITO: diritto di accesso riconosciuto'; end if;
    update entitlements set valid_until = now() + interval '1 year';
    if found then raise exception 'FALLITO: un turista non modifica i propri diritti'; end if;
    reset role;

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
    perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-000000000005","role":"authenticated"}', true);
    if can_access_route('c0000000-0000-0000-0000-00000000000b') then raise exception 'FALLITO: il diritto di un utente non vale per un altro'; end if;
    reset role;

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

    -- Tutto superato: si annullano i dati di prova uscendo con un errore intercettato qui sotto.
    raise exception 'VERIFICA_SUPERATA';
  exception when raise_exception then
    if sqlerrm <> 'VERIFICA_SUPERATA' then raise; end if;
  end;
end
$$;

-- Arriva qui solo se tutti i controlli sono passati (i dati di prova sono già stati annullati).
select 'superato' as esito,
       (select count(*) from organizations where id = '00000000-0000-0000-0000-0000000000aa') as dati_di_prova_rimasti,
       (select count(*) from memberships where role = 'platform_admin') as amministratori;
