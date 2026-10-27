# Gaia e le condizioni di oggi (fasi F1 «contesto e prudenza» e F2 «avvisi operativi»)

Bozza 0.2 · 27 ottobre 2026. Prime due fasi del piano sulle fonti dinamiche (analisi del 27/10). Riguarda solo le
**domande** (`POST /api/guide/ask`); i racconti dei luoghi non cambiano.

## Regola

**Il bel tempo non dimostra che un sentiero sia aperto.** Lo stato di oggi di un sentiero, un luogo o un servizio
(aperto, chiuso, praticabile, orari di oggi) Gaia lo dice solo se lo afferma un **avviso operativo** in vigore (F2) o
un'**informazione pratica** della base ancora valida, e lo cita. Nessun avviso non vuol dire che tutto sia aperto. Altrimenti dichiara che non può verificarlo e indica dove controllare (sito ufficiale
dell'ente, ufficio turistico). Meteo, allerte e condizioni del mare non li conosce: lo dice.

## Cosa riceve Gaia

| Dato | Da dove | Come si cita | Note |
|---|---|---|---|
| Data e ora sul posto | calcolate dal server a ogni domanda | `context:time` | Fuso `Europe/Rome`, lo stesso predefinito di `destinations.timezone`: il bundle non porta ancora il fuso della destinazione |
| Percorsi | `routes` del bundle pubblico | `route:<percorso>` | Durata (stimata o misurata sul campo), difficoltà, dislivello, tappe, fonti. Non dicono se oggi il percorso è aperto |
| Informazioni pratiche | `places[].practical` del bundle pubblico | `info:<luogo>#<n>` | Testo, data del controllo e ultimo giorno di validità (`checkedAt` + `recheckAfterDays`). Quelle scadute le elenca il messaggio della domanda, calcolate dal sistema |
| Note di sicurezza | `config.safetyNotes` | `safety:<id>` | |
| Avvisi operativi (F2) | `public_operational_notices()`, letti a ogni domanda (al massimo una volta al minuto) | `op:<avviso>` | Solo pubblicati, verificati, con fonte https e in vigore oggi nel fuso della destinazione. Stanno nel messaggio della domanda, mai nella base in cache. Senza risposta entro 1,5 s il messaggio dice che non sono disponibili; nessun avviso si dichiara come tale |

Solo il **bundle pubblico** (decisione D10): i percorsi a pagamento e i loro dati non arrivano a Gaia per questa via.

## Controlli deterministici (`lib/ask-operational.ts`, `checkModelAnswer`)

- Le citazioni `route:`, `info:`, `safety:` e `op:` devono esistere nella base o tra gli avvisi della domanda; i numeri della risposta devono venire dai dati
  citati (durata, dislivello, orari del testo, date del controllo).
- La data e l'ora si possono dire solo citando `context:time`.
- **Stato di oggi:** una frase che lo dichiara («il sentiero è aperto», «oggi è chiusa», «is open») scarta la risposta
  se non cita un avviso in vigore o un'informazione pratica ancora valida. Non contano le frasi ipotetiche («non so se oggi è aperto») né le
  descrizioni del paesaggio («è aperto sul golfo», «chiusa tra due promontori»). Contano anche «è visitabile», «è accessibile»
  (non «accessibile ai disabili», «in barca», «solo dal mare») e, solo con oggi, ora, domani…, «è raggiungibile» e «si può
  visitare» (da solo «raggiungibile in barca» è una descrizione). Il
  controllo è volutamente stretto: il resto lo misura la suite di prova (area `condizioni`).
- La cache delle risposte distingue giorno e ora sul posto (`cacheSlot`) e gli avvisi in vigore (`noticesKey`): un avviso
  nuovo, cambiato o ritirato non serve più la risposta vecchia.
- «Approfondisci» (ricerca web): stessa regola nel prompt; uno stato trovato sul web si riferisce con la fonte e la data
  della pagina, invitando comunque a verificare sul sito dell'ente. Il controllo dei numeri del web resta non bloccante.

Valgono con qualunque fornitore del modello (Anthropic o compatibile OpenAI, anche un server locale: `PROVIDER-ALTERNATIVI.md`): il contesto è nel messaggio e il controllo è sul server. Prove insieme alla fase B in `test/integrazione-b-f1.test.ts`.

Nell'app, la sezione «Fonti» della risposta mostra anche le fonti dei percorsi e delle informazioni pratiche citate: lì
c'è il collegamento al sito ufficiale. Gli avvisi citati vi compaiono a parte («Avvisi di oggi, verificati dalla
redazione»), con il collegamento alla fonte, il giorno della verifica e la fine della validità.

## Cosa serve alla redazione

Oggi Porto Venere non ha informazioni pratiche né note di sicurezza, e tutti i suoi percorsi sono a pagamento: la F1
porta subito la data di oggi e la regola di prudenza, ma i dati pratici compaiono solo quando la redazione li inserisce.
**Lo Studio ha la sezione «Informazioni pratiche» nella scheda di ogni luogo** (migrazione `20261104000000_studio_practical.sql`,
`studio_set_practical`): tipo, testo, data del controllo, giorni di validità e fonte, con le regole del Territory Pack.
Valgono nell'app dalla «Ripubblica» successiva.

## Avvisi operativi (F2)

Per ciò che cambia di giorno in giorno (frana, lavori, chiusura straordinaria, solo su prenotazione) c'è la scheda
**«Avvisi» dello Studio** (migrazione `20261105000000_operational_notices.sql`, sul modello degli eventi del giorno):

- un avviso ha uno stato (chiuso, con limitazioni, solo su prenotazione, con cautela, aperto), un titolo e un testo per
  lingua, un luogo o un percorso (o tutta la destinazione), le date di validità (al massimo 180 giorni) e la fonte https;
- nasce in bozza; si pubblica solo con la fonte verificata e se non è scaduto; cambiare stato, testi, date, soggetto o
  fonte di un avviso pubblicato richiede una nuova verifica nello stesso salvataggio;
- pubblicato e in vigore, Gaia lo usa entro un minuto, senza ripubblicare il territorio; ritirato o scaduto, smette;
- la nota di verifica è interna; il pubblico (e Gaia) legge solo `public_operational_notices()`, campi elencati uno per uno;
- le bozze le elimina chi modifica il territorio, gli altri avvisi solo l'amministratore; la revoca della migrazione si
  ferma se esiste anche un solo avviso.

Il server legge gli avvisi con la chiave anonima, senza cookie (`lib/ask-notices-server.ts`). Senza Supabase, per una
destinazione non pubblicata nel database o finché la migrazione non è applicata, le domande funzionano come in F1.

## Costi

Il prompt fisso cresce di circa 420 token (in cache; quello della ricerca web di circa 160), il messaggio di ogni domanda di circa 80; la base cresce con i dati
pratici della destinazione (zero per Porto Venere oggi) e il messaggio con gli avvisi in vigore (circa 60 token
ciascuno). Nessuna chiamata al modello nuova; una lettura del database al minuto per destinazione e lingua.

## Limiti e passi successivi

- Fuso fisso finché il bundle non porta `timezone` (da aggiungere alla pubblicazione).
- Nessun dato meteo né allerta dalle fonti ufficiali: fasi F3 (meteo ARPAL) e F4 (allerte). Lo stato dei sentieri
  arriva solo dagli avvisi che la redazione inserisce e verifica (F2), non da un collegamento automatico all'ente.
- Le prove della suite (`ask:eval`) girano senza avvisi: le domande con un avviso sono coperte dai test unitari
  (`test/ask-notices.test.ts`), non ancora da casi della suite.
- Gli esempi di riferimento (`GAIA-EXAMPLES`) non hanno ancora i casi dell'area `condizioni`.
