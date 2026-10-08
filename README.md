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
territories/               Territory Pack (_synthetic/: territori inventati per i test)
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
- [ ] domande alla guida (AI, solo su affermazioni verificate)
- [ ] Studio minimo con changeset
