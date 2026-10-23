-- Domande senza risposta: le lacune della base di conoscenza che la guida rileva, raccolte per la redazione.
--
-- Dati operativi, fuori dai Territory Pack, dai bundle e dalla base dell'AI: non entrano in pack_snapshot()/import_pack()
-- e nessuna riga diventa da sola un contenuto. Servono alla redazione per decidere cosa aggiungere al pack.
--
-- Raccolta minima (vedi docs/v0.3-platform/DOMANDE-SENZA-RISPOSTA.md):
--   - una riga per domanda distinta (stessa destinazione, lingua e testo normalizzato) con un contatore, mai le
--     conversazioni: niente risposte, cronologia, posizione, indirizzo IP, account o orari precisi (solo il giorno);
--   - il testo arriva già mascherato dal server (email, telefoni, IBAN, codici fiscali, indirizzi web), al massimo 300
--     caratteri. Il mascheramento automatico non riconosce nomi e altri riferimenti: il testo non è anonimo;
--   - scadenza 90 giorni dall'ultima volta che la domanda è stata fatta; oltre, la riga non si legge più e si cancella.
--
-- Garanzie applicate dal database:
--   - scrive solo gap_record(), eseguibile soltanto dal ruolo di servizio (il server della guida, mai il browser);
--     nessuno, nemmeno il ruolo di servizio, ha privilegi diretti sulle tabelle;
--   - tetto globale di righe nuove al giorno, contato in modo atomico (riga del giorno bloccata dall'upsert): le
--     richieste simultanee non lo superano; la stessa domanda ripetuta aumenta un contatore, non la tabella;
--   - legge, cambia lo stato ed elimina solo chi può modificare il territorio (can_edit_pack), attraverso le funzioni
--     dello Studio; le funzioni che scrivono toccano solo le colonne della revisione o la riga indicata.

-- ---------------------------------------------------------------- 1. vocabolari

-- Come la guida ha chiuso la domanda (lo decide il sistema dall'esito della risposta, non da parole chiave):
--   not_in_knowledge: la base non contiene l'informazione;  partial: la contiene solo in parte;
--   rejected: la risposta del modello non ha superato i controlli;  web_answer: l'ha completata la ricerca online;
--   web_unavailable: serviva la ricerca online ma non era possibile;  ambiguous: la domanda rimandava a un luogo non indicato.
create type question_gap_kind as enum ('not_in_knowledge', 'partial', 'rejected', 'web_answer', 'web_unavailable', 'ambiguous');
create type question_gap_review as enum ('new', 'planned', 'covered', 'ignored');

-- ---------------------------------------------------------------- 2. tabelle

create table question_gaps (
  id             uuid primary key default gen_random_uuid(),
  pack_id        text not null references packs (id) on delete cascade,
  locale         text not null check (locale ~ '^[a-z]{2}$'),
  -- sha256 del testo normalizzato (calcolato qui, non dal chiamante): raggruppa le domande uguali.
  fingerprint    text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  question       text not null check (length(question) between 2 and 300),
  kind           question_gap_kind not null,
  place_ref      text check (length(place_ref) <= 200),
  selected_ref   text check (length(selected_ref) <= 200),
  reject_reason  text check (length(reject_reason) <= 120),
  web_sources    jsonb not null default '[]' check (jsonb_typeof(web_sources) = 'array' and jsonb_array_length(web_sources) <= 5),
  kb_hash        text check (length(kb_hash) <= 80),
  prompt_version text check (length(prompt_version) <= 40),
  hits           integer not null default 1 check (hits between 1 and 10000),
  first_seen     date not null default current_date,
  last_seen      date not null default current_date,
  expires_at     date not null default current_date + 90,
  review_status  question_gap_review not null default 'new',
  reviewed_by    uuid references auth.users (id) on delete set null,
  reviewed_at    timestamptz,
  unique (pack_id, locale, fingerprint),
  check (last_seen >= first_seen and expires_at > last_seen)
);
create index question_gaps_pack_idx on question_gaps (pack_id, hits desc, last_seen desc);
create index question_gaps_expiry_idx on question_gaps (expires_at);

-- Righe nuove per giorno (tutte le destinazioni): il tetto globale. Si tiene una settimana.
create table question_gap_daily (
  day      date primary key,
  new_rows integer not null check (new_rows >= 0)
);

-- ---------------------------------------------------------------- 3. accesso diretto (RLS)

alter table question_gaps enable row level security;
alter table question_gap_daily enable row level security;
revoke all on question_gaps, question_gap_daily from public, anon, authenticated, service_role;
-- Lettura per lo Studio: solo le righe dei territori che si possono modificare, e non scadute.
grant select on question_gaps to authenticated;
create policy question_gaps_editor_read on question_gaps for select
  using (can_edit_pack(pack_id) and expires_at >= current_date);

-- ---------------------------------------------------------------- 4. scrittura dal server della guida

-- Registra una domanda senza risposta. Restituisce 'created', 'updated', 'limit' (tetto del giorno raggiunto),
-- 'unknown_pack' o 'invalid': nessuna eccezione per i dati del visitatore, così il server non registra testi nei log.
-- p_key è il testo normalizzato dal server (minuscolo, solo lettere e cifre separate da uno spazio): qui diventa
-- l'impronta. Ogni chiamata cancella fino a 100 righe scadute (pulizia senza processi pianificati).
create function gap_record(
  p_pack text, p_locale text, p_question text, p_key text, p_kind text,
  p_place text default null, p_selected text default null, p_reason text default null,
  p_web_sources jsonb default '[]', p_kb_hash text default null, p_prompt text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  c_daily_cap constant integer := 500;
  v_question text := btrim(p_question);
  v_key text := btrim(p_key);
  v_kind question_gap_kind;
  v_fp text;
  v_sources jsonb;
  v_slot integer;
  v_id uuid;
begin
  if v_question is null or length(v_question) not between 2 and 300
     or v_key is null or length(v_key) not between 1 and 300 or v_key <> lower(v_key) or v_key ~ '\s\s'
     or p_locale is null or p_locale !~ '^[a-z]{2}$'
     or length(p_place) > 200 or length(p_selected) > 200 or length(p_kb_hash) > 80 or length(p_prompt) > 40 then
    return 'invalid';
  end if;
  begin
    v_kind := p_kind::question_gap_kind;
  exception when invalid_text_representation then return 'invalid'; end;
  if p_pack is null or not exists (select 1 from destinations where pack_id = p_pack) then return 'unknown_pack'; end if;

  delete from question_gaps where id in (select id from question_gaps where expires_at < current_date order by expires_at limit 100);
  delete from question_gap_daily where day < current_date - 7;

  v_fp := encode(sha256(convert_to(v_key, 'UTF8')), 'hex');
  -- Fonti web: solo indirizzo https e titolo, al massimo cinque.
  v_sources := coalesce((
    select jsonb_agg(jsonb_build_object('url', s ->> 'url', 'title', left(coalesce(s ->> 'title', ''), 200)))
    from (select s from jsonb_array_elements(case when jsonb_typeof(p_web_sources) = 'array' then p_web_sources else '[]' end) s
          where jsonb_typeof(s) = 'object' and is_public_https_url(s ->> 'url') limit 5) x), '[]');

  -- Domanda già vista: cresce il contatore, nessun posto nuovo nel tetto. Lo stato della revisione non cambia.
  update question_gaps set
    hits = least(hits + 1, 10000), last_seen = current_date, expires_at = current_date + 90,
    kind = v_kind, place_ref = p_place, selected_ref = p_selected, reject_reason = left(p_reason, 120),
    web_sources = v_sources, kb_hash = p_kb_hash, prompt_version = p_prompt
  where pack_id = p_pack and locale = p_locale and fingerprint = v_fp
  returning id into v_id;
  if v_id is not null then return 'updated'; end if;

  -- Riga nuova: prima il posto nel tetto del giorno. L'upsert blocca la riga del giorno, quindi due richieste
  -- simultanee non leggono lo stesso conteggio; oltre il tetto non restituisce nulla.
  insert into question_gap_daily as d (day, new_rows) values (current_date, 1)
  on conflict (day) do update set new_rows = d.new_rows + 1 where d.new_rows < c_daily_cap
  returning new_rows into v_slot;
  if v_slot is null then return 'limit'; end if;

  -- La stessa domanda inserita in parallelo da un'altra richiesta: si somma al contatore.
  insert into question_gaps (pack_id, locale, fingerprint, question, kind, place_ref, selected_ref, reject_reason,
                             web_sources, kb_hash, prompt_version)
  values (p_pack, p_locale, v_fp, v_question, v_kind, p_place, p_selected, left(p_reason, 120), v_sources, p_kb_hash, p_prompt)
  on conflict (pack_id, locale, fingerprint) do update set
    hits = least(question_gaps.hits + 1, 10000), last_seen = current_date, expires_at = current_date + 90;
  return 'created';
end;
$$;

-- ---------------------------------------------------------------- 5. funzioni dello Studio

create function studio_question_gap_json(g question_gaps)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', g.id, 'pack', g.pack_id, 'locale', g.locale, 'question', g.question, 'kind', g.kind,
    'place', g.place_ref, 'selected', g.selected_ref, 'reason', g.reject_reason, 'webSources', g.web_sources,
    'hits', g.hits, 'firstSeen', g.first_seen, 'lastSeen', g.last_seen, 'expiresAt', g.expires_at,
    'status', g.review_status, 'reviewedAt', g.reviewed_at);
$$;

-- Domande di un territorio, le più frequenti prima (al massimo 500). Con l'identità di chi legge: le policy filtrano.
create function studio_question_gaps(p_pack text)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per le domande di questo territorio');
  return coalesce((
    select jsonb_agg(studio_question_gap_json(g) order by g.hits desc, g.last_seen desc, g.id)
    from (select * from question_gaps where pack_id = p_pack and expires_at >= current_date
          order by hits desc, last_seen desc, id limit 500) g), '[]');
end;
$$;

-- Stato della revisione: da vedere, in programma, coperta, ignorata. Cambia solo queste colonne; chi e quando li
-- registra il database.
create function studio_set_question_gap_status(p_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row question_gaps;
  v_status question_gap_review;
begin
  select * into v_row from question_gaps where id = p_id and expires_at >= current_date;
  if v_row.id is null then raise exception 'domanda non trovata'; end if;
  perform studio_require(can_edit_pack(v_row.pack_id), 'non hai i permessi per le domande di questo territorio');
  begin
    v_status := p_status::question_gap_review;
  exception when invalid_text_representation then raise exception 'stato sconosciuto: %', p_status; end;
  update question_gaps set review_status = v_status, reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_id returning * into v_row;
  return studio_question_gap_json(v_row);
end;
$$;

-- Elimina una domanda (per esempio se il testo contiene dati personali sfuggiti al mascheramento).
create function studio_delete_question_gap(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_pack text;
begin
  select pack_id into v_pack from question_gaps where id = p_id;
  if v_pack is null then raise exception 'domanda non trovata'; end if;
  perform studio_require(can_edit_pack(v_pack), 'non hai i permessi per le domande di questo territorio');
  delete from question_gaps where id = p_id;
end;
$$;

-- ---------------------------------------------------------------- 6. permessi sulle funzioni

revoke execute on function gap_record(text, text, text, text, text, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function gap_record(text, text, text, text, text, text, text, text, jsonb, text, text) to service_role;
do $$
declare f text;
begin
  foreach f in array array[
    'studio_question_gap_json(question_gaps)', 'studio_question_gaps(text)',
    'studio_set_question_gap_status(uuid,text)', 'studio_delete_question_gap(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
