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

## Coordinate: discrepanze da controllare (non corrette)

Calcolate solo sui dati del file, senza correggerli:

- **Posizioni relative sospette.** Rispetto alla Porta del Borgo, il file mette la Palmaria a 570 m verso
  ovest-nord-ovest, Fezzano a 3 km verso ovest, Le Grazie a 2,6 km verso est-sud-est e il Muzzerone a 790 m verso
  sud. Dalla mia conoscenza generale (approssimativa, da verificare) la Palmaria è a sud del borgo oltre lo
  stretto, Le Grazie e Fezzano sono a nord lungo il golfo e il Muzzerone è a nord del borgo. Se è così, alcune
  coordinate, o forse l'intero gruppo del borgo, sono spostate. Nel test, guarda la distanza mostrata dal debug
  davanti a ogni luogo.
- **Geofence sovrapposti** (il validatore li elenca): Porta/Torre/San Lorenzo; San Pietro con Castello, Grotta di
  Byron, Forte e Scalinata (la Scalinata è a 14 m dal centro di San Pietro); Bastreri/Palazzata;
  Palmaria/Grotta Azzurra; Le Grazie/santuario. Due luoghi possono scattare insieme: va deciso sul posto quale
  raggio e quale punto usare.
- Il geofence della Palmaria (200 m) è centrato a circa 570 m dalla Porta del Borgo: se le coordinate fossero
  giuste, la Palmaria scatterebbe quasi in paese.

## Test sul campo

1. Apri l'app con `?debug=1` in fondo all'indirizzo (resta attivo su quel telefono; `?debug=0` lo spegne).
2. Scegli **Portovenere → Italiano**, poi un percorso o il giro libero. Premi **Scarica per l'uso offline**
   prima di partire.
3. **Inizia il tour → Usa il GPS.** Il pannello Debug mostra posizione e precisione, i luoghi più vicini con
   distanza, stato del geofence (fuori / in ingresso / dentro / in uscita / ignorato per precisione), stato delle
   coordinate e del racconto; tocca un luogo per vedere le note.
4. Davanti a ogni luogo: scegli il luogo nell'elenco, aspetta precisione sotto 10–15 m e premi **Registra qui**.
   Per problemi o osservazioni usa **Solo nota con posizione**.
5. Alla fine **Esporta i rilievi (JSON)** e mandami il file: aggiorno le coordinate (`field_verified`, con data,
   autore e precisione) e i raggi.

### Lista di controllo

- [ ] Punto GPS esatto di ogni luogo (dove deve scattare il racconto, non il centro dell'edificio).
- [ ] Raggio: percorri il bordo del geofence e annota se scatta troppo presto o troppo tardi.
- [ ] Stabilità del GPS nei carruggi e vicino alle scogliere (precisione mostrata dal debug).
- [ ] Riferimento visivo per ogni luogo (es. "davanti al portale").
- [ ] Scale e accessibilità (Scalinata, salita al Castello).
- [ ] Orari e regole di accesso attuali (Castello, chiese, Palmaria, Tino) con la data del controllo.
- [ ] Foto originali, con la localizzazione attiva (danno anche le coordinate: `guide-pack photos`).
- [ ] Audio: pausa, avanti, interruzioni, cuffie, schermo bloccato.
- [ ] Prova "cattiva": entrare e uscire dai geofence, tornare indietro, saltare un luogo, camminare veloce,
      restare fermi, togliere la rete, fare domande fuori tema o su un altro luogo.
- [ ] Tempi reali dei percorsi da 60 e 90 minuti.

## Prima della produzione

Per passare `releaseStage` a `production` il validatore pretende: coordinate `field_verified`, percorsi
`field_calibrated` e affermazioni `verified` (con un verificatore diverso dall'autore) per tutto ciò che le unità
raccontano.
