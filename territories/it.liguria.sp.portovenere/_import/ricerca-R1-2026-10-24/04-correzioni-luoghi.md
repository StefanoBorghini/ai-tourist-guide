# Correzioni dei luoghi — da fare nello Studio

**Base:** fotografia del database `it.liguria.sp.portovenere`, 24/10/2026.
**Perché nello Studio e non in SQL.** Ogni modifica passa da `studio_update_place` o dalla scheda del luogo. Così:
- i permessi vengono controllati;
- le coordinate vecchie restano salvate in `previousLocation`;
- si deve indicare il metodo usato per le coordinate.

Un `UPDATE` scritto a mano nel SQL Editor salterebbe questi controlli.

Ogni correzione richiede poi «Ripubblica».

Legenda:
- **A** = correzione sicura;
- **B** = serve una scelta della redazione: indico la mia proposta;
- **C** = da non toccare.

---

## A. Correzioni sicure

| # | Luogo | Campo | Oggi | Correzione | Perché |
|---|---|---|---|---|---|
| A1 | `forte-san-pietro` | «È un sottoluogo di» | `le-grazie` | **`portovenere`** | Il luogo e la sua affermazione (`fs-strutture`) riguardano il promontorio di San Pietro, nel borgo di Porto Venere. Oggi si vende insieme a Le Grazie. |
| A2 | `mater-naturae` | Nome (en) | assente | **Mater Naturae** | È il titolo dell'opera, uguale nelle due lingue. Toglie l'avviso `LABEL_MISSING_LOCALE`. |
| A3 | `mater-naturae` | Categorie | `statua` | **`art`, `landscape`** | Allinea il luogo alle categorie usate dagli altri luoghi (`art` è già in uso). La statua di Lello Scorzelli sta sugli scogli sopra la baia di Byron. |
| A4 | `portovenere` | Categorie | `luogo` | **`village`, `history`, `unesco`** | Allinea il luogo al vocabolario usato per `fezzano` e `le-grazie`. |
| A5 | `piazza-paolo-centinaro` | Categorie | `luogo` | **`urban`** | Come `piazza-bastreri`. |

## B. Da decidere: le coordinate

Nessuna di queste coordinate viene da una fonte che ho potuto leggere. Restano tutte `preliminary` finché non vengono rilevate sul posto.

| # | Luogo | Problema | Proposta |
|---|---|---|---|
| B1 | **`forte-san-pietro`** | Le coordinate «Google» (44.05753, 9.82713) stanno **sul Muzzerone, a 6 m dal luogo `muzzerone`** e a circa 1,1 km dal promontorio di San Pietro. Il racconto sulle fortificazioni di San Pietro partirebbe in montagna. | Spostarlo sul promontorio, **dalla mappa dello Studio**, sulle mura tra la scalinata e la chiesa. Metodo: «punto da mappa nello Studio, da rilevare sul campo». Raggio 20 m, senza sovrapporsi a `san-pietro` (50 m). Non ho trovato coordinate pubblicate: la ricerca v1 lo dava già come «non identificabile come punto unico». |
| B2 | `muzzerone` | Le coordinate (44.05759, 9.82712) sono plausibili: stanno nel gruppo delle falesie (falesia.it 44.0589, 9.8255; TheCrag 44.0562, 9.8240). Il problema era solo il forte sovrapposto. | **Lasciarle**, e correggere B1. Da valutare: oggi `muzzerone` è sottoluogo di `le-grazie`, quindi si vende con Le Grazie. È una scelta commerciale, non un errore. |
| B3 | `mater-naturae` ↔ `scalinata-san-pietro` | Sono a 1 m l'uno dall'altro: uno dei due è stato messo sul punto dell'altro. La statua è un punto riconoscibile, sopra la Grotta di Byron (Atlas Obscura, Travel365). La «scalinata» non è identificata nemmeno dalla ricerca v1. | **Tenere `mater-naturae`** dov'è e spostare `scalinata-san-pietro` all'inizio della salita, dalla mappa dello Studio, a una distanza di almeno 40 m. In alternativa, se la redazione intende la stessa salita, togliere la scalinata dal percorso `prova` e unirla a `mater-naturae`. |
| B4 | **`portovenere`** | Le coordinate (44.05965, 9.83558) stanno circa 1 km **a nord del borgo**, sulla strada per Le Grazie. Wikipedia dà il paese a circa 44.05, 9.83. È il luogo introduttivo: il suo racconto d'apertura, gratuito, partirebbe fuori dal paese. | Due possibilità: un punto d'ingresso al borgo, per esempio vicino a `porta-del-borgo` ma senza sovrapporsi ai suoi 50 m; oppure lasciarlo come luogo «contenitore» non raggiungibile a piedi. Da decidere prima di creare il racconto `portovenere-opening`. |

## C. Da non toccare

| Luogo | Cosa | Perché |
|---|---|---|
| `piazza-paolo-centinaro` | La posizione precedente è salvata in ordine lat, lon (`[44.1179, 9.7574]`). | È solo storico: l'app non la usa e lo Studio non la modifica. Correggerla richiede SQL a mano, e non vale il rischio. |
| Gli altri 11 luoghi con avvisi `GEOFENCE_OVERLAP` | Centri a 23–89 m nel borgo. | Il borgo è fitto: sono sovrapposizioni attese, da calibrare sul campo (`FIELD-TEST-CHECKLIST.md`). |

## Non sono luoghi, ma li ho trovati nella stessa verifica

- **Percorsi «prova» e «test-campo-1» in vendita** (`config.access.premiumRoutes`). Solo l'amministratore della piattaforma può toglierli, dalla scheda Vendita.
- **`37686-mveqvtry`:** media senza `originalUrl` né `licenseNote`.

---

**Dopo le correzioni:**
1. «Ripubblica».
2. Nuova fotografia con `pack_snapshot`: verifico io che il validatore non mostri più questi avvisi e che non ci siano effetti sulle parti in vendita.
