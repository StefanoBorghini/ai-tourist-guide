# Gaia con fornitori diversi da Anthropic

Bozza 0.1 · 26 ottobre 2026.

Come far rispondere Gaia con un modello diverso da quello di produzione e come valutarlo **sul proprio computer**, senza toccare la produzione. Riguarda solo le **domande** (`POST /api/guide/ask`). I racconti dei luoghi non usano modelli.

## 1. Cosa cambia e cosa no

| Parte | Con un altro fornitore |
|---|---|
| Base di conoscenza, prompt (`SYSTEM_PROMPT`), persona di Gaia | **Identici**: lo stesso testo va a qualunque modello |
| Controlli della risposta (`checkModelAnswer`: citazioni, numeri, secoli, 112) | **Identici**: una risposta che non li supera viene scartata, con qualunque modello |
| Emergenze riconosciute senza modello (`lib/emergency.ts`) | Identiche |
| Data e ora sul posto, dati pratici e controllo sullo stato di oggi (F1, `CONDIZIONI.md`) | Identici: lo stato di oggi senza un'informazione pratica valida è scartato con qualunque modello |
| Budget per domanda e tetto giornaliero | Identici. Un modello fuori listino è contato **con le tariffe più alte del listino**, mai gratis (§5) |
| «Approfondisci» (ricerca web) | **Solo Anthropic**. Senza `ANTHROPIC_API_KEY` la guida risponde con la sola base e lo dice |
| Ripiego lato server su un altro modello (`fallbacks`) | Solo Anthropic |

Il codice: `apps/guide/lib/model.ts`, con l'interfaccia `ModelAdapter` e due adattatori: `AnthropicAdapter` e `OpenAICompatibleAdapter`.

## 2. Variabili d'ambiente

| Variabile | Valori | Default | Note |
|---|---|---|---|
| `ASK_PROVIDER` | `anthropic`, `openai-compatible` | `anthropic` | |
| `ANTHROPIC_API_KEY` | chiave | — | Obbligatoria con `anthropic`. Con l'altro fornitore serve solo alla ricerca web |
| `ASK_MODEL` | nome del modello | `claude-opus-5-5` con Anthropic | Obbligatoria con `openai-compatible` |
| `ASK_BASE_URL` | indirizzo dell'API, es. `https://servizio.example/v1` | — | Obbligatoria con `openai-compatible`. Deve usare **https**; `http` è ammesso solo verso la stessa macchina (`localhost`, `127.0.0.1`, `::1`). Niente credenziali né parametri nell'indirizzo |
| `ASK_API_KEY` | chiave del servizio | — | Obbligatoria per ogni servizio **non locale**; facoltativa per un server su `localhost` (senza chiave non si manda l'intestazione `Authorization`) |
| `ASK_JSON_MODE` | `json_schema`, `json_object` | `json_schema` | Solo con `openai-compatible`. `json_object` per i servizi che non applicano lo schema: lo schema arriva al modello come istruzione di formato in fondo al messaggio di sistema, e la risposta passa comunque dagli stessi controlli |
| `ASK_TIMEOUT_MS` | millisecondi, da 5000 a 50000 | 25000 | Tempo massimo della risposta locale, per qualunque fornitore. Oltre i 25 s, un «Approfondisci» può restare senza tempo per la ricerca (la guida lo dichiara). Il massimo resta sotto i 60 s della route |
| `ASK_MAX_USD_PER_QUESTION` | dollari stimati per domanda | — | Obbligatoria (`docs/v0.3-platform/COSTI-AI.md`) |

**Una variabile non valida spegne le domande con un motivo leggibile**: `GET /api/guide/ask` risponde `available: false` e la domanda riceve 503. Non c'è mai un ripiego silenzioso. I motivi non contengono mai i valori delle chiavi.

**Errori:**

| Situazione | Tipo | Codice della route | Risposta al visitatore |
|---|---|---|---|
| Tempo scaduto | `timeout` (nei log `ask_error`) | 504 | identica |
| Limite di richieste del servizio | `rate_limit` | 429 | identica |
| Altri errori (HTTP, rete, corpo non JSON, nessuna scelta) | `unavailable` | 502 | identica |

## 3. Sviluppo e produzione: tenerli separati

- **Produzione: non si cambia niente** finché una valutazione (§6) non lo giustifica e il proprietario non lo decide. Le variabili di produzione si cambiano solo su Vercel, con una decisione esplicita.
- **Sviluppo e valutazione** si fanno sul proprio computer, con un file `apps/guide/.env.local` (ignorato da git) o con variabili impostate nel terminale.
- **Un server locale non è raggiungibile da Vercel.** Ollama su un portatile serve solo agli script di valutazione, eseguiti sullo stesso portatile.
- **Servizi esterni gratuiti:** solo con le domande di prova sintetiche (`GAIA-EVAL`), **mai** con domande vere dei visitatori. Le condizioni dei piani gratuiti possono prevedere l'uso dei dati: vanno lette prima.

## 4. Requisiti per i test sul proprio computer

- Node.js 22 e il repository installato (`npm ci` nella cartella principale).
- Un server compatibile OpenAI sulla stessa macchina. Per esempio **Ollama**, che espone `http://localhost:11434/v1`.
  - L'installazione è un passo a parte, da autorizzare.
  - Che applichi `json_schema` dipende dalla versione: se le risposte arrivano spesso «nel formato sbagliato», provare `ASK_JSON_MODE=json_object`.
- **Hardware:** con 16 GB di RAM conviene un modello piccolo (indicativamente 7–8 miliardi di parametri, compresso). Su sola CPU una risposta può richiedere decine di secondi.
- La **base** su cui valutare: vedi §6.1.

## 5. Costi con un modello non in listino

- Il listino (`lib/ask-cost.ts`, `PRICES`) contiene solo modelli Anthropic. Un modello che non c'è viene contato con le **tariffe più alte del listino** (qualità del costo `unknown`).
- Se il servizio non riporta i consumi, si conta il **caso peggiore stimato** della chiamata (`recordUnmetered`). Non c'è nessun «costo zero» automatico.
- Per un modello locale sono **contatori prudenti, non pagamenti**: nessuno addebita quei dollari. Ma il budget li applica davvero.
  - Il caso peggiore minimo della prima chiamata è stato misurato il 26/10 sulla fotografia del 25/10. Vale circa 0,07 $ con la base pubblica di Porto Venere (6 affermazioni) e circa 0,10 $ con la base completa (52 affermazioni): un budget per domanda più basso blocca la chiamata.
  - **Durante una valutazione locale** si alzano solo i tetti **dello script**, mai le variabili di produzione. Per esempio `--max-usd-per-question 0.5 --max-usd 100`: l'esecuzione si ferma quando il totale *stimato* supera `--max-usd`.
  - Il rapporto riporta questi costi come `unknown`: non vanno letti come spesa reale.
- Il costo dell'infrastruttura (server, elettricità) **non** è nei contatori. Va valutato a parte prima di qualsiasi uso in produzione (`docs/v0.4-gaia/`, fase D).

## 6. Valutare un modello: `ask:eval` e `gaia:examples`

### 6.1 Quale base usare
- **Senza opzioni**, gli script leggono il **bundle pubblicato**: lo stesso delle domande dei visitatori. Con l'esplorazione a pagamento contiene solo le panoramiche gratuite (per Porto Venere, il 25/10, 6 affermazioni su 52): quasi tutte le domande di prova risultano «non lo so».
- **`--pack <cartella>`** compila la base **sul proprio computer**, da una cartella di Territory Pack:
  - una fotografia del database: `select pack_snapshot('it.liguria.sp.portovenere');` → file JSON → `guide-pack db-export <snapshot.json> --out <cartella>/it.liguria.sp.portovenere`, più una copia di `territories/it.liguria` nella stessa cartella;
  - oppure i file del repository (`territories`), che possono essere indietro rispetto al database.
- **`--full`** (solo con `--pack`) include anche i contenuti che in produzione sono a pagamento: le suite `GAIA-EVAL` e gli esempi sono scritti sulla base completa.

**Sicurezza dei contenuti a pagamento:**
- `--pack` e `--full` esistono **solo negli script** (`lib/eval-knowledge.ts`). La route delle domande non li usa: lo verifica `test/eval-knowledge.test.ts`.
- Nessun dato viene scritto né pubblicato.
- La fotografia contiene contenuti a pagamento: **tenerla fuori dal repository** e non condividerla.

### 6.2 Comandi
Dalla cartella principale del repository.

Windows PowerShell, server locale:
```powershell
$env:ASK_PROVIDER = "openai-compatible"
$env:ASK_BASE_URL = "http://localhost:11434/v1"
$env:ASK_MODEL = "<nome-del-modello>"
# $env:ASK_JSON_MODE = "json_object"   # solo se serve (§4)

# 1. Gratuito, nessuna chiamata: cosa sa la base su ogni domanda
npm run ask:eval -w @guide/app -- --file ../../territories/it.liguria.sp.portovenere/GAIA-EVAL.it.json --pack C:\percorso\fotografia --full --dry --out dry.md

# 2. Con il modello locale, senza ricerca web, un'area alla volta
npm run ask:eval -w @guide/app -- --file ../../territories/it.liguria.sp.portovenere/GAIA-EVAL.it.json --pack C:\percorso\fotografia --full --no-web --area fatti-base --timeout-ms 300000 --max-usd-per-question 0.5 --max-usd 100 --json locale.json --out locale.md

# 3. Gli esempi di riferimento sulla stessa base (nessun modello)
npm run gaia:examples -w @guide/app -- --file ../../territories/it.liguria.sp.portovenere/GAIA-EXAMPLES.it.json --pack C:\percorso\fotografia --full
```

Opzioni:
- `--timeout-ms` (da 5000 a 600000) vale **solo per quell'esecuzione**: per i modelli lenti sul proprio computer. Non cambia la route.
- `--no-web`: senza la chiave Anthropic la ricerca è comunque spenta.

**Confronto tra due esecuzioni:** stesse domande, stessa base.
```
npm run ask:compare -w @guide/app -- a.json b.json --blind --key chiave.json --scores-template punteggi.json --out cieca.md
```
- Il confronto segnala se le due esecuzioni usano basi diverse (`kbHash`).
- Il rapporto e il file `--json` riportano la base usata, il tempo massimo e il modello.

**Fermare una prova:** `Ctrl+C` nel terminale. Lo script non avvia servizi e non lascia nulla in esecuzione. Si ferma da solo alla prima chiamata fallita (per esempio un tempo scaduto) e lo scrive nel rapporto.

### 6.3 Cosa misurare
- La rubrica è in `docs/v0.4-gaia/RUBRICHE.md`.
- In breve:
  - esito corretto;
  - citazioni attese;
  - risposte scartate dai controlli (numeri o citazioni inventati);
  - «non lo so» quando la base non risponde;
  - iniezioni respinte;
  - emergenze;
  - italiano e voce di Gaia, con una lettura alla cieca;
  - tempo di risposta;
  - token.
- Il punteggio automatico è un primo filtro: il giudizio resta umano.

## 7. Limiti noti

- **«Approfondisci»** (ricerca web) esiste solo con Anthropic.
- **«Compatibile OpenAI» non vuol dire identico.**
  - Lo schema `strict` non è applicato da tutti i servizi: c'è `ASK_JSON_MODE=json_object`.
  - Alcuni modelli dell'API OpenAI chiedono `max_completion_tokens` al posto di `max_tokens`: l'adattatore manda `max_tokens`, accettato dai server locali tipo Ollama. **Non verificato** per ogni servizio.
  - L'adattatore usa `temperature: 0.3`.
- **Cache del prompt:** con Anthropic è esplicita. Con gli altri servizi dipende dal servizio. Senza cache ogni domanda rielabora tutta la base: più lento sui modelli locali.
- **Tempi:** la route ha 60 s in tutto. Un modello che impiega più di 50 s non è utilizzabile in produzione, nemmeno con `ASK_TIMEOUT_MS`.
- **I limiti di spesa sono per istanza e in memoria** (`lib/limits.ts`). Con un server proprio non c'è una console del fornitore con un tetto rigido.
- **I costi di un modello locale** nei contatori sono stime prudenti, non spese (§5).
