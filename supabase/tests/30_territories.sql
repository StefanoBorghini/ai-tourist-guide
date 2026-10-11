-- Test della gestione dei territori dallo Studio. Usa i pack importati da roundtrip.ts; Portovenere
-- non deve cambiare in nessun modo (impronta di pack_snapshot prima e dopo).
\set ON_ERROR_STOP 1

create temp table impronta as select md5(pack_snapshot('it.liguria.sp.portovenere')::text) as prima;
grant select on impronta to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('f0000000-0000-0000-0000-000000000001', 'editor-test@prova.test', '{}'),
  ('f0000000-0000-0000-0000-000000000002', 'esperto-test@prova.test', '{}'),
  ('f0000000-0000-0000-0000-000000000003', 'editor-borgo-stretto@prova.test', '{}'),
  ('f0000000-0000-0000-0000-000000000004', 'visitatore-territori@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope)
select u, (select organization_id from packs where id = 'it.test'), r::member_role, p
from (values
  ('f0000000-0000-0000-0000-000000000001'::uuid, 'territory_editor', 'it.test'),
  ('f0000000-0000-0000-0000-000000000002'::uuid, 'expert', 'it.test'),
  ('f0000000-0000-0000-0000-000000000003'::uuid, 'territory_editor', 'it.test.borgo-di-prova')) v(u, r, p);

-- ---------------------------------------------------------------- chi non può creare
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000004';
do $$ begin
  begin
    perform studio_create_pack('{"id": "it.test.visitatore", "title": {"it": "X"}}');
    raise exception 'FALLITO: un visitatore non crea territori';
  exception when insufficient_privilege then null; end;
  if pack_snapshot('it.test') is not null then raise exception 'FALLITO: un visitatore non rilegge i territori'; end if;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000002';
do $$ begin
  begin
    perform studio_create_pack('{"id": "it.test.esperto", "title": {"it": "X"}}');
    raise exception 'FALLITO: un esperto non crea territori';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000003';
do $$ begin
  begin
    perform studio_create_pack('{"id": "it.test.fratello", "title": {"it": "X"}}');
    raise exception 'FALLITO: un editor con ambito ristretto non crea fuori dal proprio ambito';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- editor dell'area it.test
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000001';
do $$
declare k jsonb; a jsonb;
begin
  begin
    perform studio_create_pack('{"id": "it.altrove", "title": {"it": "Altrove"}}');
    raise exception 'FALLITO: nessun territorio fuori dall''ambito';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_create_pack('{"id": "it.test.Maiuscolo", "title": {"it": "X"}}');
    raise exception 'FALLITO: identificativo non valido';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_create_pack('{"id": "it.test.senza-nome", "title": {"en": "Only English"}, "defaultLocale": "it"}');
    raise exception 'FALLITO: nome nella lingua principale obbligatorio';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_create_pack('{"id": "it.test.legato", "title": {"it": "X"}, "dependsOn": ["it.liguria"]}');
    raise exception 'FALLITO: nessuna dipendenza da territori non leggibili';
  exception when insufficient_privilege then null; end;

  k := studio_create_pack('{"id": "it.test.nuovo-borgo", "kind": "destination", "title": {"it": "Nuovo borgo", "en": "New village"},
                            "description": {"it": "Un borgo di prova creato dallo Studio."}, "defaultLocale": "it",
                            "locales": ["it", "en"], "dependsOn": ["it.test"]}');
  if k ->> 'status' <> 'draft' or k -> 'dependsOn' <> '["it.test"]' or k #>> '{organization,id}' is null then
    raise exception 'FALLITO: destinazione creata in bozza, con dipendenza e organizzazione: %', k;
  end if;
  begin
    perform studio_create_pack('{"id": "it.test.nuovo-borgo", "title": {"it": "Doppione"}}');
    raise exception 'FALLITO: identificativo già usato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;

  -- Dipendenze: niente cicli. Identificativo e tipologia non cambiano.
  begin
    perform studio_update_pack('it.test', '{"dependsOn": ["it.test.nuovo-borgo"]}');
    raise exception 'FALLITO: dipendenza circolare';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_update_pack('it.test.nuovo-borgo', '{"kind": "region"}');
    raise exception 'FALLITO: la tipologia non cambia';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  k := studio_update_pack('it.test.nuovo-borgo', '{"title": {"it": "Borgo nuovo", "en": "New village"}, "description": {"it": "Descrizione aggiornata."}}');
  if k #>> '{title,it}' <> 'Borgo nuovo' then raise exception 'FALLITO: metadati aggiornati'; end if;

  -- Stati: niente salti, niente pubblicazione di un territorio vuoto.
  begin
    perform studio_set_pack_status('it.test.nuovo-borgo', 'published', '{"ok": true}');
    raise exception 'FALLITO: dalla bozza non si pubblica';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  k := studio_set_pack_status('it.test.nuovo-borgo', 'in_review');
  begin
    perform studio_set_pack_status('it.test.nuovo-borgo', 'published', '{"ok": true}');
    raise exception 'FALLITO: un territorio vuoto non si pubblica';
  exception when raise_exception then if sqlerrm not like 'non si può pubblicare%' then raise; end if; end;
  begin
    perform studio_set_pack_status('it.test', 'in_review');
    raise exception 'FALLITO: una regione o area non ha stato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;

  -- Contenuti dal CMS: luogo, fonte, affermazione con prova, racconto, percorso.
  perform studio_create_place('it.test.nuovo-borgo', '{"name": {"it": "Piazza della Fontana", "en": "Fountain Square"},
           "location": [9.9, 44.1], "coordinateMethod": "rilievo GPS sul posto, ±5 m", "categories": ["Piazza"], "importance": 4}');
  begin
    perform studio_create_place('it.test.nuovo-borgo', '{"name": {"it": "Senza metodo"}, "location": [9.9, 44.1]}');
    raise exception 'FALLITO: coordinate senza metodo';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  perform studio_create_source('it.test.nuovo-borgo', '{"title": "Archivio comunale di prova", "sourceKind": "archive_document", "reliability": "A"}');
  a := studio_create_assertion('it.test.nuovo-borgo', '{"subject": "piazza-della-fontana", "type": "fact", "certainty": "established",
         "texts": {"it": "La fontana della piazza è del 1890.", "en": "The square''s fountain dates from 1890."},
         "evidence": [{"source": "archivio-comunale-di-prova", "locator": "registro 12, p. 4"}], "submit": true}');
  if a ->> 'status' <> 'in_review' or a ->> 'authoredBy' <> 'f0000000-0000-0000-0000-000000000001' then
    raise exception 'FALLITO: affermazione in revisione con l''autore reale: %', a;
  end if;
  begin
    perform studio_create_unit('it.test.nuovo-borgo', '{"anchor": "piazza-della-fontana", "text": "Testo senza fatti.", "assertions": []}');
    raise exception 'FALLITO: un racconto senza affermazioni';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  perform studio_create_unit('it.test.nuovo-borgo', jsonb_build_object('anchor', 'piazza-della-fontana', 'unitType', 'opening', 'locale', 'it',
           'durationS', 20, 'text', 'Siete in piazza: la fontana risale al 1890.', 'assertions', jsonb_build_array(a ->> 'slug')));
  perform studio_create_route('it.test.nuovo-borgo', '{"name": {"it": "Giro della piazza"}, "durationMin": 15, "stops": [{"place": "piazza-della-fontana", "dwellMin": 5}]}');
  if jsonb_array_length(studio_units('it.test.nuovo-borgo')) <> 1 or jsonb_array_length(studio_sources('it.test.nuovo-borgo')) <> 1 then
    raise exception 'FALLITO: racconto e fonte elencati';
  end if;
  if pack_snapshot('it.test.nuovo-borgo') -> 'places' -> 0 ->> 'id' <> 'piazza-della-fontana' then
    raise exception 'FALLITO: il nuovo territorio si rilegge nel formato dei pack';
  end if;

  -- Pubblicazione: solo con un controllo superato; registra la richiesta.
  begin
    perform studio_set_pack_status('it.test.nuovo-borgo', 'published', '{"ok": false}');
    raise exception 'FALLITO: senza controllo superato non si pubblica';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  k := studio_set_pack_status('it.test.nuovo-borgo', 'published', '{"ok": true, "errors": []}');
  if k ->> 'status' <> 'published' or jsonb_array_length(k -> 'publications') <> 1 then
    raise exception 'FALLITO: pubblicazione approvata e richiesta registrata: %', k;
  end if;
  k := studio_set_pack_status('it.test.nuovo-borgo', 'in_review');
  if k ->> 'status' <> 'in_review' then raise exception 'FALLITO: ritiro della pubblicazione'; end if;

  -- Copertina: un'immagine del territorio.
  insert into storage.objects (bucket_id, name, owner) values ('media', 'it.test.nuovo-borgo/fontana.jpg', auth.uid());
  perform studio_register_media('it.test.nuovo-borgo', '{"file": "fontana.jpg", "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
           "mimeType": "image/jpeg", "bytes": 1000, "alt": {"it": "La fontana"}, "author": "Redazione", "license": "own",
           "source": "own_photo", "subjects": ["piazza-della-fontana"]}');
  k := studio_update_pack('it.test.nuovo-borgo', '{"cover": "fontana"}');
  if k ->> 'cover' <> 'fontana' or (pack_snapshot('it.test.nuovo-borgo') -> 'media' -> 0 ->> 'cover')::boolean is not true then
    raise exception 'FALLITO: copertina scelta e presente nel formato dei pack';
  end if;
end $$;
reset role;

-- L'organizzazione e i permessi del nuovo territorio seguono quelli dell'area.
do $$ begin
  if (select organization_id from packs where id = 'it.test.nuovo-borgo') <> (select organization_id from packs where id = 'it.test') then
    raise exception 'FALLITO: organizzazione ereditata dall''ambito';
  end if;
  if (select count(*) from publications where pack_id = 'it.test.nuovo-borgo' and status = 'requested') <> 1 then
    raise exception 'FALLITO: una richiesta di pubblicazione';
  end if;
  if (select prima from impronta) <> md5(pack_snapshot('it.liguria.sp.portovenere')::text) then
    raise exception 'FALLITO: Portovenere è cambiato';
  end if;
end $$;

-- L'editor con ambito ristretto non vede il nuovo territorio; l'esperto dell'area sì, ma non lo modifica.
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000003';
do $$ begin
  if studio_pack('it.test.nuovo-borgo') is not null then raise exception 'FALLITO: territorio fuori ambito invisibile'; end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000002';
do $$ begin
  if studio_pack('it.test.nuovo-borgo') is null then raise exception 'FALLITO: l''esperto dell''area vede il territorio'; end if;
  begin
    perform studio_update_pack('it.test.nuovo-borgo', '{"title": {"it": "Intruso"}}');
    raise exception 'FALLITO: l''esperto non modifica i metadati';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'territori: tutti i controlli superati' as esito;
