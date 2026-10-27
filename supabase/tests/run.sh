#!/usr/bin/env bash
# Prova le migrazioni e le policy su un Postgres locale usa e getta (serve PostgreSQL 16 + PostGIS).
#   npm run db:check
# Crea un cluster temporaneo, applica lo strato che imita Supabase, tutte le migrazioni in ordine
# e i test SQL (supabase/tests/[1-9]*.sql). Esce con errore al primo fallimento.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
[ -x "$BIN/initdb" ] || { echo "PostgreSQL non trovato (servono initdb/pg_ctl)"; exit 2; }
DATA="$(mktemp -d)"; PORT="${DB_CHECK_PORT:-54329}"
trap '"$BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT
# Postgres rifiuta di girare come root: si usa l'utente postgres se serve.
RUN=(); [ "$(id -u)" = 0 ] && { chown -R postgres "$DATA"; RUN=(runuser -u postgres --); }
"${RUN[@]}" "$BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"${RUN[@]}" "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$DATA/log" -w start >/dev/null
PSQL=(psql -h "$DATA" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -f "$HERE/00_supabase_stub.sql"
for f in "$ROOT"/migrations/*.sql; do
  echo "migrazione $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
# La verifica da incollare nel SQL Editor del progetto reale deve passare anche qui e non lasciare dati.
echo "test remote-check.sql"
"${PSQL[@]}" -f "$HERE/remote-check.sql" -At | grep -qx 'superato|0|0|nessuno' || { echo "remote-check.sql: esito inatteso"; exit 1; }
# Parità pack ↔ database: ogni pack di territories/ importato, riletto e ricompilato in bundle identici.
echo "test roundtrip.ts"
PGHOST="$DATA" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres npx tsx "$HERE/roundtrip.ts"
for f in "$HERE"/[1-9]*.sql; do
  [ -e "$f" ] || continue
  echo "test $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
# Revoca: le migrazioni con uno script in rollback/ si devono poter annullare (in ordine inverso)
# e riapplicare, senza errori.
# La revoca dei diritti non deve mai allargarli: con dati commerciali presenti si ferma prima di cambiare qualcosa.
ENT=20261024000000_entitlements
echo "test revoca $ENT con dati presenti"
"${PSQL[@]}" -f "$HERE/rollback/entitlements_guard.sql" >/dev/null
if "${PSQL[@]}" -f "$ROOT/rollback/$ENT.down.sql" 2>"$DATA/guard.err"; then echo "la revoca dei diritti doveva fermarsi"; exit 1; fi
grep -q "REVOCA DIRITTI interrotta, nulla è stato modificato" "$DATA/guard.err" || { cat "$DATA/guard.err"; exit 1; }
"${PSQL[@]}" -f "$HERE/rollback/entitlements_guard_check.sql"
# Due sessioni reali in parallelo: presa in carico delle pubblicazioni (R2) e revoca con scritture concorrenti (R6).
TMPDIR_CONC="$DATA" PGHOST="$DATA" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres bash "$HERE/concurrent.sh"
# La revoca del bucket «premium» non cancella mai contenuti: con file presenti si ferma senza cambiare nulla.
PREM=20261027000000_premium_storage
echo "test revoca $PREM con file presenti"
"${PSQL[@]}" -c "insert into storage.objects (bucket_id, name) values ('premium', 'zz.prova/it/00000000-0000-0000-0000-000000000000/explore.0000000000000000.json')"
if "${PSQL[@]}" -f "$ROOT/rollback/$PREM.down.sql" 2>"$DATA/prem.err"; then echo "la revoca del bucket premium doveva fermarsi"; exit 1; fi
grep -q "REVOCA PREMIUM interrotta, nulla è stato modificato" "$DATA/prem.err" || { cat "$DATA/prem.err"; exit 1; }
"${PSQL[@]}" -At -c "select count(*) from pg_policies where policyname like 'premium_files_%'" | grep -qx 4 || { echo "revoca premium: policy toccate"; exit 1; }
"${PSQL[@]}" -c "delete from storage.objects where bucket_id = 'premium'"
# La revoca degli eventi non cancella mai eventi: con un evento presente si ferma senza cambiare nulla.
EVT=20261031000000_local_events
echo "test revoca $EVT con eventi presenti"
"${PSQL[@]}" -c "insert into packs (id, kind, organization_id, default_locale, locales, title) values ('zz.revoca-eventi', 'destination', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{\"it\":\"R\"}')" \
  -c "insert into destinations (pack_id) values ('zz.revoca-eventi')" \
  -c "insert into local_events (pack_id, slug, labels, category, start_date, venue_name) values ('zz.revoca-eventi', 'resta', '{\"it\":{\"title\":\"Resta\"}}', 'culture', '2030-01-01', 'Piazza')"
if "${PSQL[@]}" -f "$ROOT/rollback/$EVT.down.sql" 2>"$DATA/evt.err"; then echo "la revoca degli eventi doveva fermarsi"; exit 1; fi
grep -q "REVOCA EVENTI interrotta, nulla è stato modificato" "$DATA/evt.err" || { cat "$DATA/evt.err"; exit 1; }
"${PSQL[@]}" -At -c "select count(*) from local_events where pack_id = 'zz.revoca-eventi'" | grep -qx 1 || { echo "revoca eventi: evento toccato"; exit 1; }
"${PSQL[@]}" -c "delete from local_events where pack_id = 'zz.revoca-eventi'"
# Lo stesso per gli avvisi operativi.
OPN=20261105000000_operational_notices
echo "test revoca $OPN con avvisi presenti"
"${PSQL[@]}" -c "insert into operational_notices (pack_id, slug, notice_status, labels, valid_from, valid_until) values ('zz.revoca-eventi', 'resta', 'caution', '{\"it\":{\"title\":\"Resta\"}}', '2030-01-01', '2030-01-02')"
if "${PSQL[@]}" -f "$ROOT/rollback/$OPN.down.sql" 2>"$DATA/opn.err"; then echo "la revoca degli avvisi doveva fermarsi"; exit 1; fi
grep -q "REVOCA AVVISI interrotta, nulla è stato modificato" "$DATA/opn.err" || { cat "$DATA/opn.err"; exit 1; }
"${PSQL[@]}" -At -c "select count(*) from operational_notices where pack_id = 'zz.revoca-eventi'" | grep -qx 1 || { echo "revoca avvisi: avviso toccato"; exit 1; }
"${PSQL[@]}" -c "delete from operational_notices where pack_id = 'zz.revoca-eventi'"
for f in $(ls "$ROOT"/rollback/*.down.sql 2>/dev/null | sort -r); do
  echo "revoca $(basename "$f")"
  "${PSQL[@]}" -f "$f"
  if [ "$(basename "$f" .down.sql)" = "$ENT" ]; then "${PSQL[@]}" -f "$HERE/rollback/entitlements_after.sql"; fi
done
for f in "$ROOT"/rollback/*.down.sql; do
  [ -e "$f" ] || continue
  up="$ROOT/migrations/$(basename "$f" .down.sql).sql"
  echo "riapplico $(basename "$up")"
  "${PSQL[@]}" -f "$up"
done
echo "✓ migrazioni e test del database superati"
