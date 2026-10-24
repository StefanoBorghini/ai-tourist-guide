# Gaia — Fotografia del database e confronto (integrazione R1, passo 1)

**Data:** 24 ottobre 2026 · **Stato:** sola lettura, **nessuna modifica eseguita** (database, Studio, repository)
**Fotografia:** `select pack_snapshot('it.liguria.sp.portovenere')`, esportata dal SQL Editor (CSV) e convertita con `guide-pack db-export`.
**Confronto con:** file del repository `ai-tourist-guide`, ramo `commercio` @ `71dd2df`, con `diffPacks` del pacchetto `territory-pack` (elementi abbinati per id).

---

## 1. In breve

1. **Fonti e affermazioni nel database sono identiche ai file**: 19 fonti, 56 affermazioni (51 `in_review`, 5 `draft`), campo per campo. La classificazione del rapporto R1 resta valida. Nessuna delle 15 fonti e delle 32 affermazioni proposte è già stata inserita dallo Studio: nessun id né URL in collisione.
2. **Lo Studio ha creato il luogo `portovenere`**, che ora è il luogo principale del borgo: 11 luoghi sono suoi sottoluoghi. Le 3 affermazioni `bpv-*` vanno su questo luogo, quindi il nodo `borgo-porto-venere` non serve più. Restano da decidere solo i nodi `portoro` e `area-tutela-marina`.
3. **Scoperta importante, che corregge il rapporto R1 (§5.2.7):** con l'esplorazione a pagamento (`config.access.explore: premium`, come oggi nel database) il bundle contiene **solo le affermazioni citate da un racconto** (unità narrativa), sia nella parte pubblica sia in quella a pagamento (`packages/bundle/src/build.ts`, `assertionsOf`). Le 32 affermazioni nuove, anche verificate, **non arriverebbero a Gaia** senza racconti che le citino. Già oggi 8 delle 56 affermazioni non sono citate da nessun racconto, quindi non arrivano: `bs-passaggio`, `fs-strutture`, `fz-chiesa-opere`, `fz-frazione`, `pb-accesso`, `sim-vita`, `ss-salita`, `tc-difesa`.
4. **Validazione:** la fotografia più le anteprime v2 danno 88 affermazioni, 34 fonti e 3 nodi, con 0 errori di contenuto. Gli unici 21 errori sono `MEDIA_FILE_MISSING`, attesi: i file stanno in Storage, non nella fotografia.

---

## 2. Database ↔ file: cosa è diverso

| Elemento | File | Database | Differenza |
|---|---|---|---|
| Fonti | 19 | 19 | identiche |
| Affermazioni | 56 | 56 | identiche |
| Racconti (unità) | 56 | 56 | identici (28 it + 28 en) |
| Nodi | 1 | 1 | `simonetta-cattaneo-vespucci`: descrizione breve cambiata («Nobildonna genovese del Quattrocento…») |
| Luoghi | 18 | 21 | **nuovi:** `portovenere`, `piazza-paolo-centinaro`, `mater-naturae` · **13 sottoluoghi** (`partOf`) · **3 spostati** con coordinate «Google»: `forte-san-pietro`, `muzzerone`, `scalinata-san-pietro` |
| Percorsi | 4 | 5 | nuovo `prova` |
| Media | 5 | 21 | **nessuno in comune**: i 21 caricati dallo Studio non sono nei file, i 5 dei file (compreso il video di copertina `portovenere-canale`) non sono nel database |
| `config.access` | assente | presente | esplorazione `premium`; luoghi introduttivi `fezzano`, `le-grazie`, `portovenere`; percorsi premium `borgo-60`, `borgo-90`, `palmaria-210`, `prova`, `test-campo-1` |
| `manifest.locales` | it, en | en, it | solo l'ordine |

**Conferma della regola «mai importare dai file».** Un'importazione dai file cancellerebbe tre cose:
- i 3 luoghi nuovi;
- le 13 relazioni di sottoluogo;
- i 21 media e la configurazione di vendita.

---

## 3. Conseguenze per l'integrazione

### 3.1 Dove vanno le affermazioni (decisione 4, aggiornata)

| Soggetto proposto | Esiste? | In vendita (oggi) | Proposta v2 |
|---|---|---|---|
| `borgo-porto-venere` (3) | no | — | **sul luogo `portovenere`**: principale e introduttivo |
| `palmaria` (8) | sì | principale a pagamento | invariato |
| `tino` (5), `tinetto` (2) | sì | sottoluoghi di `palmaria` | invariato: si sbloccano con la Palmaria |
| `le-grazie` (3, Varignano) | sì | principale e introduttivo | invariato |
| `santuario-le-grazie` (3) | sì | sottoluogo di `le-grazie` | invariato |
| `san-pietro` (1), `castello-doria` (1) | sì | sottoluoghi di `portovenere` | invariato |
| `fezzano` (1) | sì | principale e introduttivo | invariato |
| `simonetta-cattaneo-vespucci` (1) | sì (nodo) | — | invariato |
| `portoro` (2), `area-tutela-marina` (2) | no | — | nodo nuovo (sviluppo «crea nodo») **oppure** sul luogo `palmaria` |

### 3.2 I racconti servono, non solo le affermazioni
Il percorso dello Studio va completato con un passo:
1. crea l'affermazione in bozza;
2. «Conferma fonte»;
3. revisione;
4. **crea o aggiorna il racconto che la cita** (`studio_create_unit`, che esiste);
5. «Ripubblica».

Il racconto decide anche la parte in vendita: le affermazioni seguono il luogo del racconto che le cita. Per esempio, un racconto sulla Villa del Varignano ancorato a `le-grazie` sta nella parte a pagamento di Le Grazie, a meno che non sia il suo racconto d'apertura.

Un racconto ancorato a un nodo (`portoro`, `area-tutela-marina`) non appartiene a nessun luogo, quindi entra solo nell'esplorazione completa. È un argomento in più per ancorare quei racconti alla `palmaria`.

In alternativa si può cambiare il codice e mandare a Gaia anche le affermazioni senza racconto. È una decisione sulla vendita, perché oggi nessun fatto a pagamento raggiunge l'app per altra via. Non lo propongo senza tua decisione.

### 3.3 Nota sul luogo `portovenere`
È introduttivo ma **non ha un racconto d'apertura**: il validatore lo segnala (`ACCESS_INTRO_NO_OPENING`, in it e in en). Le 3 affermazioni `bpv-*` (nome *Portus Veneris*, Genova dal 1113, sistema difensivo del borgo) sono il materiale naturale per quel racconto, una volta verificate.

---

## 4. Anomalie nel database (trovate, non corrette)

- **`muzzerone` e `forte-san-pietro` a 6 m l'uno dall'altro.** Il Muzzerone è stato spostato con coordinate «Google» quasi sul forte, con raggi di 100 m e 20 m. Probabilmente uno dei due punti è sbagliato. In più `muzzerone` risulta sottoluogo di `le-grazie`.
- **`mater-naturae` e `scalinata-san-pietro` a 1 m**, con geofence sovrapposti.
- **`piazza-paolo-centinaro`:** la posizione precedente è salvata come lat, lon invece di lon, lat (`[44.1179, 9.7574]`), cioè verso La Spezia. Oggi è solo storico, ma va pulito.
- **`mater-naturae`:** manca il nome inglese. La categoria «statua» e quella «luogo» di `portovenere` e `piazza-paolo-centinaro` sono fuori dall'elenco abituale.
- **Percorsi premium «prova» e «test-campo-1».** Sembrano percorsi di test messi in vendita: da confermare o togliere dal catalogo.
- **Media:** `37686-mveqvtry` («archive», autrice Irina Balashova) non ha `originalUrl` né `licenseNote`.
- **Già nei file** (quindi non nuove): 5 bozze, 5 affermazioni senza fonte (`bs-passaggio`, `fs-strutture`, `pb-accesso`, `ss-salita`, `tc-difesa`) e 41 con fonte solo dedotta.

---

## 5. File (scratchpad, fuori dal repository)

- `snap/snapshot.json`: la fotografia in JSON.
- `snap/export/`: la fotografia nel formato del pack (`db-export`).
- `snap/diff.txt`: le differenze campo per campo.
- `anteprima-v2/proposed-sources.yaml`: 15 fonti, invariate.
- `anteprima-v2/proposed-nodes.yaml`: 2 nodi (`portoro`, `area-tutela-marina`).
- `anteprima-v2/proposed-assertions.yaml`: 32 affermazioni; le 3 `bpv-*` ora su `portovenere`.

---

## 6. Decisioni ancora aperte

1. **Fonti:** le leggo io (aprendo i domini nella rete dell'ambiente) oppure la redazione.
2. **Come inserire:** a mano nello Studio, oppure un'importazione «solo aggiunte».
3. **`portoro` e `area-tutela-marina`:** su `palmaria`, oppure sviluppo «crea nodo».
4. **Racconti:** chi li scrive per le affermazioni nuove (proposta: io preparo le bozze, la redazione le rivede); oppure si cambia la regola del bundle (§3.2).
5. **Anomalie del §4:** correzione nello Studio da parte della redazione.

*Nessuna modifica senza la tua autorizzazione.*
