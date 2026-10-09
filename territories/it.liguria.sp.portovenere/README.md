# Portovenere — Territory Pack (stadio: ricerca)

Stato dichiarato: **RESEARCH_READY_NOT_PRODUCTION_VERIFIED**. Nessun contenuto di questo pack è verificato
per la produzione. L'app lo usa solo come **anteprima per il test sul campo**, con un avviso visibile.

Origine: materiale di ricerca "Portovenere Territory Pack v1" (copia integrale in `_import/`).
Dipende da `it.liguria` (sito UNESCO e fonti UNESCO, condivisi con i futuri territori delle Cinque Terre).

## Come è stato importato

| Materiale di ricerca | Nel pack |
|---|---|
| 18 POI, `lat`/`lon`, `geofence_radius_m` | `geography/places.yaml`: valori copiati senza correzioni all'importazione (`preliminary`), poi corretti con la verifica cartografica descritta sotto (`map_verified`), un geofence di arrivo col raggio indicato |
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

## Coordinate

### Verifica cartografica (9 ottobre 2026)

Il primo uso sul telefono ha confermato l'anomalia segnalata: i pin del borgo cadevano sulla Palmaria. Le coordinate
sono state **verificate su mappa** con le fonti indicate e corrette; **nessuna è verificata sul campo**. Stato nel pack:
`coordinates.status: map_verified` (etichetta redazionale **MAP_VERIFIED_FIELD_PENDING**), con `mapSources` (la prima
è la fonte adottata, le altre sono conferme), `mapVerifiedAt` e `previousLocation` (coordinate di ricerca originali).

Limiti della verifica: OpenStreetMap (Nominatim/Overpass), Wikidata, Wikipedia e il sito del Parco non erano
raggiungibili direttamente dall'ambiente di lavoro; le fonti sono state consultate **tramite motore di ricerca**,
accettando solo coordinate riportate esplicitamente da una fonte identificabile e, dove possibile, confermate da
altre fonti. Affidabilità: B = catasto istituzionale, C = Wikipedia/Wikidata/guide e mappe commerciali.

| Luogo | Coordinate precedenti | Coordinate nuove | Fonte adottata | Affid. | Scostamento | Stato |
|---|---|---|---|---|---|---|
| Porta del Borgo | 44.0410, 9.8485 | 44.051700, 9.834500 | [Nomads Travel Guide (punto Google Maps)](https://www.nomads-travel-guide.com/places/porta-del-borgo-porto-venere/) | C | 1633 m | MAP_VERIFIED_FIELD_PENDING |
| Torre Capitolare | 44.0412, 9.8483 | 44.051522, 9.834653 | [Wikidata Q91088598](https://www.wikidata.org/wiki/Q91088598) | C | 1583 m | MAP_VERIFIED_FIELD_PENDING |
| Chiesa di San Lorenzo | 44.0418, 9.8488 | 44.050750, 9.833639 | [Wikidata Q3949671](https://www.wikidata.org/wiki/Q3949671) | C | 1568 m | MAP_VERIFIED_FIELD_PENDING |
| Chiesa di San Pietro | 44.0359, 9.8527 | 44.048344, 9.832381 | [Wikipedia it, Chiesa di San Pietro (Porto Venere)](https://it.wikipedia.org/wiki/Chiesa_di_San_Pietro_(Porto_Venere)) | C | 2134 m | MAP_VERIFIED_FIELD_PENDING |
| Castello Doria | 44.0365, 9.8535 | 44.051097, 9.832764 | [Wikimedia Commons, Category:Castello Doria (Porto Venere)](https://commons.wikimedia.org/wiki/Category:Castello_Doria_(Porto_Venere)) | C | 2320 m | MAP_VERIFIED_FIELD_PENDING |
| Grotta di Byron / Cala dell'Arpaia | 44.0358, 9.8522 | 44.049100, 9.833100 | [Apple Maps (Grotta di Byron)](https://maps.apple.com/place?place-id=I40587B1B06DA6DF1) | C | 2126 m | MAP_VERIFIED_FIELD_PENDING |
| Forte / sistema fortificato di San Pietro | 44.0365, 9.8529 | invariate | — | — | — | preliminare: da identificare |
| Piazza Bastreri | 44.0402, 9.8479 | 44.051890, 9.835290 | [Tuttocittà, Piazza Giacomo Bastreri](https://www.tuttocitta.it/mappa/portovenere/piazza-giacomo-bastreri) | C | 1645 m | MAP_VERIFIED_FIELD_PENDING |
| Palazzata a mare | 44.0396, 9.8475 | 44.050900, 9.834600 | [Nomads Travel Guide (Palazzata a Mare)](https://www.nomads-travel-guide.com/places/palazzata-a-mare-portovenere/) | C | 1625 m | MAP_VERIFIED_FIELD_PENDING |
| Scalinata / salita verso San Pietro | 44.0360, 9.8528 | invariate | — | — | — | preliminare: da identificare |
| Isola Palmaria | 44.0431, 9.8420 | 44.042836, 9.843867 | [Wikidata Q757114 (Palmaria)](https://www.wikidata.org/wiki/Q757114) | C | 152 m | MAP_VERIFIED_FIELD_PENDING |
| Grotta Azzurra | 44.0425, 9.8420 | 44.044007, 9.835808 | [Catasto speleologico ligure LI84 (Gauss-Boaga fuso Ovest E 1566989, N 4877117, convertito in WGS84)](https://www.catastogrotte.net/liguria/it/caves/view/86/) | B | 523 m | MAP_VERIFIED_FIELD_PENDING |
| Isola del Tino | 44.0277, 9.8517 | 44.027222, 9.850556 | [Wikipedia it/en, Isola del Tino](https://it.wikipedia.org/wiki/Isola_del_Tino) | C | 106 m | MAP_VERIFIED_FIELD_PENDING |
| Isola del Tinetto | 44.0236, 9.8500 | 44.023722, 9.851083 | [Wikipedia it, Isola del Tinetto](https://it.wikipedia.org/wiki/Isola_del_Tinetto) | C | 88 m | MAP_VERIFIED_FIELD_PENDING |
| Le Grazie | 44.0298, 9.8772 | 44.064083, 9.837956 | [Wikipedia it, Le Grazie (Porto Venere)](https://it.wikipedia.org/wiki/Le_Grazie_(Porto_Venere)) | C | 4937 m | MAP_VERIFIED_FIELD_PENDING |
| Santuario di Nostra Signora delle Grazie | 44.0299, 9.8765 | 44.065822, 9.840017 | [Wikipedia it, Santuario della Madonna delle Grazie (Portovenere)](https://it.wikipedia.org/wiki/Santuario_della_Madonna_delle_Grazie_(Portovenere)) | C | 4945 m | MAP_VERIFIED_FIELD_PENDING |
| Fezzano | 44.0490, 9.8120 | 44.080022, 9.826514 | [Wikipedia it, Fezzano](https://it.wikipedia.org/wiki/Fezzano) | C | 3639 m | MAP_VERIFIED_FIELD_PENDING |
| Muzzerone / palestra di roccia | 44.0340, 9.8500 | invariate | — | — | — | preliminare: da identificare |

Conferme e note per ogni luogo sono in `geography/places.yaml` (`coordinates.mapSources`, `curation.notes`) e nel debug.

**Non identificati con sufficiente certezza (invariati, preliminari):**

- **Forte / sistema fortificato di San Pietro**: Non identificabile come punto unico: il pack descrive le strutture militari del promontorio di San Pietro, non un edificio; nessuna fonte con coordinate proprie.
- **Scalinata / salita verso San Pietro**: Non identificabile con certezza: non è chiaro quale scalinata o salita si intenda; nessuna fonte con coordinate.
- **Muzzerone**: Area estesa (falesia e sentieri), non un punto: le fonti danno punti distanti fino a ~700 m tra loro (falesia.it 44.0589, 9.8255 e 44.0599, 9.8288; TheCrag 44.056156, 9.824003; Rifugio Muzzerone 44.055016, 9.830210; presso il Forte del Muzzerone ~44.0532, 9.8284 da Gulliver). Serve scegliere quale punto deve far partire il racconto.

Restano nella posizione di ricerca (circa 1 km a sud della Palmaria, quindi sicuramente sbagliata): vanno identificati
e rilevati sul campo, oppure va indicato quale punto usare.

**Da chiarire sul campo:** Grotta di Byron (punto delle mappe 44.0491, 9.8331 contro ingresso del catasto speleologico
LI2083 44.0500, 9.8326, ~105 m più a nord); Castello Doria e Palazzata a mare sono estesi (punto indicativo);
San Lorenzo ha una sola fonte con coordinate proprie; Palmaria, Tino e Tinetto sono punti centrali delle isole, non
approdi.

### Geofence sovrapposti (raggi invariati)

Ricalcolate le distanze con le nuove coordinate. I raggi **non sono stati cambiati**: vanno calibrati sul campo.

| Coppia | Distanza tra i centri | Somma dei raggi |
|---|---|---|
| Porta del Borgo ↔ Torre Capitolare | 23 m | 90 m |
| Porta del Borgo ↔ Piazza Bastreri | 67 m | 90 m |
| Porta del Borgo ↔ Palazzata a mare | 89 m | 110 m |
| Torre Capitolare ↔ Piazza Bastreri | 65 m | 80 m |
| Torre Capitolare ↔ Palazzata a mare | 69 m | 100 m |
| San Lorenzo ↔ Castello Doria | 80 m | 110 m |
| San Lorenzo ↔ Palazzata a mare | 79 m | 110 m |

Nel percorso «Test sul campo 1» i luoghi fuori percorso non interrompono e parte da sola solo la tappa attesa, ma
Palazzata a mare (tappa 3) si sovrappone a Porta del Borgo (tappa 1) e San Lorenzo (tappa 2): da osservare sul campo.
Distanze in linea d'aria del percorso: Porta del Borgo → San Lorenzo 126 m, → Palazzata a mare 79 m, → San Pietro
335 m (totale 540 m).

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
