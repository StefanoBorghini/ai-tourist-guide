# AI Tourist Guide — Audit del CMS, collaudo e pubblicazione multi-territorio

Data: 2026-10-11 · Branch: `piattaforma-fondamenta` (commit di riferimento `4c6b633`) · Autore: audit tecnico
Nessuna modifica al codice dell'applicazione, al database remoto o ai deploy è stata fatta durante l'audit.

**Legenda degli ambienti**

| Sigla | Significato |
|---|---|
| **U** | test unitari (vitest) |
| **DB** | test SQL su Postgres 16 + PostGIS locale usa e getta (`npm run db:check`, stesse migrazioni del progetto reale) |
| **E2E** | browser (Playwright/Chromium) contro la build di produzione di Next su uno stack locale: Postgres e PostgREST reali, Auth e Storage **simulati** da un sostituto che applica le stesse policy RLS |
| **REALE** | Supabase reale + anteprima Vercel, verificato dal proprietario con screenshot durante questa sessione |
| **—** | non verificato |

---

## 1. Executive summary

**Stato generale.** Il CMS (Studio, `/studio`) è funzionante per una redazione interna fidata, sul ciclo completo:
- accesso;
- territori;
- luoghi;
- percorsi;
- affermazioni con quattro occhi;
- fonti;
- racconti;
- foto;
- eliminazione con copia di sicurezza;
- pubblicazione.

La pubblicazione aggiorna davvero la PWA **senza nuovo deploy**. Un territorio creato da zero nello Studio diventa usabile nella guida (mappa, luoghi, percorso, narrazione, uso offline). Questo è verificato in E2E locale. Nel **reale** è verificato solo per la ripubblicazione di Portovenere, non per un territorio nuovo.

**Non è pronto per più organizzazioni clienti.** I permessi del database non tengono conto dell'organizzazione e sono aggirabili scrivendo direttamente nelle tabelle. Le sonde di sicurezza (§4) lo dimostrano in locale.

**Rischi principali**

1. **Isolamento tra organizzazioni assente.**
   - Un ambito di permesso gerarchico (`xa.audita`) dà accesso anche a un territorio di un'altra organizzazione con identificativo figlio (`xa.audita.sub`).
   - Un ruolo con ambito vuoto vale per tutte le organizzazioni.
2. **Regole del CMS aggirabili via API diretta.** Un editor, con la sola sessione e la chiave pubblica, può fare via REST cose che lo Studio vieta:
   - cambiare l'organizzazione di un territorio;
   - eliminare un'affermazione verificata;
   - spostare coordinate senza metodo;
   - mettere un territorio «pubblicato» senza controllo.
3. **Bucket pubblico `bundles` senza limiti di tipo e dimensione.**
   - Chi pubblica può caricarvi qualunque file, servito poi dal dominio dell'app tramite `/pub/`.
   - Rischio potenziale di script ospitati sul dominio dell'app (da verificare sul reale, §4).
4. **Limiti e costi AI non affidabili per un servizio commerciale.**
   - I contatori sono in memoria per singola istanza.
   - Non c'è attribuzione dei consumi a territorio od organizzazione.
5. **Produzione non collegata.** La produzione (`main`) non ha Supabase configurato e usa solo i bundle dei file. La pubblicazione dallo Studio oggi raggiunge **solo l'anteprima**.

---

## 2. Matrice delle funzionalità

| Funzionalità | Dove nel codice | Dati / servizi | Autorizzazione | Implementata | Testata | Reale |
|---|---|---|---|---|---|---|
| Login / logout | `app/studio/login`, `actions.ts` (`signIn`, `signOut`), `proxy.ts`, `lib/studio/server.ts` (`requireStaff`) | Supabase Auth (email+password), cookie `@supabase/ssr` | `getUser()` verificato dal server Auth a ogni pagina e azione; `studio_me()` per i ruoli | Sì | E2E (password errata, senza sessione, senza ruolo, uscita) | **Sì** (accesso amministratore) |
| Ruoli e autorizzazioni | `supabase/migrations/20261014…` (`has_role`, `can_edit_pack`, `can_verify_pack`, `can_publish_pack`, `is_pack_staff`) | `memberships` (ruolo, `pack_scope`) | RLS su ogni tabella + controlli espliciti nelle funzioni `studio_*` | Sì, **per territorio, non per organizzazione** | DB (10, 20, 30, 40, 50), E2E (editor, esperto, visitatore, amministratore) | Solo amministratore (non esistono altri account nel reale) |
| Organizzazioni | `organizations`, `packs.organization_id`; scelta in `/studio/nuovo` (solo amministratore) | `organizations`, `memberships` | Lettura delle sole proprie; scrittura solo amministratore | Parziale: **nessuna gestione da UI** (organizzazioni, utenti, inviti solo via SQL) | DB (lettura) | — |
| Elenco territori | `app/studio/page.tsx`, `studio_packs()` | `packs`, `destinations` | `is_pack_staff` | Sì | E2E | **Sì** |
| Crea / modifica territorio | `app/studio/nuovo`, `[pack]/panoramica`, `studio_create_pack`, `studio_update_pack` | `packs`, `pack_dependencies`, `destinations` | `can_edit_pack(nuovo id)`; tipo e id immutabili; produzione solo con permesso di pubblicazione (**solo nella funzione**, §4) | Sì | DB 30, E2E 24 controlli | — |
| Luoghi (POI) | `[pack]/luoghi`, `studio_place`, `studio_update_place`, `studio_create_place` | `nodes`, `node_labels`, `places`, `geofences` | RLS `can_edit_pack`; coordinate solo con metodo (**solo nella funzione**) | Sì | DB 20, E2E (modifica, ricarica, persistenza) | Parziale (modifica di Fezzano e pubblicazione) |
| Percorsi e tappe | `[pack]/percorsi`, `StopsEditor.tsx`, `studio_set_route_stops`, `studio_create_route` | `routes`, `route_stops` | RLS; tappe solo del territorio o delle sue dipendenze; calibrazione azzerata se cambiano | Sì | DB 20, E2E (riordino, aggiunta, rimozione, persistenza) | — |
| Racconti | `[pack]/racconti`, `studio_create_unit`, `studio_units` | `narrative_units`, `unit_assertions` | RLS; un racconto si basa solo su affermazioni esistenti | Creazione ed eliminazione sì; **modifica del testo no** | DB 30, E2E | — |
| Affermazioni, fonti, verifica | `[pack]/affermazioni`, `[pack]/fonti`, `studio_review_assertion`, `studio_confirm_evidence`, `studio_create_source` | `assertions`, `assertion_texts`, `evidence`, `sources` | Quattro occhi (vincolo `verified_by <> authored_by` + trigger); verifica solo esperto o redazione con fonte esplicita | Sì | DB 20, E2E (verifica, rifiuto con motivo, fonte dedotta bloccata) | — |
| Revisioni e note editoriali | `assertions.review_note`; storico `content_revisions` (trigger `record_revision`) | `content_revisions` | Lettura staff; scrittura solo trigger | Note sì; storico registrato **ma senza interfaccia di consultazione o ripristino** | DB 40 (ripristino completo via `import_pack`) | — |
| Media | `[pack]/media`, `MediaUploader.tsx`, `studio_register_media`, `signedMediaUrls` | bucket privato `media`, `media_assets` | Policy Storage per cartella di territorio; indirizzi firmati di 10 minuti; autore e licenza obbligatori | Sì (riduzione a 2048 px nel browser) | DB 20, E2E | **Sì** (foto di Fezzano, copia dei file dal repository) |
| Eliminazione | `[pack]/elimina`, `studio_delete_plan`, `studio_delete`, `studio_delete_pack` | tutte le tabelle del territorio + copia in `content_revisions` | Piano con blocchi; verificate solo esperto; territorio intero solo amministratore con conferma | Sì | DB 40 (con ripristino), E2E 17 | — |
| Pubblicazione | `[pack]/panoramica`, `lib/studio/publish.ts`, `runPublication`, `studio_publication_finish`, `public_bundle_index` | bucket pubblico `bundles`, `bundles`, `publications` | Permesso di pubblicazione; controllo di pubblicazione nel server dell'app (**non verificato dal DB**, §4) | Sì | U (parità DB ↔ file), DB 50, E2E 19 + 24 + 10 | **Sì** (Portovenere, `/pub/index.json` presente) |
| Errori e stati di caricamento | `friendlyError`, `?errore=` / `?ok=` | — | — | Messaggi sì; **nessun `error.tsx`, nessun indicatore di attesa** sulle azioni lunghe | E2E (messaggi) | Un errore 500 reale trovato e corretto (`ffeca48`) |

---

## 3. Risultati dei test (eseguiti in questa sessione)

| Test | Ambiente | Esito |
|---|---|---|
| `npm run ci`: typecheck, validazione dei pack, controllo territori | U | **Superato.** app 125, bundle 25, context-engine 29, domain 21, narrative-planner 13, territory-pack 51 |
| `npm run db:check`: migrazioni, `remote-check.sql`, parità pack ↔ DB, 10/20/30/40/50, revoca e riapplicazione | DB | **Superato** |
| `studio-e2e`: accesso, ruoli, luoghi, tappe, revisione, foto, telefono | E2E | **31/31** |
| `studio-territori-e2e`: crea regione e destinazione → contenuti → controllo → pubblica → home dell'app | E2E | **24/24** |
| `studio-elimina-e2e` | E2E | **17/17** |
| `studio-pubblica-e2e`: copia dal repository, foto, pubblica, ripubblica, domande, offline, ritiro | E2E | **19/19 alla seconda esecuzione**. La prima si è fermata per un timeout non riprodotto, causa **non individuata** (§8) |
| `app-nuovo-territorio` (nuovo, solo audit): il territorio creato nello Studio usato nella guida | E2E | **10/10**: hub, percorso, scarico offline, mappa, elenco, narrazione del testo scritto nello Studio, server delle domande, uso senza rete. Prima esecuzione 9/10 per un errore di tempi nel test stesso, non nell'app |
| Sonde di sicurezza e isolamento (nuove, solo audit) | DB | Vedi §4: **8 criticità confermate** |
| Export in YAML di un territorio creato dallo Studio (`db-export`) + `guide-pack validate` | DB | Export riuscito; validazione con il solo errore atteso `MEDIA_FILE_MISSING`: export senza `--media` |

**Non eseguito:**
- risposte reali dell'AI: l'ambiente non ha `ANTHROPIC_API_KEY`, quindi il server delle domande risponde 503 come previsto;
- qualunque verifica sul reale oltre a quelle segnate **Sì** in §2;
- comportamento di Supabase Storage reale su file HTML e SVG.

---

## 4. Sicurezza e permessi

**Cosa funziona** (DB + E2E):
- un anonimo non legge territori, luoghi o affermazioni (0/0/0);
- un visitatore autenticato non vede media né territori;
- un editor non vede storico, ruoli o organizzazioni altrui;
- le funzioni dello Studio rifiutano chi non ha i permessi (42501);
- quattro occhi e quote di verifica sono imposte da trigger e vincoli;
- nessuna chiave di servizio nello Studio;
- il service worker non mette in cache `/studio`.

### Sonde (Postgres locale, ruolo `authenticated` come PostgREST)

Script ed esiti: `docs/v0.3-platform/audit/audit-probes.sql` e `audit-probes.out`; la prova del territorio nuovo nella guida: `audit/app-nuovo-territorio.mjs`. Le criticità:

| # | Sonda | Esito | Gravità |
|---|---|---|---|
| P1 | `platform_editor` dell'org B modifica un territorio dell'org A | CONSENTITO | Alta per multi-cliente: i ruoli «platform_*» sono globali; ammissibile solo per lo staff interno |
| P2 | `territory_editor` con `pack_scope` nullo modifica qualunque territorio | CONSENTITO | Alta: «ambito vuoto = tutto» è un rischio di configurazione |
| P3 | Editor dell'org A (ambito `xa.audita`) modifica `xa.audita.sub` **dell'org B** | CONSENTITO | **Bloccante** per multi-cliente: l'ambito gerarchico ignora l'organizzazione |
| P4 | Editor cambia `packs.organization_id` del proprio territorio via REST | CONSENTITO | **Bloccante**: un cliente può spostare un territorio in un'altra organizzazione |
| P5 | Editor elimina un'affermazione **verificata** con `DELETE` diretto | CONSENTITO | Alta: la regola «solo chi verifica» è nella funzione, non nel DB |
| P6 | Editor sposta coordinate senza metodo con `UPDATE` diretto | CONSENTITO | Media: regola editoriale aggirabile |
| P7 | `territory_editor` mette la destinazione «published» con `UPDATE` diretto, senza controllo né blocchi | CONSENTITO | Media: l'indice pubblico richiede comunque una pubblicazione riuscita, ma lo stato mente |
| P8 | Editor scrive `…/pagina.html` nel bucket pubblico `bundles` | CONSENTITO (bucket senza limiti di MIME e dimensione) | Alta **da verificare sul reale**: il file sarebbe servito da `/pub/` sul dominio dell'app, dove vive anche la sessione dello Studio |
| P12 | Anonimo elenca gli oggetti del bucket `bundles` | Consentito (bucket pubblico) | Bassa: i bundle ritirati o vecchi restano scaricabili |

### Altre osservazioni

- **Pubblicazione senza quattro occhi.** Il `territory_editor` può approvare e pubblicare il proprio territorio da solo. La regola dei quattro occhi vale per le affermazioni, non per la pubblicazione.
- **Il controllo di pubblicazione lo fa il server dell'app**, poi `studio_publication_finish` registra quello che riceve. Chi ha il permesso di pubblicare può caricare bundle arbitrari del proprio territorio chiamando direttamente le API. Accettabile con redazione interna, non con clienti esterni.
- **CSRF.** Le Server Actions di Next verificano l'origine; le azioni rifanno `requireStaff()` e il DB applica le RLS. Testato a livello DB, non con richieste forgiate a mano.

---

## 5. Flusso CMS → PWA (dal codice esaminato)

1. **Studio.** Le modifiche vanno nelle tabelle Supabase tramite le funzioni `studio_*`, con l'identità dell'utente. La PWA **non legge mai il database**.
2. **Pubblica** (`setPackStatus` / `republishPack` → `runPublication` in `lib/studio/server.ts`):
   1. `checkReadiness`;
   2. `pack_snapshot` del territorio e delle dipendenze;
   3. foto scaricate dal bucket `media` e verificate con sha256;
   4. `compilePublication` (stesso validatore e stesso `buildBundle` dei file);
   5. caricamento in `bundles/<territorio>/<lingua>-full/`: prima i file con l'impronta nel nome, poi i `manifest.json`;
   6. `studio_publication_finish` registra l'esito e i bundle;
   7. `public_bundle_index()` → `bundles/index.json`.
3. **PWA** (`components/GuideApp.tsx` → `loadIndex`):
   - legge `/bundles/index.json` (bundle compilati dai file al build) e `/pub/index.json`;
   - `/pub/` è il bucket pubblico servito sullo stesso dominio dalla riscrittura in `next.config.ts`, presente solo se `NEXT_PUBLIC_SUPABASE_URL` è definita;
   - `mergeIndexes`: una destinazione pubblicata dallo Studio **sostituisce** quella dei file.
4. **Scelta del territorio:** pagina iniziale con le voci dell'indice unito. Ogni voce porta manifest, lingua e copertina; il contenuto è verificato con gli hash (`verifyBundle`).
5. **Cache e offline** (`public/sw.js`, `lib/offline.ts`):
   - file con l'impronta nel nome: prima la cache;
   - indici e manifest: prima la rete, con timeout di 4 s;
   - «Scarica per l'uso offline» mette in cache indice (o indici), manifest e file;
   - verificato in E2E per Portovenere ripubblicato e per un territorio nuovo.
6. **Domande AI** (`lib/ask-server.ts`): stesso indice unito. L'indice pubblicato è ricontrollato ogni minuto; il contenuto è letto dal bucket e verificato.
7. **Nuovo deploy: non serve.** Un territorio pubblicato compare alla successiva apertura dell'app.
   - Verificato in E2E per un territorio nuovo.
   - Verificato nel reale per Portovenere: indice con `/pub/…` e foto visibili.
   - **Eccezione:** in produzione la riscrittura `/pub/` non esiste (nessuna variabile Supabase), quindi la produzione mostra solo i bundle dei file.

---

## 6. Multi-territorio

**Cosa funziona oggi** (E2E; nel reale solo la parte Portovenere):
- **Creazione dal CMS**, senza toccare il repository: regione o destinazione, nome e descrizione it/en, lingua principale e lingue, stadio, «fa parte di».
- **Identificativo:** validato (regex nell'app e nel DB, mai corretto in silenzio), unico (chiave primaria), immutabile.
- **Associazione all'organizzazione:** l'organizzazione del ruolo che autorizza; l'amministratore può sceglierla.
- **Contenuti** (luoghi, percorsi, fonti, affermazioni, racconti, foto): associati al territorio tramite `pack_id` e verificati dalle funzioni.
- **Distinzione bozza / in revisione / pubblicato** per territorio, con controllo di pubblicazione.
- **Ciclo completo** crea → POI → itinerario → narrazioni e fonti → media → revisione → pubblica → **usabile nella guida e offline**: E2E 24/24 + 10/10.
- **Import/export:** un territorio creato nello Studio si esporta in YAML (`db-export`); i pack dei file si importano (`db-sql`).
- **Nessuna dipendenza da codice o configurazioni per territorio** (`check:no-territory-code` superato). Restano due eccezioni:
  - i territori dei file (Liguria, Portovenere) sono anche compilati al build;
  - finché non vengono pubblicati dallo Studio, la loro fonte resta il repository.

**Cosa manca:**
1. **Localizzazione e metadati del territorio:**
   - nessun centro mappa, perimetro, fuso orario, contatti o pagina di presentazione;
   - la mappa si ricava dai luoghi.
2. **Bozza e pubblicato per singolo contenuto.**
   - La pubblicazione è un'istantanea dell'intero territorio: un luogo a metà lavoro finisce online alla prossima ripubblicazione.
   - Le affermazioni in bozza sono comunque escluse.
3. **Modifica dei racconti:** solo creazione ed eliminazione.
4. **Interfaccia per lo storico:** consultazione e ripristino.
5. **Verifica nel reale** di creazione, eliminazione, ritiro e ripubblicazione di un territorio nuovo.

---

## 7. Architettura commerciale futura (solo lacune)

| Esigenza | Stato oggi | Lacuna / decisione da prendere |
|---|---|---|
| Più organizzazioni clienti | `organizations` e `packs.organization_id` esistono | I permessi ignorano l'organizzazione (P1–P4). Decidere: ruoli per organizzazione (per esempio amministratore dell'organizzazione), spazio di identificativi per organizzazione o divieto di gerarchie tra organizzazioni |
| Più territori per organizzazione | Sì, tramite `organization_id` | Nessun elenco per organizzazione nello Studio; nessuna quota |
| Utenti e ruoli per organizzazione | `memberships` (ruolo, ambito) | Nessuna interfaccia di inviti e gestione utenti; ambito nullo = globale |
| Separazione dati e permessi | RLS per territorio | Scritture dirette sulle tabelle che aggirano le regole (P4–P7). Decidere se tutte le scritture passano da funzioni (revoca dei privilegi diretti) o se le regole vanno in trigger |
| Bozza, revisione, pubblicato | Per territorio | Per singolo contenuto: decidere se servono «changeset» o una versione pubblicata separata |
| Piani B2B | Assenti | Tabella piani e limiti per organizzazione; misurazione dell'uso (territori, utenti, domande AI, spazio) |
| Contenuti premium per turisti | Tabelle `products`, `purchases`, `entitlements`, `access_tier` e `can_access_route()` presenti, mai usate | I bundle sono **pubblici**: un contenuto premium non può stare nei bundle attuali. Serve una consegna protetta (bundle separato firmato o API con verifica del diritto) e la decisione su cosa funziona offline |
| Consumi AI per organizzazione e territorio | Solo log in console | Nessuna tabella di uso, nessuna attribuzione all'organizzazione |

---

## 8. Priorità operative

**Bloccanti** (prima di aprire lo Studio a clienti esterni):
1. **Isolamento per organizzazione nei permessi.** Esito P3 / P4 / P1 / P2.
2. **Regole del CMS non aggirabili dall'API diretta.** Esito P4–P7: colonne protette, trigger o scritture solo tramite funzioni.
3. **Bucket `bundles` con tipi e dimensioni ammessi**, e verifica sul reale di come Supabase serve HTML e SVG. Esito P8.

**Importanti:**
1. Controllo di pubblicazione eseguito in un contesto fidato (il DB o un servizio dedicato), non solo nel server dell'app; quattro occhi opzionali sulla pubblicazione.
2. Limiti AI condivisi tra istanze (archivio esterno) e uso registrato per territorio e organizzazione, senza testo libero delle domande nei log, o con il testo ridotto.
3. Studio:
   - `error.tsx` per non mostrare la pagina 500 generica;
   - indicatore di attesa e protezione dal doppio clic su «Approva e pubblica» (circa 4 s).
4. Collaudo nel reale con account di prova dedicati (editor ed esperto di un territorio di prova) e con un territorio nuovo.
5. Decisione sulla produzione: variabili Supabase anche in Production e Portovenere pubblicato dallo Studio, oppure produzione solo dai file.
6. Timeout intermittente della prova di pubblicazione: riprodurre e capire.

**Miglioramenti successivi:**
- metadati del territorio (centro, perimetro, contatti);
- modifica dei racconti;
- interfaccia dello storico con ripristino;
- pulizia dei bundle ritirati;
- gestione di organizzazioni e utenti da interfaccia.

---

## 9. Piano della fase seguente (in ordine)

1. **Permessi per organizzazione**, con test DB a due organizzazioni:
   - ruoli legati a `organization_id`;
   - nessuna gerarchia tra organizzazioni;
   - ambito nullo solo per lo staff della piattaforma.
2. **Chiusura delle scritture dirette**, con le sonde P4–P8 trasformate in test:
   - `organization_id` immutabile per i non amministratori;
   - stato di pubblicazione e regole editoriali in trigger;
   - tipi e dimensioni ammessi nel bucket `bundles`.
3. **Collaudo sul reale** (manuale, con le tue credenziali):
   - account editor ed esperto di prova;
   - territorio di prova creato, pubblicato, usato nell'app, ritirato ed eliminato.
4. **Misurazione dei consumi AI**: tabella d'uso per territorio e organizzazione, limiti condivisi, log senza dati personali.
5. **Robustezza dello Studio**: pagine d'errore, attese, doppio clic, modifica dei racconti.

---

## Risposte

**Il CMS è pronto per gestire contenuti editoriali in sicurezza?**
Sì per una **redazione interna fidata**:
- flussi, quattro occhi, copie di sicurezza e permessi dello Studio sono testati;
- l'accesso, le foto e la pubblicazione sono verificati nel reale.

No per **utenti esterni o clienti**: le regole si aggirano con l'API diretta (P4–P8).

**È possibile creare una nuova destinazione dal CMS?**
Sì: verificato in E2E con uno stack locale, senza toccare il repository. **Nel reale non è ancora stato provato.**

**È possibile pubblicarla e renderla disponibile nella PWA senza un nuovo deploy?**
Sì:
- in E2E per un territorio nuovo: compare nella home, si apre, la narrazione e l'uso offline funzionano;
- nel reale **nell'anteprima** per Portovenere.

**In produzione no**, finché la produzione non ha la configurazione Supabase.

**L'architettura è pronta per più organizzazioni clienti?**
**No.** Il modello dati lo prevede, ma i permessi non isolano le organizzazioni (P1–P4). Mancano poi la gestione utenti per organizzazione, la misurazione dei consumi e la consegna protetta dei contenuti premium.

**Qual è il prossimo intervento minimo indispensabile?**
Rendere i permessi del database consapevoli dell'organizzazione e chiudere le scritture dirette che aggirano lo Studio (punti 1 e 2 del piano), con test a due organizzazioni. Fino ad allora gli account dello Studio vanno dati solo alla redazione interna.
