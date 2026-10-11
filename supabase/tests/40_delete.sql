-- Test dell'eliminazione dallo Studio: piano, blocchi, permessi per ruolo, copia di sicurezza e
-- ripristino completo di un territorio eliminato. Usa i pack importati da roundtrip.ts e gli utenti di
-- 30_territories.sql; Portovenere non deve cambiare.
\set ON_ERROR_STOP 1

create temp table impronta_40 as select md5(pack_snapshot('it.liguria.sp.portovenere')::text) as prima;
grant select on impronta_40 to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('f0000000-0000-0000-0000-000000000040', 'admin-elimina@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope)
select 'f0000000-0000-0000-0000-000000000040', (select organization_id from packs where id = 'it.test'), 'platform_admin', null;

-- ---------------------------------------------------------------- editor del territorio
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000001';
do $$
declare v jsonb; n int;
begin
  -- Un luogo usato da un percorso e da un altro luogo non si elimina; il piano dice perché.
  v := studio_delete_plan('it.test.borgo-di-prova', 'place', 'porta-del-borgo');
  if (v ->> 'allowed')::boolean then raise exception 'FALLITO: porta-del-borgo è una tappa'; end if;
  if not (v -> 'blockers')::text like '%giro-breve%' then raise exception 'FALLITO: il blocco nomina il percorso: %', v; end if;
  if not (v -> 'blockers')::text like '%carrugio-centrale%' then raise exception 'FALLITO: il blocco nomina il luogo contenuto: %', v; end if;
  begin
    perform studio_delete('it.test.borgo-di-prova', 'place', 'porta-del-borgo');
    raise exception 'FALLITO: eliminato un luogo bloccato';
  exception when insufficient_privilege then null; end;
  if not exists (select 1 from nodes where pack_id = 'it.test.borgo-di-prova' and slug = 'porta-del-borgo') then
    raise exception 'FALLITO: il luogo bloccato è sparito';
  end if;

  -- Una fonte usata come prova non si elimina.
  v := studio_delete_plan('it.test.borgo-di-prova', 'source', 'guida-fittizia');
  if (v ->> 'allowed')::boolean then raise exception 'FALLITO: guida-fittizia è una prova'; end if;

  -- Un'affermazione verificata e usata da un racconto non si elimina (né per l'uso né per il ruolo).
  v := studio_delete_plan('it.test.borgo-di-prova', 'assertion', 'porta-larghezza');
  if (v ->> 'allowed')::boolean or jsonb_array_length(v -> 'blockers') < 2 then raise exception 'FALLITO: porta-larghezza: %', v; end if;

  -- Un percorso si elimina; i luoghi restano; prima si salva la copia del territorio.
  select count(*) into n from content_revisions where table_name = 'pack_snapshot';
  perform studio_delete('it.test.borgo-di-prova', 'route', 'giro-breve');
  if exists (select 1 from routes where pack_id = 'it.test.borgo-di-prova' and slug = 'giro-breve') then
    raise exception 'FALLITO: percorso non eliminato';
  end if;
  if (select count(*) from nodes where pack_id = 'it.test.borgo-di-prova' and slug = 'porta-del-borgo') <> 1 then
    raise exception 'FALLITO: i luoghi del percorso devono restare';
  end if;
  if (select count(*) from content_revisions where table_name = 'pack_snapshot') <> n + 1 then
    raise exception 'FALLITO: manca la copia di sicurezza';
  end if;
  if (select before -> 'manifest' from content_revisions where table_name = 'pack_snapshot' order by id desc limit 1) is null then
    raise exception 'FALLITO: la copia di sicurezza non è un pack completo';
  end if;

  -- Un racconto in bozza si elimina; le affermazioni restano.
  perform studio_delete('it.test.borgo-di-prova', 'unit', 'belvedere-ada-it');
  if exists (select 1 from narrative_units where pack_id = 'it.test.borgo-di-prova' and slug = 'belvedere-ada-it') then
    raise exception 'FALLITO: racconto non eliminato';
  end if;
  if not exists (select 1 from assertions where pack_id = 'it.test.borgo-di-prova' and slug = 'ada-belvedere') then
    raise exception 'FALLITO: le affermazioni del racconto devono restare';
  end if;

  -- Una foto che condivide il file con un'altra: il file nel bucket resta.
  v := studio_delete('it.test.borgo-di-prova', 'media', 'vista-dal-belvedere-2');
  if jsonb_array_length(v -> 'files') <> 0 then raise exception 'FALLITO: il file serve ancora a un''altra foto: %', v; end if;

  -- Un territorio intero no.
  begin
    perform studio_delete_pack('it.test.borgo-di-prova', 'it.test.borgo-di-prova');
    raise exception 'FALLITO: un editor ha eliminato un territorio';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_delete('it.test.borgo-di-prova', 'pack', null);
    raise exception 'FALLITO: studio_delete non elimina territori';
  exception when raise_exception then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- editor di un altro ambito
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000003';
do $$ begin
  begin
    perform studio_delete_plan('it.test', 'unit', 'x');
    raise exception 'FALLITO: piano fuori dal proprio ambito';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_delete('it.liguria.sp.portovenere', 'route', 'giro-classico');
    raise exception 'FALLITO: eliminazione fuori dal proprio ambito';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- esperto
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000002';
do $$ begin
  -- Elimina un'affermazione (come la scrive e la verifica), non un percorso o un luogo.
  perform studio_delete('it.test.borgo-di-prova', 'assertion', 'torre-scalini');
  if exists (select 1 from assertions where pack_id = 'it.test.borgo-di-prova' and slug = 'torre-scalini') then
    raise exception 'FALLITO: affermazione non eliminata';
  end if;
  begin
    perform studio_delete('it.test.borgo-di-prova', 'place', 'belvedere');
    raise exception 'FALLITO: un esperto ha eliminato un luogo';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- amministratore
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000040';
do $$
declare v jsonb;
begin
  -- Una torre richiamata da un altro racconto non si elimina.
  v := studio_delete_plan('it.test.borgo-di-prova', 'place', 'torre-di-prova');
  if (v ->> 'allowed')::boolean or not (v -> 'blockers')::text like '%porta-apertura-it%' then
    raise exception 'FALLITO: torre-di-prova è richiamata da un racconto: %', v;
  end if;
  -- Tolto il percorso, la chiesa si elimina con i suoi racconti e le affermazioni su di lei.
  v := studio_delete_plan('it.test.borgo-di-prova', 'place', 'chiesa-di-san-test');
  if not (v ->> 'allowed')::boolean or jsonb_array_length(v -> 'items') <> 3 then raise exception 'FALLITO: piano della chiesa: %', v; end if;
  perform studio_delete('it.test.borgo-di-prova', 'place', 'chiesa-di-san-test');
  if exists (select 1 from nodes where pack_id = 'it.test.borgo-di-prova' and slug = 'chiesa-di-san-test')
     or exists (select 1 from narrative_units where pack_id = 'it.test.borgo-di-prova' and slug = 'chiesa-datazione-it')
     or exists (select 1 from assertions where pack_id = 'it.test.borgo-di-prova' and slug like 'chiesa-datazione-%') then
    raise exception 'FALLITO: il luogo o i suoi contenuti sono rimasti';
  end if;
  -- Ciò che non era solo suo resta (la fonte dell'area usata come prova, le altre affermazioni).
  if not exists (select 1 from sources where pack_id = 'it.test' and slug = 'cronaca-immaginaria')
     or not exists (select 1 from assertions where pack_id = 'it.test.borgo-di-prova' and slug = 'porta-funzione') then
    raise exception 'FALLITO: è sparito qualcosa che non apparteneva al luogo';
  end if;
  -- Una foto con il suo file: il piano restituisce il file da togliere dal bucket.
  v := studio_delete('it.test.borgo-di-prova', 'media', 'torre-foto-nc');
  if v -> 'files' <> '["it.test.borgo-di-prova/torre-fittizia.jpg"]' then raise exception 'FALLITO: file da togliere: %', v -> 'files'; end if;

  -- Un territorio che contiene altri territori non si elimina.
  begin
    perform studio_delete_pack('it.test', 'it.test');
    raise exception 'FALLITO: eliminata un''area che contiene destinazioni';
  exception when insufficient_privilege then null; end;
  -- La conferma deve essere l'identificativo esatto.
  begin
    perform studio_delete_pack('it.test.borgo-di-prova', 'borgo');
    raise exception 'FALLITO: conferma sbagliata accettata';
  exception when raise_exception then null; end;
end $$;
reset role;

-- Un territorio pubblicato va prima ritirato.
update destinations set status = 'published' where pack_id = 'it.test.borgo-di-prova';
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000040';
do $$ begin
  begin
    perform studio_delete_pack('it.test.borgo-di-prova', 'it.test.borgo-di-prova');
    raise exception 'FALLITO: eliminato un territorio pubblicato';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update destinations set status = 'draft' where pack_id = 'it.test.borgo-di-prova';

-- Eliminazione completa e ripristino dalla copia: il territorio torna identico.
create temp table prima_eliminazione as select pack_snapshot('it.test.borgo-di-prova') as s,
  (select organization_id from packs where id = 'it.test.borgo-di-prova') as org;
set role authenticated;
set request.jwt.claim.sub = 'f0000000-0000-0000-0000-000000000040';
select studio_delete_pack('it.test.borgo-di-prova', 'it.test.borgo-di-prova') is not null as eliminato \gset
reset role;
do $$ begin
  if exists (select 1 from packs where id = 'it.test.borgo-di-prova')
     or exists (select 1 from nodes where pack_id = 'it.test.borgo-di-prova')
     or exists (select 1 from media_assets where pack_id = 'it.test.borgo-di-prova') then
    raise exception 'FALLITO: territorio non eliminato del tutto';
  end if;
  if not exists (select 1 from packs where id = 'it.test') then raise exception 'FALLITO: l''area è sparita'; end if;
  perform import_pack((select before from content_revisions where table_name = 'pack_snapshot' and pack_id = 'it.test.borgo-di-prova'
                       order by id desc limit 1), (select org from prima_eliminazione));
  if md5(pack_snapshot('it.test.borgo-di-prova')::text) <> (select md5(s::text) from prima_eliminazione) then
    raise exception 'FALLITO: il ripristino dalla copia non restituisce lo stesso territorio';
  end if;
  if md5(pack_snapshot('it.liguria.sp.portovenere')::text) <> (select prima from impronta_40) then
    raise exception 'FALLITO: Portovenere è cambiato';
  end if;
end $$;

select 'eliminazione: tutti i controlli superati';
