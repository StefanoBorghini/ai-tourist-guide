-- Test delle funzioni dello Studio (milestone 4), sul territorio sintetico importato da roundtrip.ts.
-- Ogni blocco agisce come un utente diverso; fallisce con «FALLITO» se una regola non è rispettata.
\set ON_ERROR_STOP 1

insert into auth.users (id, email, raw_user_meta_data) values
  ('d0000000-0000-0000-0000-000000000001', 'editor-borgo@prova.test', '{}'),
  ('d0000000-0000-0000-0000-000000000002', 'esperto-borgo@prova.test', '{}'),
  ('d0000000-0000-0000-0000-000000000003', 'editor-altrove@prova.test', '{}'),
  ('d0000000-0000-0000-0000-000000000004', 'visitatore@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope)
select u, (select organization_id from packs where id = 'it.test.borgo-di-prova'), r::member_role, p
from (values
  ('d0000000-0000-0000-0000-000000000001'::uuid, 'territory_editor', 'it.test.borgo-di-prova'),
  ('d0000000-0000-0000-0000-000000000002'::uuid, 'expert', 'it.test.borgo-di-prova'),
  ('d0000000-0000-0000-0000-000000000003'::uuid, 'territory_editor', 'it.test.alfa')) v(u, r, p);

do $$ begin
  if (select allowed_mime_types from storage.buckets where id = 'media') is null
     or (select file_size_limit from storage.buckets where id = 'media') <> 50 * 1024 * 1024 then
    raise exception 'FALLITO: limiti di formato e dimensione sul bucket media';
  end if;
end $$;

-- ---------------------------------------------------------------- anonimo e visitatore: niente Studio
set role anon;
set request.jwt.claim.sub = '';
do $$ begin
  begin
    perform studio_packs();
    raise exception 'FALLITO: un anonimo non usa le funzioni dello Studio';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-0000-0000-000000000004';
do $$ begin
  if jsonb_array_length(studio_packs()) <> 0 then raise exception 'FALLITO: un visitatore non vede territori nello Studio'; end if;
  if jsonb_array_length(studio_places('it.test.borgo-di-prova')) <> 0 then raise exception 'FALLITO: un visitatore non vede i luoghi'; end if;
  if (studio_me() ->> 'admin')::boolean or jsonb_array_length(studio_me() -> 'roles') <> 0 then
    raise exception 'FALLITO: un visitatore non ha ruoli';
  end if;
  begin
    perform studio_update_place('it.test.borgo-di-prova', 'belvedere', '{"importance": 5}');
    raise exception 'FALLITO: un visitatore non modifica un luogo';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- editor del borgo
set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-0000-0000-000000000001';
do $$
declare p jsonb; r jsonb;
begin
  if not exists (select 1 from jsonb_array_elements(studio_packs()) x where x ->> 'id' = 'it.test.borgo-di-prova' and (x ->> 'canEdit')::boolean) then
    raise exception 'FALLITO: l''editor vede e può modificare il proprio territorio';
  end if;
  if exists (select 1 from jsonb_array_elements(studio_packs()) x where x ->> 'id' = 'it.test.alfa') then
    raise exception 'FALLITO: l''editor non vede altri territori';
  end if;
  if jsonb_array_length(studio_places('it.test.borgo-di-prova')) <> 5 then raise exception 'FALLITO: elenco dei luoghi'; end if;

  -- Luogo: nome, importanza, note; coordinate solo con il metodo dichiarato, e tornano preliminari.
  p := studio_update_place('it.test.borgo-di-prova', 'belvedere',
         '{"labels": {"it": {"name": "Belvedere alto", "short": "Vista sul borgo"}}, "importance": 4, "fieldNotes": ["ringhiera bassa", " "]}');
  if p #>> '{labels,it,name}' <> 'Belvedere alto' or (p ->> 'importance')::int <> 4 or jsonb_array_length(p -> 'fieldNotes') <> 1 then
    raise exception 'FALLITO: modifica di nome, importanza e note';
  end if;
  begin
    perform studio_update_place('it.test.borgo-di-prova', 'belvedere', '{"location": [9.5, 44.5]}');
    raise exception 'FALLITO: coordinate cambiate senza metodo';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  p := studio_update_place('it.test.borgo-di-prova', 'belvedere', '{"location": [9.5, 44.5], "coordinateMethod": "rilievo GPS sul posto, ±4 m"}');
  if p #>> '{coordinates,status}' <> 'preliminary' or p #> '{coordinates,previousLocation}' is null then
    raise exception 'FALLITO: coordinate nuove preliminari, con quelle precedenti conservate';
  end if;
  begin
    perform studio_update_place('it.test.borgo-di-prova', 'belvedere', '{"importance": 9}');
    raise exception 'FALLITO: importanza fuori scala';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;

  -- Percorso: riordino e rimozione di una tappa; i doppioni e i luoghi sconosciuti si rifiutano.
  r := studio_set_route_stops('it.test.borgo-di-prova', 'giro-breve',
         '[{"place": "torre-di-prova", "dwellMin": 12}, {"place": "it.test.borgo-di-prova:porta-del-borgo"}, {"place": "chiesa-di-san-test", "optional": true}]');
  if jsonb_array_length(r -> 'stops') <> 3 or r #>> '{stops,0,place}' <> 'it.test.borgo-di-prova:torre-di-prova'
     or (r #>> '{stops,0,dwellMin}')::int <> 12 or not (r #>> '{stops,2,optional}')::boolean then
    raise exception 'FALLITO: riordino delle tappe';
  end if;
  begin
    perform studio_set_route_stops('it.test.borgo-di-prova', 'giro-breve', '[{"place": "belvedere"}, {"place": "belvedere"}]');
    raise exception 'FALLITO: tappa doppia';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  begin
    perform studio_set_route_stops('it.test.borgo-di-prova', 'giro-breve', '[{"place": "it.test.alfa:luogo-a"}]');
    raise exception 'FALLITO: tappa in un territorio estraneo';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  begin
    perform studio_set_route_stops('it.test.borgo-di-prova', 'giro-breve', '[]');
    raise exception 'FALLITO: percorso senza tappe';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;

  -- Revisione: l'editor ritira una verifica (con motivo) ma non verifica né respinge.
  perform studio_review_assertion('it.test.borgo-di-prova', 'porta-larghezza', 'reopen', 'misura da ricontrollare');
  begin
    perform studio_review_assertion('it.test.borgo-di-prova', 'porta-larghezza', 'verify');
    raise exception 'FALLITO: un editor non verifica';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_review_assertion('it.test.borgo-di-prova', 'porta-larghezza', 'reject', 'no');
    raise exception 'FALLITO: un editor non respinge';
  exception when insufficient_privilege then null; end;
  perform studio_review_assertion('it.test.borgo-di-prova', 'torre-scalini', 'submit');
end $$;
reset role;

-- Un editor di un altro territorio non tocca il borgo.
set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-0000-0000-000000000003';
do $$ begin
  begin
    perform studio_update_place('it.test.borgo-di-prova', 'belvedere', '{"importance": 1}');
    raise exception 'FALLITO: editor di un altro territorio';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_set_route_stops('it.test.borgo-di-prova', 'giro-breve', '[{"place": "belvedere"}]');
    raise exception 'FALLITO: percorsi di un altro territorio';
  exception when insufficient_privilege then null; end;
  if studio_place('it.test.borgo-di-prova', 'belvedere') is not null then raise exception 'FALLITO: luoghi di un altro territorio'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- esperto del borgo
set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-0000-0000-000000000002';
do $$
declare a jsonb; v uuid;
begin
  begin
    perform studio_update_place('it.test.borgo-di-prova', 'belvedere', '{"importance": 1}');
    raise exception 'FALLITO: un esperto non modifica i luoghi';
  exception when insufficient_privilege then null; end;

  a := studio_review_assertion('it.test.borgo-di-prova', 'porta-larghezza', 'verify', 'misura confermata');
  if a ->> 'status' <> 'verified' or a ->> 'verifiedBy' <> 'd0000000-0000-0000-0000-000000000002' then
    raise exception 'FALLITO: verifica registrata con il verificatore reale';
  end if;
  -- Senza fonti non si verifica; senza motivo non si respinge.
  begin
    perform studio_review_assertion('it.test.borgo-di-prova', 'torre-scalini', 'verify');
    raise exception 'FALLITO: verifica senza fonti';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  begin
    perform studio_review_assertion('it.test.borgo-di-prova', 'torre-scalini', 'reject');
    raise exception 'FALLITO: rifiuto senza motivo';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  a := studio_review_assertion('it.test.borgo-di-prova', 'torre-scalini', 'reject', 'manca la fonte del numero di gradini');
  if a ->> 'status' <> 'rejected' or a ->> 'reviewNote' is null then raise exception 'FALLITO: rifiuto con motivo'; end if;

  -- Quattro occhi: l'esperto scrive un'affermazione e non può verificarla lui.
  insert into assertions (pack_id, slug, subject_id, predicate_id, type, certainty, status, authored_by)
  values ('it.test.borgo-di-prova', 'nota-esperto', (select id from nodes where pack_id = 'it.test.borgo-di-prova' and slug = 'belvedere'),
          'described_as', 'fact', 'established', 'in_review', 'x')
  returning id into v;
  insert into assertion_texts (assertion_id, locale, statement) values (v, 'it', 'Dal belvedere si vedono tre campanili.');
  insert into evidence (assertion_id, source_id, attribution)
  values (v, (select id from sources where pack_id = 'it.test.borgo-di-prova' order by slug limit 1), 'explicit');
  begin
    perform studio_review_assertion('it.test.borgo-di-prova', 'nota-esperto', 'verify');
    raise exception 'FALLITO: l''autore non verifica la propria affermazione';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Le fonti solo dedotte non bastano per verificare.
do $$ begin
  update evidence set attribution = 'inferred'
  where assertion_id = (select id from assertions where pack_id = 'it.test.borgo-di-prova' and slug = 'nota-esperto');
  update assertions set authored_by = 'qualcun-altro' where pack_id = 'it.test.borgo-di-prova' and slug = 'nota-esperto';
end $$;
set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-0000-0000-000000000002';
do $$ begin
  begin
    perform studio_review_assertion('it.test.borgo-di-prova', 'nota-esperto', 'verify');
    raise exception 'FALLITO: verifica con sole fonti dedotte';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
end $$;
reset role;

-- Conferma della fonte: solo chi verifica, con il punto della fonte; poi la verifica è possibile.
set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-0000-0000-000000000001';
do $$ begin
  begin
    perform studio_confirm_evidence('it.test.borgo-di-prova', 'nota-esperto', 0, 'p. 12');
    raise exception 'FALLITO: un editor non conferma le fonti';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-0000-0000-000000000002';
do $$
declare a jsonb;
begin
  begin
    perform studio_confirm_evidence('it.test.borgo-di-prova', 'nota-esperto', 0, ' ');
    raise exception 'FALLITO: conferma senza indicare il punto della fonte';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  a := studio_confirm_evidence('it.test.borgo-di-prova', 'nota-esperto', 0, 'p. 12, secondo capoverso');
  if a #>> '{evidence,0,attribution}' <> 'explicit' or a #>> '{evidence,0,locator}' <> 'p. 12, secondo capoverso' then
    raise exception 'FALLITO: fonte confermata con il punto indicato';
  end if;
  a := studio_review_assertion('it.test.borgo-di-prova', 'nota-esperto', 'verify');
  if a ->> 'status' <> 'verified' then raise exception 'FALLITO: verifica dopo la conferma della fonte'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- media
set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-0000-0000-000000000001';
do $$
declare m jsonb;
  img jsonb := '{"file": "vista-dal-belvedere.jpg", "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
                 "mimeType": "image/jpeg", "bytes": 120000, "alt": {"it": "Il borgo visto dal belvedere"},
                 "author": "Redazione", "license": "own", "source": "own_photo", "subjects": ["belvedere"]}';
begin
  begin
    perform studio_register_media('it.test.borgo-di-prova', img);
    raise exception 'FALLITO: si registra solo un file già caricato';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  insert into storage.objects (bucket_id, name, owner) values ('media', 'it.test.borgo-di-prova/vista-dal-belvedere.jpg', auth.uid());
  m := studio_register_media('it.test.borgo-di-prova', img);
  if m ->> 'slug' <> 'vista-dal-belvedere' or m ->> 'alt' <> 'Il borgo visto dal belvedere' then raise exception 'FALLITO: registrazione del media'; end if;
  m := studio_register_media('it.test.borgo-di-prova', img);
  if m ->> 'slug' <> 'vista-dal-belvedere-2' then raise exception 'FALLITO: slug unico per lo stesso nome file'; end if;
  if not exists (select 1 from jsonb_array_elements(studio_place('it.test.borgo-di-prova', 'belvedere') -> 'media') x
                 where x ->> 'slug' = 'vista-dal-belvedere') then
    raise exception 'FALLITO: la foto compare nella scheda del luogo';
  end if;
  begin
    perform studio_register_media('it.test.borgo-di-prova', img || '{"alt": {"it": " "}}');
    raise exception 'FALLITO: testo alternativo obbligatorio';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  begin
    perform studio_register_media('it.test.borgo-di-prova', img || '{"file": "script.exe"}');
    raise exception 'FALLITO: formato non ammesso';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('media', 'it.test.alfa/intruso.jpg', auth.uid());
    raise exception 'FALLITO: upload in un altro territorio';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Tutto è nello storico, con l'autore della modifica.
do $$ begin
  if not exists (select 1 from content_revisions where table_name = 'routes' or (table_name = 'places' and actor_id = 'd0000000-0000-0000-0000-000000000001')) then
    raise exception 'FALLITO: le modifiche dello Studio restano nello storico';
  end if;
  if (select count(*) from content_revisions where table_name = 'assertions' and actor_id = 'd0000000-0000-0000-0000-000000000002') < 2 then
    raise exception 'FALLITO: le decisioni di revisione restano nello storico';
  end if;
end $$;

select 'studio: tutti i controlli superati' as esito;
