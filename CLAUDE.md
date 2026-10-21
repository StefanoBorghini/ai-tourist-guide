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
  guidati** (itinerari curati, gratuiti o a pagamento, elencati anche durante l'esplorazione; tappe in ordine, GPS reale; il percorso su misura non si offre più). Si passa dall'una all'altra in un tocco, nella
  stessa visita: la memoria del racconto resta, l'avanzamento delle tappe è del singolo percorso. L'app è organizzata come un'app nativa, con una barra in basso a quattro schede (Home, Esplora, Percorsi, Profilo; `components/GuideApp.tsx`; Esplora elenca solo le destinazioni, con card toccabili per intero, e toccarne una avvia subito l'esplorazione; «‹ Destinazioni» nella visita e in Percorsi riapre l'elenco senza chiudere la visita, che la sua card propone di riprendere; nella visita l'avviso di anteprima sta sotto la barra, il GPS è una riga compatta quando il segnale è buono, «Esplorazione completa» mostra il prezzo solo se in vendita, e il pulsante «debug» e gli strumenti di prova («Simula la camminata») compaiono solo in modalità debug): ogni scheda ha in alto marchio e scelta della lingua come la home (la visita in corso ha la sua barra), la visita in corso resta attiva cambiando scheda, la sua scheda mostra un punto verde, e il Profilo raccoglie modalità (ricordata sul dispositivo, anche per le visite nuove; predefinita «Mi chiede prima») e velocità della guida, uso offline e account. `lib/runtime.ts` collega motore di contesto e narrazione (logica
  pura, testata: coda degli arrivi, niente interruzioni mentre la guida parla, luoghi rifiutati non riproposti per
  15 minuti, luoghi vicini); `lib/gps-status.ts` stato del segnale; `lib/geo-permission.ts` posizione bloccata dal visitatore (istruzioni per riattivarla secondo il telefono, ripartenza automatica quando torna concessa); `components/InstallPrompt.tsx` invito a installare l'app a ogni apertura (finché non è installata; «Non ora» vale per la sessione); `components/PlaceCard.tsx` scheda del luogo (galleria, miniature: mai la
  foto di un altro luogo al posto di quella mancante); `components/Icon.tsx` icone; `components/NoPinchZoom.tsx` con viewport e `touch-action` del CSS: niente zoom con due dita sulla pagina, solo sulla mappa; `app/globals.css` design system
  (font di sistema, nessun download: funziona offline); `app/manifest.webmanifest/route.ts` manifest della PWA (link con `crossorigin="use-credentials"` nel layout); al build `scripts/build-bundles.ts` compila i bundle in `public/bundles/` (generati, non versionati);
  `public/sw.js` e `lib/offline.ts` gestiscono l'uso senza rete (nomi dei cache allineati tra i due);
  `lib/ask.ts` (prompt e controllo delle risposte, puro e testato; distanze e direzioni in linea d'aria le calcola il
  sistema dalla posizione, l'AI le riferisce soltanto), `lib/ask-web.ts` (approfondimento con ricerca web: quando
  cercare, lettura di fonti e citazioni, cache, limiti; puro e testato), `lib/ask-server.ts` (chiamate al
  modello) e `app/api/guide/ask` per le domande all'AI; `lib/ask-cost.ts` listino, consumi e budget per domanda
  (`ASK_MAX_USD_PER_QUESTION` obbligatoria, stime prima di ogni chiamata, nessun nuovo tentativo automatico; non è un tetto
  assoluto, vedi `docs/v0.3-platform/COSTI-AI.md`); `npm run ask:eval` esegue le domande di prova di un territorio
  (`ASK-EVAL.json` nel pack) e scrive un rapporto da rileggere;
  `components/DebugPanel.tsx` e `lib/field-points.ts` per il test sul campo (`?debug=1`);
  `components/MapView.tsx` e `lib/map-view.ts` per la mappa (Web Mercator, sfondo OpenStreetMap solo online e
  solo per le prove, attribuzione come solo testo senza link: in produzione serve un fornitore di tile con licenza adeguata);
  `lib/site-lock.ts` protezione del sito con nome utente e password (autenticazione di base, applicata da `proxy.ts` a ogni percorso tranne il webhook di Stripe; accesa solo con le variabili del server `SITE_USERNAME` e `SITE_PASSWORD`, spenta senza; alla prima risposta 401 il service worker cancella le copie per l'uso senza rete);
  `app/studio/` e `lib/studio/` lo Studio della redazione (`/studio`, Supabase Auth, funzioni `studio_*` del database con
  l'identità dell'utente, nessuna chiave di servizio; `proxy.ts` per `/studio`, `/account`, `/auth` e `/pub/`; nuovi territori, stati, eliminazione (piano e copia
  di sicurezza nel database) e controllo di pubblicazione in `lib/studio/readiness.ts` (spiegato in parole semplici, con la sezione dove correggere, da `lib/studio/explain.ts`), vedi `docs/v0.3-platform/TERRITORI-DAL-CMS.md`; senza variabili dice di non essere
  configurato e la guida funziona come prima); `app/account/`, `app/auth/` e `lib/account/` gli account dei visitatori
  (solo per acquistare; spenti senza `NEXT_PUBLIC_ACCOUNTS_ENABLED` e testi legali; esiti nell'indirizzo solo come codici,
  redirect solo interni, consensi registrati al primo accesso; vedi `docs/v0.3-platform/ACCOUNT.md`); `app/studio/[pack]/vendita/` (scheda «Vendita»: cosa è a pagamento e catalogo) e `lib/studio/catalog.ts` il catalogo
  (prodotti e prezzi in bozza/pubblicati, solo amministratore; listino pubblico `public_catalog()`; vedi `docs/v0.3-platform/CATALOGO.md`);
  `lib/payments/` e `app/api/checkout`, `app/api/stripe/webhook`, `app/account/acquista`, `app/account/ordine` gli acquisti con Stripe, che partono anche dalla guida (schede Percorsi ed Esplora: `lib/shop.ts`, listino da `app/api/catalog`); dopo il pagamento la guida aperta si sblocca da sola, senza ricaricare (`lib/purchase-watch.ts`: richieste a intervalli per 15 minuti dopo la partenza verso la cassa e segnale dalla pagina dell'ordine)
  (solo modalità test; il browser invia solo il prodotto, prezzo dal database; diritti solo dal webhook firmato, che usa la
  chiave di servizio solo per le funzioni `payment_*`; vedi `docs/v0.3-platform/PAGAMENTI.md`)
- `packages/domain` — identificativi, vocabolari, ontologia, schemi zod del Territory Pack
- `packages/territory-pack` — caricamento, validazione e CLI `guide-pack` (`validate`, `photos`: coordinate dall'EXIF,
  `field`: revisione dei rilievi sul campo, formato `guide-field-points/2` in `packages/domain/src/field-points.ts`;
  propone, non scrive mai nel pack; `db-sql`/`db-export`: scambio con il database tramite `import_pack()` e
  `pack_snapshot()`, `src/db.ts`)
- `packages/context-engine` — motore di contesto sul dispositivo: geofence, movimento, pianificatore con ancora,
  monitor del tempo, istantanea per la narrazione. TypeScript puro, senza rete né AI; testato con tracce GPS simulate
- `packages/narrative-planner` — decide cosa raccontare in ogni tappa (unità, prerequisiti, richiami, ganci) e
  aggiorna la memoria del tour. Deterministico: l'AI riceve il piano e rende solo i raccordi
- `packages/bundle` — compila un Territory Pack in un bundle di runtime per lingua (solo affermazioni raccontabili,
  deterministico, con hash) e lo rilegge sul dispositivo. L'app usa solo i bundle, mai il database: quelli dei file
  (`/bundles/`) e quelli pubblicati dallo Studio nel bucket `bundles` (`/pub/`, che li sostituiscono; `lib/bundle-index.ts`,
  pipeline in `lib/studio/publish.ts`, vedi `docs/v0.3-platform/PUBBLICAZIONE.md`). I media
  `video` (con `poster`) restano fuori dal pacchetto offline (`streamFiles`); `cover: true` indica la copertina
  della destinazione, che l'indice dei bundle espone alla pagina iniziale; i contenuti a pagamento (`config.access` della destinazione:
  esplorazione, luoghi introduttivi, percorsi premium) restano fuori dal bundle pubblico, vedi `docs/v0.3-platform/ACCESSO-CONTENUTI.md`;
  le parti a pagamento (un percorso comprende i racconti delle sue tappe) vanno nel bucket privato `premium`, leggibile solo con il diritto
  (migrazione `20261027000000_premium_storage.sql`, vedi `docs/v0.3-platform/CONSEGNA-CONTENUTI.md`); con l'esplorazione a pagamento
  ogni luogo non introduttivo ha anche la sua parte e si compra da solo (prodotto «place», migrazione `20261028000000_place_products.sql`);
  i luoghi gratuiti (`config.access.freePlaces`, scelti nella scheda Vendita, migrazione `20261029000000_free_places.sql`) hanno tutti i racconti nel bundle pubblico e non si vendono;
  solo le destinazioni elencate in `territories/static-bundles.json` hanno bundle dai file, e non possono avere contenuti a pagamento
- Eventi del giorno (dati operativi, fuori da Territory Pack, bundle e AI): tabella `local_events` e `destinations.timezone`
  (migrazione `20261031000000_local_events.sql`; date nel fuso della destinazione, orari del cambio d'ora rifiutati, fonte https e
  verifica obbligatorie per pubblicare, bozze solo a chi modifica il territorio, lettura pubblica solo con `public_local_events()`);
  la stessa logica di date e indirizzi in `apps/guide/lib/local-events.ts`; API pubblica `GET /api/v1/events`
  (`app/api/v1/events`, regole in `lib/events-api.ts`, client anonimo senza cookie in `lib/public-supabase.ts`, cache CDN 60 s);
  scheda «Eventi» dello Studio in `app/studio/[pack]/eventi/` con azioni in `app/studio/actions-events.ts` e lettura del modulo in
  `lib/studio/local-events.ts` (crea in bozza, verifica la fonte, pubblica/ritira, annulla o rinvia senza ritirare, elimina solo bozze);
  nella guida `components/EventsPanel.tsx` con regole pure in `lib/events-view.ts`: pulsante «Oggi a …» nella home (apre un pannello,
  la home resta senza scorrimento) e scheda «Eventi» nella visita; viste Oggi/Domani/7 giorni dal `today` del territorio, filtri,
  annullato/rinviato come testo, «Verificato il …», link solo https; solo online, mai nel pacchetto offline né nelle domande all'AI
- `territories/` — Territory Pack; `_synthetic/` contiene territori inventati per i test
- `supabase/migrations/` — schema del database (sistema di redazione, non letto dall'app a runtime); `supabase/tests/`
  test delle migrazioni, delle policy e della parità pack ↔ database su un Postgres locale (`npm run db:check`;
  `remote-check.sql` è la stessa verifica da incollare nel SQL Editor del progetto reale), `supabase/rollback/` revoche.
  Architettura della piattaforma (CMS, account, pubblicazione, premium): `docs/v0.3-platform/PLATFORM-ARCHITECTURE.md`

## Comandi

- `npm run ci` — typecheck, test, validazione dei pack, controllo territori
- `npm run packs:validate` — valida tutti i pack sotto `territories/`
- `npm run bundles:build:test` — compila il bundle del territorio sintetico in `dist/bundles/`
- `npm run dev` / `npm run build` — app
- `npm run db:check` — migrazioni, policy RLS, revoca e riapplicazione su un Postgres 16 + PostGIS locale

## Convenzioni

- Documentazione, messaggi del validatore e commenti in italiano.
- Le coordinate dei pack di ricerca non si "correggono" a memoria: si segnalano e si verificano sul posto.
- Versioni delle dipendenze fissate (niente `^`), pubblicate da almeno due settimane.
- I pacchetti sono distribuiti come sorgenti TypeScript (`exports` → `src/index.ts`).
