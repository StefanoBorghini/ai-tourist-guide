# Checklist del test sul campo — Portovenere

Versione dell'app: dal commit `df722e6` (esplorazione libera + percorsi guidati); domande con ricerca web e
contatore dei costi in debug dai commit successivi (verificare in Debug → «Contenuti» che telefono e server coincidano).
Scopo: calibrare coordinate e geofence, verificare proposte audio, luoghi vicini e passaggio tra modalità.
Nessun punto diventa `field_verified` durante il test: i rilievi si esportano e si rivedono dopo con
`guide-pack field` (propone, non scrive nel pack).

Legenda: ☐ da fare · ✓ superato · ✗ non superato (annotare cosa, dove, a che ora).

## 0. Prima di partire (con rete)

- ☐ Aprire l'app con `?debug=1` nell'indirizzo; Portovenere → Italiano.
- ☐ «Scarica per l'uso offline»: deve comparire «Disponibile offline».
- ☐ Sintesi vocale: volume alto, modalità silenzioso disattivata, auricolare/cassa se c'è rumore.
- ☐ Batteria carica (lo schermo resterà acceso) e una batteria esterna.
- ☐ Domande AI: con rete, l'indirizzo `/api/guide/ask` deve rispondere `{"available":true}`.
  Se risponde `false`, `ANTHROPIC_API_KEY` non è impostata nel progetto Vercel (Production).
- ☐ Annotare modello di telefono, sistema operativo e browser.

## 0b. Budget delle prove (20 $ complessivi, piano di spesa)

Ripartizione: 5 $ base locale (fase A) · 5 $ ricerca web (fase B) · 10 $ riserva per il campo.

- ☐ Console Anthropic: annotare il credito disponibile prima di iniziare (`____ $`) e verificare che la
  **ricarica automatica sia disattivata**. Con il credito prepagato e la ricarica spenta, a credito esaurito
  l'API smette di rispondere: è l'unico tetto davvero globale. I limiti dell'app valgono per istanza del server.
- ☐ Debug (`?debug=1`) → «azzera» il totale delle domande nella sezione domande prima di ogni fase.
- ☐ Dopo ogni fase annotare: totale stimato mostrato dal telefono, numero di domande, quante con ricerca,
  e la «Spesa di questo mese» della Console (confrontare **prima e dopo** la stessa fase, non periodi diversi).
- ☐ Fermarsi quando il totale della fase raggiunge la sua quota.
- Costi attesi (stime, non misure): domanda dalla base 0,02–0,05 $; con ricerca 0,10–0,35 $; da cache 0 $.

## 0c. Fase A — base locale (prima del sopralluogo, con rete; ~10 domande, ~0,50 $)

Impostazione: nessuna. La ricerca parte solo se la base non basta; per tenerla spenta in questa fase si può
impostare `ASK_WEB_ENABLED=0` su Vercel e ripubblicare (poi rimetterla a `1`).

- ☐ Fezzano: «Quando è stata costruita la chiesa di Fezzano?» — deve citare entrambe le date in disaccordo.
- ☐ Fezzano: «Simonetta Vespucci è nata a Fezzano?» — deve presentare le due versioni senza sceglierne una.
- ☐ San Pietro: «Perché la chiesa è costruita sul promontorio?» — cosa dice la base, e lo dichiara «in revisione»?
- ☐ Castello Doria: «Che cos'era il Castello Doria?» — usa le due affermazioni della base?
- ☐ Grotta di Byron: «È vero che Byron nuotò da qui?» — la presenta come tradizione, non come fatto?
- ☐ Una domanda di cui la base non sa nulla (es. «Chi era il vescovo di Portovenere nel 1500?»): deve dirlo.
- ☐ «Come arrivo al Castello Doria?» — solo distanza e direzione in linea d'aria, niente strade né tempi.
- ☐ Per ogni risposta: corretta? abbastanza approfondita? costo in debug? annotare «chiamate 1».

## 0d. Fase B — ricerca web (con rete; ~8 domande, 1,50–3 $)

- ☐ `/api/guide/ask` mostra `"web":{"enabled":true,…,"supported":true}`.
- ☐ «Quali trasformazioni storiche ha subito il Castello Doria?» (scheda del Castello)
- ☐ «Cosa devo osservare nella facciata di San Lorenzo?» (scheda di San Lorenzo)
- ☐ «Cosa racconta la leggenda della Madonna Bianca?» — leggenda distinta dai fatti?
- ☐ «Qual è il rapporto storico fra Portovenere, la Palmaria e il Golfo dei Poeti?»
- ☐ Una risposta della base (fase A) → «🔎 Approfondisci»: in debug deve risultare «chiamate 1».
- ☐ Ripetere una domanda identica sullo stesso luogo: deve risultare «dalla cache» con costo 0.
- ☐ Per ogni risposta: in debug «origine web» e numero di ricerche; aprire «Fonti e approfondimenti»:
  i link si aprono? le pagine dicono davvero ciò che la risposta afferma? fonti istituzionali o deboli?
  numeri segnalati «da verificare»? la risposta è migliore di quella della sola base?
- In alternativa, da un computer con il repository e la chiave (`ANTHROPIC_API_KEY` nell'ambiente, mai nei file),
  dalla cartella `apps/guide`, con `F=../../territories/it.liguria.sp.portovenere/ASK-EVAL.json`:
  - fase A: `npm run ask:eval -- --file $F --no-web --max-usd 0.8 --json a.json --out fase-a.md`
  - fase B, configurazione attuale: `npm run ask:eval -- --file $F --only sp-promontorio,cd-trasformazioni,sl-portale,madonna-bianca,golfo-poeti,byron-nuotata --max-usd 2.6 --json opus.json --out fase-b-opus.md`
  - fase B, Sonnet per la ricerca: stesso comando con `--web-model claude-sonnet-5-5 --max-usd 1.6 --json sonnet.json --out fase-b-sonnet.md`
  - confronto (gratuito): `npm run ask:compare -- opus.json sonnet.json --out confronto.md`, poi compilare
    qualità e affermazioni non supportate leggendo le fonti.
  I tetti coprono tutte le domande con la riserva prudente (0,42 $ con Opus, 0,26 $ con Sonnet, 0,07 $ senza
  ricerca): si ferma prima di superarli, salvo turni ripresi dal server più lunghi della riserva.

## 1. GPS e stato del segnale

- ☐ «Inizia a esplorare» chiede il permesso di posizione; dopo averlo concesso la riga in alto
  passa da «Cerco la posizione…» a «GPS attivo · ±N m».
- ☐ All'aperto (Piazza Bastreri, Palazzata): annotare la precisione tipica (±m).
- ☐ Nei carrugi stretti: la precisione peggiora? Compare «GPS impreciso» oltre ±35 m?
- ☐ Fermi per 2 minuti: compare per errore «Posizione non aggiornata»? (soglia 45 s; su iOS da
  fermi gli aggiornamenti possono diradarsi — annotare se succede).
- ☐ Bloccare il telefono 1 minuto e riaprire: deve comparire l'avviso «la guida era in pausa».
  (Atteso: a schermo spento la posizione **non** si aggiorna.)
- ☐ Debug: la posizione è etichettata «GPS REALE» (mai «SIMULATA»).

## 2. Coordinate dei luoghi (verificate su mappa, **non** sul campo)

Per ogni luogo: stare nel punto che un visitatore riconoscerebbe come «il luogo» (ingresso,
facciata, centro della piazza), aspettare precisione ≤ 10–15 m, poi nel debug
«Registra un rilievo» → *Posizione del luogo*. Annotare la distanza dal punto del pack mostrata nel rilievo.

| Luogo | Stato attuale | Raggio | Rilievo | Distanza dal pack | Note |
|---|---|---|---|---|---|
| Porta del Borgo | su mappa (C) | 50 m | ☐ | | |
| Torre Capitolare | su mappa (C) | 40 m | ☐ | | |
| Piazza Bastreri | su mappa (C) | 40 m | ☐ | | |
| Chiesa di San Lorenzo | su mappa (C, una sola fonte) | 50 m | ☐ | | |
| Palazzata a mare | su mappa (C, elemento esteso) | 60 m | ☐ | | |
| Castello Doria | su mappa (C, elemento esteso) | 60 m | ☐ | | |
| Chiesa di San Pietro | su mappa (C) | 50 m | ☐ | | |
| Grotta di Byron / Cala dell'Arpaia | su mappa (C) | 30 m | ☐ | | il catasto grotte indica l'ingresso ~105 m più in là: quale punto è giusto? |
| Isola Palmaria | su mappa (C, centro isola) | 200 m | ☐ | | serve il punto di approdo? |
| Grotta Azzurra | su mappa (B, catasto) | 30 m | ☐ | | raggiungibile solo dal mare |
| Isola del Tino / Tinetto | su mappa (C, centro isola) | 150 / 100 m | ☐ | | solo dal mare |
| Le Grazie / Santuario | su mappa (C) | 80 / 30 m | ☐ | | |
| Fezzano | su mappa (C) | 80 m | ☐ | | |

**Luoghi con coordinate sicuramente sbagliate (preliminari, ~1 km a sud della Palmaria, in mare):**

- ☐ Forte / sistema fortificato di San Pietro — quale struttura indica il luogo?
- ☐ Scalinata / salita verso San Pietro — quale scalinata?
- ☐ Muzzerone / palestra di roccia — quale punto (parcheggio, attacco delle vie, belvedere)?

Per questi tre: rilevare il punto giusto e scrivere nella nota del rilievo cosa si è scelto e
perché. Sulla mappa dell'app appaiono nel posto sbagliato: è atteso, non è un errore dell'app.

## 3. Geofence (dove inizia il racconto)

Per ogni luogo del borgo: avvicinarsi camminando da direzioni diverse e registrare
*Bordo del geofence* nel punto in cui il racconto **dovrebbe** iniziare, con «Raggio suggerito».

- ☐ Sovrapposizioni note (raggi non ridotti, da valutare sul posto):
  Porta–Torre (23 m tra i centri), Porta–Bastreri (67), Porta–Palazzata (89), Torre–Bastreri (65),
  Torre–Palazzata (69), San Lorenzo–Castello (80), San Lorenzo–Palazzata (79).
- ☐ Nelle sovrapposizioni: viene proposto il luogo più vicino a dove si è davvero?
- ☐ Il debug (mappa con cerchi dei geofence) mostra «dentro» quando si è effettivamente nel luogo?
- ☐ Si entra in un geofence senza volerlo passando per strada (falsi arrivi)? Dove?

## 4. Proposte audio (esplorazione libera)

Modalità «Mi chiede prima».

- ☐ Arrivando in un luogo con racconto compare «Sei arrivato a … Vuoi che ti racconti?» entro ~10 s.
- ☐ «Sì, raccontami»: la voce parte, il testo è leggibile anche senza audio.
- ☐ Mentre la guida parla, entrare in un altro luogo: **non** deve interrompere; la proposta
  arriva a racconto finito (se si è ancora lì).
- ☐ «No, grazie», uscire e rientrare entro 15 minuti: **nessuna** nuova proposta.
- ☐ Un luogo già raccontato non riparte rientrando.
- ☐ «Sono qui» su un luogo non riconosciuto: racconta subito.
- ☐ Provare anche «Racconta da sola» per un tratto: parte senza chiedere?
- ☐ Luoghi senza racconto (Porta del Borgo, Torre Capitolare, Piazza Bastreri) non devono proporre nulla.

## 5. Luoghi vicini e mappa

- ☐ Il punto blu «Tu» segue i movimenti; gli spilli sono nei punti giusti (vedi sezione 2).
- ☐ Spostare la mappa col dito → compare «Centra su di me» (in alto a sinistra); toccarlo riaggancia.
- ☐ «Vicino a te»: ordine e distanze plausibili? Le direzioni (N, NE, …) corrispondono?
- ☐ Toccare uno spillo lontano → scheda → «Ascolta la storia» funziona anche lontano dal luogo.
- ☐ Sfondo OpenStreetMap visibile con rete; senza rete resta la mappa schematica.
- ☐ Leggibilità al sole; si usa con una mano camminando?

## 6. Domande all'AI (servono rete e chiave configurata)

- ☐ Dalla scheda di un luogo, «Fai una domanda» → «Perché è stata costruita proprio qui?»
- ☐ «C'è una leggenda legata a questo luogo?» — la risposta distingue leggenda da fatto storico?
- ☐ «Come raggiungo il Castello Doria?» — deve dare solo distanza e direzione in linea d'aria e
  rimandare alla mappa; **non** deve inventare strade, scale o tempi di cammino.
- ☐ «Cosa posso visitare qui vicino?» — propone luoghi effettivamente vicini?
- ☐ Le risposte su contenuti in revisione riportano «⚠ Risposta basata su contenuti in revisione».
- ☐ Domanda storica non coperta dalla guida (es. «Quali trasformazioni ha subito il Castello Doria?»): la risposta
  arriva entro un minuto, riporta «🌐 Include informazioni trovate online…» e «Fonti e approfondimenti» si apre
  con link funzionanti. Annotare se le fonti sono pertinenti.
- ☐ «🔎 Approfondisci» sotto una risposta della guida: risposta più ricca, con fonti.
- ☐ La lettura ad alta voce di una risposta lunga resta ascoltabile camminando? (annotare la durata)
- ☐ Senza rete: messaggio chiaro, il racconto dei luoghi continua.

## 7. Percorsi guidati e passaggio tra modalità

- ☐ Pagina iniziale: entrambe le modalità visibili; i percorsi 60 min, 90 min, Periplo Palmaria e
  Test sul campo 1 sono presenti.
- ☐ Avviare «Test sul campo 1» (Porta → San Lorenzo → Palazzata → San Pietro): il GPS parte da solo,
  tappe numerate, «Prossima tappa» corretta.
- ☐ Un luogo fuori percorso (Castello Doria) **non** interrompe il percorso.
- ☐ Arrivare a una tappa fuori ordine: la guida chiede, non salta tappe da sola.
- ☐ «Salta tappa» e «Sono qui» funzionano.
- ☐ A metà percorso «Passa all'esplorazione libera»: GPS, testo e luoghi ascoltati restano;
  compare «La visita continua».
- ☐ Dall'esplorazione «🗺 Percorsi guidati» → scegliere un percorso: un luogo già ascoltato non viene
  ripetuto, ma la tappa avanza.
- ☐ Chiudere e riaprire l'app (o la scheda del browser): «Riprendi» ripristina la visita nella modalità giusta.
- ☐ Annotare i tempi reali di ogni tratto del percorso (i tempi sono «da calibrare»).
- ☐ Periplo Palmaria: oggi ha **una sola tappa** (l'isola); verificare come si comporta e annotare
  quali punti del giro meriterebbero una tappa.

## 7b. Connessione lenta

- ☐ Nei carrugi o in zone con segnale debole: una domanda con ricerca può richiedere fino a un minuto;
  compare «Cerco anche fonti online…»? Il racconto dei luoghi continua nel frattempo?
- ☐ Se la risposta non arriva entro ~65 s: messaggio chiaro, nessun blocco dell'app.

## 8. Offline

- ☐ Modalità aereo dopo aver scaricato: l'app si apre, mappa schematica, racconti funzionanti.
- ☐ Le domande AI dichiarano che serve la rete.

## 9. Alla fine

- ☐ Debug → «Condividi i rilievi» (o «Scarica JSON»): file `guide-field-points/2`.
- ☐ Inviare il file per la revisione: le coordinate passano a `field_verified` solo dopo revisione
  dei rilievi, con fonte «rilievo sul campo», data e autore.
- ☐ Elenco dei problemi riscontrati con luogo, ora e screenshot.
