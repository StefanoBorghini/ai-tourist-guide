# Portovenere — Territory Pack (stadio: ricerca)

Stato dichiarato: **RESEARCH_READY_NOT_PRODUCTION_VERIFIED**. Nessun contenuto di questo pack è verificato
per la produzione. L'app lo usa solo come **anteprima per il test sul campo**, con un avviso visibile.

Origine: materiale di ricerca "Portovenere Territory Pack v1" (copia integrale in `_import/`).
Dipende da `it.liguria` (sito UNESCO e fonti UNESCO, condivisi con i futuri territori delle Cinque Terre).

## Come è stato importato

| Materiale di ricerca | Nel pack |
|---|---|
| 18 POI, `lat`/`lon`, `geofence_radius_m` | `geography/places.yaml`: valori copiati **senza correzioni**, `coordinates.status: preliminary`, un geofence di arrivo col raggio indicato |
| `story_status` | `curation.storyStatus` del luogo |
| `coordinate_status: PRELIMINARY_FIELD_VERIFICATION_REQUIRED` | `coordinates.status: preliminary` (in produzione serve `field_verified`, il validatore lo impone) |
| claim fattuali | `knowledge/assertions.yaml`, stato `in_review`, testo originale in `originalClaim` |
| claim che sono istruzioni redazionali ("verificare…", "le fasi costruttive vanno prese da…") | note di curatela del luogo, non affermazioni |
| FACT / TRADITION / LEGEND / HYPOTHESIS | `type`: `fact` / `tradition` / `legend` / `hypothesis` (nuovo tipo, distinto da `interpretation`) |
| UNVERIFIED | non è un tipo ma uno stato: `draft` (mai raccontato) o `in_review` (solo in anteprima) |
| fonti (`priority` PRIMARY / SECONDARY_LOCAL) | `knowledge/sources.yaml`, id e `priority` conservati; affidabilità B (istituzionale) / C (divulgativa locale) |
| percorsi | `narrative/routes.yaml`, `calibration: draft`; il periplo della Palmaria con difficoltà, dislivello e fonte |

### Scelte da confermare

- **Fonti dei claim.** Il materiale di ricerca elenca le fonti, ma non dice quale fonte sostiene quale claim.
  Dove il claim la nomina ("local tourism source", "UNESCO describes", "Official Parco route") il collegamento è
  diretto; negli altri casi l'ho dedotto dall'argomento ed è marcato nell'evidenza con
  *"attribuzione della fonte dedotta in importazione: da confermare"*.
- **Cinque claim senza alcuna fonte** (Porta del Borgo, Torre Capitolare, Forte di San Pietro, Piazza Bastreri,
  Scalinata) restano in **bozza**: questi luoghi oggi sono "muti". Serve una fonte per ciascuno.
- **Tradizione del tronco di cedro (San Lorenzo):** la ricerca la cita ma non ne riporta il contenuto; non è
  raccontata finché non arriva il testo con la sua fonte.
- **Importanza, tempi di sosta e "raggiungibile a piedi"** non sono nel materiale di ricerca: valori provvisori
  miei, da calibrare. Isole, Grotta Azzurra, Le Grazie, santuario e Fezzano sono marcati non raggiungibili a piedi
  dal borgo: non vengono proposti nel giro libero, ma si riconoscono se ci si arriva.
- I nomi inglesi dei luoghi sono traduzioni mie dei nomi italiani.
- La versione `0.1.0-research` è diventata `0.1.0` + `releaseStage: research` (il formato vuole semver puro).

## Coordinate: anomalie (nessuna corretta)

Tutte le coordinate restano **preliminari** e invariate. Riferimenti consultati (solo per segnalare, non per
correggere; accesso diretto a OpenStreetMap e ai siti istituzionali non disponibile dall'ambiente di lavoro):

| Riferimento | Coordinate | Fonte | Affidabilità |
|---|---|---|---|
| Comune di Porto Venere | 44.050, 9.833 | Wikipedia (voce "Porto Venere") | C |
| Porto di Portovenere | 44.0536, 9.83811 | portale nautico (marinelink / nauticalflock) | C |

**Anomalia principale.** Tutti i 10 luoghi del borgo distano **1,5–2,3 km** da entrambi i riferimenti, mentre il
borgo è lungo poche centinaia di metri: le coordinate del borgo sono probabilmente spostate in blocco. Sul posto
i geofence potrebbero non scattare mai: per questo l'app ha «Sono qui» e il rilievo delle posizioni.

| Luogo | Coordinate (lat, lon) | Problema | Come verificarlo |
|---|---|---|---|
| Porta del Borgo | 44.0410, 9.8485 | 1593 m dal riferimento del comune; geofence sovrapposto a Torre (27 m) e San Lorenzo (92 m) | rilievo «Posizione del luogo» davanti alla porta; controllare la distanza mostrata dal debug |
| Torre Capitolare | 44.0412, 9.8483 | 1566 m; a 27 m dalla Porta | rilievo davanti alla torre |
| Chiesa di San Lorenzo | 44.0418, 9.8488 | 1558 m; sovrapposta a Porta e Torre | rilievo davanti alla facciata |
| Chiesa di San Pietro | 44.0359, 9.8527 | 2222 m; sovrapposta a Castello, Grotta di Byron, Forte, Scalinata (a 14 m) | rilievo sul sagrato; raggio suggerito |
| Castello Doria | 44.0365, 9.8535 | 2222 m; sovrapposto a San Pietro, Forte, Scalinata | rilievo all'ingresso |
| Grotta di Byron / Cala dell'Arpaia | 44.0358, 9.8522 | 2202 m; a 41 m da San Pietro | rilievo dal punto panoramico sulla cala |
| Forte di San Pietro | 44.0365, 9.8529 | 2187 m; raggio 20 m dentro i geofence di Castello e San Pietro | rilievo e nota sul punto di riconoscimento |
| Piazza Bastreri | 44.0402, 9.8479 | 1614 m; sovrapposta alla Palazzata | rilievo al centro della piazza |
| Palazzata a mare | 44.0396, 9.8475 | 1637 m; sovrapposta a Bastreri | rilievo sul lungomare, raggio suggerito |
| Scalinata verso San Pietro | 44.0360, 9.8528 | 2220 m; a 14 m dal centro di San Pietro | rilievo all'inizio della salita |
| Isola Palmaria | 44.0431, 9.8420 | nel pack a ovest-nord-ovest della Porta; da conoscenza generale (non verificata) è a sud, oltre lo stretto; geofence 200 m | rilievo dal battello o sull'isola |
| Grotta Azzurra | 44.0425, 9.8420 | segue la Palmaria (67 m dal suo centro) | solo dal mare |
| Isola del Tino | 44.0277, 9.8517 | dipende dallo stesso riferimento sospetto | dal battello |
| Isola del Tinetto | 44.0236, 9.8500 | come il Tino | dal battello |
| Le Grazie | 44.0298, 9.8772 | nel pack a est-sud-est del borgo; da conoscenza generale è a nord, lungo il golfo | rilievo in paese |
| Santuario delle Grazie | 44.0299, 9.8765 | segue Le Grazie | rilievo all'ingresso |
| Fezzano | 44.0490, 9.8120 | nel pack a ovest del borgo; da conoscenza generale è a nord, lungo il golfo | rilievo in paese |
| Muzzerone | 44.0340, 9.8500 | nel pack a sud del borgo; da conoscenza generale è a nord-ovest | rilievo all'accesso della falesia |

Le stesse note sono nella curatela di ogni luogo (`geography/places.yaml`) e si vedono nel debug toccando il luogo.

## Fonti delle affermazioni (audit)

- 33 affermazioni raccontate (in revisione), 5 bozze senza fonte (mai raccontate).
- **11** hanno un collegamento **esplicito** alla fonte (il claim la nomina); **22** hanno un collegamento
  **dedotto** in importazione (`attribution: inferred`): l'app e l'AI le trattano come "fonte da confermare" e il
  validatore impedisce di verificarle finché il collegamento non è controllato sulla fonte.
- Tipi: 30 fatti, 2 tradizioni (Grotta di Byron, «Città dei palombari»), 1 ipotesi (origini di San Pietro).
  La tradizione del tronco di cedro di San Lorenzo non è raccontata (manca il contenuto con la sua fonte).

## Test sul campo

Percorso consigliato: **«Test sul campo 1: Porta del Borgo → San Pietro»** (Porta del Borgo → San Lorenzo →
Palazzata a mare → San Pietro). Ordine fisso; nessuna tappa viene saltata da sola; i luoghi fuori percorso non
interrompono; la tappa successiva si racconta da sola solo in modalità "Racconta da sola", le altre chiedono.
Durata (45 min) e soste sono provvisorie: il percorso resta `calibration: draft`.

Prima di partire (con rete):

1. Apri l'app con `?debug=1` (resta attivo su quel telefono; `?debug=0` lo spegne).
2. Portovenere → Italiano → «Test sul campo 1» → **Scarica per l'uso offline** (deve comparire «Disponibile offline»).

Sul posto:

3. **Inizia il tour → Usa il GPS** e consenti la posizione. Lo schermo resta acceso finché il GPS è attivo.
4. Il pannello Debug mostra: posizione **GPS REALE** o **SIMULATA**, precisione, luoghi vicini con distanza, stato
   del geofence (fuori / in ingresso / dentro / in uscita / ignorato per precisione), luogo attivo (anche
   "confermato a mano"), prossima tappa, coordinate preliminari o verificate, stato delle informazioni,
   sovrapposizioni, rete e cache offline. Tocca un luogo per i dettagli.
5. Se la guida non riconosce un luogo (probabile, vedi sopra): **«Sono qui: …»** racconta la tappa; **«Salta
   tappa»** passa alla successiva.
6. Davanti a ogni luogo: tipo **Posizione del luogo**, scegli il luogo, aspetta precisione sotto 10–15 m,
   **Registra qui** (nota e raggio suggerito facoltativi). Dove dovrebbe iniziare il racconto: **Bordo del
   geofence**. Problemi o osservazioni: **Nota con posizione**.
7. Se il telefono chiude l'app (es. dopo la fotocamera), riaprila: **«Giro in corso → Riprendi»**. I rilievi
   restano salvati sul telefono.

Alla fine:

8. **Condividi i rilievi** (WhatsApp, e-mail, Drive) o **Scarica JSON**, e mandami il file.
9. Revisione, senza modificare nulla: `npm run field --workspace @guide/territory-pack -- <rilievi.json> --territories territories`
   (posizione mediana, scostamento dal pack, raggio proposto, avvisi su rilievi singoli o imprecisi; i punti
   simulati sono ignorati). Solo dopo la revisione si aggiornano coordinate (`field_verified`, con data, autore,
   metodo) e raggi.

### Lista di controllo

- [ ] Punto GPS esatto di ogni luogo del percorso (dove deve scattare il racconto).
- [ ] Raggio: rilievo «Bordo del geofence» dove il racconto dovrebbe iniziare.
- [ ] Stabilità del GPS nei carruggi e vicino alle scogliere (precisione nel debug).
- [ ] Riferimento visivo per ogni luogo (nella nota).
- [ ] Scale e accessibilità (Scalinata, salita al Castello).
- [ ] Orari e regole di accesso attuali (Castello, chiese, Palmaria, Tino) con la data del controllo.
- [ ] Foto originali con la localizzazione attiva (`guide-pack photos` ne legge le coordinate).
- [ ] Audio: pausa, avanti, interruzioni, cuffie, schermo bloccato.
- [ ] Prova "cattiva": entrare e uscire dai geofence, tornare indietro, saltare un luogo, camminare veloce,
      restare fermi, togliere la rete, fare domande fuori tema o su un altro luogo (se le domande sono attive).
- [ ] Tempi reali del percorso.

## Prima della produzione

Per passare `releaseStage` a `production` il validatore pretende: coordinate `field_verified`, percorsi
`field_calibrated` e affermazioni `verified` (con un verificatore diverso dall'autore) per tutto ciò che le unità
raccontano.
