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
apps/guide                 app Next.js (PWA, poi Capacitor)
packages/domain            identificativi, vocabolari, ontologia, schemi del Territory Pack
packages/territory-pack    caricamento, validazione, CLI guide-pack
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
```

## Stato

Fase 0 (fondazioni) in corso:

- [x] monorepo, app Next.js minima
- [x] Territory Pack v1: schema, validatore, CLI `guide-pack`
- [x] territorio sintetico di test e controllo "nessun codice per territorio"
- [x] schema del database v0.2 (grafo, affermazioni con prove, narrazione, changeset)
- [ ] Tour Context Engine (posizione, tempo, ancore, pianificazione)
- [ ] Narrative Planner (narrazione componibile)
- [ ] compilazione dei bundle di runtime
- [ ] Studio minimo con changeset
