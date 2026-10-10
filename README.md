# AI Guide Engine

Piattaforma per guide turistiche AI territoriali: una guida che accompagna il visitatore a piedi e racconta il territorio
con storytelling basato su conoscenza **verificata** e **collegata** (grafo territoriale), audio-first e offline.

Portovenere è il primo territorio e il laboratorio reale; l'engine non contiene nulla di specifico per un territorio.

## Documentazione

| Documento | Contenuto |
|---|---|
| [v0.2 · Strategia di prodotto e architettura](docs/v0.2-product-strategy/PRODUCT-STRATEGY-AND-ARCHITECTURE.md) | **Documento di riferimento.** Analisi dei concorrenti, differenziazione, Territorial Knowledge Graph, Verified Knowledge, storytelling componibile, Tour Context Engine, Territory Pack, multi-territorio, CMS e curatela, MVP Portovenere, roadmap, KPI, modelli di business, rischi |
| [v0.1 · Architettura iniziale](docs/v0.1-architecture/ARCHITECTURE.md) | Primo passaggio (superato in parte dalla v0.2): GPS, geofencing, audio, offline, privacy, API |
| [v0.1 · Schema database](docs/v0.1-architecture/schema.sql) | Schema Supabase/PostgreSQL della v0.1 (da rivedere secondo il modello dati v0.2) |
| [v0.1 · Tool AI](docs/v0.1-architecture/ai-tools.ts) | Definizioni dei tool della guida AI |

## Struttura del repository

```
apps/guide                 app Next.js: walk mode, voce, simulatore di camminata, GPS (PWA, poi Capacitor)
packages/domain            identificativi, vocabolari, ontologia, schemi del Territory Pack
packages/territory-pack    caricamento, validazione, CLI guide-pack
packages/context-engine    posizione, geofence, movimento, pianificazione con ancora, monitor del tempo
packages/narrative-planner scelta delle unità narrative per tappa, prerequisiti, richiami, memoria del tour
packages/bundle            compilazione e lettura dei bundle scaricabili (offline), CLI guide-bundle
territories/               Territory Pack (_synthetic/: territori inventati per i test;
                           it.liguria.sp.portovenere: primo territorio reale, in fase di ricerca)
supabase/migrations/       schema del database v0.2
```

## Sviluppo

Requisiti: Node 22 o superiore.

```bash
npm install
npm run ci               # typecheck, test, validazione dei pack, controllo territori
npm run packs:validate   # valida i Territory Pack
npm run dev              # app in locale
npm run photos --workspace @guide/territory-pack -- <cartella-foto> --territories territories --pack <id>
                         # coordinate, quota e data dalle foto JPEG, con il luogo più vicino
npm run field --workspace @guide/territory-pack -- <rilievi.json> --territories territories
                         # revisione dei rilievi esportati dall'app (debug): proposte, nessuna modifica al pack
```

### Immagini nei pack

Le immagini stanno in `<pack>/media/files/` e sono descritte in `<pack>/media/media.yaml`: soggetti, testo
alternativo, fonte (`own_photo`, `institution`, `archive`, `web`, `other`), autore, licenza, attribuzione,
`originalUrl`. Il validatore pretende l'attribuzione quando la licenza la richiede e l'indirizzo originale per le
immagini prese dal web. Nei bundle entrano solo immagini con licenza utilizzabile: mai "tutti i diritti riservati",
le non commerciali solo se il territorio lo ammette (`config.media.allowNonCommercial`).

## Stato

Fase 0 (fondazioni) in corso:

- [x] monorepo, app Next.js minima
- [x] Territory Pack v1: schema, validatore, CLI `guide-pack`
- [x] territorio sintetico di test e controllo "nessun codice per territorio"
- [x] schema del database v0.2 (grafo, affermazioni con prove, narrazione, changeset)
- [x] Tour Context Engine (posizione, geofence, movimento, tempo, ancore, pianificazione)
- [x] Narrative Planner (narrazione componibile, memoria del tour, raccordi a modello)
- [x] compilazione dei bundle di runtime (solo fatti raccontabili, deterministici, verificati all'apertura)
- [x] prima app: runtime della guida, voce (sintesi del dispositivo), walk mode, simulatore, GPS
- [x] immagini con licenza nei pack e nei bundle; coordinate dei luoghi lette dalle foto (EXIF)
- [x] funzionamento offline: service worker e "Scarica per l'uso offline" (pagina, bundle, immagini)
- [x] domande alla guida (`/api/guide/ask`): risponde prima con le affermazioni verificate del bundle, le cita; risposte
      con citazioni inesistenti o numeri non presenti nelle fonti vengono scartate. Richiede `ANTHROPIC_API_KEY`
      nelle variabili d'ambiente del progetto (senza, l'app funziona ma non risponde alle domande)
- [x] approfondimento con ricerca web (strumento ufficiale dell'API Anthropic) quando la base non basta o su
      richiesta, con fonti mostrate e marcate come non verificate; limiti, cache e log dei consumi: vedi
      [Domande e ricerca web](#domande-e-ricerca-web)
- [x] stadi di rilascio (ricerca, prova sul campo, produzione) e bundle di anteprima dichiarati come tali;
      stato delle coordinate, curatela, informazioni pratiche datate, ipotesi, percorsi curati
- [x] primo territorio reale: Portovenere (18 luoghi, in ricerca: vedi `territories/it.liguria.sp.portovenere/README.md`)
- [x] modalità debug per il test sul campo (`?debug=1`): GPS, geofence, stati redazionali, rilievo delle posizioni
- [ ] Portovenere verificato sul campo (coordinate, percorsi) e dalla redazione (affermazioni)
- [ ] Studio minimo con changeset

## Domande e ricerca web

Pipeline di `/api/guide/ask` (codice in `apps/guide/lib/ask.ts`, `ask-web.ts`, `ask-server.ts`):

1. **Base locale** — il modello riceve la base di conoscenza del bundle e risponde in JSON con le affermazioni
   citate; il sistema scarta citazioni inesistenti e numeri non presenti nelle fonti. Se la base risponde, finisce qui.
2. **Ricerca web** — solo se la base risponde in parte o non risponde, o se il visitatore tocca «Approfondisci».
   Il modello riceve la stessa base, la risposta locale e lo strumento `web_search_20260318` (filtraggio dinamico dei
   risultati, nessun costo aggiuntivo per l'esecuzione del codice), con un numero massimo di ricerche e i domini
   esclusi. Le pagine trovate sono trattate come dati, mai come istruzioni.
3. **Risposta** — testo parlato con le fonti in «Fonti e approfondimenti» (titolo, sito, livello presunto della
   fonte, data se nota, brano citato). Una risposta con ricerca che non cita nessuna fonte non si mostra. Se la
   ricerca non è disponibile la guida risponde con la base locale e lo dice.

Le risposte con ricerca non diventano conoscenza verificata: compaiono nei log (`event: "web_answer"`, con le fonti)
perché la redazione le valuti e, se reggono, le porti nel Territory Pack.

Variabili d'ambiente (tutte facoltative tranne la chiave):

| Variabile | Default | Effetto |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | obbligatoria per le domande (solo lato server) |
| `ASK_WEB_ENABLED` | `1` | `0` spegne la ricerca web (resta la base locale) |
| `ASK_WEB_MAX_USES` | `3` | ricerche massime per domanda (1–10) |
| `ASK_WEB_MODEL` | `claude-opus-5-5` | modello della risposta con ricerca (es. `claude-sonnet-5-5` per spendere meno) |
| `ASK_WEB_EFFORT` | `medium` | `low` / `medium` / `high` |
| `ASK_WEB_PER_IP` | `6` | domande con ricerca per indirizzo ogni 10 minuti (per istanza) |
| `ASK_WEB_DAILY_LIMIT` | `300` | domande con ricerca al giorno per istanza del server |
| `ASK_WEB_BLOCKED_DOMAINS` | recensioni e social | domini esclusi, separati da virgole (vuoto = nessuno) |
| `ASK_CACHE_TTL_HOURS` | `24` | durata della cache delle risposte (0 = niente cache) |
| `ASK_WEB_TIMEOUT_MS` | `50000` | tempo massimo della risposta con ricerca |

I limiti per indirizzo e per giorno valgono per singola istanza del server: sono argini, non quote globali.
Il tetto di spesa mensile affidabile si imposta nella Console Anthropic (limite di spesa del workspace a cui
appartiene la chiave). `GET /api/guide/ask` dice se la ricerca è attiva e se il modello la supporta (Models API).
Prove di qualità: `npm run ask:eval -w @guide/app -- --file ../../territories/<id>/ASK-EVAL.json --out rapporto.md`
(chiama davvero l'API: serve la chiave e ha un costo; `--dry` mostra solo cosa sa la base locale). Prima di ogni
domanda tiene libera una riserva prudente e non parte se supererebbe `--max-usd`; `--no-web` per la sola base,
`--web-model` per scegliere il modello della ricerca, `--json` per salvare i risultati e confrontare due esecuzioni
con `npm run ask:compare -w @guide/app -- a.json b.json --out confronto.md` (nessun costo).
