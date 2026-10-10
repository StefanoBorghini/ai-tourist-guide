# AI Guide Engine — istruzioni per chi lavora sul codice

Documento di riferimento: `docs/v0.2-product-strategy/PRODUCT-STRATEGY-AND-ARCHITECTURE.md`.

## Regole non negoziabili

1. **Nessun codice specifico per territorio.** Tutto ciò che riguarda un luogo sta nel suo Territory Pack
   (`territories/`). `npm run check:no-territory-code` lo verifica in CI.
2. **Il sistema calcola, l'AI racconta.** Posizione, tempi, percorsi e selezione dei contenuti sono deterministici
   e testabili; l'AI genera solo testo a partire da affermazioni verificate.
3. **L'AI non inventa fatti.** Racconta solo affermazioni `verified` di livello ammesso dalla configurazione del
   territorio, e le cita. Unica eccezione: i territori con `releaseStage`
   `research` o `field_test` producono bundle di **anteprima** che includono anche affermazioni `in_review`
   (mai `draft`), marcate e dichiarate all'utente; in `production` il validatore impone affermazioni verificate,
   coordinate `field_verified` e percorsi `field_calibrated`.
   **Ricerca web (decisione del proprietario, 2026-10):** il racconto dei luoghi non usa mai il web; le *risposte alle
   domande* possono approfondire con lo strumento ufficiale di ricerca web dell'API Anthropic, solo dopo la base locale
   e solo se questa non basta o se il visitatore chiede di approfondire (`lib/ask-web.ts`). Ciò che viene dal web si
   mostra con le sue fonti, marcato come non verificato dalla redazione, e **non entra mai da solo nel Territory Pack**:
   ci arriva solo con il processo normale di revisione. Si spegne con `ASK_WEB_ENABLED=0`.
4. **Il Territory Pack è l'unica porta d'ingresso dei contenuti.** Il formato è definito in
   `packages/domain/src/pack-schema.ts` e validato da `guide-pack validate`. Le immagini entrano solo con fonte,
   autore e licenza dichiarati; non si raccolgono immagini dal web senza licenza.
5. **Codice e database condividono il vocabolario.** Modifiche a `packages/domain/src/vocabulary.ts` o
   `ontology.ts` vanno riflesse in una migrazione in `supabase/migrations/` (un test lo verifica).

## Struttura

- `apps/guide` — app Next.js (PWA, poi Capacitor). Due modalità sullo stesso motore (GPS, geofence, luoghi, fonti,
  narrazione), cambia solo l'organizzazione: **esplorazione libera** (nessun piano, tutti i luoghi attivi) e **percorsi
  guidati** (itinerari curati o su misura, tappe in ordine, GPS reale). Si passa dall'una all'altra in un tocco, nella
  stessa visita: la memoria del racconto resta, l'avanzamento delle tappe è del singolo percorso. `lib/runtime.ts` collega motore di contesto e narrazione (logica
  pura, testata: coda degli arrivi, niente interruzioni mentre la guida parla, luoghi rifiutati non riproposti per
  15 minuti, luoghi vicini); `lib/gps-status.ts` stato del segnale; `components/PlaceCard.tsx` scheda del luogo; al build `scripts/build-bundles.ts` compila i bundle in `public/bundles/` (generati, non versionati);
  `public/sw.js` e `lib/offline.ts` gestiscono l'uso senza rete (nomi dei cache allineati tra i due);
  `lib/ask.ts` (prompt e controllo delle risposte, puro e testato; distanze e direzioni in linea d'aria le calcola il
  sistema dalla posizione, l'AI le riferisce soltanto), `lib/ask-web.ts` (approfondimento con ricerca web: quando
  cercare, lettura di fonti e citazioni, cache, limiti, costi; puro e testato), `lib/ask-server.ts` (chiamate al
  modello) e `app/api/guide/ask` per le domande all'AI; `npm run ask:eval` esegue le domande di prova di un territorio
  (`ASK-EVAL.json` nel pack) e scrive un rapporto da rileggere;
  `components/DebugPanel.tsx` e `lib/field-points.ts` per il test sul campo (`?debug=1`);
  `components/MapView.tsx` e `lib/map-view.ts` per la mappa (Web Mercator, sfondo OpenStreetMap solo online e
  solo per le prove: in produzione serve un fornitore di tile con licenza adeguata)
- `packages/domain` — identificativi, vocabolari, ontologia, schemi zod del Territory Pack
- `packages/territory-pack` — caricamento, validazione e CLI `guide-pack` (`validate`, `photos`: coordinate dall'EXIF,
  `field`: revisione dei rilievi sul campo, formato `guide-field-points/2` in `packages/domain/src/field-points.ts`;
  propone, non scrive mai nel pack)
- `packages/context-engine` — motore di contesto sul dispositivo: geofence, movimento, pianificatore con ancora,
  monitor del tempo, istantanea per la narrazione. TypeScript puro, senza rete né AI; testato con tracce GPS simulate
- `packages/narrative-planner` — decide cosa raccontare in ogni tappa (unità, prerequisiti, richiami, ganci) e
  aggiorna la memoria del tour. Deterministico: l'AI riceve il piano e rende solo i raccordi
- `packages/bundle` — compila un Territory Pack in un bundle di runtime per lingua (solo affermazioni raccontabili,
  deterministico, con hash) e lo rilegge sul dispositivo. L'app usa solo i bundle, mai il database
- `territories/` — Territory Pack; `_synthetic/` contiene territori inventati per i test
- `supabase/migrations/` — schema del database (sistema di redazione, non letto dall'app a runtime)

## Comandi

- `npm run ci` — typecheck, test, validazione dei pack, controllo territori
- `npm run packs:validate` — valida tutti i pack sotto `territories/`
- `npm run bundles:build:test` — compila il bundle del territorio sintetico in `dist/bundles/`
- `npm run dev` / `npm run build` — app

## Convenzioni

- Documentazione, messaggi del validatore e commenti in italiano.
- Le coordinate dei pack di ricerca non si "correggono" a memoria: si segnalano e si verificano sul posto.
- Versioni delle dipendenze fissate (niente `^`), pubblicate da almeno due settimane.
- I pacchetti sono distribuiti come sorgenti TypeScript (`exports` → `src/index.ts`).
