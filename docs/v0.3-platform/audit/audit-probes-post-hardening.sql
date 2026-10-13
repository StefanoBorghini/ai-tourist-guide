-- Sonde di audit (solo database locale usa e getta). Ogni riga: sonda, esito osservato.
\set ON_ERROR_STOP 1
create table audit_out (id text, observed text);
grant all on audit_out to authenticated, anon;
insert into organizations (id, name, kind) values
  ('0a000000-0000-0000-0000-00000000000a', 'Org A (audit)', 'institution'),
  ('0b000000-0000-0000-0000-00000000000b', 'Org B (audit)', 'partner');
insert into packs (id, kind, version, organization_id, default_locale, quality_tier, release_stage, locales, title)
values ('xa.audita', 'destination', '0.1.0', '0a000000-0000-0000-0000-00000000000a', 'it', 'silver', 'research', '{it}', '{"it":"Audit A"}'),
       ('xa.audita.sub', 'destination', '0.1.0', '0b000000-0000-0000-0000-00000000000b', 'it', 'silver', 'research', '{it}', '{"it":"Audit A sub di B"}'),
       ('xb.auditb', 'destination', '0.1.0', '0b000000-0000-0000-0000-00000000000b', 'it', 'silver', 'research', '{it}', '{"it":"Audit B"}');
insert into destinations (pack_id) values ('xa.audita'), ('xa.audita.sub'), ('xb.auditb');
insert into auth.users (id, email, raw_user_meta_data) values
  ('ae000000-0000-0000-0000-000000000001', 'te-a@audit.test', '{}'),
  ('ae000000-0000-0000-0000-000000000002', 'pe-b@audit.test', '{}'),
  ('ae000000-0000-0000-0000-000000000003', 'te-b-null@audit.test', '{}'),
  ('ae000000-0000-0000-0000-000000000004', 'visitor@audit.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('ae000000-0000-0000-0000-000000000001', '0a000000-0000-0000-0000-00000000000a', 'territory_editor', 'xa.audita'),
  ('ae000000-0000-0000-0000-000000000003', '0b000000-0000-0000-0000-00000000000b', 'territory_editor', null);
do $$ begin
  insert into memberships (user_id, organization_id, role, pack_scope) values ('ae000000-0000-0000-0000-000000000002', '0b000000-0000-0000-0000-00000000000b', 'platform_editor', null);
  insert into audit_out values ('P1 (setup) ruolo platform_editor in un''organizzazione cliente', 'CONSENTITO');
exception when others then insert into audit_out values ('P1 (setup) ruolo platform_editor in un''organizzazione cliente', 'negato: ' || sqlerrm); end $$;
-- un nodo e un'affermazione verificata in xa.audita
insert into nodes (id, pack_id, slug, kind) values ('ad000000-0000-0000-0000-000000000001', 'xa.audita', 'piazza', 'place');
insert into places (node_id, location, place_kind, importance, dwell_min, coordinate_method) values ('ad000000-0000-0000-0000-000000000001', 'SRID=4326;POINT(9.9 44.1)', 'poi', 3, 10, 'GPS');
insert into assertions (pack_id, slug, subject_id, predicate_id, type, certainty, status, authored_by, verified_by)
values ('xa.audita', 'verificata', 'ad000000-0000-0000-0000-000000000001', 'described_as', 'fact', 'established', 'verified', 'x', 'y');

-- P1: platform_editor dell'org B modifica un territorio dell'org A
set role authenticated; set request.jwt.claim.sub = 'ae000000-0000-0000-0000-000000000002';
do $$ begin execute 'with u as (update packs set title = ''{"it":"Audit A (toccato da B)"}'' where id = ''xa.audita'' returning 1)
insert into audit_out select ''P1 platform_editor org B modifica pack org A'', case when count(*) > 0 then ''CONSENTITO'' else ''negato'' end from u'; exception when others then insert into audit_out values ('P1 platform_editor org B modifica pack org A', 'negato: ' || sqlerrm); end $$;

reset role;
-- P2: territory_editor org B con ambito nullo
set role authenticated; set request.jwt.claim.sub = 'ae000000-0000-0000-0000-000000000003';
do $$ begin execute 'with u as (update packs set description = ''{"it":"toccato da te-b-null"}'' where id = ''xa.audita'' returning 1)
insert into audit_out select ''P2 territory_editor org B ambito nullo modifica pack org A'', case when count(*) > 0 then ''CONSENTITO'' else ''negato'' end from u'; exception when others then insert into audit_out values ('P2 territory_editor org B ambito nullo modifica pack org A', 'negato: ' || sqlerrm); end $$;

reset role;
-- P3..P6 come editor di xa.audita (org A)
set role authenticated; set request.jwt.claim.sub = 'ae000000-0000-0000-0000-000000000001';
do $$ begin execute 'with u as (update packs set description = ''{"it":"toccato da te-a"}'' where id = ''xa.audita.sub'' returning 1)
insert into audit_out select ''P3 ambito gerarchico: editor org A modifica xa.audita.sub (org B)'', case when count(*) > 0 then ''CONSENTITO'' else ''negato'' end from u'; exception when others then insert into audit_out values ('P3 ambito gerarchico: editor org A modifica xa.audita.sub (org B)', 'negato: ' || sqlerrm); end $$;

do $$ begin execute 'with u as (update packs set organization_id = ''0b000000-0000-0000-0000-00000000000b'' where id = ''xa.audita'' returning 1)
insert into audit_out select ''P4 editor cambia organization_id del proprio pack (REST diretto)'', case when count(*) > 0 then ''CONSENTITO'' else ''negato'' end from u'; exception when others then insert into audit_out values ('P4 editor cambia organization_id del proprio pack (REST diretto)', 'negato: ' || sqlerrm); end $$;


do $$ begin execute 'with u as (delete from assertions where pack_id = ''xa.audita'' and slug = ''verificata'' returning 1)
insert into audit_out select ''P5 editor elimina affermazione verificata con DELETE diretto'', case when count(*) > 0 then ''CONSENTITO'' else ''negato'' end from u'; exception when others then insert into audit_out values ('P5 editor elimina affermazione verificata con DELETE diretto', 'negato: ' || sqlerrm); end $$;

do $$ begin execute 'with u as (update places set location = ''SRID=4326;POINT(9.95 44.15)'' where node_id = ''ad000000-0000-0000-0000-000000000001'' returning 1)
insert into audit_out select ''P6 editor sposta coordinate senza metodo (UPDATE diretto)'', case when count(*) > 0 then ''CONSENTITO'' else ''negato'' end from u'; exception when others then insert into audit_out values ('P6 editor sposta coordinate senza metodo (UPDATE diretto)', 'negato: ' || sqlerrm); end $$;
do $$ begin
  update destinations set status = 'published' where pack_id = 'xa.audita';
  insert into audit_out values ('P7 territory_editor mette «published» senza controllo (UPDATE diretto)', case when found then 'CONSENTITO' else 'negato' end);
exception when others then insert into audit_out values ('P7 territory_editor mette «published» senza controllo (UPDATE diretto)', 'negato: ' || sqlerrm); end $$;
do $$ begin
  insert into storage.objects (bucket_id, name, owner) values ('bundles', 'xa.audita/it-full/pagina.html', auth.uid());
  insert into audit_out values ('P8 editor scrive un file .html nel bucket pubblico bundles (a livello DB)', 'CONSENTITO');
exception when others then insert into audit_out values ('P8 editor scrive un file .html nel bucket pubblico bundles (a livello DB)', 'negato: ' || sqlerrm); end $$;
insert into audit_out select 'P9 editor org A vede le organizzazioni', string_agg(name, ', ' order by name) from organizations;
insert into audit_out select 'P10 editor org A vede content_revisions di altri pack', count(*)::text from content_revisions where pack_id not like 'xa.audita%';
insert into audit_out select 'P11 editor org A vede memberships altrui', count(*)::text from memberships where user_id <> auth.uid();
reset role;
-- P12..P14 anonimo e visitatore
reset request.jwt.claim.sub;
set role anon;
insert into audit_out select 'P12 anonimo legge oggetti del bucket bundles (elenco)', count(*)::text from storage.objects where bucket_id = 'bundles';
insert into audit_out select 'P13 anonimo legge packs / nodes / assertions', (select count(*) from packs) || ' / ' || (select count(*) from nodes) || ' / ' || (select count(*) from assertions);
reset role;
set role authenticated; set request.jwt.claim.sub = 'ae000000-0000-0000-0000-000000000004';
insert into audit_out select 'P14 visitatore autenticato legge media / packs', (select count(*) from storage.objects where bucket_id = 'media') || ' / ' || (select count(*) from packs);
reset role;
insert into audit_out select 'P15 limiti del bucket bundles (dimensione / MIME)', coalesce(file_size_limit::text, 'nessuno') || ' / ' || coalesce(array_to_string(allowed_mime_types, ','), 'nessuno') from storage.buckets where id = 'bundles';
select * from audit_out;
