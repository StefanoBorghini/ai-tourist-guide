# Gaia e le condizioni di oggi (fase F1, «contesto e prudenza»)

Bozza 0.1 · 27 ottobre 2026. Prima fase del piano sulle fonti dinamiche (analisi del 27/10). Riguarda solo le
**domande** (`POST /api/guide/ask`); i racconti dei luoghi non cambiano.

## Regola

**Il bel tempo non dimostra che un sentiero sia aperto.** Lo stato di oggi di un sentiero, un luogo o un servizio
(aperto, chiuso, praticabile, orari di oggi) Gaia lo dice solo se lo afferma un'**informazione pratica** della base
ancora valida, e la cita. Altrimenti dichiara che non può verificarlo e indica dove controllare (sito ufficiale
dell'ente, ufficio turistico). Meteo, allerte e condizioni del mare non li conosce: lo dice.

## Cosa riceve Gaia

| Dato | Da dove | Come si cita | Note |
|---|---|---|---|
| Data e ora sul posto | calcolate dal server a ogni domanda | `context:time` | Fuso `Europe/Rome`, lo stesso predefinito di `destinations.timezone`: il bundle non porta ancora il fuso della destinazione |
| Percorsi | `routes` del bundle pubblico | `route:<percorso>` | Durata (stimata o misurata sul campo), difficoltà, dislivello, tappe, fonti. Non dicono se oggi il percorso è aperto |
| Informazioni pratiche | `places[].practical` del bundle pubblico | `info:<luogo>#<n>` | Testo, data del controllo e ultimo giorno di validità (`checkedAt` + `recheckAfterDays`). Quelle scadute le elenca il messaggio della domanda, calcolate dal sistema |
| Note di sicurezza | `config.safetyNotes` | `safety:<id>` | |

Solo il **bundle pubblico** (decisione D10): i percorsi a pagamento e i loro dati non arrivano a Gaia per questa via.

## Controlli deterministici (`lib/ask-operational.ts`, `checkModelAnswer`)

- Le citazioni `route:`, `info:` e `safety:` devono esistere nella base; i numeri della risposta devono venire dai dati
  citati (durata, dislivello, orari del testo, date del controllo).
- La data e l'ora si possono dire solo citando `context:time`.
- **Stato di oggi:** una frase che lo dichiara («il sentiero è aperto», «oggi è chiusa», «is open») scarta la risposta
  se non cita un'informazione pratica ancora valida. Non contano le frasi ipotetiche («non so se oggi è aperto») né le
  descrizioni del paesaggio («è aperto sul golfo», «chiusa tra due promontori»). Il controllo è volutamente stretto: il
  resto lo misura la suite di prova (area `condizioni`).
- La cache delle risposte distingue giorno e ora sul posto (`cacheSlot`).
- «Approfondisci» (ricerca web): stessa regola nel prompt; uno stato trovato sul web si riferisce con la fonte e la data
  della pagina, invitando comunque a verificare sul sito dell'ente. Il controllo dei numeri del web resta non bloccante.

Valgono con qualunque fornitore del modello (Anthropic o compatibile OpenAI, anche un server locale: `PROVIDER-ALTERNATIVI.md`): il contesto è nel messaggio e il controllo è sul server. Prove insieme alla fase B in `test/integrazione-b-f1.test.ts`.

Nell'app, la sezione «Fonti» della risposta mostra anche le fonti dei percorsi e delle informazioni pratiche citate: lì
c'è il collegamento al sito ufficiale.

## Cosa serve alla redazione

Oggi Porto Venere non ha informazioni pratiche né note di sicurezza, e tutti i suoi percorsi sono a pagamento: la F1
porta subito la data di oggi e la regola di prudenza, ma i dati pratici compaiono solo quando la redazione li inserisce.
**Lo Studio non ha ancora un modulo per le informazioni pratiche**: per i territori gestiti dal database va aggiunto (fase
successiva, da autorizzare), oppure si inseriscono con `import_pack()` da una copia del pack.

## Costi

Il prompt fisso cresce di circa 350 token (in cache; quello della ricerca web di circa 160), il messaggio di ogni domanda di circa 80; la base cresce con i dati
pratici della destinazione (zero per Porto Venere oggi). Nessuna chiamata nuova.

## Limiti e passi successivi

- Fuso fisso finché il bundle non porta `timezone` (da aggiungere alla pubblicazione).
- Nessun dato meteo, allerta o stato dei sentieri dalle fonti ufficiali: fasi F2 (avvisi operativi verificati, sul
  modello degli eventi del giorno), F3 (meteo ARPAL), F4 (allerte).
- Gli esempi di riferimento (`GAIA-EXAMPLES`) non hanno ancora i casi dell'area `condizioni`.
