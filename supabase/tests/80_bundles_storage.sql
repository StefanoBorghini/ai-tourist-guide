-- Test del bucket «bundles» (20261023000000_bundles_storage.sql): nessuno elenca i file tranne chi pubblica il
-- territorio; chi pubblica cancella solo i contenuti superati del proprio territorio. Il bucket resta pubblico
-- (lo scaricamento dall'indirizzo pubblico non passa dalle policy: va verificato sul progetto reale).
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values ('8c000000-0000-0000-0000-000000000000', 'institution', 'Comune D (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title) values
  ('zd.delta', 'destination', '8c000000-0000-0000-0000-000000000000', 'it', '{it}', '{"it":"Delta"}'),
  ('ze.epsilon', 'destination', '8c000000-0000-0000-0000-000000000000', 'it', '{it}', '{"it":"Epsilon"}');
insert into destinations (pack_id) values ('zd.delta'), ('ze.epsilon');
insert into storage.objects (bucket_id, name, owner) values
  ('bundles', 'zd.delta/it-full/manifest.json', null),
  ('bundles', 'zd.delta/it-full/content.aaaaaaaaaaaaaaaa.json', null),
  ('bundles', 'zd.delta/it-full/content.bbbbbbbbbbbbbbbb.json', null),
  ('bundles', 'zd.delta/it-full/media/cccccccccccccccc.jpg', null),
  ('bundles', 'ze.epsilon/it-full/content.dddddddddddddddd.json', null);
insert into auth.users (id, email, raw_user_meta_data) values
  ('80000000-0000-0000-0000-000000000001', 'editor-d@prova.test', '{}'),
  ('80000000-0000-0000-0000-000000000002', 'visitatore-d@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('80000000-0000-0000-0000-000000000001', '8c000000-0000-0000-0000-000000000000', 'territory_editor', 'zd.delta');

-- ---------------------------------------------------------------- nessun elenco per anonimi e visitatori
do $$ begin
  if not (select public from storage.buckets where id = 'bundles') then raise exception 'FALLITO: il bucket bundles deve restare pubblico'; end if;
end $$;
set role anon;
do $$ begin
  -- Gli indici numerati (index/…) sono pubblici ed elencabili (R2): nient'altro.
  if exists (select 1 from storage.objects where bucket_id = 'bundles' and name !~ '^index/[0-9]{20}\.json$') then
    raise exception 'FALLITO: un anonimo elenca i file dei bundle';
  end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000002';
do $$ begin
  if exists (select 1 from storage.objects where bucket_id = 'bundles' and name !~ '^index/[0-9]{20}\.json$') then
    raise exception 'FALLITO: un visitatore elenca i file dei bundle';
  end if;
  delete from storage.objects where bucket_id = 'bundles' and name like 'zd.delta/%';
end $$;
reset role;
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'bundles' and name like 'zd.delta/%') <> 4 then
    raise exception 'FALLITO: un visitatore cancella file dei bundle';
  end if;
end $$;

-- ---------------------------------------------------------------- chi pubblica: il proprio territorio
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'bundles' and name like 'zd.delta/%') <> 4 then
    raise exception 'FALLITO: chi pubblica non vede i file del proprio territorio';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'bundles' and name like 'ze.epsilon/%') then
    raise exception 'FALLITO: chi pubblica vede i file di un territorio fuori dal suo ambito';
  end if;
  -- Nessuna cancellazione nella struttura precedente finché è quella in linea (R2: il territorio non ha ancora una
  -- pubblicazione nella struttura nuova): né contenuti, né manifest, né media, né file di altri territori.
  -- Le righe semplicemente non sono toccate; la cancellazione ammessa è provata più sotto, sezione R2.
  delete from storage.objects where bucket_id = 'bundles' and name in
    ('zd.delta/it-full/content.aaaaaaaaaaaaaaaa.json', 'zd.delta/it-full/manifest.json', 'zd.delta/it-full/media/cccccccccccccccc.jpg',
     'ze.epsilon/it-full/content.dddddddddddddddd.json');
end $$;
reset role;
do $$ begin
  if (select count(*) from storage.objects where name in ('zd.delta/it-full/manifest.json', 'zd.delta/it-full/media/cccccccccccccccc.jpg',
                                                          'ze.epsilon/it-full/content.dddddddddddddddd.json', 'zd.delta/it-full/content.aaaaaaaaaaaaaaaa.json',
                                                          'zd.delta/it-full/content.bbbbbbbbbbbbbbbb.json')) <> 5 then
    raise exception 'FALLITO: cancellati file della struttura precedente ancora in linea';
  end if;
end $$;

-- ---------------------------------------------------------------- una pubblicazione alla volta (M1)
-- Due persone pubblicano lo stesso territorio quasi insieme: la seconda non parte finché la prima è in corso,
-- quindi la pulizia dei contenuti superati della prima non può cancellare i file della seconda.
insert into auth.users (id, email, raw_user_meta_data) values
  ('80000000-0000-0000-0000-000000000003', 'editor-d2@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('80000000-0000-0000-0000-000000000003', '8c000000-0000-0000-0000-000000000000', 'territory_editor', 'zd.delta');
insert into publications (id, pack_id, requested_by, status, report, created_at) values
  ('8d000000-0000-0000-0000-00000000000a', 'zd.delta', '80000000-0000-0000-0000-000000000001', 'requested', '{"ok":true}', now() - interval '2 seconds'),
  ('8d000000-0000-0000-0000-00000000000b', 'zd.delta', '80000000-0000-0000-0000-000000000003', 'requested', '{"ok":true}', now() - interval '1 second');

create function pg_temp.stato_80(p uuid) returns text language sql as $$ select status::text from publications where id = p $$;

set role anon;
do $$ begin
  perform studio_publication_claim('zd.delta');
  raise exception 'FALLITO: un anonimo prende in carico una pubblicazione';
exception when insufficient_privilege then null;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000002';
do $$ begin
  perform studio_publication_claim('zd.delta');
  raise exception 'FALLITO: un visitatore prende in carico una pubblicazione';
exception when insufficient_privilege or raise_exception then
  if sqlerrm like 'FALLITO%' then raise; end if;
end $$;

-- A prende in carico la propria richiesta.
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$
declare r jsonb;
begin
  r := studio_publication_claim('zd.delta');
  if (r ->> 'ok')::boolean is not true or (r ->> 'publication')::uuid <> '8d000000-0000-0000-0000-00000000000a' then
    raise exception 'FALLITO: A non prende in carico la propria richiesta: %', r;
  end if;
end $$;
-- B, nel frattempo, viene fermata: la sua richiesta risulta fallita, quella di A resta in corso.
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$
declare r jsonb;
begin
  r := studio_publication_claim('zd.delta');
  if (r ->> 'ok')::boolean is not false or r ->> 'reason' <> 'busy' then raise exception 'FALLITO: B parte mentre A è in corso: %', r; end if;
end $$;
reset role;
do $$ begin
  if pg_temp.stato_80('8d000000-0000-0000-0000-00000000000a') <> 'building' or pg_temp.stato_80('8d000000-0000-0000-0000-00000000000b') <> 'failed' then
    raise exception 'FALLITO: stati dopo la presa in carico concorrente: A %, B %',
      pg_temp.stato_80('8d000000-0000-0000-0000-00000000000a'), pg_temp.stato_80('8d000000-0000-0000-0000-00000000000b');
  end if;
end $$;

-- Le forme senza identificativo (server che non prendono in carico) non toccano una pubblicazione presa in carico.
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  perform studio_publication_finish('zd.delta', false, '{"errors":["prova"]}');
  raise exception 'FALLITO: la forma senza identificativo ha chiuso qualcosa';
exception when raise_exception then
  if sqlerrm not like 'nessuna pubblicazione in corso%' then raise; end if;
end $$;
reset role;
do $$ begin
  if pg_temp.stato_80('8d000000-0000-0000-0000-00000000000a') <> 'building' then
    raise exception 'FALLITO: la forma senza identificativo ha toccato la pubblicazione presa in carico';
  end if;
end $$;

-- ---------------------------------------------------------------- esito per identificativo (R1)
-- Fotografia di una pubblicazione, per verificare che un esito rifiutato non abbia cambiato nulla.
create function pg_temp.foto_80(p uuid) returns text language sql as $$
  select to_jsonb(x)::text from publications x where id = p $$;
create function pg_temp.bundle_80(p_pub uuid, p_hash text) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'locale', 'it', 'url', '/pub/zd.delta/it-full/' || p_pub || '/manifest.json',
    'manifest', jsonb_build_object('destination', 'zd.delta', 'bundleSchemaVersion', 1, 'minAppVersion', '0.1.0',
                                   'kbHash', p_hash, 'totalBytes', 10, 'content', p_pub || '/content.' || p_hash || '.json'),
    'entry', jsonb_build_object('destination', 'zd.delta', 'locale', 'it', 'manifest', '/pub/zd.delta/it-full/' || p_pub || '/manifest.json'))) $$;
-- Il territorio ze.epsilon è pubblicabile anche da B (per provare un identificativo di un altro territorio).
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('80000000-0000-0000-0000-000000000003', '8c000000-0000-0000-0000-000000000000', 'territory_editor', 'ze.epsilon');

-- La presa di A scade (il suo processo è ancora vivo ma non dà notizie); B richiede e prende in carico.
update publications set report = report || jsonb_build_object('buildingSince', now() - interval '20 minutes')
where id = '8d000000-0000-0000-0000-00000000000a';
insert into publications (id, pack_id, requested_by, status, report) values
  ('8d000000-0000-0000-0000-00000000000c', 'zd.delta', '80000000-0000-0000-0000-000000000003', 'requested', '{"ok":true}');
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$
declare r jsonb;
begin
  r := studio_publication_claim('zd.delta');
  if (r ->> 'ok')::boolean is not true or (r ->> 'publication')::uuid <> '8d000000-0000-0000-0000-00000000000c' then
    raise exception 'FALLITO: B non prende in carico dopo la scadenza di A: %', r;
  end if;
end $$;
reset role;
do $$ begin
  if pg_temp.stato_80('8d000000-0000-0000-0000-00000000000a') <> 'failed' or pg_temp.stato_80('8d000000-0000-0000-0000-00000000000c') <> 'building' then
    raise exception 'FALLITO: stati dopo la scadenza di A';
  end if;
end $$;
create temp table foto_prima_80 as
  select pg_temp.foto_80('8d000000-0000-0000-0000-00000000000a') as a, pg_temp.foto_80('8d000000-0000-0000-0000-00000000000c') as b,
         (select count(*) from bundles where pack_id = 'zd.delta') as n;
grant select on foto_prima_80 to authenticated;

-- Il processo di A, tardivo, prova a completare e a fallire: rifiutato, né A né B cambiano.
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  begin
    perform studio_publication_finish('zd.delta', true, '{"ms":1}', pg_temp.bundle_80('8d000000-0000-0000-0000-00000000000a', 'aaaaaaaaaaaaaaaa'),
                                      '8d000000-0000-0000-0000-00000000000a');
    raise exception 'FALLITO: completamento tardivo di A accettato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like '%non è più in corso%' then raise; end if; end;
  begin
    perform studio_publication_finish('zd.delta', false, '{"errors":["tardivo"]}', '[]', '8d000000-0000-0000-0000-00000000000a');
    raise exception 'FALLITO: fallimento tardivo di A accettato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like '%non è più in corso%' then raise; end if; end;
  -- A non può nemmeno usare l'identificativo di B (non è sua).
  begin
    perform studio_publication_finish('zd.delta', false, '{"errors":["intruso"]}', '[]', '8d000000-0000-0000-0000-00000000000c');
    raise exception 'FALLITO: A chiude la pubblicazione di B';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_publication_finish('zd.delta', true, '{}', pg_temp.bundle_80('8d000000-0000-0000-0000-00000000000c', 'cccccccccccccccc'),
                                      '8d000000-0000-0000-0000-00000000000c');
    raise exception 'FALLITO: A completa la pubblicazione di B';
  exception when insufficient_privilege then null; end;
end $$;
-- Un visitatore senza permessi, e B con l'identificativo giusto ma un altro territorio: rifiutati.
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000002';
do $$ begin
  perform studio_publication_finish('zd.delta', false, '{}', '[]', '8d000000-0000-0000-0000-00000000000c');
  raise exception 'FALLITO: un visitatore chiude una pubblicazione';
exception when insufficient_privilege then null;
end $$;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  perform studio_publication_finish('ze.epsilon', false, '{}', '[]', '8d000000-0000-0000-0000-00000000000c');
  raise exception 'FALLITO: identificativo accettato per un altro territorio';
exception when insufficient_privilege then null;
end $$;
-- Un identificativo inesistente: rifiutato.
do $$ begin
  perform studio_publication_finish('zd.delta', false, '{}', '[]', '8d000000-0000-0000-0000-0000000000ff');
  raise exception 'FALLITO: identificativo inesistente accettato';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$ begin
  if pg_temp.foto_80('8d000000-0000-0000-0000-00000000000a') is distinct from (select a from foto_prima_80)
     or pg_temp.foto_80('8d000000-0000-0000-0000-00000000000c') is distinct from (select b from foto_prima_80)
     or (select count(*) from bundles where pack_id = 'zd.delta') <> (select n from foto_prima_80) then
    raise exception 'FALLITO: un esito rifiutato ha cambiato le pubblicazioni o i bundle';
  end if;
end $$;

-- B completa normalmente dopo i tentativi tardivi di A, e solo una volta.
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$
declare r jsonb;
begin
  r := studio_publication_finish('zd.delta', true, '{"ms":2}', pg_temp.bundle_80('8d000000-0000-0000-0000-00000000000c', 'cccccccccccccccc'),
                                 '8d000000-0000-0000-0000-00000000000c');
  if r ->> 'status' <> 'published' or (r ->> 'publication')::uuid <> '8d000000-0000-0000-0000-00000000000c' then
    raise exception 'FALLITO: B non completa: %', r;
  end if;
  begin
    perform studio_publication_finish('zd.delta', false, '{"errors":["doppio"]}', '[]', '8d000000-0000-0000-0000-00000000000c');
    raise exception 'FALLITO: una pubblicazione completata è stata richiusa';
  exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like '%non è più in corso%' then raise; end if; end;
end $$;
reset role;
do $$ begin
  if pg_temp.stato_80('8d000000-0000-0000-0000-00000000000a') <> 'failed' or pg_temp.stato_80('8d000000-0000-0000-0000-00000000000c') <> 'published'
     or (select count(*) from bundles where pack_id = 'zd.delta') <> (select n from foto_prima_80) + 1
     or (select kb_hash from bundles where pack_id = 'zd.delta' order by version desc limit 1) <> 'cccccccccccccccc' then
    raise exception 'FALLITO: stati o bundle dopo il completamento di B';
  end if;
end $$;

-- Due pubblicazioni concorrenti (A e D), ciascuna con il proprio esito: nessuna altera l'altra.
insert into publications (id, pack_id, requested_by, status, report) values
  ('8d000000-0000-0000-0000-00000000000d', 'zd.delta', '80000000-0000-0000-0000-000000000001', 'requested', '{"ok":true}'),
  ('8d000000-0000-0000-0000-00000000000e', 'zd.delta', '80000000-0000-0000-0000-000000000003', 'requested', '{"ok":true}');
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  if (studio_publication_claim('zd.delta') ->> 'ok')::boolean is not true then raise exception 'FALLITO: presa in carico di A'; end if;
end $$;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  if (studio_publication_claim('zd.delta') ->> 'ok')::boolean is not false then raise exception 'FALLITO: la seconda parte mentre la prima è in corso'; end if;
  -- La pubblicazione fermata non può registrare un esito, né sulla propria riga né su quella in corso.
  begin
    perform studio_publication_finish('zd.delta', true, '{}', pg_temp.bundle_80('8d000000-0000-0000-0000-00000000000e', 'eeeeeeeeeeeeeeee'),
                                      '8d000000-0000-0000-0000-00000000000e');
    raise exception 'FALLITO: la pubblicazione fermata registra un esito';
  exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like '%non è più in corso%' then raise; end if; end;
  begin
    perform studio_publication_finish('zd.delta', false, '{}', '[]', '8d000000-0000-0000-0000-00000000000d');
    raise exception 'FALLITO: la pubblicazione fermata chiude quella in corso';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  if studio_publication_finish('zd.delta', false, '{"errors":["prova"]}', '[]', '8d000000-0000-0000-0000-00000000000d') ->> 'status' <> 'failed' then
    raise exception 'FALLITO: esito di A';
  end if;
end $$;
reset role;
do $$ begin
  if pg_temp.stato_80('8d000000-0000-0000-0000-00000000000d') <> 'failed' or pg_temp.stato_80('8d000000-0000-0000-0000-00000000000e') <> 'failed'
     or pg_temp.stato_80('8d000000-0000-0000-0000-00000000000c') <> 'published' then
    raise exception 'FALLITO: stati dopo le due pubblicazioni concorrenti';
  end if;
  if (select (report -> 'pipeline' -> 'errors') ->> 0 from publications where id = '8d000000-0000-0000-0000-00000000000e')
     <> 'un''altra pubblicazione dello stesso territorio era in corso' then
    raise exception 'FALLITO: la pubblicazione fermata ha un esito diverso dal rifiuto';
  end if;
end $$;
drop table foto_prima_80;

-- ---------------------------------------------------------------- rinnovo della presa in carico (R2)
-- Simulato nel database: il «processo» A che ha perso la presa non è un secondo processo reale.
insert into publications (id, pack_id, requested_by, status, report) values
  ('8e000000-0000-0000-0000-00000000000a', 'zd.delta', '80000000-0000-0000-0000-000000000001', 'requested', '{"ok":true}');
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  if (studio_publication_claim('zd.delta') ->> 'publication')::uuid <> '8e000000-0000-0000-0000-00000000000a' then
    raise exception 'FALLITO: presa in carico per il rinnovo';
  end if;
end $$;
reset role;
-- Il rinnovo di chi tiene la presa la rinfresca.
update publications set report = report || jsonb_build_object('buildingSince', now() - interval '5 minutes')
where id = '8e000000-0000-0000-0000-00000000000a';
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  if studio_publication_renew('zd.delta', '8e000000-0000-0000-0000-00000000000a') is not true then raise exception 'FALLITO: rinnovo di chi tiene la presa'; end if;
end $$;
reset role;
do $$ begin
  if (select (report ->> 'buildingSince')::timestamptz from publications where id = '8e000000-0000-0000-0000-00000000000a') < now() - interval '1 minute' then
    raise exception 'FALLITO: il rinnovo non rinfresca la presa in carico';
  end if;
end $$;

-- Rinnovo con l'identificativo giusto ma da un altro utente, per un altro territorio, da un visitatore, da un anonimo:
-- false o rifiutato, e nulla cambia.
create temp table foto_rinnovo_80 as select pg_temp.foto_80('8e000000-0000-0000-0000-00000000000a') as a;
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  if studio_publication_renew('zd.delta', '8e000000-0000-0000-0000-00000000000a') is not false then raise exception 'FALLITO: rinnovo della presa di un altro utente'; end if;
  if studio_publication_renew('ze.epsilon', '8e000000-0000-0000-0000-00000000000a') is not false then raise exception 'FALLITO: rinnovo per un altro territorio'; end if;
end $$;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000002';
do $$ begin
  perform studio_publication_renew('zd.delta', '8e000000-0000-0000-0000-00000000000a');
  raise exception 'FALLITO: un visitatore rinnova una presa in carico';
exception when insufficient_privilege then null;
end $$;
reset role;
set role anon;
do $$ begin
  perform studio_publication_renew('zd.delta', '8e000000-0000-0000-0000-00000000000a');
  raise exception 'FALLITO: un anonimo rinnova una presa in carico';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$ begin
  if pg_temp.foto_80('8e000000-0000-0000-0000-00000000000a') is distinct from (select a from foto_rinnovo_80) then
    raise exception 'FALLITO: un rinnovo rifiutato ha cambiato la pubblicazione';
  end if;
end $$;
drop table foto_rinnovo_80;

-- Una presa scaduta ma rinnovata prima che qualcuno la sostituisca resta valida: chi arriva dopo trova la
-- pubblicazione in corso (una pubblicazione lunga e legittima non viene sostituita).
update publications set report = report || jsonb_build_object('buildingSince', now() - interval '20 minutes')
where id = '8e000000-0000-0000-0000-00000000000a';
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  if studio_publication_renew('zd.delta', '8e000000-0000-0000-0000-00000000000a') is not true then raise exception 'FALLITO: rinnovo prima della sostituzione'; end if;
end $$;
reset role;
insert into publications (id, pack_id, requested_by, status, report) values
  ('8e000000-0000-0000-0000-00000000000b', 'zd.delta', '80000000-0000-0000-0000-000000000003', 'requested', '{"ok":true}');
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  if (studio_publication_claim('zd.delta') ->> 'ok')::boolean is not false then raise exception 'FALLITO: sostituita una presa appena rinnovata'; end if;
end $$;
reset role;

-- A non rinnova più (processo bloccato): la presa scade e B la sostituisce. Il rinnovo tardivo di A risponde false,
-- non cambia nulla, e A non può più né completare né fallire; B continua, rinnova e completa.
update publications set report = report || jsonb_build_object('buildingSince', now() - interval '20 minutes')
where id = '8e000000-0000-0000-0000-00000000000a';
insert into publications (id, pack_id, requested_by, status, report) values
  ('8e000000-0000-0000-0000-00000000000c', 'zd.delta', '80000000-0000-0000-0000-000000000003', 'requested', '{"ok":true}');
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  if (studio_publication_claim('zd.delta') ->> 'publication')::uuid <> '8e000000-0000-0000-0000-00000000000c' then
    raise exception 'FALLITO: B non sostituisce la presa scaduta di A';
  end if;
end $$;
reset role;
create temp table foto_dopo_80 as
  select pg_temp.foto_80('8e000000-0000-0000-0000-00000000000a') as a, pg_temp.foto_80('8e000000-0000-0000-0000-00000000000c') as b;
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  if studio_publication_renew('zd.delta', '8e000000-0000-0000-0000-00000000000a') is not false then raise exception 'FALLITO: A rinnova dopo la sostituzione'; end if;
  begin
    perform studio_publication_finish('zd.delta', false, '{"errors":["tardivo"]}', '[]', '8e000000-0000-0000-0000-00000000000a');
    raise exception 'FALLITO: A fallisce dopo la sostituzione';
  exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like '%non è più in corso%' then raise; end if; end;
end $$;
reset role;
do $$ begin
  if pg_temp.foto_80('8e000000-0000-0000-0000-00000000000a') is distinct from (select a from foto_dopo_80)
     or pg_temp.foto_80('8e000000-0000-0000-0000-00000000000c') is distinct from (select b from foto_dopo_80) then
    raise exception 'FALLITO: i tentativi tardivi di A hanno cambiato A o B';
  end if;
end $$;
drop table foto_dopo_80;
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  if studio_publication_renew('zd.delta', '8e000000-0000-0000-0000-00000000000c') is not true then raise exception 'FALLITO: B rinnova'; end if;
  if studio_publication_finish('zd.delta', true, '{}', pg_temp.bundle_80('8e000000-0000-0000-0000-00000000000c', 'dddddddddddddddd'),
                               '8e000000-0000-0000-0000-00000000000c') ->> 'status' <> 'published' then
    raise exception 'FALLITO: B completa dopo i tentativi tardivi di A';
  end if;
  if studio_publication_renew('zd.delta', '8e000000-0000-0000-0000-00000000000c') is not false then raise exception 'FALLITO: rinnovo di una pubblicazione completata'; end if;
end $$;
reset role;
-- ---------------------------------------------------------------- pubblicazioni immutabili (R2)
-- Stato a questo punto: 8d…0c pubblicata e poi sostituita da 8e…0c (in linea); 8d…0a fallita. Ogni pubblicazione
-- ha manifest e contenuto nella propria cartella <lingua>-full/<id>/ (file creati qui come amministratore del
-- database: le scritture degli utenti sono provate sotto).
insert into storage.objects (bucket_id, name, owner) values
  ('bundles', 'zd.delta/it-full/8d000000-0000-0000-0000-00000000000c/manifest.json', null),
  ('bundles', 'zd.delta/it-full/8d000000-0000-0000-0000-00000000000c/content.cccccccccccccccc.json', null),
  ('bundles', 'zd.delta/it-full/8e000000-0000-0000-0000-00000000000c/manifest.json', null),
  ('bundles', 'zd.delta/it-full/8e000000-0000-0000-0000-00000000000c/content.dddddddddddddddd.json', null),
  ('bundles', 'zd.delta/it-full/8d000000-0000-0000-0000-00000000000a/content.aaaaaaaaaaaaaaaa.json', null);
insert into publications (id, pack_id, requested_by, status, report) values
  ('8f000000-0000-0000-0000-000000000001', 'zd.delta', '80000000-0000-0000-0000-000000000001', 'requested', '{"ok":true}');
-- Staff della piattaforma: numera e carica l'indice pubblico (come refreshPublicIndex nella pipeline).
insert into auth.users (id, email, raw_user_meta_data) values ('80000000-0000-0000-0000-000000000009', 'staff-d@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('80000000-0000-0000-0000-000000000009', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_editor', null);
create function pg_temp.carica_indice_80() returns void language plpgsql as $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000009', true);
  insert into storage.objects (bucket_id, name, owner) values ('bundles', studio_index_snapshot() ->> 'name', auth.uid());
  reset role;
end $$;
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$
declare n int;
begin
  if (studio_publication_claim('zd.delta') ->> 'publication')::uuid <> '8f000000-0000-0000-0000-000000000001' then
    raise exception 'FALLITO: presa in carico di F';
  end if;
  -- Scrive nella cartella della propria pubblicazione in corso, e i media della lingua.
  insert into storage.objects (bucket_id, name, owner) values
    ('bundles', 'zd.delta/it-full/8f000000-0000-0000-0000-000000000001/content.ffffffffffffffff.json', auth.uid()),
    ('bundles', 'zd.delta/it-full/8f000000-0000-0000-0000-000000000001/manifest.json', auth.uid()),
    ('bundles', 'zd.delta/it-full/media/ffffffffffffffff.jpg', auth.uid());
  -- Mai nella cartella di un'altra pubblicazione (in linea, fallita, inventata), mai nella struttura precedente.
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'zd.delta/it-full/8e000000-0000-0000-0000-00000000000c/content.0123456789abcdef.json', auth.uid());
    raise exception 'FALLITO: scritto nella cartella della pubblicazione in linea';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'zd.delta/it-full/8d000000-0000-0000-0000-00000000000a/manifest.json', auth.uid());
    raise exception 'FALLITO: scritto nella cartella di una pubblicazione fallita';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'zd.delta/it-full/12345678-1234-4123-8123-123456789abc/manifest.json', auth.uid());
    raise exception 'FALLITO: scritto nella cartella di una pubblicazione inesistente';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'zd.delta/it-full/manifest.json', auth.uid());
    raise exception 'FALLITO: manifest nella struttura precedente';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'index/00000000000000000001.json', auth.uid());
    raise exception 'FALLITO: un editor di un''istituzione scrive l''indice';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_index_snapshot();
    raise exception 'FALLITO: un editor di un''istituzione numera l''indice';
  exception when insufficient_privilege then null; end;
  -- Nessuna sovrascrittura: senza policy di UPDATE nessuna riga si aggiorna (nemmeno i propri file).
  update storage.objects set owner = auth.uid() where bucket_id = 'bundles' and name like 'zd.delta/%';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLITO: % file del bucket aggiornati', n; end if;
end $$;
-- Un altro editor dello stesso territorio non scrive nella cartella di F (non l'ha presa in carico lui).
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  insert into storage.objects (bucket_id, name, owner) values ('bundles', 'zd.delta/it-full/8f000000-0000-0000-0000-000000000001/content.0123456789abcdef.json', auth.uid());
  raise exception 'FALLITO: scritto nella cartella della pubblicazione di un altro';
exception when insufficient_privilege then null;
end $$;
-- F cancella «tutto» il territorio prima che un indice caricato contenga 8e…0c: l'indice servito può ancora puntare
-- a 8d…0c o alla struttura precedente, quindi va via solo la cartella fallita (8d…0a, mai stata in linea).
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  delete from storage.objects where bucket_id = 'bundles' and (name like 'zd.delta/%' or name like 'ze.epsilon/%' or name like 'index/%');
end $$;
reset role;
do $$ begin
  if exists (select 1 from storage.objects where name like 'zd.delta/it-full/8d000000-0000-0000-0000-00000000000a/%') then
    raise exception 'FALLITO: la cartella di una pubblicazione fallita non è stata cancellata';
  end if;
  if (select count(*) from storage.objects where name in ('zd.delta/it-full/8d000000-0000-0000-0000-00000000000c/manifest.json',
        'zd.delta/it-full/8d000000-0000-0000-0000-00000000000c/content.cccccccccccccccc.json',
        'zd.delta/it-full/content.aaaaaaaaaaaaaaaa.json', 'zd.delta/it-full/content.bbbbbbbbbbbbbbbb.json')) <> 4 then
    raise exception 'FALLITO: cancellati file che l''indice servito può ancora usare (sostituta non ancora nell''indice)';
  end if;
end $$;
-- Lo staff carica un indice fotografato dopo l'esito di 8e…0c: ora 8d…0c e la struttura precedente non sono più
-- usati dall'indice servito. F cancella di nuovo «tutto»: vanno via solo quelli.
-- Restano la versione in linea, la pubblicazione in corso, i media e il manifest della struttura precedente.
select pg_temp.carica_indice_80();
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  delete from storage.objects where bucket_id = 'bundles' and (name like 'zd.delta/%' or name like 'ze.epsilon/%' or name like 'index/%');
end $$;
reset role;
do $$
declare v text;
begin
  select string_agg(name, ' ' order by name) into v from storage.objects where bucket_id = 'bundles' and name like 'zd.delta/%';
  if v is distinct from 'zd.delta/it-full/8e000000-0000-0000-0000-00000000000c/content.dddddddddddddddd.json '
                     || 'zd.delta/it-full/8e000000-0000-0000-0000-00000000000c/manifest.json '
                     || 'zd.delta/it-full/8f000000-0000-0000-0000-000000000001/content.ffffffffffffffff.json '
                     || 'zd.delta/it-full/8f000000-0000-0000-0000-000000000001/manifest.json '
                     || 'zd.delta/it-full/manifest.json '
                     || 'zd.delta/it-full/media/cccccccccccccccc.jpg '
                     || 'zd.delta/it-full/media/ffffffffffffffff.jpg' then
    raise exception 'FALLITO: file rimasti dopo la pulizia: %', v;
  end if;
  if not exists (select 1 from storage.objects where name = 'ze.epsilon/it-full/content.dddddddddddddddd.json') then
    raise exception 'FALLITO: cancellato un file di un altro territorio';
  end if;
end $$;

-- F perde la presa (scaduta) e G la sostituisce: F non scrive più nemmeno nella propria cartella, e non cancella
-- quella di G in corso; la cartella di F, ora fallita, si può cancellare (non è mai andata in linea).
update publications set report = report || jsonb_build_object('buildingSince', now() - interval '20 minutes')
where id = '8f000000-0000-0000-0000-000000000001';
insert into publications (id, pack_id, requested_by, status, report) values
  ('8f000000-0000-0000-0000-000000000002', 'zd.delta', '80000000-0000-0000-0000-000000000003', 'requested', '{"ok":true}');
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  if (studio_publication_claim('zd.delta') ->> 'publication')::uuid <> '8f000000-0000-0000-0000-000000000002' then
    raise exception 'FALLITO: G non sostituisce la presa scaduta di F';
  end if;
  insert into storage.objects (bucket_id, name, owner) values
    ('bundles', 'zd.delta/it-full/8f000000-0000-0000-0000-000000000002/content.eeeeeeeeeeeeeeee.json', auth.uid());
end $$;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000001';
do $$ begin
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'zd.delta/it-full/8f000000-0000-0000-0000-000000000001/content.0123456789abcdef.json', auth.uid());
    raise exception 'FALLITO: F scrive dopo aver perso la presa';
  exception when insufficient_privilege then null; end;
  delete from storage.objects where bucket_id = 'bundles' and name like 'zd.delta/%';
end $$;
reset role;
do $$ begin
  if exists (select 1 from storage.objects where name like 'zd.delta/it-full/8f000000-0000-0000-0000-000000000001/%') then
    raise exception 'FALLITO: la cartella di F, fallita, non è stata cancellata';
  end if;
  if (select count(*) from storage.objects where name in ('zd.delta/it-full/8f000000-0000-0000-0000-000000000002/content.eeeeeeeeeeeeeeee.json',
        'zd.delta/it-full/8e000000-0000-0000-0000-00000000000c/manifest.json', 'zd.delta/it-full/8e000000-0000-0000-0000-00000000000c/content.dddddddddddddddd.json')) <> 3 then
    raise exception 'FALLITO: cancellati i file della versione in linea o della pubblicazione in corso';
  end if;
end $$;

-- Esito: G non può registrare un bundle che punta ai file di un'altra pubblicazione (quella in linea), né un
-- manifest della struttura precedente; registra solo la propria cartella.
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  begin
    perform studio_publication_finish('zd.delta', true, '{}', pg_temp.bundle_80('8e000000-0000-0000-0000-00000000000c', 'dddddddddddddddd'),
                                      '8f000000-0000-0000-0000-000000000002');
    raise exception 'FALLITO: registrato un bundle nella cartella di un''altra pubblicazione';
  exception when raise_exception then if sqlerrm not like 'bundle fuori dalla cartella della pubblicazione%' then raise; end if; end;
  begin
    perform studio_publication_finish('zd.delta', true, '{}',
      jsonb_set(jsonb_set(pg_temp.bundle_80('8f000000-0000-0000-0000-000000000002', 'eeeeeeeeeeeeeeee'),
                          '{0,url}', '"/pub/zd.delta/it-full/manifest.json"'),
                '{0,entry,manifest}', '"/pub/zd.delta/it-full/manifest.json"'),
      '8f000000-0000-0000-0000-000000000002');
    raise exception 'FALLITO: registrato un manifest della struttura precedente';
  exception when raise_exception then if sqlerrm not like 'bundle fuori dalla cartella della pubblicazione%' then raise; end if; end;
  -- La forma senza identificativo non mette più in linea nulla (lo Studio precedente non pubblica).
  begin
    perform studio_publication_finish('zd.delta', true, '{}', pg_temp.bundle_80('8f000000-0000-0000-0000-000000000002', 'eeeeeeeeeeeeeeee'));
    raise exception 'FALLITO: la forma senza identificativo ha messo in linea una pubblicazione';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  if studio_publication_finish('zd.delta', true, '{}', pg_temp.bundle_80('8f000000-0000-0000-0000-000000000002', 'eeeeeeeeeeeeeeee'),
                               '8f000000-0000-0000-0000-000000000002') ->> 'status' <> 'published' then
    raise exception 'FALLITO: G non completa';
  end if;
  -- 8e…0c è sostituita ma nessun indice caricato contiene G: l'indice servito punta ancora a 8e…0c, che resta.
  delete from storage.objects where bucket_id = 'bundles' and name like 'zd.delta/%';
end $$;
reset role;
do $$ begin
  if (select count(*) from storage.objects where name like 'zd.delta/it-full/8e000000-0000-0000-0000-00000000000c/%') <> 2 then
    raise exception 'FALLITO: cancellata la versione ancora servita dall''indice in vigore';
  end if;
end $$;
-- Con un indice che contiene G, la cartella di 8e…0c si cancella; quella di G, in linea, no.
select pg_temp.carica_indice_80();
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000003';
do $$ begin
  delete from storage.objects where bucket_id = 'bundles' and name like 'zd.delta/%';
end $$;
reset role;
do $$
declare v text;
begin
  select string_agg(name, ' ' order by name) into v from storage.objects where bucket_id = 'bundles' and name like 'zd.delta/%/%-%';
  if v is distinct from 'zd.delta/it-full/8f000000-0000-0000-0000-000000000002/content.eeeeeeeeeeeeeeee.json' then
    raise exception 'FALLITO: cartelle rimaste dopo la seconda pulizia: %', v;
  end if;
end $$;

-- Indice numerato: lo numera solo chi pubblica per la piattaforma; un nome si scrive solo se già emesso, una volta.
set role authenticated;
set request.jwt.claim.sub = '80000000-0000-0000-0000-000000000009';
do $$
declare a jsonb; b jsonb; n int;
begin
  a := studio_index_snapshot();
  b := studio_index_snapshot();
  if (b ->> 'generation')::bigint <= (a ->> 'generation')::bigint or b ->> 'name' <= a ->> 'name' then
    raise exception 'FALLITO: numeri dell''indice non crescenti: % %', a ->> 'name', b ->> 'name';
  end if;
  if b -> 'index' -> 'bundles' is null then raise exception 'FALLITO: fotografia senza indice'; end if;
  insert into storage.objects (bucket_id, name, owner) values ('bundles', b ->> 'name', auth.uid()), ('bundles', a ->> 'name', auth.uid());
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', b ->> 'name', auth.uid());
    raise exception 'FALLITO: indice numerato scritto due volte';
  exception when unique_violation then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('bundles', 'index/' || lpad(((b ->> 'generation')::bigint + 1)::text, 20, '0') || '.json', auth.uid());
    raise exception 'FALLITO: indice con un numero non ancora emesso';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'index/99999999999999999999.json', auth.uid());
    raise exception 'FALLITO: indice con un numero oltre ogni emissione';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name, owner) values ('bundles', 'index/00000000000000000000.json', auth.uid());
    raise exception 'FALLITO: indice numero zero';
  exception when insufficient_privilege then null; end;
  -- Gli indici non si cancellano né si aggiornano.
  delete from storage.objects where bucket_id = 'bundles' and name = b ->> 'name';
  update storage.objects set owner = auth.uid() where bucket_id = 'bundles' and name = b ->> 'name';
  get diagnostics n = row_count;
  if n <> 0 or not exists (select 1 from storage.objects where bucket_id = 'bundles' and name = b ->> 'name') then
    raise exception 'FALLITO: indice numerato cancellato o aggiornato';
  end if;
end $$;
reset role;
-- L'anonimo vede (elenca) gli indici numerati, e solo quelli.
set role anon;
do $$ begin
  if not exists (select 1 from storage.objects where bucket_id = 'bundles' and name ~ '^index/[0-9]{20}\.json$') then
    raise exception 'FALLITO: un anonimo non elenca gli indici numerati';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'bundles' and name !~ '^index/[0-9]{20}\.json$') then
    raise exception 'FALLITO: un anonimo elenca altri file';
  end if;
end $$;
reset role;

delete from bundles where pack_id = 'zd.delta';
delete from publications where pack_id = 'zd.delta';

select 'bucket bundles: tutti i controlli superati';
