#!/usr/bin/env bash
# Prove con due sessioni reali in parallelo sullo stesso database (le prove SQL numerate usano una sola sessione).
# La chiama run.sh con PGHOST, PGPORT, PGUSER e PGDATABASE del cluster di prova, dopo i test e prima delle revoche.
#   R2: rinnovo e sostituzione della presa in carico di una pubblicazione, nei due ordini; fotografia dell'indice
#       mentre una pubblicazione va in linea;
#   R6: revoca di 20261024000000 mentre qualcuno scrive prodotti o percorsi premium, e tabella occupata;
#   Q8: domande senza risposta registrate in parallelo (stessa domanda: una riga; tetto del giorno mai superato).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
Q=(psql -v ON_ERROR_STOP=1 -q -X -At)
fail() { echo "FALLITO: $*"; exit 1; }
q() { "${Q[@]}" -c "$1"; }

# ---------------------------------------------------------------- R2: rinnovo contro sostituzione
q "insert into organizations (id, kind, name) values ('cc000000-0000-0000-0000-000000000000', 'institution', 'Concorrenza (prova)');
   insert into packs (id, kind, organization_id, default_locale, locales, title) values
     ('zc.conc', 'destination', 'cc000000-0000-0000-0000-000000000000', 'it', '{it}', '{\"it\":\"Conc\"}');
   insert into destinations (pack_id) values ('zc.conc');
   insert into auth.users (id, email, raw_user_meta_data) values
     ('cc000000-0000-0000-0000-000000000001', 'conc-a@prova.test', '{}'), ('cc000000-0000-0000-0000-000000000002', 'conc-b@prova.test', '{}');
   insert into memberships (user_id, organization_id, role, pack_scope) values
     ('cc000000-0000-0000-0000-000000000001', 'cc000000-0000-0000-0000-000000000000', 'territory_editor', 'zc.conc'),
     ('cc000000-0000-0000-0000-000000000002', 'cc000000-0000-0000-0000-000000000000', 'territory_editor', 'zc.conc');
   insert into publications (id, pack_id, requested_by, status, report) values
     ('cd000000-0000-0000-0000-00000000000a', 'zc.conc', 'cc000000-0000-0000-0000-000000000001', 'requested', '{\"ok\":true}');" >/dev/null
as_user() { printf "set role authenticated; set request.jwt.claim.sub = '%s';\n%s\n" "$1" "$2" | "${Q[@]}"; }
status() { q "select status from publications where id = '$1'"; }
expire() { q "update publications set report = report || jsonb_build_object('buildingSince', now() - interval '20 minutes') where id = '$1'" >/dev/null; }
request() { q "insert into publications (id, pack_id, requested_by, status, report) values ('$1', 'zc.conc', '$2', 'requested', '{\"ok\":true}')" >/dev/null; }

[ "$(as_user cc000000-0000-0000-0000-000000000001 "select studio_publication_claim('zc.conc') ->> 'ok';")" = "true" ] || fail "presa in carico di A"
expire cd000000-0000-0000-0000-00000000000a

echo "concorrenza R2: il rinnovo di A arriva prima della sostituzione"
# A rinnova (presa scaduta ma non ancora sostituita) e tiene la transazione aperta; B prova a sostituirla nel frattempo.
( as_user cc000000-0000-0000-0000-000000000001 "begin; select studio_publication_renew('zc.conc', 'cd000000-0000-0000-0000-00000000000a'); select pg_sleep(2); commit;" > "$TMPDIR_CONC/renew1" ) &
sleep 0.7
request cd000000-0000-0000-0000-00000000000b cc000000-0000-0000-0000-000000000002
B=$(as_user cc000000-0000-0000-0000-000000000002 "select studio_publication_claim('zc.conc') ->> 'ok';")
wait
[ "$(head -1 "$TMPDIR_CONC/renew1")" = "t" ] || fail "rinnovo di A: $(cat "$TMPDIR_CONC/renew1")"
[ "$B" = "false" ] || fail "B ha sostituito una presa rinnovata in parallelo"
[ "$(status cd000000-0000-0000-0000-00000000000a)" = "building" ] && [ "$(status cd000000-0000-0000-0000-00000000000b)" = "failed" ] || fail "stati dopo rinnovo e sostituzione"

echo "concorrenza R2: la sostituzione arriva prima del rinnovo di A"
expire cd000000-0000-0000-0000-00000000000a
request cd000000-0000-0000-0000-00000000000c cc000000-0000-0000-0000-000000000002
( as_user cc000000-0000-0000-0000-000000000002 "begin; select studio_publication_claim('zc.conc') ->> 'ok'; select pg_sleep(2); commit;" > "$TMPDIR_CONC/claim2" ) &
sleep 0.7
A=$(as_user cc000000-0000-0000-0000-000000000001 "select studio_publication_renew('zc.conc', 'cd000000-0000-0000-0000-00000000000a');")
wait
[ "$(head -1 "$TMPDIR_CONC/claim2")" = "true" ] || fail "sostituzione da parte di B: $(cat "$TMPDIR_CONC/claim2")"
[ "$A" = "f" ] || fail "A rinnova una presa già sostituita"
[ "$(status cd000000-0000-0000-0000-00000000000a)" = "failed" ] && [ "$(status cd000000-0000-0000-0000-00000000000c)" = "building" ] || fail "stati dopo sostituzione e rinnovo"
echo "concorrenza R2: fotografia dell'indice mentre una pubblicazione va in linea"
# B completa la pubblicazione in una transazione ancora aperta; lo staff fotografa l'indice nel frattempo. Ogni indice
# con numero maggiore di quello registrato all'esito (report.indexGeneration) deve contenere la pubblicazione: è la
# condizione su cui si basa la cancellazione delle versioni sostituite (studio_publication_dead). Senza il blocco
# condiviso tra esito e fotografia, la fotografia prenderebbe un numero più alto senza vedere la pubblicazione.
q "update destinations set status = 'published' where pack_id = 'zc.conc';
   insert into auth.users (id, email, raw_user_meta_data) values ('cc000000-0000-0000-0000-000000000009', 'conc-staff@prova.test', '{}');
   insert into memberships (user_id, organization_id, role, pack_scope) values
     ('cc000000-0000-0000-0000-000000000009', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_editor', null);" >/dev/null
P=cd000000-0000-0000-0000-00000000000c
BUNDLES="[{\"locale\":\"it\",\"url\":\"/pub/zc.conc/it-full/$P/manifest.json\",\"manifest\":{\"destination\":\"zc.conc\",\"bundleSchemaVersion\":1,\"minAppVersion\":\"0.1.0\",\"kbHash\":\"k\",\"totalBytes\":1,\"content\":\"$P/content.0123456789abcdef.json\"},\"entry\":{\"destination\":\"zc.conc\",\"name\":\"Conc\",\"locale\":\"it\",\"manifest\":\"/pub/zc.conc/it-full/$P/manifest.json\"}}]"
( as_user cc000000-0000-0000-0000-000000000002 "begin; select studio_publication_finish('zc.conc', true, '{}', '$BUNDLES', '$P') ->> 'status'; select pg_sleep(2); commit;" > "$TMPDIR_CONC/finish3" ) &
sleep 0.7
SNAP=$(as_user cc000000-0000-0000-0000-000000000009 "select (studio_index_snapshot() - 'name')::text;")
wait
[ "$(head -1 "$TMPDIR_CONC/finish3")" = "published" ] || fail "esito di B: $(cat "$TMPDIR_CONC/finish3")"
G=$(q "select report ->> 'indexGeneration' from publications where id = '$P'")
N=$(q "select ('$SNAP'::jsonb ->> 'generation')::bigint")
IN=$(q "select '$SNAP'::jsonb -> 'index' -> 'bundles' @> '[{\"manifest\": \"/pub/zc.conc/it-full/$P/manifest.json\"}]'")
[ "$N" -gt "$G" ] || fail "la fotografia presa durante l'esito ha un numero ($N) non maggiore di quello registrato ($G): ha atteso troppo poco?"
[ "$IN" = "t" ] || fail "la fotografia numero $N (> $G registrato all'esito) non contiene la pubblicazione"
q "delete from memberships where user_id = 'cc000000-0000-0000-0000-000000000009'; delete from auth.users where id = 'cc000000-0000-0000-0000-000000000009';
   delete from bundles where pack_id = 'zc.conc';" >/dev/null
q "delete from publications where pack_id = 'zc.conc'; delete from memberships where pack_scope = 'zc.conc';
   delete from auth.users where id in ('cc000000-0000-0000-0000-000000000001', 'cc000000-0000-0000-0000-000000000002');
   delete from destinations where pack_id = 'zc.conc'; delete from packs where id = 'zc.conc';
   delete from organizations where id = 'cc000000-0000-0000-0000-000000000000';" >/dev/null

# ---------------------------------------------------------------- R6: revoca e scritture concorrenti
DOWN="$ROOT/rollback/20261024000000_entitlements.down.sql"
q "insert into organizations (id, kind, name) values ('ce000000-0000-0000-0000-000000000000', 'institution', 'Revoca (prova)');
   insert into packs (id, kind, organization_id, default_locale, locales, title) values
     ('zr.race', 'destination', 'ce000000-0000-0000-0000-000000000000', 'it', '{it}', '{\"it\":\"Race\"}');
   insert into destinations (pack_id) values ('zr.race');
   insert into routes (id, pack_id, slug, duration_min, labels) values ('ce000000-0000-0000-0000-0000000000a1', 'zr.race', 'r1', 30, '{}');" >/dev/null
intact() {
  [ "$(q "select to_regprocedure('grant_product(uuid, uuid, text, uuid, text)') is not null and to_regclass('public.product_routes') is not null
            and exists (select 1 from information_schema.columns where table_name = 'entitlements' and column_name = 'scope')
            and not has_table_privilege('authenticated', 'entitlements', 'insert')")" = "t" ] || fail "$1: la revoca fermata ha cambiato il modello dei diritti"
}
# La revoca deve fermarsi, con il motivo atteso nel messaggio.
expect_stop() {
  if "${Q[@]}" -f "$DOWN" >/dev/null 2>"$TMPDIR_CONC/down.err"; then fail "$1: la revoca è andata avanti"; fi
  grep -q "$2" "$TMPDIR_CONC/down.err" || fail "$1: messaggio inatteso: $(cat "$TMPDIR_CONC/down.err")"
}

echo "concorrenza R6: percorso premium salvato mentre la revoca parte"
# Chi scrive ha già cambiato la configurazione ma non ha ancora confermato: senza il blocco iniziale la revoca non lo
# vedrebbe e allargherebbe i diritti (il percorso premium tornerebbe libero).
( "${Q[@]}" -c "begin; update packs set config = config || '{\"access\":{\"explore\":\"free\",\"introPlaces\":[],\"premiumRoutes\":[\"r1\"]}}' where id = 'zr.race'; select pg_sleep(2); commit;" >/dev/null ) &
sleep 0.7
expect_stop "percorso premium concorrente" "destinazioni con percorsi premium: 1"
wait
intact "percorso premium concorrente"
q "update packs set config = config - 'access' where id = 'zr.race'" >/dev/null

echo "concorrenza R6: prodotto creato mentre la revoca parte"
( "${Q[@]}" -c "begin; insert into products (id, slug, kind, pack_id, status) values ('ce000000-0000-0000-0000-0000000000e1', 'race-esplora', 'explore', 'zr.race', 'active'); select pg_sleep(2); commit;" >/dev/null ) &
sleep 0.7
expect_stop "prodotto concorrente" "prodotti: 1"
wait
intact "prodotto concorrente"
q "delete from products where pack_id = 'zr.race'" >/dev/null

echo "concorrenza R6: tabella occupata oltre il tempo massimo"
# Una transazione lunga tiene le destinazioni: la revoca non resta in coda all'infinito, si ferma senza cambiare nulla.
( "${Q[@]}" -c "begin; select count(*) from packs; select pg_sleep(13); commit;" >/dev/null ) &
sleep 0.7
expect_stop "tabella occupata" "lock timeout"
intact "tabella occupata"
wait

q "delete from routes where pack_id = 'zr.race'; delete from destinations where pack_id = 'zr.race'; delete from packs where id = 'zr.race';
   delete from organizations where id = 'ce000000-0000-0000-0000-000000000000';" >/dev/null

# ---------------------------------------------------------------- Q8: domande senza risposta in parallelo
q "insert into organizations (id, kind, name) values ('cf000000-0000-0000-0000-000000000000', 'institution', 'Domande (prova)');
   insert into packs (id, kind, organization_id, default_locale, locales, title) values
     ('zq.conc', 'destination', 'cf000000-0000-0000-0000-000000000000', 'it', '{it}', '{\"it\":\"Domande\"}');
   insert into destinations (pack_id) values ('zq.conc');
   delete from question_gap_daily;" >/dev/null
gap() { printf "set role service_role;\nselect gap_record('zq.conc', 'it', '%s', '%s', 'not_in_knowledge');\n" "$1" "$2" | "${Q[@]}"; }

echo "concorrenza Q8: la stessa domanda nuova da 12 richieste simultanee"
for i in $(seq 1 12); do ( gap "Domanda uguale?" "domanda uguale" > "$TMPDIR_CONC/gap$i" ) & done
wait
[ "$(q "select count(*) || '|' || max(hits) from question_gaps where pack_id = 'zq.conc'")" = "1|12" ] || fail "stessa domanda in parallelo: righe o contatore sbagliati"

echo "concorrenza Q8: tetto del giorno con 12 domande nuove simultanee e 5 posti liberi"
q "update question_gap_daily set new_rows = 495 where day = current_date" >/dev/null
for i in $(seq 1 12); do ( gap "Domanda diversa $i?" "domanda diversa $i" > "$TMPDIR_CONC/lim$i" ) & done
wait
[ "$(cat "$TMPDIR_CONC"/lim* | grep -cx created)" = "5" ] || fail "tetto in parallelo: $(cat "$TMPDIR_CONC"/lim* | sort | uniq -c | tr '\n' ' ')"
[ "$(cat "$TMPDIR_CONC"/lim* | grep -cx limit)" = "7" ] || fail "tetto in parallelo: esiti"
[ "$(q "select new_rows from question_gap_daily where day = current_date")" = "500" ] || fail "tetto in parallelo: conteggio del giorno"
[ "$(q "select count(*) from question_gaps where pack_id = 'zq.conc'")" = "6" ] || fail "tetto in parallelo: righe"

q "delete from question_gaps where pack_id = 'zq.conc'; delete from question_gap_daily; delete from destinations where pack_id = 'zq.conc';
   delete from packs where id = 'zq.conc'; delete from organizations where id = 'cf000000-0000-0000-0000-000000000000';" >/dev/null
echo "prove di concorrenza superate"
