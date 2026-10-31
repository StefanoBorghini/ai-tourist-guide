# AI Guide Engine

Piattaforma per guide turistiche AI territoriali: una guida che accompagna il visitatore a piedi e racconta il territorio
con storytelling basato su conoscenza **verificata** e **collegata** (grafo territoriale), audio-first e offline.

Portovenere è il primo territorio e il laboratorio reale; l'engine non contiene nulla di specifico per un territorio.

## Documentazione

| Documento | Contenuto |
|---|---|
| [v0.2 · Strategia di prodotto e architettura](docs/v0.2-product-strategy/PRODUCT-STRATEGY-AND-ARCHITECTURE.md) | **Documento di riferimento.** Analisi dei concorrenti, differenziazione, Territorial Knowledge Graph, Verified Knowledge, storytelling componibile, Tour Context Engine, Territory Pack, multi-territorio, CMS e curatela, MVP Portovenere, roadmap, KPI, modelli di business, rischi |
| [v0.3 · Piattaforma](docs/v0.3-platform/PLATFORM-ARCHITECTURE.md) | Studio della redazione, pubblicazione, account, catalogo e pagamenti, contenuti a pagamento, eventi e attività locali: una pagina per argomento in `docs/v0.3-platform/` |
| [v0.4 · Gaia](docs/v0.4-gaia/CHARACTER-BIBLE.md) | Identità e voce della guida, stile per lingua, rubriche ed esempi di riferimento |
| [v0.1 · Architettura iniziale](docs/v0.1-architecture/ARCHITECTURE.md) | Primo passaggio (superato in parte dalla v0.2): GPS, geofencing, audio, offline, privacy, API |
| [v0.1 · Schema database](docs/v0.1-architecture/schema.sql) | Schema Supabase/PostgreSQL della v0.1 (da rivedere secondo il modello dati v0.2) |
| [v0.1 · Tool AI](docs/v0.1-architecture/ai-tools.ts) | Definizioni dei tool della guida AI |

## Struttura del repository

```
apps/guide                 app Next.js (PWA): la guida (esplorazione libera e percorsi guidati, voce, GPS, offline),
                           lo Studio della redazione (/studio), account e acquisti, API pubbliche di eventi e attività
packages/domain            identificativi, vocabolari, ontologia, schemi del Territory Pack
packages/territory-pack    caricamento, validazione, CLI guide-pack
packages/context-engine    posizione, geofence, movimento, pianificazione con ancora, monitor del tempo
packages/narrative-planner scelta delle unità narrative per tappa, prerequisiti, richiami, memoria del tour
packages/bundle            compilazione e lettura dei bundle scaricabili (offline), CLI guide-bundle
territories/               Territory Pack (_synthetic/: territori inventati per i test;
                           it.liguria.sp.portovenere: primo territorio reale, in fase di ricerca)
supabase/migrations/       schema del database (redazione, pubblicazione, account, catalogo, ordini, eventi, attività);
                           supabase/tests/ prove su un Postgres locale, supabase/rollback/ revoche
```

## Sviluppo

Requisiti: Node 22 o superiore.

```bash
npm install
npm run ci               # typecheck, test, validazione dei pack, controllo territori
npm run packs:validate   # valida i Territory Pack
npm run db:check         # migrazioni, policy, revoca e riapplicazione su un Postgres 16 + PostGIS locale
npm run dev              # app in locale
npm run build            # build di produzione
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

Ottobre 2026. In produzione su Vercel dal ramo `commercio` (ogni push su quel ramo va in produzione; gli altri rami
diventano anteprime).

- **Motore**: Territory Pack con validatore e CLI, grafo e affermazioni con prove, Tour Context Engine, Narrative
  Planner, bundle di runtime deterministici, nessun codice specifico per territorio (controllato in CI).
- **Guida**: app a quattro schede (Home, Esplora, Percorsi, Profilo); esplorazione libera e percorsi guidati nella stessa
  visita; esplorazione tematica «Storia e cultura» / «Locali e attività»; voce del dispositivo; uso offline; domande a
  Gaia con citazioni ed emergenze riconosciute senza modello; eventi del giorno; directory gratuita delle attività
  locali con foto, «Mostra sulla mappa» e descrizione letta da Gaia (senza AI).
- **Studio** (`/studio`): territori, luoghi e sottoluoghi, affermazioni con verifica a quattro occhi (l'amministratore
  può verificare le proprie), racconti, percorsi, foto, controllo di pubblicazione spiegato in parole semplici,
  pubblicazione nell'app senza deploy, eventi, attività, domande senza risposta, scheda Vendita.
- **Commerciale**: account dei visitatori, catalogo, acquisti con Stripe (solo modalità test), esplorazione, percorsi e
  singoli luoghi a pagamento consegnati da un bucket privato.
- **Primo territorio**: Portovenere, in fase di ricerca (18 luoghi; vedi `territories/it.liguria.sp.portovenere/README.md`).

Da fare: verifica sul campo di Portovenere (coordinate, percorsi) e passaggio a `production`; fornitore di tile della
mappa con licenza adeguata (`docs/v0.3-platform/MAPPA-SFONDO.md`); pagamenti in modalità live.

## Domande e ricerca web

Pipeline di `/api/guide/ask` (codice in `apps/guide/lib/ask.ts`, `ask-web.ts`, `ask-server.ts`):

1. **Base locale** — il modello riceve la base di conoscenza del bundle e risponde in JSON con le affermazioni
   citate; il sistema scarta citazioni inesistenti e numeri non presenti nelle fonti. Se la base risponde, finisce qui.
2. **Ricerca web** — solo se il visitatore tocca «Approfondisci» (decisione del 24/10: in automatico costava molto e
   spesso non trovava fonti; `ASK_WEB_AUTO=1` la riaccende quando la base risponde in parte o non risponde).
   Il modello riceve la stessa base, la risposta locale e lo strumento `web_search_20260318` (filtraggio dinamico dei
   risultati, nessun costo aggiuntivo per l'esecuzione del codice), con un numero massimo di ricerche e i domini
   esclusi. Le pagine trovate sono trattate come dati, mai come istruzioni.
3. **Risposta** — testo parlato con le fonti in «Fonti e approfondimenti» (titolo, sito, livello presunto della
   fonte, data se nota, brano citato). Una risposta con ricerca che non cita nessuna fonte non si mostra. Se la
   ricerca non è disponibile la guida risponde con la base locale e lo dice.

Le risposte con ricerca non diventano conoscenza verificata: compaiono nei log (`event: "web_answer"`, con le fonti)
perché la redazione le valuti e, se reggono, le porti nel Territory Pack.

**La guida, Gaia.** Le risposte hanno la voce di Gaia: identità e stile sono in `apps/guide/lib/persona.ts`
(documento di riferimento `docs/v0.4-gaia/CHARACTER-BIBLE.md`), separati dalle regole di verità di `ask.ts`, che
vengono prima. Le domande su di sé citano `persona:gaia`. I log riportano l'impronta delle istruzioni (`prompt`) e la
versione della persona (`persona`).

**Emergenze.** Un'emergenza (malore, persona dispersa, incidente, pericolo) riceve subito il rimando al 112, con l'esito
`safety`. Il riconoscimento è deterministico, per parole chiave in italiano e in inglese (`apps/guide/lib/emergency.ts`),
e gira in tre punti: nel browser prima della richiesta, quindi anche senza rete; nella route prima di configurazione,
limiti e contenuti; in `askGuide` prima del modello, anche con «Approfondisci». Nessuna chiamata, nessun costo. Per i
casi che le parole chiave non coprono resta la regola del prompt: il modello risponde `safety` e il controllo pretende
il 112.

**Il modello è sostituibile.** La risposta dalla base locale passa da un `ModelAdapter` (`apps/guide/lib/model.ts`):
Anthropic per default, oppure qualunque servizio con API compatibile OpenAI ("chat completions" con output JSON
vincolato: Mistral, vLLM, servizi gestiti di modelli aperti). Gli stessi controlli valgono per ogni modello. La ricerca
web resta uno strumento di Anthropic: con un altro fornitore è attiva solo se c'è anche `ANTHROPIC_API_KEY`.

Variabili d'ambiente (tutte facoltative tranne quelle del fornitore scelto):

| Variabile | Default | Effetto |
|---|---|---|
| `ASK_PROVIDER` | `anthropic` | `anthropic` oppure `openai-compatible` |
| `ASK_MODEL` | `claude-opus-5-5` | modello della risposta locale (obbligatorio con `openai-compatible`) |
| `ASK_BASE_URL` | — | con `openai-compatible`: indirizzo dell'API (es. `https://…/v1`) |
| `ASK_API_KEY` | — | con `openai-compatible`: chiave del servizio (solo lato server) |
| `ANTHROPIC_API_KEY` | — | obbligatoria con `anthropic`; con l'altro fornitore abilita la ricerca web (solo lato server) |
| `NEXT_PUBLIC_ACCOUNTS_ENABLED`, `NEXT_PUBLIC_TERMS_URL`, `NEXT_PUBLIC_PRIVACY_URL`, `NEXT_PUBLIC_LEGAL_VERSION`, `NEXT_PUBLIC_AUTH_PROVIDERS` | — | account dei visitatori (servono per acquistare, non per visitare): spenti finché non ci sono tutte le prime quattro; configurazione di Supabase in `docs/v0.3-platform/ACCOUNT.md` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | — | acquisti con Stripe, **solo modalità test** (una chiave live li spegne); solo server; configurazione in `docs/v0.3-platform/PAGAMENTI.md` |
| `ASK_MAX_USD_PER_QUESTION` | — | obbligatoria per le domande: dollari massimi **stimati** per domanda (es. `0.15`, con il punto). Assente o non valida: domande spente. Non è un tetto assoluto: vedi `docs/v0.3-platform/COSTI-AI.md` |
| `ASK_WEB_ENABLED` | `1` | `0` spegne la ricerca web (resta la base locale) |
| `ASK_WEB_AUTO` | — | `1` fa partire la ricerca anche senza «Approfondisci», quando la base non basta |
| `ASK_WEB_MAX_USES` | `3` | ricerche massime per domanda (1–10) |
| `ASK_WEB_MODEL` | `claude-opus-5-5` | modello della risposta con ricerca (es. `claude-sonnet-5-5` per spendere meno) |
| `ASK_WEB_EFFORT` | `medium` | `low` / `medium` / `high` |
| `ASK_WEB_PER_IP` | `6` | domande con ricerca per indirizzo ogni 10 minuti (per istanza) |
| `ASK_WEB_DAILY_LIMIT` | `300` | domande con ricerca al giorno per istanza del server |
| `ASK_WEB_BLOCKED_DOMAINS` | recensioni e social | domini esclusi, separati da virgole (vuoto = nessuno) |
| `ASK_CACHE_TTL_HOURS` | `24` | durata della cache delle risposte (0 = niente cache) |
| `ASK_WEB_TIMEOUT_MS` | `50000` | tempo massimo della risposta con ricerca (ridotto al tempo che resta: la route ha 60 s) |
| `ASK_DAILY_BUDGET_USD` | `10` | tetto di spesa giornaliero stimato, per istanza del server (0 = nessun tetto) |

Emergenze (`apps/guide/lib/emergency.ts`): le domande che segnalano un'emergenza ricevono subito il rimando al 112,
senza modello, senza configurazione e anche offline.

Ogni chiamata al modello passa dal budget per domanda (`apps/guide/lib/ask-cost.ts`: stima prima, costo reale dopo,
`max_tokens` e ricerche ridotti al residuo, nessun nuovo tentativo automatico): riduce il rischio ma non è un tetto
assoluto, perché i token dei risultati della prima ricerca non si conoscono prima della risposta. Sopra c'è il tetto
giornaliero (`apps/guide/lib/limits.ts`): una domanda parte solo se il suo budget massimo ci sta, e dopo si conta il
costo reale o stimato. Oltre il tetto la guida risponde solo dalla cache e dice di non poter rispondere; le emergenze
funzionano sempre. La risposta locale ha un solo tentativo da 25 s, e la ricerca usa solo il tempo che resta prima dei
55 s: la funzione non viene interrotta dalla piattaforma.

I limiti per indirizzo, per giorno e di spesa valgono per singola istanza del server: con più istanze il tetto
effettivo si moltiplica. Sono argini, non quote globali. Il tetto di spesa affidabile si imposta nella Console del
fornitore (per Anthropic, il limite di spesa del workspace a cui appartiene la chiave). `GET /api/guide/ask` dice se le
domande sono disponibili, se il budget è configurato, se la ricerca è attiva e se il modello la supporta (Models API).
Prove di qualità e costo: `npm run ask:eval -w @guide/app -- --file ../../territories/<id>/ASK-EVAL.json --out rapporto.md`
(chiama davvero il modello configurato: serve la chiave, un budget per domanda — `--max-usd-per-question` o
`ASK_MAX_USD_PER_QUESTION` — e ha un costo; `--dry` mostra solo cosa sa la base locale). Prima di ogni domanda tiene
libero l'intero budget per domanda e non parte se supererebbe `--max-usd`; `--file` si può ripetere, `--no-web` per la
sola base, `--web-model` e `--web-max-uses` per le varianti della ricerca, `--area` per una sola area della suite,
`--json` per salvare i risultati e confrontare due esecuzioni con
`npm run ask:compare -w @guide/app -- a.json b.json --out confronto.md` (nessun costo; `--blind` per la valutazione alla
cieca). Protocollo del confronto e rubrica: `docs/v0.3-platform/COSTI-AI.md`. La suite completa di Gaia è
`GAIA-EVAL.it.json` / `GAIA-EVAL.en.json` (163 casi per lingua): lo script calcola un punteggio automatico (esito,
citazioni, luogo, parole vietate, formato, lunghezza), le rubriche per la revisione umana sono in
`docs/v0.4-gaia/RUBRICHE.md`. Le risposte di riferimento di Gaia (`GAIA-EXAMPLES.it.json`) si controllano con
`npm run gaia:examples -w @guide/app -- --file ../../territories/<id>/GAIA-EXAMPLES.it.json` (nessun costo) e, una volta
approvate dalla redazione, si esportano con `--out` per allenare un modello aperto: `docs/v0.4-gaia/ESEMPI.md`.
