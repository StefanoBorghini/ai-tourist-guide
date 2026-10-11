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
"${PSQL[@]}" -f "$HERE/remote-check.sql" -At | grep -qx 'superato|0|0' || { echo "remote-check.sql: esito inatteso"; exit 1; }
for f in "$HERE"/[1-9]*.sql; do
  [ -e "$f" ] || continue
  echo "test $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
# Revoca: le migrazioni con uno script in rollback/ si devono poter annullare (in ordine inverso)
# e riapplicare, senza errori.
for f in $(ls "$ROOT"/rollback/*.down.sql 2>/dev/null | sort -r); do
  echo "revoca $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
for f in "$ROOT"/rollback/*.down.sql; do
  [ -e "$f" ] || continue
  up="$ROOT/migrations/$(basename "$f" .down.sql).sql"
  echo "riapplico $(basename "$up")"
  "${PSQL[@]}" -f "$up"
done
echo "✓ migrazioni e test del database superati"
