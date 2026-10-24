# Gaia — Integrazione della ricerca territoriale PV-GAIA-RESEARCH-2026-10-24-R1

**Data:** 24 ottobre 2026 · **Stato:** valutazione e proposta, **nessuna modifica eseguita**
**Materiali esaminati:**
- `Gaia_TerritoryPack_Portovenere_Ricerca_2026-10-24.md`: 15 schede, 8 domande insolite, 3 avvisi operativi;
- `Gaia_TerritoryPack_Portovenere_Ricerca_2026-10-24.json`: 23 fonti, 18 record, 38 affermazioni.

**Confronto con:** il Territory Pack `it.liguria.sp.portovenere` (e `it.liguria`) nei file del repository, ramo `commercio` @ `71dd2df`.

**Vincoli rispettati:**
- repository, database, Studio e produzione non toccati (`git status` pulito);
- nessuna importazione e nessuna pubblicazione;
- nessuna chiamata AI a pagamento.

L'anteprima è in tre file della scratchpad, validati con `guide-pack validate` su una copia dei pack.

---

## 1. In breve

1. **Il materiale è buono e prudente.** Distingue già fatti, ipotesi, tradizioni e dati dinamici, e corregge alcune sovra-affermazioni. È coerente con quanto il pack già sa (Simonetta, Byron, tempio di Venere, periplo): **nessuna contraddizione con affermazioni esistenti**.
2. **Porta 32 affermazioni nuove** su argomenti che oggi Gaia non conosce:
   - Villa romana del Varignano;
   - portoro;
   - fortificazioni della Palmaria;
   - Grotta dei Colombi;
   - Tino e Tinetto in dettaglio, tarantolino;
   - area di tutela marina;
   - capre;
   - carsismo ed etimologia della Palmaria;
   - pianta del Castello;
   - attribuzioni del santuario delle Grazie.

   Porta anche 15 fonti nuove, quasi tutte del Parco (B) e del Ministero della Cultura (B).
3. **Le fonti non sono verificate.** Non ho potuto aprire nessuna delle 23 pagine citate: la rete di questo ambiente blocca tutti i domini interessati (§3). Ho controllato le affermazioni principali **solo in modo indiretto**, con il motore di ricerca. Quindi **tutte le affermazioni nuove sono proposte in bozza** (`draft`, fonte `inferred`). Gaia non le racconta finché una persona non apre la pagina e conferma la fonte nello Studio.
4. **Il controllo indiretto ha trovato 5 punti da chiarire:**
   - Batteria Umberto I: 1889 o 1890;
   - Casa del Capitano o del Castellano;
   - santuario delle Grazie: Quattro o Trecento;
   - Capellini e il 1869: nessuna conferma trovata;
   - capre ancora presenti dopo il 2018.

   Ho trovato anche una discrepanza **già nel pack**: il restauro di San Pietro, 1929–1934 contro 1931–1935.
5. **I dati operativi restano fuori dal Territory Pack**: orari, biglietti, divieti di balneazione, lavori, permessi, aperture del Tino. È la regola del progetto. Oggi Gaia non ha comunque un canale per usarli (§6).
6. **Da dove passare:** il database dello Studio è la fonte reale. L'integrazione va fatta **nello Studio, a mano**, non importando i file: un'importazione cancellerebbe le impostazioni di vendita (vedi l'audit del 24/10). Prima serve la fotografia del database, per escludere i duplicati inseriti dallo Studio.

---

## 2. Lo schema reale del Territory Pack (verificato nel codice)

| Elemento | Dove | Cosa conta per questa integrazione |
|---|---|---|
| Fonti | `knowledge/sources.yaml` → tabella `sources` | `sourceKind`, `reliability` A–D (A primaria/scientifica, B istituzionale, C divulgativa), `url`, `accessedAt`, `originalId` per la tracciabilità |
| Nodi | `knowledge/nodes.yaml` | persone, temi, territori senza coordinate. **Lo Studio non li crea**: niente funzione `studio_create_node` |
| Luoghi | `geography/places.yaml` | coordinate **obbligatorie**, con stato `preliminary` → `map_verified` → `field_verified`. Lo Studio crea luoghi (`createPlace`) |
| Affermazioni | `knowledge/assertions.yaml` → `assertions` + `evidence` | `type`: fact, interpretation, hypothesis, tradition, legend, disputed; `certainty`; `status`: draft, in_review, verified, rejected, deprecated, blocked; `dispute` per le controversie; `originalClaim` |
| Prove | `evidence` | fonte + `attribution`: `explicit` o `inferred`; `locator`; `excerpt` |
| Informazioni pratiche | `places[].practical` | `checkedAt` + `recheckAfterDays`. **Entrano nel bundle ma nessuna parte dell'app le usa**: né Gaia (`lib/ask.ts`) né l'interfaccia |
| Flusso editoriale | Studio | crea in bozza → «Conferma fonte» (`studio_confirm_evidence`) → «Invia in revisione» → verifica a quattro occhi → «Ripubblica» (bundle immutabile con `kbHash`) |
| Cosa racconta Gaia | bundle | `releaseStage: research`: solo `verified` e `in_review` (marcate). **Mai `draft`.** In `production` solo `verified` |

**Limiti dello Studio per questa integrazione:**
- un'affermazione nasce con **una sola fonte**, predicato `described_as`, senza `originalClaim`, `excerpt` né `dispute`;
- **i nodi non si creano**.

Per questo l'anteprima indica anche un soggetto alternativo (§5).

---

## 3. Verifica delle fonti

**Tutte le 23 pagine sono irraggiungibili da questo ambiente.** Il proxy rifiuta la connessione (403) e WebFetch non risolve i domini:
- `www.parconaturaleportovenere.it`
- `whc.unesco.org`
- `cultura.gov.it`
- `villaromanavarignano.cultura.gov.it`
- `www.comune.portovenere.sp.it`
- `serviziweb.comune.portovenere.sp.it`
- `www.ansa.it`
- `www.isprambiente.gov.it`

La rete si cambia dalle impostazioni dell'ambiente (menu dell'ambiente nella barra del titolo → Edit → Network access → Allowed domains), aggiungendo questi domini. In alternativa le pagine le apre la persona che revisiona.

**Controllo indiretto con il motore di ricerca.** Sono sintesi automatiche dei risultati, non letture delle pagine: valgono solo come indizi.

| Affermazione | Esito del controllo indiretto |
|---|---|
| UNESCO dal 1997 | ✅ già nel pack (`it.liguria:unesco-1997`) |
| San Pietro, gotico 1256–1277 | ✅ confermato da FAI, Wikipedia, Museionline. Nota: consacrazione 1198 (Wikipedia), assente dal pack |
| Castello: pianta pentagonale, Sala Ipostila | ✅ confermate da fonti secondarie · ⚠️ «Casa del Castellano» invece di «Casa del Capitano» |
| Varignano: frantoio più antico della Liguria, fine II sec. a.C. / 90–80 a.C. / VI sec. d.C. | ✅ le frasi risultano dal sito del Ministero nei risultati di ricerca |
| 1113, Signori di Vezzano | ✅ fonti secondarie concordi |
| *Portus Veneris* nel II secolo d.C. | ⚠️ attribuito all'Itinerario di Antonino, la cui datazione è discussa: certezza «uncertain» |
| Le Grazie: Fra Paolo da Recco, Andrea de Aste, Nicolò Corso | ✅ guide locali concordi (coro datato 1511) · ⚠️ una guida dà la chiesa al XIV secolo |
| Fezzano, San Giovanni Battista 1740 | ⚠️ già nel pack come **controversia** con il Catalogo MiC («ante 1739»): resta aperta |
| Batteria Umberto I 1887–1889 | ⚠️ altre fonti danno **1887–1890** |
| Forte Cavour: idea del 1808, progetto 1857–1859 | ✅ confermato dalla scheda FAI |
| Tino: festa 13 settembre, zona militare, monastero dell'XI secolo | ✅ concordi |
| Tarantolino *Euleptes europaea* sul Tino | ✅ studio scientifico del 2008 (Oneto, Ottonello, Salvidio): fonte A da aggiungere |
| Portoro estratto in epoca romana | ✅ fonte ISPRA (A) nei risultati · ⚠️ «30 cave nel 1862» non trovato: Capellini 1862 risulta per il nome «Portoro» |
| Grotta dei Colombi: Capellini 1869 | ❓ resti umani e animali paleolitici confermati (italia.it); **Capellini e il 1869 non trovati** |
| Capre 2018 | ✅ Sky TG24 (foto ANSA): 8 capre trasferite il 27/4/2018, stima ENPA di circa 80 · ⚠️ un articolo successivo de La Nazione («troppe capre, cresce il gregge») indica capre ancora presenti dopo il progetto |
| Ordinanza n. 84 del 25/09/2026 (balneazione Le Grazie) | ❓ **non trovata**. Un elenco regionale del 2025 dà «Rotonda della chiesa» balneabile. Non verificabile da qui |
| Via Mortea, leggenda di Martina, sentiero 518C | ❓ non trovato |

**Conclusione:** nessuna citazione del pacchetto è stata trattata come già verificata. Le conferme indirette servono a dare la priorità al lavoro della revisione, non a cambiare lo stato.

---

## 4. Confronto con il pack: classificazione delle 38 affermazioni del JSON, più il rapporto Markdown

**Legenda:**
- **N** = nuova (in anteprima);
- **A** = aggiornamento di un'affermazione esistente;
- **D** = duplicato;
- **E** = esclusa: dato dinamico o operativo;
- **R** = respinta: fonte insufficiente;
- **C** = nota di curatela (regola per la redazione, non un fatto).

| Id pacchetto | Esito | Nel pack / anteprima | Livello epistemico proposto |
|---|---|---|---|
| PV-001-C1 UNESCO 1997 | **D** | `it.liguria:unesco-1997` | documentato |
| PV-001-C2 valore del paesaggio | **D** parziale | `pz-unesco`, `cd-palinsesto`; la frase generale andrebbe nel pack `it.liguria` | documentato |
| PV-001 tutele distinte (MD §2) | **N** | `pa-tutele-distinte` | interpretazione (sintesi della ricerca) |
| PV-002-C1 Portus Veneris | **N** | `bpv-portus-veneris` | da verificare (uncertain) |
| PV-002-C2 1113 e sistema del borgo | **N** | `bpv-genova-1113`, `bpv-sistema-difensivo` | supportato, da verificare |
| PV-002-C3 tempio di Venere | **D** | `sp-origini` (già ipotesi) | ipotesi |
| PV-003-C1 San Pietro | **A** + **N** | aggiungere `parco-chiese` (B) a `sp-fase-gotica` (oggi solo C) e cambiare «Secondo il materiale turistico locale» in «Secondo il Parco»; nuova `sp-due-corpi` | supportato |
| PV-004-C1 pianta del Castello | **N** | `cd-pianta` | supportato; controllare il nome «Capitano / Castellano» |
| PV-004-C2 orari e tariffe | **E** | — | dinamico |
| PV-005-C1 santuario | **N** + **A** | `sg-quattrocento`, `sg-attribuzioni`, `sg-olivetani-privato`; aggiungere `parco-borghi` a `sg-olivetani`; dopo la verifica, ritirare (`deprecated`) la vaga `sg-opere` | supportato; secolo da chiarire |
| PV-006-C1, C2 Varignano | **N** | `vv-complesso`, `vv-cronologia`, `vv-luna` (sul luogo `le-grazie`) | documentato (MiC), da confermare sulla pagina |
| PV-006-C3 orari e biglietti | **E** | — | dinamico |
| PV-007-C1 chiesa di Fezzano 1740 | **A** | aggiungere `parco-borghi` a `fz-chiesa-1740`: la controversia con `fz-chiesa-catalogo` **resta** | controverso |
| PV-007 patrono 24 giugno (MD) | **N** | `fz-patrono` | supportato |
| PV-007-C2 Simonetta modella | **D** | `sim-venere` (già tradizione) | tradizione |
| PV-007-C2 sfondo = Golfo dei Poeti | **N** | `fz-venere-golfo` | ipotesi; non è chiaro se la pagina del Parco lo dica |
| PV-007 Villa Cattaneo (MD) | **A** | aggiungere `parco-borghi` (B) a `fz-villa-cattaneo` (oggi solo fonti C) | supportato, da verificare |
| PV-008-C1 versanti e falesie | **N** | `pa-versanti` (188 m solo nel Markdown) | supportato |
| PV-008-C2 carsismo e cave | **N** + **D** parziale | `pa-carsismo`; le cave di portoro sono già in `pa-contenuti` | supportato |
| PV-008-C3 balma | **N** | `pa-nome-balma` | ipotesi |
| PV-008 superfici (MD) | **C** | non fissare una cifra senza dire quale perimetro | — |
| PV-009-C1 Grotta dei Colombi | **N** | `pa-grotta-colombi` (sul luogo `palmaria`) | da verificare: 1869 non confermato |
| PV-009-C2 accesso su falesia | **C** + **E** | nota di curatela e di sicurezza su `palmaria`: non proporre la visita | — |
| PV-010-C1 portoro | **N** | `po-descrizione`, `po-estrazione` | supportato; il 1862 da verificare |
| PV-010-C2 cava attiva al Muzzerone | **E** | — | dinamico |
| PV-010 «marmo» o calcare (MD) | **C** | il testo di `po-descrizione` dice già «chiamato tradizionalmente marmo» | — |
| PV-011-C1 Batteria Umberto I | **N** | `pa-batteria-umberto` | **da verificare**: 1889 o 1890 |
| PV-011-C2 Forte Cavour | **N** | `pa-forte-cavour` | supportato |
| PV-012-C1 Tino militare, chiesa del 1050 | **N** | `ti-militare`, `ti-chiesa-1050` (arricchiscono `ti-monastero`) | supportato |
| PV-012-C2 fuochi di San Venerio | **N** | `ti-venerio-fuochi` | tradizione |
| PV-012 festa del 13 settembre (MD) | **N** + **E** | `ti-festa-venerio` (solo la data della festa); l'apertura dell'isola è **E** | supportato |
| PV-012-C3 tarantolino | **N** | `ti-tarantolino` | documentato + studio scientifico |
| PV-013-C1 resti del Tinetto | **N** | `tn-eremo` (arricchisce `tn-resti`) | supportato |
| PV-013 VI secolo (MD) | **N** | `tn-vi-secolo` | ipotesi |
| PV-013-C2 accesso | **E** | — | dinamico |
| PV-014-C1 area di tutela marina | **N** | `atm-perimetro`, `atm-fondali` | supportato |
| PV-014-C2 autorizzazioni, Secca di Dante | **E** + **C** | nota di sicurezza (`config.safetyNotes`); i regolamenti restano fuori | dinamico |
| PV-015-C1 numeri dei sentieri | **E** (rinviata) | vanno nei percorsi (`narrative/routes.yaml`), da calibrare sul campo, non come affermazioni | dinamico |
| PV-015-C2 periplo | **D** | `pa-periplo` (stessa fonte, stessi dati) | supportato |
| PV-015-C3 Via Mortea, leggenda di Martina | **R** | il pacchetto la marca «documented_official» ma è una leggenda **senza il testo**: come per il tronco di cedro, non si racconta finché non c'è il testo con la fonte | — |
| PV-Q-001 capre | **N** | `pa-capre-2018` | progetto documentato; **presenza attuale non risolta** |
| Grotta Azzurra, perché è azzurra (MD §4) | **R** | nessuna fonte con indirizzo nel pacchetto | — |
| Byron a nuoto (MD §4) | **D** | `gb-byron` (già tradizione) | tradizione |
| PV-OPS-001 ordinanza di balneazione | **E** | fuori dal pack; ordinanza non trovata | dinamico, urgente |
| PV-OPS-002 lavori in Via Cavour | **E** | fuori dal pack | dinamico |
| «Errore *Tarentola mauritanica*» (MD §7) | — | **non presente** nel repository: niente da correggere | — |

**Totali dell'anteprima:**
- 32 affermazioni nuove, tutte `draft`:
  - 27 fatti, di cui 2 con certezza «uncertain»;
  - 3 ipotesi;
  - 1 interpretazione;
  - 1 tradizione;
- 15 fonti nuove;
- 3 nodi nuovi;
- 5 aggiornamenti di affermazioni esistenti, solo aggiunte di fonte o ritiro;
- 6 duplicati, più 1 parziale;
- 9 esclusi;
- 2 respinti;
- 4 note di curatela.

**Discrepanza già nel pack, trovata durante il controllo** (documentata, non corretta): `sp-restauro` dice 1929–1934, una fonte secondaria dice 1931–1935.

---

## 5. Proposta di integrazione

### 5.1 Principi
- **Nessun sistema parallelo.** Le stesse tabelle, lo stesso Studio, lo stesso flusso a quattro occhi e gli stessi bundle.
- **Provenienza conservata.** Per ogni affermazione:
  - `authoredBy: ricerca-pv-gaia-2026-10-24-r1`;
  - `originalClaim` con il testo del pacchetto;
  - `locator` con l'id del pacchetto (es. `PV-006-C2`);
  - `accessedAt` della fonte.
- **Nessuna sovrascrittura.** Gli «aggiornamenti» aggiungono solo una fonte o ritirano dopo la verifica; i testi esistenti cambiano solo con una nuova revisione.
- **Ricerca su richiesta.** I dati dinamici restano fuori: per orari, biglietti e balneazione Gaia continua a dire che non lo sa e offre «Approfondisci».

### 5.2 Percorso (ogni passo richiede la tua autorizzazione)
1. **Fotografia del database** (`select pack_snapshot('it.liguria.sp.portovenere');`, sola lettura). Rifaccio il confronto anche con quello che è stato inserito dallo Studio: oggi il confronto è solo con i file.
2. **Lettura delle fonti.** Due possibilità:
   - aggiungi i domini del §3 alla rete dell'ambiente e io leggo le pagine, segnando per ogni affermazione il punto della pagina e la frase esatta (`excerpt`);
   - lo fa la persona che revisiona.

   Le affermazioni che la pagina non sostiene vengono riscritte o respinte.
3. **Inserimento nello Studio, a mano,** in quest'ordine:
   1. fonti (15);
   2. affermazioni in bozza (32);
   3. «Conferma fonte» con il punto della pagina;
   4. «Invia in revisione»;
   5. verifica da una seconda persona;
   6. «Ripubblica».

   Con lo stadio `research`, le affermazioni `in_review` entrano nell'anteprima marcate come tali. **Mai un'importazione del pack dai file.**
4. **Soggetti alternativi** (lo Studio non crea nodi): le affermazioni `bpv-*` vanno sul luogo `porta-del-borgo` o `castello-doria`, `po-*` su `palmaria`, `atm-*` su `palmaria` o `tino`. In alternativa servono un piccolo sviluppo («crea nodo» nello Studio) e una migrazione, da autorizzare a parte.
5. **Luoghi nuovi:** Villa del Varignano, Grotta dei Colombi, Batteria Umberto I, Forte Cavour. Si creano solo con coordinate da cartografia ufficiale o dal catasto. Fino ad allora le affermazioni stanno su `le-grazie` e `palmaria`.
6. **Dopo la pubblicazione:**
   - `db-export` per aggiornare i file del repository;
   - aggiornare la suite `GAIA-EVAL` (es. `i08-tino-piedi` e `b10-sg-olivetani` passano da «web» a «local») e aggiungere domande sui temi nuovi (capre, portoro, Varignano, tarantolino);
   - `ask:eval --dry` a costo zero.
7. **Vendita:** se un luogo è a pagamento (`config.access` nel database), le affermazioni nuove entrano nella sua parte a pagamento e non nel bundle pubblico. Va controllato luogo per luogo.

### 5.3 Fuori da questa integrazione, da decidere
- **Avvisi operativi** (ordinanze, lavori, aperture straordinarie). Oggi non c'è un posto giusto:
  - il Territory Pack non li ammette;
  - gli «Eventi del giorno» sono per gli eventi;
  - `practical` non lo legge nessuno.

  Una funzione futura sarebbe una tabella operativa con scadenza, come gli Eventi, mostrata nell'app e mai inviata all'AI senza data e fonte.
- **Fonti scientifiche suggerite dal controllo:**
  - ISPRA sul portoro (A);
  - Oneto e altri, 2008, sul tarantolino del Tino (A);
  - Catalogo generale dei Beni Culturali per San Pietro, il santuario delle Grazie e il Castello.

  Servono a passare da B ad A le affermazioni con date e attribuzioni.

---

## 6. Rischi
- **Fonti non lette:** è il rischio principale. Per questo tutto resta in bozza.
- **Divergenza file ↔ database:** il confronto va rifatto sulla fotografia (passo 1).
- **Pagine del Parco divulgative:** un'affermazione con sola fonte del Parco va raccontata con «Secondo il Parco…» e certezza «probable», come fa già il pack per le guide turistiche.
- **Lavoro manuale:** 32 affermazioni e 15 fonti nello Studio sono qualche ora di redazione. Un'importazione «solo aggiunte» con controllo dei duplicati sarebbe più rapida, ma è codice nuovo da autorizzare a parte.

---

## 7. File consegnati (scratchpad, fuori dal repository)
- `proposed-sources.yaml`: 15 fonti nuove, con l'elenco di quelle già presenti.
- `proposed-nodes.yaml`: 3 nodi.
- `proposed-assertions.yaml`: 32 affermazioni in bozza, ciascuna con `originalClaim`, `locator` ed eventuali note `# CONTROLLO`.
- **Validazione:** i tre file aggiunti a una copia dei pack danno «0 errori», con 88 affermazioni (56 + 32), 34 fonti e 4 nodi. Gli avvisi sono quelli già esistenti, più le 32 affermazioni «con fonte solo dedotta», come previsto.

**Decisioni richieste:**
1. Fotografia del database (query di sola lettura).
2. Chi legge le fonti: io, aprendo i domini della rete, oppure la redazione.
3. Inserimento nello Studio a mano, oppure sviluppo di un'importazione «solo aggiunte».
4. Soggetti alternativi oppure «crea nodo» nello Studio.

*Nessuna modifica senza la tua autorizzazione.*
