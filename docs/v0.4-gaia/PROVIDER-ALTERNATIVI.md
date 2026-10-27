# Gaia con fornitori diversi da Anthropic

Bozza 0.1 · 26 ottobre 2026.

Come far rispondere Gaia con un modello diverso da quello di produzione e come valutarlo **sul proprio computer**, senza toccare la produzione. Riguarda solo le **domande** (`POST /api/guide/ask`). I racconti dei luoghi non usano modelli.

## 1. Cosa cambia e cosa no

| Parte | Con un altro fornitore |
|---|---|
| Base di conoscenza, prompt (`SYSTEM_PROMPT`), persona di Gaia | **Identici**: lo stesso testo va a qualunque modello |
| Controlli della risposta (`checkModelAnswer`: citazioni, numeri, secoli, 112) | **Identici**: una risposta che non li supera viene scartata, con qualunque modello |
| Emergenze riconosciute senza modello (`lib/emergency.ts`) | Identiche |
| Data e ora sul posto, dati pratici e controllo sullo stato di oggi (F1, `CONDIZIONI.md`) | Identici: lo stato di oggi senza un avviso in vigore o un'informazione pratica valida è scartato con qualunque modello |
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
- **Contesto di Ollama (misurato il 27/10):** il prompt di Gaia con la base completa di Porto Venere vale circa **8.100 token**. Ollama carica i modelli con un contesto più piccolo (4.096 nella prova) e taglia il prompt **senza avvisare**: il modello non vede parte delle regole o della base, e la valutazione non vale. L'API compatibile OpenAI non permette di chiedere più contesto: serve un modello derivato con `PARAMETER num_ctx 16384` (`ollama create <nome> -f <Modelfile>`, con `FROM <modello>`). Verifiche: `ollama ps` (colonna `CONTEXT`) e, nel log del server, `truncated = 0` con `n_tokens` sopra gli 8.000.
- **Modelli che «ragionano» (es. qwen3):** prima della risposta producono centinaia o migliaia di token di ragionamento. Su un portatile possono servire più minuti per una sola domanda (27/10: 1,8–10 token al secondo su i7-11370H con GPU parziale e RAM quasi piena). Chiudere le applicazioni pesanti prima delle prove.
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
- `--timeout-ms` (da 5000 a 600000) vale **solo per quell'esecuzione**: per i modelli lenti sul proprio computer. Non cambia la route. Lo script chiama il fornitore compatibile OpenAI senza il limite di 5 minuti del `fetch` di Node (`lib/eval-fetch.ts`, solo script), che con un server senza streaming come Ollama farebbe fallire con «fetch failed» ogni risposta oltre i 300 s.
- `--no-web`: senza la chiave Anthropic la ricerca è comunque spenta.
- Per ogni risposta scartata dai controlli il rapporto (e il file `--json`, campo `rejectedText`) riporta anche il **testo originale del modello**, per capire perché è stata scartata. Solo valutazione: la route non lo registra né lo invia, e il visitatore riceve il messaggio di ripiego.
- Gli errori HTTP del servizio riportano il motivo scritto dal servizio (per esempio `HTTP 500: …`), accorciato a 200 caratteri e con la chiave mascherata, anche nei log della route.

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

## 8. Prove con modelli locali (27/10, portatile i7-11370H, 16 GB, RTX 3050 Laptop 4 GB)

Area `condizioni` di `GAIA-EVAL`, base dei file del repository (`--pack ../../territories --full`).

| Modello | Esito | Note |
|---|---|---|
| qwen3:4b (contesto predefinito 4.096) | inutilizzabile | Prompt tagliato a circa 2.000 token senza avviso |
| qwen3:4b con `num_ctx 16384` | inutilizzabile | Ragiona sempre (oltre 2.000 token per una frase), anche con un template che chiude il ragionamento; 1,5–2 token/s con il prompt intero: oltre 10 minuti |
| gemma3:4b con `num_ctx 12288` | veloce, non affidabile | 5–30 s a risposta (la cache del prompt di Ollama aiuta). Con `json_schema` a volte va in ciclo («token repeat limit reached»): meglio `ASK_JSON_MODE=json_object`. 2 risposte valide su 8: riferimenti inventati o copiati dagli esempi, dati di un percorso attribuiti a un altro, nomi di enti inventati, una conferma falsa ripetuta. I controlli le hanno scartate tutte |
| gemma3:4b, dopo le correzioni del prompt e dei riferimenti nel testo | migliore, ancora non affidabile | 4 risposte valide su 8. Restano: riferimenti inventati, la conferma falsa della conversazione ripetuta («Sì, è aperto»), percorsi confusi, «è accessibile» detto senza fonte (ora riconosciuto dal controllo sullo stato di oggi). Tutte scartate |

Conclusioni (prove chiuse su questo portatile il 27/10): un modello da 4 miliardi di parametri non basta per Gaia, nemmeno con i controlli (il visitatore riceverebbe quasi sempre il ripiego). Servono un modello più grande, quindi un altro hardware, o un allenamento sugli esempi approvati (`ESEMPI.md`). I controlli non verificano i nomi propri (enti, luoghi esterni): con modelli piccoli è un rischio da valutare prima di qualsiasi uso.
