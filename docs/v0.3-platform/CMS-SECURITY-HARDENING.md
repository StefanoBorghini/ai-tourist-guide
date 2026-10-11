# AI Tourist Guide — Hardening di sicurezza del CMS

Data: 2026-10-11 · Branch: `cms-hardening` (locale, **non pubblicato**) · Riferimento: `CMS-AUDIT-REPORT.md`

Stato: **pronto per la revisione.** Niente è stato applicato al Supabase remoto e non c'è stato nessun deploy.

Tutte le verifiche sono state fatte in locale:
- **DB**: Postgres 16 + PostGIS usa e getta, con tutte le migrazioni del progetto;
- **E2E**: build di produzione di Next con Postgres e PostgREST veri; Auth e Storage sono simulati da un sostituto che applica le stesse policy.

La PWA, il design dello Studio e i dati di Portovenere non sono cambiati.

---

## 1. Criticità risolte

Le sonde dell'audit sono state rieseguite dopo la migrazione: `audit/audit-probes-post-hardening.sql` e `.out`.

| # | Criticità (audit) | Prima | Dopo | Come |
|---|---|---|---|---|
| P1 | `platform_editor` di un'organizzazione cliente modifica i territori di altre organizzazioni | consentito | **negato** | I ruoli di piattaforma valgono solo nell'organizzazione di tipo `platform` (`is_platform_admin`, `has_role_in`). Il trigger `memberships_guard` impedisce di assegnarli in un'organizzazione cliente |
| P2 | Ambito nullo = tutti i territori di tutte le organizzazioni | consentito | **negato** | Ambito nullo = tutti i territori **della propria organizzazione**. Globale solo per lo staff della piattaforma |
| P3 | L'ambito gerarchico (`xa.audita` → `xa.audita.sub`) attraversa le organizzazioni | consentito | **negato** | Per i clienti l'ambito vale solo se il territorio è della stessa organizzazione. `memberships_guard` vieta ambiti su territori di altre organizzazioni |
| P4 | Un editor sposta il proprio territorio in un'altra organizzazione (REST) | consentito | **negato** | Trigger `packs_guard`: organizzazione, tipologia e «fittizio» li cambia solo l'amministratore. Le policy di INSERT e UPDATE verificano l'organizzazione della riga (`can_edit_pack_in`) |
| P5 | Un editor elimina un'affermazione verificata con un DELETE diretto | consentito | **negato** | Trigger `editorial_delete_guard`: un'affermazione verificata la elimina chi verifica; un contenuto pubblicato (racconto, percorso, nodo) chi pubblica. Togliere una prova a un'affermazione verificata la riporta in revisione (`editorial_evidence_guard`) |
| P6 | Coordinate spostate senza metodo (UPDATE diretto) | consentito | **negato** | Trigger `places_guard`: la posizione cambia solo da `studio_update_place`, che chiede il metodo. Un luogo nuovo deve avere il metodo. Lo stato «verificato» lo dichiara solo chi verifica |
| P7 | «Pubblicato» con un UPDATE diretto, senza controllo né blocchi | consentito | **negato** | Trigger `destinations_guard`: lo stato cambia solo da `studio_set_pack_status`, che applica passaggi, permessi, blocchi e controllo. La policy di `publications` accetta solo le richieste nate dalle funzioni dello Studio |
| P8 | File arbitrari (HTML) nel bucket pubblico `bundles` | consentito | **negato** | Bucket limitato a 50 MB e ai tipi JSON, JPEG, PNG, WebP, MP4, WebM e audio. La policy ammette solo i percorsi prodotti dalla pipeline (`bundle_object_name_ok`). In più `/pub/` risponde con `Content-Security-Policy: sandbox` e `nosniff` |
| nuovo | La vista `node_refs` mostrava a chiunque, anche anonimo, identificativi e riferimenti di **tutti** i nodi | consentito | **negato** | `security_invoker` sulla vista (valgono le policy di `nodes`); niente lettura per gli anonimi |
| nuovo | Riferimenti a contenuti di altri territori conoscendone l'UUID (tappe, prove, foto, racconti…) | consentito | **negato** | Trigger `references_guard` su 10 tabelle: solo il proprio territorio e quelli da cui dipende, come il validatore dei pack |
| nuovo | Un editor cliente riscrive l'indice pubblico di tutti i territori (`index.json`) | consentito | **negato** | `index.json` lo scrive solo lo staff della piattaforma. L'app accetta una voce pubblicata solo se punta alla cartella del suo territorio |
| nuovo | Dipendenze circolari e foto con file di altri territori tramite scritture dirette | consentito | **negato** | `pack_dependencies_guard`, `media_assets_guard` (percorso nella cartella del territorio, file presente nel bucket) |

**Esame di tutte le tabelle scrivibili via PostgREST.** Ho controllato le 37 policy di scrittura delle tabelle `public`:

- **tabelle dei contenuti:** coperte dai trigger sopra, oppure senza regole oltre ai permessi, per esempio i nomi dei luoghi;
- **tabelle dei visitatori** (`favorites`, `route_progress`, `profiles`, `consents`): solo righe proprie;
- **tabelle commerciali** (`products`, `entitlements`): solo amministratore;
- **`publications`:** solo dalle funzioni dello Studio;
- **`content_revisions`, `bundles`:** nessuna scrittura diretta;
- **`changesets`:** scrittura per lo staff del territorio, già vincolata all'autore.

Le tabelle senza RLS sono solo quelle di PostGIS (`spatial_ref_sys` e viste), dati di riferimento pubblici.

**Prova dell'interfaccia non coinvolta.** Ogni controllo è nel database (policy, trigger, privilegi): i test lo verificano con la sessione dell'utente, come una richiesta REST, senza passare dallo Studio.

## 2. Modifiche

### Migrazione preparata (non applicata)

`supabase/migrations/20261021000000_cms_hardening.sql`, con revoca in `supabase/rollback/20261021000000_cms_hardening.down.sql`.

- **Controllo iniziale.** La migrazione **si ferma senza cambiare nulla** se trova:
  - ruoli di piattaforma in organizzazioni non `platform`;
  - ambiti di un cliente su territori di un'altra organizzazione.

  Il messaggio indica le righe da correggere.
- **Funzioni:**
  - nuove: `has_role_in`, `can_edit_pack_in`, `pack_reaches`, `pack_of`, `media_file_exists`, `bundle_object_name_ok`, più i trigger elencati in §1;
  - ridefinite: `has_role`, `is_platform_admin`, `studio_can_publish_any`, `studio_creation_scopes`;
  - con modifiche minime: `studio_create_pack`, `studio_update_place`, `studio_set_pack_status`, `studio_request_publication`.
- **Il «sigillo» delle funzioni dello Studio.** Le funzioni ridefinite impostano una variabile valida solo per la transazione corrente (`app.studio`), che i trigger richiedono per le operazioni consentite solo dallo Studio. Una richiesta REST è una transazione a sé e non può impostarla: `set_config` non è esposto da PostgREST.
- **Nessuna tabella nuova.** Le importazioni (`import_pack`, ruolo di servizio, SQL Editor) non sono soggette ai controlli per `authenticated`.

### Codice dell'app (minimo, interfaccia invariata)

| File | Modifica |
|---|---|
| `apps/guide/proxy.ts` | Fa la riscrittura `/pub/` verso il bucket e aggiunge `Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self'; sandbox` e `X-Content-Type-Options: nosniff`. Le intestazioni di `next.config` non arrivavano alle risposte riscritte verso un altro dominio: verificato |
| `apps/guide/next.config.ts` | Tolta la riscrittura spostata nel proxy |
| `apps/guide/lib/bundle-index.ts` | Una voce dell'indice pubblicato vale solo se manifest e copertina stanno nella cartella del suo territorio |
| `apps/guide/lib/studio/server.ts` | Chi non è staff della piattaforma non tenta di riscrivere l'indice; lo Studio lo dice nel messaggio |

### Test aggiornati

Le regole vecchie erano verificate da test che ora devono rifiutare l'operazione:
- `remote-check.sql` e `10_platform_security.sql`:
  - coordinate e stato «pubblicato» con scritture dirette → ora rifiutati;
  - file caricato prima della registrazione della foto.
- `50_publication.sql`: prepara lo stato iniziale come amministratore del database.

## 3. Test eseguiti

| Test | Ambiente | Esito |
|---|---|---|
| `supabase/tests/60_hardening.sql` (nuovo): due organizzazioni clienti (Comune A, Albergo B), staff della piattaforma, amministratore, esperto, anonimo | DB | **Superato** |
| `npm run db:check`: tutte le migrazioni, `remote-check.sql`, parità pack ↔ DB (`roundtrip.ts`), test 10–60, revoca e riapplicazione di tutte le migrazioni | DB | **Superato** |
| Sonde dell'audit rieseguite | DB | P1–P8 **negati** (`audit/audit-probes-post-hardening.out`) |
| `npm run ci`: typecheck, test unitari, validazione dei pack, controllo territori | U | **Superato.** app 126 (+1: indice manomesso), bundle 25, context-engine 29, domain 21, narrative-planner 13, territory-pack 51 |
| Studio nel browser | E2E | **31/31** |
| Creazione di un territorio | E2E | **24/24** |
| Eliminazione | E2E | **17/17** |
| Pubblicazione Portovenere | E2E | **19/19.** In una esecuzione su sei è comparso il timeout intermittente già segnalato nell'audit, non riprodotto con i log dettagliati (§4) |
| Territorio creato nello Studio usato nella guida, anche offline | E2E | **10/10** |
| Intestazioni su `/pub/` | E2E | Presenti (`content-security-policy`, `x-content-type-options`); JSON e immagini servite normalmente |

### Copertura delle richieste

`60_hardening.sql` salvo dove indicato.

| Richiesta | Esito |
|---|---|
| L'org A non legge né modifica B | Testato su territori, luoghi, affermazioni, fonti, foto, `node_refs`; da REST e dallo Studio. Vale anche per il territorio `za.alfa.sub`, di B, che sta «sotto» l'ambito di A |
| Nessuno sposta un territorio in un'altra organizzazione | Testato per l'editor, lo staff non amministratore e la creazione intestata ad altri. Solo l'amministratore può |
| Nessuna cancellazione diretta di affermazioni verificate | Testato: l'editor no, l'esperto sì |
| Coordinate non aggirabili | Testato: UPDATE diretto rifiutato, stato «verificato» rifiutato per l'editor, Studio con metodo accettato |
| Pubblicazione non attivabile con un UPDATE diretto | Testato: UPDATE, INSERT di una destinazione «pubblicata», INSERT diretto in `publications`; dallo Studio i blocchi valgono |
| Niente HTML o SVG nel bucket pubblico | Testato: `.html` e `.svg` rifiutati, file della pipeline accettati, cartella di B e `index.json` rifiutati a un cliente, HTML rifiutato anche nel bucket `media` |
| L'amministratore conserva i permessi | Testato: vede tutto, sposta territori tra organizzazioni, crea per un cliente, assegna ruoli |
| Portovenere invariato | Impronta di `pack_snapshot` invariata in 30, 40, 50 e 60; parità dei bundle in `roundtrip.ts`; pubblicazione E2E 19/19 |

## 4. Problemi residui

**Da decidere prima di dare accesso a clienti esterni:**
1. **Il controllo di pubblicazione lo fa ancora il server dell'app.** Il DB applica i blocchi (nome, luoghi, racconti, fittizio), ma accetta il rapporto del controllo così come arriva. Chi ha il permesso di pubblicare può caricare nella propria cartella del bucket file del tipo ammesso, compilati da sé. Per i clienti serve un compilatore in un contesto fidato: funzione con chiave di servizio, o job.
2. **L'indice pubblico lo aggiorna solo lo staff della piattaforma.** Quando pubblica un cliente, i suoi bundle vengono caricati e registrati, ma compaiono nell'app solo al prossimo aggiornamento dell'indice da parte dello staff. Serve un aggiornamento fidato dell'indice (stesso contesto del punto 1).
3. **Dipendenze tra organizzazioni.** Un cliente non può far dipendere un suo territorio da una regione della piattaforma (per esempio `it.liguria`): non la vede. Serve una lettura in sola consultazione dei territori «condivisi».
4. **Pubblicazione senza quattro occhi.** Chi ha il permesso di pubblicare un territorio può approvarlo da solo.

**Già noti e invariati:**
- limiti e costi AI per istanza (`CMS-AUDIT-REPORT.md` §8);
- bundle ritirati o vecchi ancora scaricabili dal bucket pubblico (P12);
- timeout intermittente della prova di pubblicazione: circa 2 esecuzioni su 7, causa non trovata, nessun errore dell'app osservato.

**Nuovo costo minimo:** il proxy di Next ora gira anche sulle richieste `/pub/` (una invocazione di middleware per file). Da osservare su Vercel.

## 5. Come applicare la migrazione in sicurezza (Supabase Preview, con la tua autorizzazione)

1. **Controllo preliminare**, in sola lettura, nel SQL Editor:

   ```sql
   select o.name as organizzazione, o.kind, m.role, m.pack_scope
   from memberships m join organizations o on o.id = m.organization_id order by 1, 3;
   select p.id as territorio, o.name as organizzazione, o.kind
   from packs p join organizations o on o.id = p.organization_id order by 1;
   ```

   - L'account amministratore deve stare in un'organizzazione con `kind = 'platform'`.
   - Se la tua organizzazione risulta di altro tipo **ed è davvero quella della piattaforma**, prima va corretto il suo tipo (`update organizations set kind = 'platform' where id = '…'`). Te lo preparo io dopo aver visto il risultato.
   - Altrimenti la migrazione si ferma da sola con il motivo.
2. **Copia di sicurezza:**
   - esporta Portovenere: `select pack_snapshot('it.liguria.sp.portovenere')`, salvando il risultato;
   - annota l'orario. Il piano gratuito non ha il ripristino puntuale.
3. **Prima di applicarla al Supabase remoto, l'app nell'anteprima deve già avere la riscrittura `/pub/` in `proxy.ts`.** Cioè il branch deve essere stato pubblicato e compilato da Vercel, con la tua autorizzazione al deploy. Le due cose sono indipendenti, ma senza il nuovo proxy mancano solo le intestazioni di difesa.
4. Esegui `20261021000000_cms_hardening.sql` nel SQL Editor, dal file allegato e non da un'anteprima troncata.
5. Esegui `supabase/tests/remote-check.sql` aggiornato. Esito atteso: `superato | 0 | 0`. Non lascia dati.
6. **In caso di problemi:** esegui `supabase/rollback/20261021000000_cms_hardening.down.sql`. Ripristina le regole precedenti e non tocca i dati.

## 6. Verifica manuale su Supabase Preview (dopo l'applicazione)

1. Con l'account amministratore nello Studio:
   - l'elenco territori è uguale a prima;
   - apri Portovenere, modifica il nome di un luogo e salva;
   - sposta un luogo **con** il metodo: salvato;
   - Pubblicazione → «Ripubblica con le modifiche»: riquadro verde.
2. Nell'app dell'anteprima: Portovenere si apre e le foto si vedono.
3. Strumenti per sviluppatori → Rete → una richiesta `/pub/…`: intestazioni `content-security-policy` e `x-content-type-options` presenti.
4. **Facoltativo**, con un'organizzazione di prova e due account di prova (te li preparo in SQL, senza dati reali):
   - l'editor di prova non vede Portovenere;
   - non può creare territori fuori dal proprio ambito;
   - la pubblicazione dei suoi bundle non tocca l'indice.

## 7. Compatibilità con Portovenere

- **Dati e bundle invariati:** impronta di `pack_snapshot` identica prima e dopo; parità database ↔ file dei bundle.
- **Pubblicazione:** dallo Studio funziona come prima (E2E 19/19, con copia dei file dal repository, foto nuova, ripubblicazione, domande, uso offline, ritiro).
- **Bundle e formato** dell'indice: invariati.
- **Condizione:** lo staff che pubblica deve stare nell'organizzazione di tipo `platform` (§5.1).
