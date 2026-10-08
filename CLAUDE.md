# AI Guide Engine — istruzioni per chi lavora sul codice

Documento di riferimento: `docs/v0.2-product-strategy/PRODUCT-STRATEGY-AND-ARCHITECTURE.md`.

## Regole non negoziabili

1. **Nessun codice specifico per territorio.** Tutto ciò che riguarda un luogo sta nel suo Territory Pack
   (`territories/`). `npm run check:no-territory-code` lo verifica in CI.
2. **Il sistema calcola, l'AI racconta.** Posizione, tempi, percorsi e selezione dei contenuti sono deterministici
   e testabili; l'AI genera solo testo a partire da affermazioni verificate.
3. **L'AI non inventa fatti.** Racconta solo affermazioni `verified` di livello ammesso dalla configurazione del
   territorio, e le cita. Nessun accesso al web per la guida.
4. **Il Territory Pack è l'unica porta d'ingresso dei contenuti.** Il formato è definito in
   `packages/domain/src/pack-schema.ts` e validato da `guide-pack validate`.
5. **Codice e database condividono il vocabolario.** Modifiche a `packages/domain/src/vocabulary.ts` o
   `ontology.ts` vanno riflesse in una migrazione in `supabase/migrations/` (un test lo verifica).

## Struttura

- `apps/guide` — app Next.js (PWA, poi Capacitor)
- `packages/domain` — identificativi, vocabolari, ontologia, schemi zod del Territory Pack
- `packages/territory-pack` — caricamento, validazione e CLI `guide-pack`
- `packages/context-engine` — motore di contesto sul dispositivo: geofence, movimento, pianificatore con ancora,
  monitor del tempo, istantanea per la narrazione. TypeScript puro, senza rete né AI; testato con tracce GPS simulate
- `territories/` — Territory Pack; `_synthetic/` contiene territori inventati per i test
- `supabase/migrations/` — schema del database (sistema di redazione, non letto dall'app a runtime)

## Comandi

- `npm run ci` — typecheck, test, validazione dei pack, controllo territori
- `npm run packs:validate` — valida tutti i pack sotto `territories/`
- `npm run dev` / `npm run build` — app

## Convenzioni

- Documentazione, messaggi del validatore e commenti in italiano.
- Versioni delle dipendenze fissate (niente `^`), pubblicate da almeno due settimane.
- I pacchetti sono distribuiti come sorgenti TypeScript (`exports` → `src/index.ts`).
