-- Test della pubblicazione: chi chiude una pubblicazione, bundle registrati, indice pubblico, fallimento
-- che non tocca la versione in linea, ritiro. Usa it.test.alfa (da 10_platform_security.sql: approvata, con
-- una richiesta aperta) e gli utenti di 10 e 30.
\set ON_ERROR_STOP 1

-- Situazione di partenza (come amministratore del database): alfa approvata con una richiesta aperta.
update destinations set status = 'published' where pack_id = 'it.test.alfa';
insert into publications (pack_id, requested_by, status) values ('it.test.alfa', 'a0000000-0000-0000-0000-000000000002', 'requested');

create temp table impronta_50 as select md5(pack_snapshot('it.liguria.sp.portovenere')::text) as prima;

-- Anonimo: niente funzioni di pubblicazione (l'indice pubblico lo legge dal file nel bucket).
set role anon;
do $$ begin
  begin
    perform public_bundle_index();
    raise exception 'FALLITO: un anonimo chiama le funzioni di pubblicazione';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Editor di un altro territorio: non chiude la pubblicazione di alfa e non ne scrive i file.
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000003';
do $$ begin
  begin
    perform studio_publication_finish('it.test.alfa', true, '{}', '[]');
    raise exception 'FALLITO: pubblicazione chiusa da chi non pubblica il territorio';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'it.test.alfa/it-full/media/0123456789abcdef.jpg', auth.uid());
    raise exception 'FALLITO: file di un altro territorio';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Visitatore: non scrive l'indice.
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000004';
do $$ begin
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'index.json', auth.uid());
    raise exception 'FALLITO: un visitatore scrive l''indice';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Editor di alfa: prende in carico la pubblicazione e la chiude per identificativo (R2: manifest e contenuti nella
-- cartella della pubblicazione, <lingua>-full/<id>/; nessun index.json da scrivere, l'indice è numerato).
create temp table pub_50 (id uuid);
grant select, insert on pub_50 to authenticated;
set role authenticated;
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
do $$
declare v jsonb; b jsonb; p uuid;
begin
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'index.json', auth.uid());
    raise exception 'FALLITO: index.json della struttura precedente riscritto';
  exception when insufficient_privilege then null; end;
  p := (studio_publication_claim('it.test.alfa') ->> 'publication')::uuid;
  if p is null then raise exception 'FALLITO: presa in carico'; end if;
  insert into pub_50 values (p);
  b := jsonb_build_array(
    jsonb_build_object('locale', 'it', 'url', '/pub/it.test.alfa/it-full/' || p || '/manifest.json',
      'manifest', jsonb_build_object('bundleSchemaVersion', 1, 'minAppVersion', '0.1.0', 'destination', 'it.test.alfa', 'kbHash', 'k1', 'totalBytes', 100,
                                     'content', p || '/content.0000000000000001.json'),
      'entry', jsonb_build_object('destination', 'it.test.alfa', 'name', 'Alfa', 'locale', 'it', 'manifest', '/pub/it.test.alfa/it-full/' || p || '/manifest.json')),
    jsonb_build_object('locale', 'en', 'url', '/pub/it.test.alfa/en-full/' || p || '/manifest.json',
      'manifest', jsonb_build_object('bundleSchemaVersion', 1, 'minAppVersion', '0.1.0', 'destination', 'it.test.alfa', 'kbHash', 'k2', 'totalBytes', 90,
                                     'content', p || '/content.0000000000000002.json'),
      'entry', jsonb_build_object('destination', 'it.test.alfa', 'name', 'Alfa', 'locale', 'en', 'manifest', '/pub/it.test.alfa/en-full/' || p || '/manifest.json')));
  -- Un bundle con l'indirizzo di un altro territorio è rifiutato.
  begin
    perform studio_publication_finish('it.test.alfa', true, '{}',
      jsonb_set(b, '{0,url}', '"/pub/it.test.beta/it-full/manifest.json"'), p);
    raise exception 'FALLITO: accettato un bundle fuori dalla cartella';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- La forma senza identificativo non mette in linea nulla.
  begin
    perform studio_publication_finish('it.test.alfa', true, '{"ms": 1200}', b);
    raise exception 'FALLITO: pubblicazione in linea senza presa in carico';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  v := studio_publication_finish('it.test.alfa', true, '{"ms": 1200}', b, p);
  if v ->> 'status' <> 'published' or jsonb_array_length(v -> 'bundles') <> 2 then raise exception 'FALLITO: esito %', v; end if;
end $$;
reset role;

do $$
declare p text := (select id::text from pub_50);
begin
  if (select count(*) from bundles where pack_id = 'it.test.alfa' and version = 1) <> 2 then
    raise exception 'FALLITO: bundle non registrati';
  end if;
  if public_bundle_index() -> 'bundles' <> jsonb_build_array(
       jsonb_build_object('destination', 'it.test.alfa', 'name', 'Alfa', 'locale', 'en', 'manifest', '/pub/it.test.alfa/en-full/' || p || '/manifest.json'),
       jsonb_build_object('destination', 'it.test.alfa', 'name', 'Alfa', 'locale', 'it', 'manifest', '/pub/it.test.alfa/it-full/' || p || '/manifest.json')) then
    raise exception 'FALLITO: indice %', public_bundle_index();
  end if;
  -- Gli altri territori (anche approvati) non ci sono finché non hanno una pubblicazione riuscita.
  if public_bundle_index()::text like '%nuovo-borgo%' then raise exception 'FALLITO: territorio senza bundle nell''indice'; end if;
end $$;

-- Ripubblicazione: serve un territorio senza blocchi (alfa non ha contenuti) e un controllo superato.
set role authenticated;
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
do $$ begin
  begin
    perform studio_request_publication('it.test.alfa', '{"ok": true}');
    raise exception 'FALLITO: ripubblicazione di un territorio con blocchi';
  exception when raise_exception then
    if sqlerrm not like '%non si può pubblicare%' then raise; end if;
  end;
end $$;
reset role;

-- Ripubblicazione fallita: la versione in linea resta.
insert into publications (pack_id, requested_by, status) values ('it.test.alfa', 'a0000000-0000-0000-0000-000000000002', 'requested');
set role authenticated;
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
do $$ begin
  perform studio_publication_finish('it.test.alfa', false, '{"error": "caricamento interrotto"}');
end $$;
reset role;
do $$ begin
  if (select status from publications where pack_id = 'it.test.alfa' order by created_at desc limit 1) <> 'failed' then
    raise exception 'FALLITO: pubblicazione fallita non registrata';
  end if;
  if jsonb_array_length(public_bundle_index() -> 'bundles') <> 2 then
    raise exception 'FALLITO: un fallimento ha tolto la versione in linea';
  end if;
end $$;

-- Ritiro: il territorio esce dall'indice.
update destinations set status = 'in_review' where pack_id = 'it.test.alfa';
do $$ begin
  if jsonb_array_length(public_bundle_index() -> 'bundles') <> 0 then raise exception 'FALLITO: territorio ritirato nell''indice'; end if;
  if md5(pack_snapshot('it.liguria.sp.portovenere')::text) <> (select prima from impronta_50) then
    raise exception 'FALLITO: Portovenere è cambiato';
  end if;
end $$;
update destinations set status = 'published' where pack_id = 'it.test.alfa';

select 'pubblicazione: tutti i controlli superati';
