-- Test del registro delle domande senza risposta (20261103000000_question_gaps.sql):
--   Q1 anon: non legge, non scrive, non esegue nessuna funzione;
--   Q2 utente autenticato senza permessi sul territorio: non scrive, non legge, non cambia stato né elimina;
--   Q3 ruolo di servizio: registra con gap_record (raggruppamento, contatore, lingue separate, fonti ripulite, valori
--      rifiutati senza eccezioni), ma non ha privilegi diretti sulle tabelle;
--   Q4 redattore: legge e rivede solo le domande del suo territorio; elimina; chi e quando lo registra il database;
--   Q5 scadenza: una riga scaduta non si legge più e la prossima registrazione la cancella;
--   Q6 tetto globale del giorno: oltre il tetto niente righe nuove, ma le domande già viste si contano ancora;
--      contatore con tetto;
--   Q7 proprietà delle funzioni (definer, search_path, permessi) e nessun privilegio diretto sulle tabelle.
-- La concorrenza (stessa domanda e tetto con richieste simultanee) è in concurrent.sh. Usa territori propri (zq.*) e
-- alla fine li ripulisce.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values
  ('9c000000-0000-0000-0000-00000000000a', 'institution', 'Comune Q (prova)'),
  ('9c000000-0000-0000-0000-00000000000b', 'institution', 'Comune R (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zq.domande', 'destination', '9c000000-0000-0000-0000-00000000000a', 'it', '{it,en}', '{"it":"Domande"}', '{}'),
  ('zq.altro', 'destination', '9c000000-0000-0000-0000-00000000000b', 'it', '{it}', '{"it":"Altro"}', '{}'),
  ('zq.regione', 'region', '9c000000-0000-0000-0000-00000000000a', 'it', '{it}', '{"it":"Regione"}', '{}');
insert into destinations (pack_id, status) values ('zq.domande', 'published'), ('zq.altro', 'published');
insert into auth.users (id, email, raw_user_meta_data) values
  ('9c000000-0000-0000-0000-000000000001', 'redattore-q@prova.test', '{}'),
  ('9c000000-0000-0000-0000-000000000002', 'redattore-r@prova.test', '{}'),
  ('9c000000-0000-0000-0000-000000000003', 'turista-q@prova.test', '{}'),
  ('9c000000-0000-0000-0000-000000000004', 'traduttore-q@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('9c000000-0000-0000-0000-000000000001', '9c000000-0000-0000-0000-00000000000a', 'territory_editor', 'zq.domande'),
  ('9c000000-0000-0000-0000-000000000002', '9c000000-0000-0000-0000-00000000000b', 'territory_editor', 'zq.altro'),
  ('9c000000-0000-0000-0000-000000000004', '9c000000-0000-0000-0000-00000000000a', 'translator', 'zq.domande');

-- ---------------------------------------------------------------- Q3 (prima, per avere righe da leggere)
set role service_role;
do $$
declare r text;
begin
  r := gap_record('zq.domande', 'it', 'Perché il castello ha quella torre?', 'perché il castello ha quella torre', 'not_in_knowledge',
                  'zq.domande:castello', null, null, '[]', 'kb-1', 'p1');
  if r <> 'created' then raise exception 'FALLITO Q3: prima registrazione: %', r; end if;
  -- Stesso testo normalizzato (maiuscole e punteggiatura diverse nel testo originale): stessa riga, contatore a 2.
  r := gap_record('zq.domande', 'it', 'perché il CASTELLO ha quella torre', 'perché il castello ha quella torre', 'partial');
  if r <> 'updated' then raise exception 'FALLITO Q3: domanda uguale non raggruppata: %', r; end if;
  -- Altra lingua: riga distinta.
  r := gap_record('zq.domande', 'en', 'Why does the castle have that tower?', 'why does the castle have that tower', 'not_in_knowledge');
  if r <> 'created' then raise exception 'FALLITO Q3: lingua: %', r; end if;
  -- Fonti web: solo https ben formati, solo indirizzo e titolo, al massimo cinque.
  r := gap_record('zq.domande', 'it', 'Chi era il vescovo?', 'chi era il vescovo', 'web_answer', null, null, null,
    jsonb_build_array(
      jsonb_build_object('url', 'http://insicuro.example.it/a', 'title', 'no'),
      jsonb_build_object('url', 'https://a.example.it/1', 'title', 'A', 'citedText', 'testo da non salvare'),
      jsonb_build_object('url', 'https://b.example.it/2', 'title', 'B'), jsonb_build_object('url', 'https://c.example.it/3', 'title', 'C'),
      jsonb_build_object('url', 'https://d.example.it/4', 'title', 'D'), jsonb_build_object('url', 'https://e.example.it/5', 'title', 'E'),
      jsonb_build_object('url', 'https://f.example.it/6', 'title', 'F'), '"non un oggetto"'::jsonb));
  if r <> 'created' then raise exception 'FALLITO Q3: risposta dal web: %', r; end if;
  -- Valori non validi: nessuna eccezione (il server non deve registrare testi nei log), solo l'esito.
  if gap_record('zq.domande', 'it', 'x', 'x', 'partial') <> 'invalid' then raise exception 'FALLITO Q3: domanda troppo corta'; end if;
  if gap_record('zq.domande', 'it', repeat('a', 301), 'a', 'partial') <> 'invalid' then raise exception 'FALLITO Q3: domanda troppo lunga'; end if;
  if gap_record('zq.domande', 'it', 'Domanda valida', 'Domanda Valida', 'partial') <> 'invalid' then raise exception 'FALLITO Q3: chiave non normalizzata'; end if;
  if gap_record('zq.domande', 'it', 'Domanda valida', 'domanda  valida', 'partial') <> 'invalid' then raise exception 'FALLITO Q3: chiave con spazi doppi'; end if;
  if gap_record('zq.domande', 'ita', 'Domanda valida', 'domanda valida', 'partial') <> 'invalid' then raise exception 'FALLITO Q3: lingua'; end if;
  if gap_record('zq.domande', 'it', 'Domanda valida', 'domanda valida', 'answered') <> 'invalid' then raise exception 'FALLITO Q3: esito non ammesso'; end if;
  if gap_record('zq.domande', 'it', 'Domanda valida', 'domanda valida', 'partial', repeat('p', 201)) <> 'invalid' then raise exception 'FALLITO Q3: luogo troppo lungo'; end if;
  if gap_record('zq.inesistente', 'it', 'Domanda valida', 'domanda valida', 'partial') <> 'unknown_pack' then raise exception 'FALLITO Q3: territorio inesistente'; end if;
  if gap_record('zq.regione', 'it', 'Domanda valida', 'domanda valida', 'partial') <> 'unknown_pack' then raise exception 'FALLITO Q3: territorio che non è una destinazione'; end if;
  -- Il ruolo di servizio non ha privilegi diretti: scrive solo con gap_record.
  begin
    perform 1 from question_gaps;
    raise exception 'FALLITO Q3: il ruolo di servizio legge la tabella';
  exception when insufficient_privilege then null; end;
  begin
    insert into question_gaps (pack_id, locale, fingerprint, question, kind) values ('zq.domande', 'it', repeat('0', 64), 'Diretta', 'partial');
    raise exception 'FALLITO Q3: il ruolo di servizio scrive direttamente';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_question_gaps('zq.domande');
    raise exception 'FALLITO Q3: il ruolo di servizio esegue le funzioni dello Studio';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$
declare g question_gaps;
begin
  select * into g from question_gaps where pack_id = 'zq.domande' and locale = 'it' and question like 'Perché il castello%';
  if g.hits <> 2 or g.kind <> 'partial' or g.question <> 'Perché il castello ha quella torre?' or g.place_ref is not null then
    raise exception 'FALLITO Q3: raggruppamento (contatore %, esito %, testo %, luogo %)', g.hits, g.kind, g.question, g.place_ref;
  end if;
  if g.fingerprint <> encode(sha256(convert_to('perché il castello ha quella torre', 'UTF8')), 'hex') then raise exception 'FALLITO Q3: impronta'; end if;
  if g.first_seen <> current_date or g.last_seen <> current_date or g.expires_at <> current_date + 90 or g.review_status <> 'new' then
    raise exception 'FALLITO Q3: date o stato iniziale';
  end if;
  select * into g from question_gaps where pack_id = 'zq.domande' and question = 'Chi era il vescovo?';
  if jsonb_array_length(g.web_sources) <> 5 or g.web_sources -> 0 <> '{"url":"https://a.example.it/1","title":"A"}'::jsonb then
    raise exception 'FALLITO Q3: fonti web non ripulite: %', g.web_sources;
  end if;
  if (select count(*) from question_gaps where pack_id like 'zq.%') <> 3 then raise exception 'FALLITO Q3: righe in più'; end if;
  if (select new_rows from question_gap_daily where day = current_date) < 3 then raise exception 'FALLITO Q3: righe nuove del giorno non contate'; end if;
end $$;
-- Una riga dell'altro territorio, per l'isolamento.
set role service_role;
select gap_record('zq.altro', 'it', 'Dov''è il molo?', 'dov è il molo', 'not_in_knowledge');
reset role;

-- ---------------------------------------------------------------- Q1 anon
set role anon;
do $$
begin
  begin
    perform 1 from question_gaps;
    raise exception 'FALLITO Q1: anon legge le domande';
  exception when insufficient_privilege then null; end;
  begin
    perform gap_record('zq.domande', 'it', 'Domanda di anon', 'domanda di anon', 'partial');
    raise exception 'FALLITO Q1: anon registra domande';
  exception when insufficient_privilege then null; end;
  begin
    insert into question_gaps (pack_id, locale, fingerprint, question, kind) values ('zq.domande', 'it', repeat('1', 64), 'Diretta', 'partial');
    raise exception 'FALLITO Q1: anon scrive direttamente';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_question_gaps('zq.domande');
    raise exception 'FALLITO Q1: anon esegue le funzioni dello Studio';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from question_gap_daily;
    raise exception 'FALLITO Q1: anon legge il conteggio del giorno';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- Q2 autenticato senza permessi
set role authenticated;
set request.jwt.claim.sub = '9c000000-0000-0000-0000-000000000003';
do $$
begin
  if exists (select 1 from question_gaps) then raise exception 'FALLITO Q2: un turista legge le domande'; end if;
  begin
    perform gap_record('zq.domande', 'it', 'Domanda del turista', 'domanda del turista', 'partial');
    raise exception 'FALLITO Q2: un turista registra domande';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_question_gaps('zq.domande');
    raise exception 'FALLITO Q2: un turista legge le domande dallo Studio';
  exception when insufficient_privilege then null; end;
  begin
    update question_gaps set review_status = 'ignored';
    raise exception 'FALLITO Q2: aggiornamento diretto';
  exception when insufficient_privilege then null; end;
  begin
    delete from question_gaps;
    raise exception 'FALLITO Q2: eliminazione diretta';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- L'id letto come postgres: il turista non lo vede, ma potrebbe indovinarlo.
do $$
declare v uuid := (select id from question_gaps where pack_id = 'zq.domande' and locale = 'en');
begin
  perform set_config('q.id', v::text, false);
end $$;
set role authenticated;
set request.jwt.claim.sub = '9c000000-0000-0000-0000-000000000003';
do $$
begin
  begin
    perform studio_set_question_gap_status(current_setting('q.id')::uuid, 'ignored');
    raise exception 'FALLITO Q2: un turista cambia lo stato';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_delete_question_gap(current_setting('q.id')::uuid);
    raise exception 'FALLITO Q2: un turista elimina una domanda';
  exception when insufficient_privilege then null; end;
end $$;
-- Un traduttore del territorio è staff ma non modifica i contenuti: non vede le domande.
set request.jwt.claim.sub = '9c000000-0000-0000-0000-000000000004';
do $$
begin
  if exists (select 1 from question_gaps) then raise exception 'FALLITO Q2: il traduttore legge le domande'; end if;
  begin
    perform studio_question_gaps('zq.domande');
    raise exception 'FALLITO Q2: il traduttore legge le domande dallo Studio';
  exception when insufficient_privilege then null; end;
end $$;
-- Il redattore di un altro territorio non vede né tocca queste domande.
set request.jwt.claim.sub = '9c000000-0000-0000-0000-000000000002';
do $$
begin
  if exists (select 1 from question_gaps where pack_id = 'zq.domande') then raise exception 'FALLITO Q2: isolamento tra territori'; end if;
  if (select count(*) from question_gaps) <> 1 then raise exception 'FALLITO Q2: il redattore R non vede le sue domande'; end if;
  begin
    perform studio_question_gaps('zq.domande');
    raise exception 'FALLITO Q2: il redattore R legge le domande di un altro territorio';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_set_question_gap_status(current_setting('q.id')::uuid, 'covered');
    raise exception 'FALLITO Q2: il redattore R cambia lo stato in un altro territorio';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_delete_question_gap(current_setting('q.id')::uuid);
    raise exception 'FALLITO Q2: il redattore R elimina in un altro territorio';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- Q4 redattore del territorio
set role authenticated;
set request.jwt.claim.sub = '9c000000-0000-0000-0000-000000000001';
do $$
declare
  l jsonb;
  g jsonb;
begin
  l := studio_question_gaps('zq.domande');
  if jsonb_array_length(l) <> 3 then raise exception 'FALLITO Q4: il redattore vede % domande', jsonb_array_length(l); end if;
  if (l -> 0 ->> 'hits')::int <> 2 then raise exception 'FALLITO Q4: le più frequenti prima'; end if;
  if l -> 0 ? 'fingerprint' or l -> 0 ? 'reviewedBy' then raise exception 'FALLITO Q4: campi interni esposti'; end if;
  g := studio_set_question_gap_status((l -> 0 ->> 'id')::uuid, 'planned');
  if g ->> 'status' <> 'planned' or g ->> 'reviewedAt' is null then raise exception 'FALLITO Q4: stato'; end if;
  begin
    perform studio_set_question_gap_status((l -> 0 ->> 'id')::uuid, 'pubblicata');
    raise exception 'FALLITO Q4: stato sconosciuto accettato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  perform studio_set_question_gap_status((l -> 1 ->> 'id')::uuid, 'covered');
  perform studio_set_question_gap_status((l -> 2 ->> 'id')::uuid, 'ignored');
  -- Un aggiornamento diretto resta vietato anche al redattore (stato, autore e date li scrive solo la funzione).
  begin
    update question_gaps set hits = 1;
    raise exception 'FALLITO Q4: aggiornamento diretto del redattore';
  exception when insufficient_privilege then null; end;
  perform studio_delete_question_gap(current_setting('q.id')::uuid);
  if jsonb_array_length(studio_question_gaps('zq.domande')) <> 2 then raise exception 'FALLITO Q4: eliminazione'; end if;
  begin
    perform studio_delete_question_gap(current_setting('q.id')::uuid);
    raise exception 'FALLITO Q4: eliminata due volte';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
reset role;
do $$
begin
  if (select reviewed_by from question_gaps where pack_id = 'zq.domande' and review_status = 'planned') <> '9c000000-0000-0000-0000-000000000001' then
    raise exception 'FALLITO Q4: autore della revisione non registrato';
  end if;
end $$;
-- Una domanda già rivista che torna: cresce il contatore, lo stato della revisione resta.
set role service_role;
select gap_record('zq.domande', 'it', 'Perché il castello ha quella torre?', 'perché il castello ha quella torre', 'not_in_knowledge');
reset role;
do $$
begin
  if (select review_status from question_gaps where pack_id = 'zq.domande' and question like 'Perché il castello%') <> 'planned'
     or (select hits from question_gaps where pack_id = 'zq.domande' and question like 'Perché il castello%') <> 3 then
    raise exception 'FALLITO Q4: una domanda che torna perde lo stato o non si conta';
  end if;
end $$;

-- ---------------------------------------------------------------- Q5 scadenza
update question_gaps set first_seen = current_date - 120, last_seen = current_date - 100, expires_at = current_date - 10
where pack_id = 'zq.domande' and question = 'Chi era il vescovo?';
set role authenticated;
set request.jwt.claim.sub = '9c000000-0000-0000-0000-000000000001';
do $$
begin
  if exists (select 1 from question_gaps where question = 'Chi era il vescovo?') then raise exception 'FALLITO Q5: una riga scaduta si legge ancora'; end if;
  if jsonb_array_length(studio_question_gaps('zq.domande')) <> 1 then raise exception 'FALLITO Q5: la riga scaduta è nello Studio'; end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from question_gaps where question = 'Chi era il vescovo?') then raise exception 'FALLITO Q5: cancellata prima della registrazione successiva'; end if;
end $$;
set role service_role;
select gap_record('zq.domande', 'it', 'Un''altra domanda', 'un altra domanda', 'partial');
reset role;
do $$
begin
  if exists (select 1 from question_gaps where question = 'Chi era il vescovo?') then raise exception 'FALLITO Q5: la riga scaduta non è stata cancellata'; end if;
end $$;

-- ---------------------------------------------------------------- Q6 tetto del giorno e contatore
update question_gap_daily set new_rows = 500 where day = current_date;
set role service_role;
do $$
begin
  if gap_record('zq.domande', 'it', 'Domanda nuova oltre il tetto', 'domanda nuova oltre il tetto', 'partial') <> 'limit' then
    raise exception 'FALLITO Q6: riga nuova oltre il tetto del giorno';
  end if;
  if gap_record('zq.domande', 'it', 'Un''altra domanda', 'un altra domanda', 'partial') <> 'updated' then
    raise exception 'FALLITO Q6: una domanda già vista non si conta più oltre il tetto';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from question_gaps where question = 'Domanda nuova oltre il tetto') then raise exception 'FALLITO Q6: riga creata oltre il tetto'; end if;
  if (select new_rows from question_gap_daily where day = current_date) <> 500 then raise exception 'FALLITO Q6: conteggio del giorno cambiato oltre il tetto'; end if;
end $$;
update question_gap_daily set new_rows = 0 where day = current_date;
update question_gaps set hits = 10000 where question = 'Un''altra domanda';
set role service_role;
select gap_record('zq.domande', 'it', 'Un''altra domanda', 'un altra domanda', 'partial');
reset role;
do $$
begin
  if (select hits from question_gaps where question = 'Un''altra domanda') <> 10000 then raise exception 'FALLITO Q6: contatore oltre il tetto'; end if;
end $$;

-- ---------------------------------------------------------------- Q7 proprietà delle funzioni
do $$
declare f record;
begin
  for f in select * from (values
      ('gap_record(text,text,text,text,text,text,text,text,jsonb,text,text)', false, false, true, true),
      ('studio_question_gaps(text)', false, true, false, false),
      ('studio_set_question_gap_status(uuid,text)', false, true, false, true),
      ('studio_delete_question_gap(uuid)', false, true, false, true),
      ('studio_question_gap_json(question_gaps)', false, true, false, false)
    ) as t(sig, anon_exec, auth_exec, service_exec, definer) loop
    if has_function_privilege('anon', f.sig, 'execute') is distinct from f.anon_exec then raise exception 'FALLITO Q7: anon su %', f.sig; end if;
    if has_function_privilege('authenticated', f.sig, 'execute') is distinct from f.auth_exec then raise exception 'FALLITO Q7: authenticated su %', f.sig; end if;
    if has_function_privilege('service_role', f.sig, 'execute') is distinct from f.service_exec then raise exception 'FALLITO Q7: service_role su %', f.sig; end if;
    if (select prosecdef from pg_proc where oid = f.sig::regprocedure) is distinct from f.definer then raise exception 'FALLITO Q7: SECURITY DEFINER di %', f.sig; end if;
    if (select proconfig from pg_proc where oid = f.sig::regprocedure) is distinct from array['search_path=public'] then
      raise exception 'FALLITO Q7: search_path di %', f.sig;
    end if;
  end loop;
  for f in select * from (values ('anon'), ('authenticated'), ('service_role')) as t(r) loop
    if has_table_privilege(f.r, 'question_gaps', 'insert') or has_table_privilege(f.r, 'question_gaps', 'update')
       or has_table_privilege(f.r, 'question_gaps', 'delete') or has_table_privilege(f.r, 'question_gap_daily', 'select')
       or has_table_privilege(f.r, 'question_gap_daily', 'update') then
      raise exception 'FALLITO Q7: % ha privilegi diretti di scrittura', f.r;
    end if;
  end loop;
  if has_table_privilege('anon', 'question_gaps', 'select') or has_table_privilege('service_role', 'question_gaps', 'select') then
    raise exception 'FALLITO Q7: lettura diretta per anon o per il ruolo di servizio';
  end if;
end $$;

-- ---------------------------------------------------------------- pulizia
delete from question_gaps where pack_id like 'zq.%';
delete from question_gap_daily;
\echo 'domande senza risposta: Q1–Q7 superati'
