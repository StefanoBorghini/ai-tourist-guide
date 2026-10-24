# Checklist operativa — correzioni dei luoghi di Porto Venere

**Stato al 24/10/2026:** **nessuna correzione è applicata.** Claude le ha solo preparate e provate su una copia della fotografia del database. Nello Studio non c'è ancora niente.

**Regole valide per tutta la checklist:**
- si lavora **solo dalla scheda del luogo nello Studio**;
- niente SQL di modifica;
- niente importazione dal repository.

---

## Fase 0 — Prima di toccare qualcosa
- [ ] Eseguire `fotografia-commerciale.sql` nel SQL Editor ed esportare il risultato come **«prima»**. È una sola SELECT, non modifica niente.
- [ ] Eseguire `select pack_snapshot('it.liguria.sp.portovenere');` ed esportare il risultato come **«prima»**. La fotografia del 24/10 è già in mano a Claude; rifarla serve solo se nel frattempo qualcuno ha lavorato nello Studio.

## Fase 1 — Correzioni certe (approvate)

| ✓ | Luogo | Scheda dello Studio → campo | Da | A |
|---|---|---|---|---|
| [ ] | `forte-san-pietro` | «È un sottoluogo di» | Le Grazie | **Portovenere** |
| [ ] | `mater-naturae` | Nome, inglese | (vuoto) | **Mater Naturae** |
| [ ] | `mater-naturae` | Categorie | `statua` | **`art, landscape`** |
| [ ] | `portovenere` | Categorie | `luogo` | **`village, history, unesco`** |
| [ ] | `piazza-paolo-centinaro` | Categorie | `luogo` | **`urban`** |

**Verifica sulle categorie, chiesta prima di approvare le ultime due righe:**
- **Non esiste un vocabolario chiuso.** Lo schema e lo Studio accettano qualsiasi parola in minuscolo con trattini (`pack-schema.ts`, `studio_update_place`). Anche `statua` e `luogo` erano tecnicamente validi: le sostituzioni servono alla coerenza, non a correggere errori.
- **Sono tutte categorie già in uso** in altri luoghi del territorio:

  | Categoria | Luoghi che la usano |
  |---|---|
  | `village` | 2 (Fezzano e Le Grazie) |
  | `history` | 10 |
  | `unesco` | 3 |
  | `urban` | 4 (tra cui Piazza Bastreri) |
  | `art` | 2 |
  | `landscape` | 7 |

  Nessuna parola nuova.
- **A cosa servono oggi:** solo come «interessi» nel pianificatore dei giri (`context-engine/planner.ts`: bonus ×1,5 se coincidono con gli interessi del visitatore). Nell'app, però, nessuna schermata imposta gli interessi. Quindi **il cambio non ha effetti su ciò che vede il visitatore**: nessun testo, nessun filtro, nessuna icona.
- **Esito:** le due righe ⚠️ si possono approvare.

## Fase 2 — Coordinate, solo dalla mappa dello Studio

Per ogni punto: scegliere il punto sulla mappa e scrivere nel campo **metodo**:

> punto scelto sulla mappa dello Studio il GG/MM, da rilevare sul campo

Lo Studio salva da solo la posizione vecchia e rimette lo stato a «preliminare».

| ✓ | Luogo | Cosa fare | Controllo dopo |
|---|---|---|---|
| [ ] | `forte-san-pietro` | Spostarlo sulle mura del promontorio, tra la scalinata e la chiesa di San Pietro. Oggi sta sul Muzzerone, a circa 1,1 km. | A più di 70 m dal centro di `san-pietro` (raggi 50 + 20 m) |
| [ ] | `mater-naturae` | Controllare sulla mappa che il punto sia sulla statua, sugli scogli sopra la Grotta di Byron. Se è giusto, **non toccarlo**. | — |
| [ ] | `scalinata-san-pietro` | Spostarla all'**inizio effettivo** della salita, verificato sulla cartografia. Oggi sta a 1 m da Mater Naturae. | A più di 60 m da `mater-naturae` (raggi 40 + 20 m) |
| [ ] | `portovenere` | **Prima decidere** dove deve partire il racconto introduttivo gratuito: per esempio l'ingresso al borgo, vicino a Porta del Borgo, oppure dove arrivano bus e traghetti. Solo dopo spostare il punto. Oggi è a circa 1 km a nord del borgo. | Fuori dai 50 m di `porta-del-borgo` |
| [ ] | `muzzerone` | **Nessun intervento.** Le coordinate sono plausibili; il problema era il forte sovrapposto. | — |

**Piazza Paolo Centinaro, posizione storica invertita: non toccare.** La verifica sulle dipendenze ha dato questo esito:
- la `previousLocation` non entra nel bundle (`packages/bundle` non la legge), quindi non arriva all'app né a Gaia;
- è mostrata solo nella scheda dello Studio e passa dalla fotografia e dall'importazione;
- lo Studio non la modifica, la sovrascrive alla prossima modifica delle coordinate. Correggerla richiederebbe SQL a mano: nessun beneficio, qualche rischio.

## Fase 3 — Prima di ripubblicare
- [ ] Eseguire di nuovo `fotografia-commerciale.sql` (**«dopo»**) e confrontarla con «prima». Devono restare identici:
  - `accesso` (luoghi introduttivi, luoghi gratuiti, percorsi a pagamento);
  - `prodotti` (stato, disponibilità, prezzi pubblicati);
  - acquisti e diritti.

  **Unica differenza attesa:** nessuna. Le correzioni toccano solo i luoghi.
- **Nota su `forte-san-pietro`.** Spostarlo sotto Portovenere cambia il luogo con cui si sblocca. Oggi però **non ha racconti**, e la sua unica affermazione, `fs-strutture`, non è citata da nessuno. Quindi chi ha comprato Le Grazie non perde niente. Il controllo va rifatto solo se nel frattempo gli viene aggiunto un racconto.

## Fase 4 — Ripubblicare e verificare
- [ ] «Ripubblica» dallo Studio, **non** un'importazione dal repository.
- [ ] Nuova `pack_snapshot` (**«dopo»**), da mandare a Claude.
- [ ] Claude confronta errori e avvisi con quelli di oggi. Attesi:

  | Avviso | Prima | Dopo |
  |---|---|---|
  | `LABEL_MISSING_LOCALE` (mater-naturae) | 1 | 0 |
  | `GEOFENCE_OVERLAP` forte-san-pietro ↔ muzzerone | 1 | 0 |
  | `GEOFENCE_OVERLAP` mater-naturae ↔ scalinata-san-pietro | 1 | 0 |
  | Errori di contenuto | 0 | 0 |

  Gli altri avvisi restano: le sovrapposizioni nel borgo da calibrare sul campo e le affermazioni con fonte dedotta.

---

## A parte — percorsi «prova» e «test-campo-1»

**Cosa risulta dal codice (verificato):**
- Lo stato del percorso nel database (`routes.status`, bozza o pubblicato) **non viene letto** né dalla fotografia (`pack_snapshot`) né dalla compilazione del bundle. Ogni percorso del territorio finisce nel bundle.
- I due percorsi sono in `config.access.premiumRoutes`. Il bundle li elenca quindi come **percorsi a pagamento bloccati**, con nome e durata. L'app li mostra nella scheda Percorsi e nell'elenco della visita, con il lucchetto (`GuideApp.tsx`), **anche se non esiste un prodotto in vendita**. Senza un prodotto non mostrano il prezzo e non si possono comprare.
- Il percorso «prova» ha come nome inglese **«dsadsad»**.
- Gli stessi percorsi danno accesso a racconti: compaiono nelle parti a pagamento del bundle (`route-prova`, `route-test-campo-1`).

**Quindi:** se l'ultima pubblicazione di Porto Venere è andata a buon fine e la destinazione è pubblicata, **i visitatori li vedono già**, come percorsi bloccati. Se esiste anche un prodotto attivo con un prezzo pubblicato, si possono pure comprare.

**Come verificarlo:** il risultato di `fotografia-commerciale.sql` contiene tutto quello che serve:
- `destinazione.stato`;
- `pubblicazioni_recenti` (con l'esito);
- `percorsi[].prodotti`;
- `prodotti[]` (stato, disponibilità, prezzo, acquisti).

**Se risultano visibili, cosa fare** (ogni passo da autorizzare):
1. **L'amministratore della piattaforma** li toglie dai percorsi a pagamento, nella scheda Vendita. È l'unico che può: lo impone un controllo nel database. Un percorso in `premiumRoutes` non si può né eliminare né rinominare.
2. Se esiste un prodotto, lo ritira dalla vendita (`retired`). Se il prodotto ha già acquisti non si elimina.
3. La redazione elimina i due percorsi nello Studio. In alternativa li tiene, per i test sul campo, senza venderli. Restano però visibili come percorsi gratuiti finché esistono, perché lo stato «bozza» non li nasconde.
4. «Ripubblica».
