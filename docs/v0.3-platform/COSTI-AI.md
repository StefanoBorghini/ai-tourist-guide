# Costi delle domande all'AI: protezioni e confronto della ricerca web (2026-10-13)

Il visitatore fa una domanda; la guida risponde con la base verificata e, se serve, con la ricerca web
(`app/api/guide/ask/route.ts`, `lib/ask-server.ts`, `lib/ask-web.ts`). Questo documento descrive come il codice limita
la spesa per domanda, che cosa resta stimato e come confrontare `ASK_WEB_MAX_USES=1` e `3` prima di decidere.

**Il budget nel codice riduce il rischio, non è un tetto assoluto.** Il tetto rigido è il limite di spesa del
workspace nella Console Anthropic, a cui appartiene la chiave. Va impostato comunque.

## Protezioni nel codice

| Protezione | Dove | Che cosa garantisce |
|---|---|---|
| Budget per domanda `ASK_MAX_USD_PER_QUESTION` | `lib/ask-cost.ts` (`questionBudgetConfig`, `QuestionBudget`) | Obbligatorio: assente o non valido (vuoto, non numerico, ≤ 0, virgola al posto del punto) → domande all'AI spente, nessuna chiamata, errore nei log (`ask_config_error`), `GET /api/guide/ask` risponde `available: false`. Nessun valore di ripiego. |
| Stima prima di ogni chiamata | `QuestionBudget.plan`, `askLocal`, `askWeb` | Prima della risposta locale e prima di **ogni** giro della ricerca si calcola il caso peggiore stimato; se non ci sta nel residuo la chiamata non parte. |
| `max_tokens` ridotto | `QuestionBudget.plan` | Se il limite pieno (4.000 locale, 6.000 ricerca) non ci sta, si riduce al residuo; sotto il minimo utile (1.000 / 1.500) la chiamata non parte. |
| Ricerche limitate | `askWeb` | `max_uses` = ricerche rimaste (`ASK_WEB_MAX_USES` meno quelle già fatte), ridotte ulteriormente se il budget non le copre; mai un giro senza ricerche disponibili. |
| Giri limitati | `WEB_MAX_ROUNDS = 3` | `pause_turn` non può generare cicli: al massimo 3 giri, ciascuno passa dal budget. |
| Ripiego nel budget | `askGuide` | Nell'approfondimento la ricerca lascia da parte il costo della risposta locale minima, così il ripiego dopo un errore resta pagabile; nel percorso normale la risposta locale c'è già e non si ripaga. Se il budget non basta nemmeno per il ripiego: risposta controllata «non riesco a rispondere», senza dettagli interni. |
| Nessun nuovo tentativo automatico | `new Anthropic({ maxRetries: 0 })` nella route e in `ask:eval`, più `maxRetries: 0` su ogni chiamata | Un tempo scaduto o un errore di rete non si ripete in silenzio (l'SDK di default ritenta 2 volte). Compromesso: meno resilienza agli errori temporanei; il visitatore vede «non riesco a rispondere» e può riprovare. |
| Costo per modello | `usageParts` (usa `usage.iterations` dell'API) | Ogni passaggio (giri della ricerca, modello che ha declinato, modello di ripiego) si prezza con il suo listino. |
| Mai costo zero | `recordFailure`, `CONSERVATIVE_RATES` | Tempo scaduto, rete o 5xx: si conta il caso peggiore stimato della chiamata (`estimated`). Modello fuori listino: tariffe più alte del listino (`unknown`). Solo un rifiuto HTTP 4xx dell'API (richiesta non eseguita) conta zero. |
| Log | evento `ask` / `ask_error` | Modelli serviti, percorso, giri, ricerche, token (anche cache), costo, qualità del costo (`measured`/`estimated`/`unknown`), budget (limite, speso, motivo dell'arresto), ogni chiamata (`modelCalls`). Nessuna chiave; la domanda resta solo negli eventi `knowledge_gap`/`web_answer` come prima. |

### Che cosa resta stimato

- **Risultati della prima ricerca.** Il testo che il modello legge non si conosce prima della risposta: il budget conta
  `SEARCH_RESULT_TOKENS_ALLOWANCE` (10.000 token) per ricerca. Se le pagine sono più lunghe, quella chiamata può
  costare più della stima. Dal giro successivo il contesto è noto (dai consumi restituiti) e il budget lo usa.
- **Token d'ingresso stimati dai caratteri** (`CHARS_PER_TOKEN = 2`, per eccesso) e tutti al prezzo più alto
  (scrittura in cache). Prudente; va tarato con i consumi reali di `ask:eval`.
- **Ripiego automatico (`fallbacks: "default"`).** Se Opus 5.5 declina, l'API ripete la richiesta su un altro modello:
  una chiamata può pagare due passaggi, oltre la stima. Il costo reale viene comunque registrato e scalato dal residuo.
- **Costo a listino, non fatturato.** Il fatturato è nella Console; sconti o rimborsi del ripiego non sono visibili qui.
- **Nessun limite globale.** Budget e contatori valgono per singola domanda o singola istanza: un registro condiviso
  dei consumi richiede il database (fuori da questa fase).

### Valori di riferimento per scegliere il budget

Casi peggiori **stimati** da `QuestionBudget.plan` sul bundle dei file di Portovenere (`kbHash 3031a471…`, Opus 5.5).
Non sono costi misurati: sono le soglie che il codice usa per decidere se una chiamata parte.

| Chiamata | Caso peggiore stimato |
|---|---|
| Risposta locale minima (1.000 token in uscita) | 0,074 $ |
| Risposta locale piena (4.000) | 0,134 $ |
| Ricerca, 1 ricerca, uscita minima (1.500) | 0,145 $ |
| Ricerca, 1 ricerca, uscita piena (6.000) | 0,235 $ |
| Ricerca, 3 ricerche, uscita piena | 0,355 $ |

Con un budget sotto 0,074 $ nessuna domanda parte. Per la ricerca serve il costo **reale** della risposta locale (già
pagata, in genere molto sotto la stima) più almeno 0,145 $. Nell'approfondimento la ricerca deve lasciare libero 0,074 $.
Il valore di `ASK_MAX_USD_PER_QUESTION` lo decide il proprietario, dopo le misure reali.

## Confronto `ASK_WEB_MAX_USES` 1 contro 3

### Corpus

`ASK-EVAL.json` (13 domande) più `ASK-EVAL-RICERCA.json` (10) nel pack di Portovenere: fatti storici, risposte già
nella base, orientamento, fuori tema, fonti incerte o discordanti, informazioni pratiche (orari, biglietti, sicurezza),
informazioni aggiornate (restauri, eventi), domande che chiedono più ricerche, approfondimenti.

Limiti del corpus: il campo `check` contiene **criteri di comportamento, non risposte di riferimento verificate**. La
correttezza si giudica sulle fonti citate. 23 domande bastano per vedere differenze grandi, non per conclusioni
statistiche: con meno di 10 domande per gruppo i percentili sono segnati come indicativi.

### Procedura (con spesa reale: solo dopo approvazione esplicita)

1. Limite di spesa del workspace impostato e verificato nella Console Anthropic.
2. Stesso bundle (`npm run bundles`), stesso modello, stesso effort, stesso budget per domanda per le due esecuzioni.
3. Esecuzione A e B (dalla radice del repository; i percorsi sono relativi a `apps/guide`):
   ```
   npm run ask:eval -w @guide/app -- --file ../../territories/it.liguria.sp.portovenere/ASK-EVAL.json \
     --file ../../territories/it.liguria.sp.portovenere/ASK-EVAL-RICERCA.json \
     --web-max-uses 1 --max-usd-per-question <valore> --max-usd <tetto> --json a.json --out a.md
   # stessa riga con --web-max-uses 3 --json b.json --out b.md
   ```
   Prima di ogni domanda si tiene libero l'intero budget per domanda: l'esecuzione si ferma prima di superare `--max-usd`
   (stima: vedi «Che cosa resta stimato»). Con 23 domande il massimo stimato per esecuzione è 23 × budget per domanda.
4. Costi e comportamento: `npm run ask:compare -w @guide/app -- a.json b.json --out confronto.md` (nessun costo).
5. Qualità alla cieca: `npm run ask:compare -w @guide/app -- a.json b.json --blind --key chiave.json --scores-template punteggi.json --out cieca.md`.
   Chi valuta legge `cieca.md` (risposte X/Y in ordine casuale, senza costi né configurazione) e compila `punteggi.json`
   con la rubrica; la chiave non si apre prima di aver finito.
6. Si scioglie: `npm run ask:compare -w @guide/app -- a.json b.json --key chiave.json --scores punteggi.json --out confronto.md`.

### Rubrica (la stessa per A e B)

| Voce | Punteggio |
|---|---|
| corretta | 0 errata · 1 in parte corretta · 2 corretta (rispetto alle fonti citate e alla base) |
| completezza | 0 manca l'essenziale · 1 risponde in parte · 2 risponde alla domanda |
| pertinenza | 0 fuori tema · 1 divaga · 2 pertinente |
| fonti | 0 nessuna fonte adeguata · 1 fonti deboli o citazioni imprecise · 2 fonti attendibili citate correttamente |
| fuorviante | vero se afferma ciò che le fonti non dicono o presenta ipotesi come certezze |

Lunghezza e numero di fonti non sono criteri.

### Metriche raccolte

Per esecuzione e per gruppo (domande normali / che richiedono la ricerca): costo per domanda (mediana, 90° percentile,
massimo), ricerche, giri, token in ingresso e in uscita (con quota letta dalla cache), tempo, risposte non disponibili,
ricerche fallite con ripiego, fermate dal budget, costi non misurati. Dalla valutazione: quota di risposte corrette,
medie per voce, risposte fuorvianti, per categoria di domanda.

### Stato (2026-10-13)

**Nessuna misura reale.** Le prove con spesa non sono state eseguite (servono approvazione e limite di spesa). Gli
script sono stati provati solo a vuoto (`--dry`) e con esecuzioni simulate, che non sono risultati.

| Domanda | Risposta con le evidenze disponibili |
|---|---|
| Quanto si riducono le ricerche da 3 a 1? | Per costruzione al massimo una ricerca per domanda invece di tre. La riduzione reale dipende da quante domande ne usano più di una: da misurare. |
| Differenza di costo | Stima: ogni ricerca evitata risparmia 0,01 $ di tariffa più i token dei risultati (con la stima di 10.000 token, circa 0,05 $ su Opus 5.5). Da misurare. |
| Quanto cambia la qualità | Non misurato. |
| Categorie più a rischio con una ricerca | Ipotesi da verificare: domande in più parti, fonti discordanti, informazioni aggiornate. |
| 1 è una buona impostazione iniziale? | Non è dimostrato: serve il confronto. Il budget per domanda limita comunque la spesa con entrambe le impostazioni. |
| Limiti residui | Vedi «Che cosa resta stimato». |
