# Anteprima v2 — integrazione R1 (24 ottobre 2026)

**Stato:** bozze, **nulla inserito** nello Studio né nel database.
**Base:** fotografia del database `it.liguria.sp.portovenere` del 24/10.

## Cosa cambia rispetto alla v1
- **Nessun nodo nuovo.**
  - `bpv-*` (3 affermazioni) → luogo `portovenere`.
  - `po-*` (2) e `atm-*` (2) → luogo `palmaria`.
  - Il file dei nodi v1 è stato rinominato `proposed-nodes.v1-non-piu-usato.yaml`.
- **Nuovo:** `proposed-units.yaml`, 46 racconti (23 in italiano, 23 in inglese) che citano tutte e 32 le affermazioni.

## File
| File | Contenuto |
|---|---|
| `proposed-sources.yaml` | 15 fonti (invariate) |
| `proposed-assertions.yaml` | 32 affermazioni in bozza, soggetti v2 |
| `proposed-units.yaml` | 46 racconti in bozza, con note `# REVISIONE` dove un'affermazione è incerta |

## Verifiche fatte (su una copia, fotografia + anteprima)
- **Validatore:** 0 errori di contenuto. Restano solo i 21 `MEDIA_FILE_MISSING` attesi: i file sono in Storage.
- **Racconto d'apertura di Porto Venere:** sparisce l'avviso `ACCESS_INTRO_NO_OPENING` di `portovenere`. Il nuovo racconto d'apertura (`portovenere-opening-*`) colma il vuoto ed è gratuito.
- **Bundle,** simulato con le 32 affermazioni «in revisione»: **tutte le 32 raggiungono Gaia**.

| Dove arrivano | Affermazioni |
|---|---|
| Pubblico (gratis) | `bpv-sistema-difensivo` |
| Luogo Palmaria (con Tino e Tinetto) | 19 |
| Luogo Le Grazie (con il santuario) | 6 |
| Luogo Porto Venere (con San Pietro e il Castello) | 4 |
| Luogo Fezzano | 2 |
| Esplorazione completa | 31 (tutte le non gratuite) |
| Percorso `palmaria-210` | 12 |
| Percorsi `borgo-60`, `borgo-90`, `prova`, `test-campo-1` | 1–2 ciascuno |

- **Con le affermazioni ancora in bozza** i racconti non si possono creare: errore `UNIT_ASSERTION_NOT_NARRATABLE`, come previsto.

## Ordine nello Studio
1. **Fonti:** inserire le 15 fonti.
2. **Affermazioni:** crearle in bozza con il soggetto v2.
3. **Conferma fonte:** aprire la pagina e premere «Conferma fonte», indicando il punto della pagina.
4. **Revisione:** «Invia in revisione».
5. **Racconti:** crearli solo per le affermazioni ormai «in revisione». Se un'affermazione è stata riscritta o respinta, va riscritto o tolto anche il suo racconto: segui le note `# REVISIONE`.
6. **Verifica a quattro occhi**, poi «Ripubblica».

## Punti da guardare nella revisione dei testi
- `castello-doria-detail-pianta`: «Casa del Capitano» o «del Castellano».
- `palmaria-detail-forti`: Batteria Umberto I, 1889 o 1890.
- `palmaria-detail-grotta-colombi`: Capellini, 1869, ancora senza conferma. Il testo non invita ad andarci.
- `palmaria-context-paesaggio`: i 188 m sono solo nel rapporto del pacchetto.
- `palmaria-curiosity-capre`: non dice se le capre ci sono ancora, e non deve dirlo.
- `santuario-le-grazie-context-opere`: Quattrocento o Trecento.
- `fezzano-curiosity-venere-golfo`: non è chiaro se il Parco lo affermi.
- `portovenere-context-storia`: *Portus Veneris*, datazione discussa.
- **Inglese:** testi tradotti da me, da rileggere.
