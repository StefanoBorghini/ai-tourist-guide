-- Test dell'accesso a pagamento (20261022000000_access.sql): lo decide solo l'amministratore della piattaforma,
-- anche con richieste dirette; i contenuti nella configurazione non si eliminano né si rinominano; la configurazione
-- passa da pack_snapshot() e import_pack() senza perdite. Portovenere non deve cambiare.
\set ON_ERROR_STOP 1

create temp table impronta_70 as select md5(pack_snapshot('it.liguria.sp.portovenere')::text) as prima;
grant select on impronta_70 to authenticated;

-- ---------------------------------------------------------------- dati di prova (come amministratore del DB)
insert into organizations (id, kind, name) values ('7c000000-0000-0000-0000-000000000000', 'institution', 'Comune C (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title) values
  ('zg.gamma', 'destination', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{"it":"Gamma"}'),
  ('zg', 'area', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{"it":"Area G"}'),
  ('zc.cliente', 'destination', '7c000000-0000-0000-0000-000000000000', 'it', '{it}', '{"it":"Cliente C"}');
insert into destinations (pack_id) values ('zg.gamma'), ('zc.cliente');
insert into nodes (id, pack_id, slug, kind) values
  ('70000000-0000-0000-0000-0000000000a1', 'zg.gamma', 'porta', 'place'),
  ('70000000-0000-0000-0000-0000000000a2', 'zg.gamma', 'chiesa', 'place'),
  ('70000000-0000-0000-0000-0000000000a3', 'zg.gamma', 'faro', 'place'),
  ('70000000-0000-0000-0000-0000000000a4', 'zg.gamma', 'molo', 'place');
insert into node_labels (node_id, locale, name) values
  ('70000000-0000-0000-0000-0000000000a1', 'it', 'Porta'), ('70000000-0000-0000-0000-0000000000a2', 'it', 'Chiesa'),
  ('70000000-0000-0000-0000-0000000000a3', 'it', 'Faro'), ('70000000-0000-0000-0000-0000000000a4', 'it', 'Molo');
insert into places (node_id, place_kind, location, importance, dwell_min, coordinate_method)
select id, 'poi', 'SRID=4326;POINT(9.9 44.1)', 3, 10, 'GPS' from nodes where pack_id = 'zg.gamma';
insert into routes (id, pack_id, slug, duration_min, labels) values
  ('70000000-0000-0000-0000-0000000000b1', 'zg.gamma', 'giro-g', 40, '{"it":{"name":"Giro G"}}'),
  ('70000000-0000-0000-0000-0000000000b2', 'zg.gamma', 'giro-libero', 20, '{"it":{"name":"Giro libero"}}');

insert into auth.users (id, email, raw_user_meta_data) values
  ('70000000-0000-0000-0000-000000000001', 'admin-accesso@prova.test', '{}'),
  ('70000000-0000-0000-0000-000000000002', 'staff-accesso@prova.test', '{}'),
  ('70000000-0000-0000-0000-000000000003', 'editor-c@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('70000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null),
  ('70000000-0000-0000-0000-000000000002', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_editor', null),
  ('70000000-0000-0000-0000-000000000003', '7c000000-0000-0000-0000-000000000000', 'territory_editor', null);

-- ---------------------------------------------------------------- staff della piattaforma (non amministratore)
set role authenticated;
set request.jwt.claim.sub = '70000000-0000-0000-0000-000000000002';
do $$ begin
  begin
    perform studio_set_access('zg.gamma', '{"explore":"premium"}');
    raise exception 'FALLITO: lo staff imposta l''accesso a pagamento';
  exception when insufficient_privilege then null; end;
  begin
    update packs set config = config || '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":[]}}' where id = 'zg.gamma';
    raise exception 'FALLITO: lo staff cambia l''accesso con un UPDATE diretto';
  exception when insufficient_privilege then null; end;
  if (studio_access('zg.gamma') ->> 'canEdit')::boolean then raise exception 'FALLITO: lo staff risulta abilitato'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- editor di un'organizzazione cliente
set role authenticated;
set request.jwt.claim.sub = '70000000-0000-0000-0000-000000000003';
do $$ begin
  begin
    update packs set config = config || '{"access":{"explore":"free","introPlaces":[],"premiumRoutes":[]}}' where id = 'zc.cliente';
    raise exception 'FALLITO: un cliente cambia l''accesso del proprio territorio';
  exception when insufficient_privilege then null; end;
  begin
    insert into packs (id, kind, organization_id, default_locale, locales, title, config)
    values ('zc.cliente.nuovo', 'destination', '7c000000-0000-0000-0000-000000000000', 'it', '{it}', '{"it":"Nuovo"}',
            '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":[]}}');
    raise exception 'FALLITO: un cliente crea un territorio già a pagamento';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- amministratore della piattaforma
set role authenticated;
set request.jwt.claim.sub = '70000000-0000-0000-0000-000000000001';
do $$
declare r jsonb;
begin
  r := studio_set_access('zg.gamma', '{"explore":"premium","introPlaces":["porta","chiesa","porta"],"premiumRoutes":["giro-g"]}');
  if r ->> 'explore' <> 'premium' or r -> 'introPlaces' <> '["chiesa","porta"]' or r -> 'premiumRoutes' <> '["giro-g"]'
     or not (r ->> 'canEdit')::boolean or jsonb_array_length(r -> 'places') <> 4 or jsonb_array_length(r -> 'routes') <> 2 then
    raise exception 'FALLITO: impostazione dell''accesso: %', r;
  end if;
  if (select config -> 'access' from packs where id = 'zg.gamma') <> '{"explore":"premium","introPlaces":["chiesa","porta"],"premiumRoutes":["giro-g"]}' then
    raise exception 'FALLITO: configurazione salvata diversa da quella attesa';
  end if;
  begin
    perform studio_set_access('zg.gamma', '{"explore":"premium","introPlaces":["porta","chiesa","faro","molo"]}');
    raise exception 'FALLITO: più di 3 luoghi introduttivi';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_set_access('zg.gamma', '{"explore":"premium","introPlaces":["nessuno"]}');
    raise exception 'FALLITO: luogo introduttivo inesistente';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_set_access('zg.gamma', '{"premiumRoutes":["nessuno"]}');
    raise exception 'FALLITO: percorso inesistente';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_set_access('zg.gamma', '{"explore":"gratis"}');
    raise exception 'FALLITO: valore di esplorazione non ammesso';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_set_access('zg', '{"explore":"premium"}');
    raise exception 'FALLITO: accesso su un''area';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
reset role;

-- ---------------------------------------------------------------- contenuti nella configurazione: protetti
set role authenticated;
set request.jwt.claim.sub = '70000000-0000-0000-0000-000000000002';
do $$ begin
  begin
    delete from routes where pack_id = 'zg.gamma' and slug = 'giro-g';
    raise exception 'FALLITO: eliminato un percorso premium';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    update routes set slug = 'giro-g2' where pack_id = 'zg.gamma' and slug = 'giro-g';
    raise exception 'FALLITO: rinominato un percorso premium';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    delete from nodes where pack_id = 'zg.gamma' and slug = 'porta';
    raise exception 'FALLITO: eliminato un luogo introduttivo';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Le altre modifiche restano libere.
  update routes set labels = '{"it":{"name":"Giro G, nuovo nome"}}' where pack_id = 'zg.gamma' and slug = 'giro-g';
  delete from routes where pack_id = 'zg.gamma' and slug = 'giro-libero';
  if exists (select 1 from routes where pack_id = 'zg.gamma' and slug = 'giro-libero') then
    raise exception 'FALLITO: un percorso gratuito non si elimina';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------- esportazione e importazione
do $$
declare s jsonb := pack_snapshot('zg.gamma');
begin
  if s #> '{config,access}' <> '{"explore":"premium","introPlaces":["chiesa","porta"],"premiumRoutes":["giro-g"]}' then
    raise exception 'FALLITO: pack_snapshot perde l''accesso: %', s -> 'config';
  end if;
  update packs set config = config - 'access' where id = 'zg.gamma';
  perform import_pack(s);
  if (select config -> 'access' from packs where id = 'zg.gamma') <> s #> '{config,access}' then
    raise exception 'FALLITO: import_pack perde l''accesso';
  end if;
end $$;

-- ---------------------------------------------------------------- di nuovo tutto gratuito
set role authenticated;
set request.jwt.claim.sub = '70000000-0000-0000-0000-000000000001';
do $$ begin
  perform studio_set_access('zg.gamma', '{"explore":"free","introPlaces":[],"premiumRoutes":[]}');
  if (select config ? 'access' from packs where id = 'zg.gamma') then
    raise exception 'FALLITO: tutto gratuito deve togliere la configurazione';
  end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '70000000-0000-0000-0000-000000000002';
do $$ begin
  delete from routes where pack_id = 'zg.gamma' and slug = 'giro-g';
  if exists (select 1 from routes where pack_id = 'zg.gamma' and slug = 'giro-g') then
    raise exception 'FALLITO: tolto dalla configurazione, il percorso si deve poter eliminare';
  end if;
end $$;
reset role;

do $$ begin
  if md5(pack_snapshot('it.liguria.sp.portovenere')::text) <> (select prima from impronta_70) then
    raise exception 'FALLITO: Portovenere è cambiato';
  end if;
end $$;

select 'accesso: tutti i controlli superati';
