-- Test dell'hardening (20261021000000_cms_hardening.sql): due organizzazioni clienti isolate (A e B) e lo staff
-- della piattaforma. Ogni controllo è fatto con la sessione dell'utente, come le richieste REST di PostgREST:
-- nessuna regola dipende dall'interfaccia dello Studio. Portovenere non deve cambiare.
\set ON_ERROR_STOP 1

create temp table impronta_60 as select md5(pack_snapshot('it.liguria.sp.portovenere')::text) as prima;
grant select on impronta_60 to authenticated;

-- ---------------------------------------------------------------- dati di prova (come amministratore del DB)
insert into organizations (id, kind, name) values
  ('6a000000-0000-0000-0000-000000000000', 'institution', 'Comune A (prova)'),
  ('6b000000-0000-0000-0000-000000000000', 'partner', 'Albergo B (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title) values
  ('za.alfa', 'destination', '6a000000-0000-0000-0000-000000000000', 'it', '{it}', '{"it":"Alfa (A)"}'),
  ('za.alfa.sub', 'destination', '6b000000-0000-0000-0000-000000000000', 'it', '{it}', '{"it":"Sotto Alfa ma di B"}'),
  ('zb.beta', 'destination', '6b000000-0000-0000-0000-000000000000', 'it', '{it}', '{"it":"Beta (B)"}');
insert into destinations (pack_id) values ('za.alfa'), ('za.alfa.sub'), ('zb.beta');
insert into nodes (id, pack_id, slug, kind) values
  ('6a000000-0000-0000-0000-0000000000a1', 'za.alfa', 'piazza', 'place'),
  ('6b000000-0000-0000-0000-0000000000b1', 'zb.beta', 'porto', 'place'),
  ('6b000000-0000-0000-0000-0000000000b2', 'za.alfa.sub', 'molo', 'place');
insert into node_labels (node_id, locale, name) values
  ('6a000000-0000-0000-0000-0000000000a1', 'it', 'Piazza'), ('6b000000-0000-0000-0000-0000000000b1', 'it', 'Porto'),
  ('6b000000-0000-0000-0000-0000000000b2', 'it', 'Molo');
insert into places (node_id, place_kind, location, importance, dwell_min, coordinate_method) values
  ('6a000000-0000-0000-0000-0000000000a1', 'poi', 'SRID=4326;POINT(9.9 44.1)', 3, 10, 'GPS'),
  ('6b000000-0000-0000-0000-0000000000b1', 'poi', 'SRID=4326;POINT(9.8 44.0)', 3, 10, 'GPS'),
  ('6b000000-0000-0000-0000-0000000000b2', 'poi', 'SRID=4326;POINT(9.7 44.0)', 3, 10, 'GPS');
insert into sources (id, pack_id, slug, kind, title, reliability) values
  ('6a000000-0000-0000-0000-0000000000a5', 'za.alfa', 'archivio-a', 'archive_document', 'Archivio A', 'A'),
  ('6b000000-0000-0000-0000-0000000000b5', 'zb.beta', 'archivio-b', 'archive_document', 'Archivio B', 'A');
insert into assertions (id, pack_id, slug, subject_id, predicate_id, type, certainty, status, authored_by, verified_by)
values ('6a000000-0000-0000-0000-0000000000a3', 'za.alfa', 'piazza-1890', '6a000000-0000-0000-0000-0000000000a1',
        'described_as', 'fact', 'established', 'verified', 'autore', 'verificatore'),
       ('6b000000-0000-0000-0000-0000000000b3', 'zb.beta', 'porto-1900', '6b000000-0000-0000-0000-0000000000b1',
        'described_as', 'fact', 'established', 'in_review', 'autore', null);
insert into evidence (assertion_id, source_id, locator) values ('6a000000-0000-0000-0000-0000000000a3', '6a000000-0000-0000-0000-0000000000a5', 'p. 1');
insert into routes (id, pack_id, slug, duration_min, labels) values
  ('6a000000-0000-0000-0000-0000000000a4', 'za.alfa', 'giro-a', 30, '{"it":{"name":"Giro A"}}');
insert into storage.objects (bucket_id, name, owner) values ('media', 'zb.beta/foto-b.jpg', null);

insert into auth.users (id, email, raw_user_meta_data) values
  ('60000000-0000-0000-0000-000000000001', 'admin-hardening@prova.test', '{}'),
  ('60000000-0000-0000-0000-000000000002', 'staff-hardening@prova.test', '{}'),
  ('60000000-0000-0000-0000-000000000003', 'editor-a@prova.test', '{}'),
  ('60000000-0000-0000-0000-000000000004', 'esperto-a@prova.test', '{}'),
  ('60000000-0000-0000-0000-000000000005', 'editor-b@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('60000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null),
  ('60000000-0000-0000-0000-000000000002', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_editor', null),
  ('60000000-0000-0000-0000-000000000003', '6a000000-0000-0000-0000-000000000000', 'territory_editor', 'za.alfa'),
  ('60000000-0000-0000-0000-000000000004', '6a000000-0000-0000-0000-000000000000', 'expert', 'za.alfa'),
  -- Editor di B senza ambito: vale per tutti i territori di B, non per quelli degli altri.
  ('60000000-0000-0000-0000-000000000005', '6b000000-0000-0000-0000-000000000000', 'territory_editor', null);

-- ---------------------------------------------------------------- ruoli coerenti (P1)
do $$ begin
  begin
    insert into memberships (user_id, organization_id, role, pack_scope)
    values ('60000000-0000-0000-0000-000000000005', '6b000000-0000-0000-0000-000000000000', 'platform_editor', null);
    raise exception 'FALLITO: ruolo di piattaforma in un''organizzazione cliente';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into memberships (user_id, organization_id, role, pack_scope)
    values ('60000000-0000-0000-0000-000000000005', '6b000000-0000-0000-0000-000000000000', 'territory_editor', 'za.alfa');
    raise exception 'FALLITO: ambito su un territorio di un''altra organizzazione';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;

-- ---------------------------------------------------------------- editor dell'organizzazione A
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
do $$
declare n int;
begin
  -- Isolamento: B non si legge (P3: nemmeno il territorio «sotto» al proprio ambito ma di B).
  if exists (select 1 from packs where id in ('zb.beta', 'za.alfa.sub')) then raise exception 'FALLITO: A legge i territori di B'; end if;
  if exists (select 1 from nodes where pack_id in ('zb.beta', 'za.alfa.sub')) then raise exception 'FALLITO: A legge i luoghi di B'; end if;
  if exists (select 1 from assertions where pack_id = 'zb.beta') or exists (select 1 from sources where pack_id = 'zb.beta') then
    raise exception 'FALLITO: A legge affermazioni o fonti di B';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'media' and name like 'zb.beta/%') then raise exception 'FALLITO: A vede le foto di B'; end if;
  if exists (select 1 from node_refs where id = '6b000000-0000-0000-0000-0000000000b1') then raise exception 'FALLITO: node_refs mostra i nodi di B'; end if;
  if not exists (select 1 from node_refs where id = '6a000000-0000-0000-0000-0000000000a1') then raise exception 'FALLITO: node_refs nasconde i nodi propri'; end if;
  -- Isolamento: B non si modifica.
  update packs set description = '{"it":"intruso"}' where id in ('zb.beta', 'za.alfa.sub');
  get diagnostics n = row_count;
  if n > 0 then raise exception 'FALLITO: A modifica i territori di B'; end if;
  update node_labels set name = 'intruso' where node_id = '6b000000-0000-0000-0000-0000000000b2';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'FALLITO: A modifica i luoghi di B'; end if;
  begin
    perform studio_update_place('za.alfa.sub', 'molo', '{"labels": {"it": {"name": "intruso"}}}');
    raise exception 'FALLITO: A modifica B dallo Studio';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_create_pack('{"id": "zb.beta.nuovo", "title": {"it": "Intruso"}}');
    raise exception 'FALLITO: A crea dentro B';
  exception when insufficient_privilege then null; end;
  begin
    insert into packs (id, kind, organization_id, default_locale, locales, title)
    values ('za.alfa.altro', 'destination', '6b000000-0000-0000-0000-000000000000', 'it', '{it}', '{"it":"In B"}');
    raise exception 'FALLITO: A crea un territorio intestato a B';
  exception when insufficient_privilege then null; end;
  -- Dentro A sì: un territorio figlio, intestato ad A.
  perform studio_create_pack('{"id": "za.alfa.borgo", "title": {"it": "Borgo di A"}}');
  if (select organization_id from packs where id = 'za.alfa.borgo') <> '6a000000-0000-0000-0000-000000000000' then
    raise exception 'FALLITO: il territorio creato da A è di A';
  end if;

  -- P4: l'organizzazione di un territorio non cambia.
  begin
    update packs set organization_id = '6b000000-0000-0000-0000-000000000000' where id = 'za.alfa';
    raise exception 'FALLITO: A sposta il territorio in B';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    update packs set fictional = true where id = 'za.alfa';
    raise exception 'FALLITO: A cambia «fittizio»';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;

  -- P5: un'affermazione verificata non si elimina con un DELETE diretto.
  begin
    delete from assertions where id = '6a000000-0000-0000-0000-0000000000a3';
    raise exception 'FALLITO: l''editor elimina un''affermazione verificata';
  exception when insufficient_privilege then null; end;
  -- Togliere una prova a un'affermazione verificata la riporta in revisione.
  delete from evidence where assertion_id = '6a000000-0000-0000-0000-0000000000a3';
  if (select status from assertions where id = '6a000000-0000-0000-0000-0000000000a3') <> 'in_review' then
    raise exception 'FALLITO: senza prove l''affermazione resta verificata';
  end if;

  -- P6: coordinate solo dallo Studio, con il metodo; verificate solo da chi verifica.
  begin
    update places set location = 'SRID=4326;POINT(9.91 44.11)' where node_id = '6a000000-0000-0000-0000-0000000000a1';
    raise exception 'FALLITO: coordinate cambiate con un UPDATE diretto';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    update places set coordinate_status = 'field_verified', coordinate_verified_at = current_date, coordinate_verified_by = 'io'
    where node_id = '6a000000-0000-0000-0000-0000000000a1';
    raise exception 'FALLITO: l''editor dichiara verificate le coordinate';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  perform studio_update_place('za.alfa', 'piazza', '{"location": [9.91, 44.11], "coordinateMethod": "rilievo GPS, 4 m"}');
  if (select coordinate_method from places where node_id = '6a000000-0000-0000-0000-0000000000a1') <> 'rilievo GPS, 4 m' then
    raise exception 'FALLITO: lo Studio sposta le coordinate con il metodo';
  end if;

  -- P7: lo stato di pubblicazione non cambia con un UPDATE diretto; dallo Studio valgono i blocchi.
  begin
    update destinations set status = 'published' where pack_id = 'za.alfa';
    raise exception 'FALLITO: «pubblicato» con un UPDATE diretto';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into destinations (pack_id, status) values ('za.alfa.borgo-2', 'published');
    raise exception 'FALLITO: destinazione nata pubblicata';
  exception when raise_exception or foreign_key_violation then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    delete from destinations where pack_id = 'za.alfa.borgo';
    -- l'editor di A ha il permesso di pubblicare za.alfa.*: può togliere una destinazione in bozza
  exception when others then raise exception 'FALLITO: l''editor che pubblica toglie la propria destinazione: %', sqlerrm; end;
  begin
    insert into publications (pack_id, requested_by) values ('za.alfa', auth.uid());
    raise exception 'FALLITO: richiesta di pubblicazione con un INSERT diretto';
  exception when insufficient_privilege then null; end;
  perform studio_set_pack_status('za.alfa', 'in_review');
  begin
    perform studio_set_pack_status('za.alfa', 'published', '{"ok": true}');
    raise exception 'FALLITO: territorio senza racconti pubblicato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;

  -- Riferimenti: niente contenuti di B nei contenuti di A, anche conoscendone gli identificativi.
  begin
    insert into route_stops (route_id, position, place_node_id) values ('6a000000-0000-0000-0000-0000000000a4', 0, '6b000000-0000-0000-0000-0000000000b1');
    raise exception 'FALLITO: tappa di A su un luogo di B';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into evidence (assertion_id, source_id, locator) values ('6a000000-0000-0000-0000-0000000000a3', '6b000000-0000-0000-0000-0000000000b5', 'x');
    raise exception 'FALLITO: prova di A con una fonte di B';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into media_assets (pack_id, slug, kind, storage_path, sha256, source, author, license)
    values ('za.alfa', 'rubata', 'image', 'zb.beta/foto-b.jpg', 'x', 'own_photo', 'X', 'own');
    raise exception 'FALLITO: foto di A con il file di B';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;

  -- P8: nel bucket pubblico solo i file dei bundle, solo nella propria cartella; l'indice no.
  insert into storage.objects (bucket_id, name, owner) values ('bundles', 'za.alfa/it-full/manifest.json', auth.uid());
  insert into storage.objects (bucket_id, name, owner) values ('bundles', 'za.alfa/it-full/content.0123abcd.json', auth.uid());
  insert into storage.objects (bucket_id, name, owner) values ('bundles', 'za.alfa/it-full/media/0123456789abcdef.jpg', auth.uid());
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'za.alfa/it-full/pagina.html', auth.uid());
    raise exception 'FALLITO: HTML nel bucket pubblico';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'za.alfa/it-full/media/0123456789abcdef.svg', auth.uid());
    raise exception 'FALLITO: SVG nel bucket pubblico';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'zb.beta/it-full/manifest.json', auth.uid());
    raise exception 'FALLITO: A scrive i bundle di B';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'index.json', auth.uid());
    raise exception 'FALLITO: un cliente riscrive l''indice di tutti';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('media', 'za.alfa/pagina.html', auth.uid());
    raise exception 'FALLITO: HTML nel bucket media';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- esperto dell'organizzazione A
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000004';
do $$ begin
  -- Chi verifica elimina un'affermazione verificata (regola di studio_delete, ora anche nel DB).
  update assertions set status = 'verified' where id = '6a000000-0000-0000-0000-0000000000a3';
  delete from assertions where id = '6a000000-0000-0000-0000-0000000000a3';
  if found is not true then raise exception 'FALLITO: l''esperto elimina un''affermazione verificata'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- editor dell'organizzazione B (ambito nullo)
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000005';
do $$
declare n int;
begin
  -- P2: l'ambito nullo vale per B (anche za.alfa.sub, che è di B), non per A.
  if (select count(*) from packs where id in ('zb.beta', 'za.alfa.sub')) <> 2 then raise exception 'FALLITO: B vede i propri territori'; end if;
  if exists (select 1 from packs where id like 'za.alfa' or id = 'za.alfa.borgo') then raise exception 'FALLITO: B vede i territori di A'; end if;
  update packs set description = '{"it":"intruso"}' where id = 'za.alfa';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'FALLITO: B modifica A'; end if;
  update packs set description = '{"it":"aggiornato da B"}' where id = 'zb.beta';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALLITO: B modifica il proprio territorio'; end if;
  -- B crea un territorio nuovo, intestato a B.
  perform studio_create_pack('{"id": "zb.gamma", "title": {"it": "Gamma di B"}}');
  if (select organization_id from packs where id = 'zb.gamma') <> '6b000000-0000-0000-0000-000000000000' then
    raise exception 'FALLITO: il territorio creato da B è di B';
  end if;
  -- Dipendenze: niente cicli.
  insert into pack_dependencies (pack_id, depends_on_id) values ('zb.gamma', 'zb.beta');
  begin
    insert into pack_dependencies (pack_id, depends_on_id) values ('zb.beta', 'zb.gamma');
    raise exception 'FALLITO: dipendenza circolare';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
reset role;

-- ---------------------------------------------------------------- staff della piattaforma
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000002';
do $$ begin
  if (select count(*) from packs where id in ('za.alfa', 'zb.beta')) <> 2 then raise exception 'FALLITO: lo staff vede A e B'; end if;
  begin
    update packs set organization_id = '6b000000-0000-0000-0000-000000000000' where id = 'za.alfa';
    raise exception 'FALLITO: lo staff (non amministratore) cambia l''organizzazione';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  insert into storage.objects (bucket_id, name, owner) values ('bundles', 'index.json', auth.uid());
end $$;
reset role;

-- ---------------------------------------------------------------- amministratore della piattaforma
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
do $$ begin
  if (select count(*) from packs where id in ('za.alfa', 'zb.beta', 'za.alfa.sub')) <> 3 then raise exception 'FALLITO: l''amministratore vede tutto'; end if;
  update packs set organization_id = '6a000000-0000-0000-0000-000000000000' where id = 'za.alfa.sub';
  if (select organization_id from packs where id = 'za.alfa.sub') <> '6a000000-0000-0000-0000-000000000000' then
    raise exception 'FALLITO: l''amministratore sposta un territorio tra organizzazioni';
  end if;
  update packs set organization_id = '6b000000-0000-0000-0000-000000000000' where id = 'za.alfa.sub';
  perform studio_create_pack('{"id": "zb.delta", "title": {"it": "Delta"}, "organizationId": "6b000000-0000-0000-0000-000000000000"}');
  if (select organization_id from packs where id = 'zb.delta') <> '6b000000-0000-0000-0000-000000000000' then
    raise exception 'FALLITO: l''amministratore crea per un''organizzazione cliente';
  end if;
  insert into memberships (user_id, organization_id, role, pack_scope)
  values ('60000000-0000-0000-0000-000000000005', '6b000000-0000-0000-0000-000000000000', 'expert', 'zb.beta');
end $$;
reset role;

-- ---------------------------------------------------------------- anonimo
reset request.jwt.claim.sub;
set role anon;
do $$ begin
  begin
    perform 1 from node_refs limit 1;
    raise exception 'FALLITO: un anonimo legge node_refs';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Bucket pubblico: tipi e dimensioni.
do $$ begin
  if (select allowed_mime_types from storage.buckets where id = 'bundles') @> array['text/html'] or
     (select allowed_mime_types from storage.buckets where id = 'bundles') @> array['image/svg+xml'] or
     (select file_size_limit from storage.buckets where id = 'bundles') is null then
    raise exception 'FALLITO: limiti del bucket bundles';
  end if;
  if md5(pack_snapshot('it.liguria.sp.portovenere')::text) <> (select prima from impronta_60) then
    raise exception 'FALLITO: Portovenere è cambiato';
  end if;
end $$;

select 'hardening: tutti i controlli superati';
