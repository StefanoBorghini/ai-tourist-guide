# Territori creati dal CMS — analisi e limiti (2026-10-11)

Obiettivo: creare e gestire un nuovo territorio interamente dallo Studio, senza toccare il repository.

## Cosa c'è già (e si riusa)

| Elemento | Dove | Note |
|---|---|---|
| Territorio | `packs` (id gerarchico `it.regione.provincia.comune`, `kind` core/region/area/destination, `title`, `description`, `default_locale`, `locales`, `release_stage`, `quality_tier`, `version`, `config`, `organization_id`) | stessa tabella dei pack importati da `territories/` |
| Dipendenze | `pack_dependencies` | es. una destinazione dipende dalla sua regione |
| Destinazione pubblicabile | `destinations` (`status` draft/in_review/published/archived, `cover_media_id`, `published_at/by`) | solo i pack `destination` arrivano all'app |
| Pubblicazione | `publications` (richiesta → compilazione → esito, `report`) | la compila il servizio di pubblicazione (milestone 5) |
| Permessi | `memberships` (ruolo × `pack_scope` gerarchico) e `can_edit_pack` / `can_publish_pack` / `is_pack_staff` | un editor con ambito `it.liguria` lavora su `it.liguria` e su tutti i suoi discendenti |
| Contenuti | `nodes`, `places`, `geofences`, `sources`, `assertions` (+ testi e prove), `narrative_units`, `routes`, `media_assets` | gli stessi del formato Territory Pack (`import_pack` / `pack_snapshot`) |
| Validazione | `validatePacks` e `buildBundle` (TypeScript) | gli stessi controlli dei pack del repository |

## Limiti architetturali

1. **La PWA oggi non legge il database.** I bundle si compilano al build dai file in `territories/`
   (`apps/guide/scripts/build-bundles.ts`) e finiscono in `public/bundles/`. Un territorio creato nello Studio
   **non può comparire nell'app** finché non esiste la pipeline di pubblicazione (milestone 5): database →
   `pack_snapshot` → validazione → `buildBundle` → bucket `bundles` → indice letto dall'app. Questo modulo prepara
   il territorio e registra la richiesta di pubblicazione, ma non cambia la PWA né il suo build: così la produzione
   resta com'è e nessun territorio in bozza può comparire.
2. **«Pubblicato» nel database non basta.** `destinations.status = published` vuol dire «approvato per la
   pubblicazione». Il bundle lo crea solo la pipeline, che ripete la validazione completa: un territorio vuoto, in
   bozza o con errori non produce bundle.
3. **I controlli completi sono in TypeScript, non in SQL.** Il validatore dei pack gira sul server dell'app
   (`pack_snapshot` → `snapshotToPack` → `validatePacks` → `buildBundle`). Il database applica un controllo minimo
   indipendente (nome, almeno un luogo e un racconto con affermazioni raccontabili) per chi chiamasse le funzioni
   direttamente, e la pipeline ripeterà il controllo completo.
4. **I file media sono su Storage, non su disco.** Il validatore controlla i file nella cartella del pack: per i
   territori del database il controllo equivalente è «il file esiste nel bucket `media`».
5. **L'identificativo non cambia dopo la creazione.** È la chiave di tutti i riferimenti (`pack:slug`), dei percorsi
   in Storage e delle autorizzazioni gerarchiche. Si può cambiare tutto il resto.
6. **La tipologia non cambia dopo la creazione.** Una destinazione ha stato, copertina e pubblicazioni; una regione
   no. La tipologia `core` resta riservata all'amministratore.
7. **Dipendenze leggibili.** Un territorio può dipendere solo da territori che l'utente può leggere; un editor con
   ambito ristretto non vede i nodi della regione madre, quindi la verifica completa di una destinazione che usa la
   regione la fa chi ha accesso a entrambi (redazione o amministratore).
8. **I territori dei file restano nei file.** Liguria e Portovenere nascono da `territories/`: lo Studio li modifica
   nel database, ma il repository resta la loro fonte finché non si decide di passare al solo database. Un territorio
   creato nello Studio vive solo nel database; con `guide-pack db-export` se ne ottiene comunque una copia in file.

## Regole scelte

- Crea un territorio chi può modificarlo: amministratore e redazione ovunque; un editor solo dentro il proprio ambito
  (`it.liguria.*` se l'ambito è `it.liguria`). Gli esperti verificano, non creano territori.
- L'organizzazione del nuovo territorio è quella del ruolo che lo autorizza (l'amministratore può sceglierla).
- Stati: bozza → in revisione → pubblicato (approvato); dalla revisione si torna in bozza; un pubblicato si può
  ritirare. Pubblica chi ha il permesso di pubblicazione, solo se il controllo di pubblicazione è superato.
- Un territorio senza contenuti si può creare e lasciare in bozza, ma non si manda in pubblicazione.
- Le regioni (e le aree) sono contenitori: non hanno stato né copertina e non arrivano all'app da sole; arrivano le
  destinazioni che dipendono da loro, con i loro nodi e affermazioni.
- Un territorio di prova (`fictional`) resta di prova: lo è chi dipende da un territorio fittizio, e non si pubblica.

## Implementazione (2026-10-11)

Migrazione `supabase/migrations/20261018000000_studio_territories.sql` (con revoca in `supabase/rollback/`). Nessuna
tabella nuova: usa `packs`, `pack_dependencies`, `destinations`, `nodes`, `assertions`, `narrative_units`, `routes`,
`media_assets`, `publications`.

- **Creazione** (`/studio/nuovo`, `studio_create_pack`): identificativo (proposto dal nome, poi immutabile e
  rifiutato se non valido, mai «corretto» in silenzio), tipo (regione, area, destinazione), nome e descrizione it/en,
  lingua principale e lingue supportate (tra quelle abilitate), stadio, «fa parte di». Il permesso si controlla sul
  nuovo identificativo con `can_edit_pack`, quindi con lo stesso ambito gerarchico dei ruoli; una dipendenza che
  l'utente non vede è «fuori dai tuoi permessi», mai «non trovata»; i cicli sono rifiutati. Una destinazione nasce in
  bozza.
- **Metadati** (`/studio/<id>/panoramica`, `studio_update_pack`): nome, descrizione, lingue, stadio (`production` solo
  con il permesso di pubblicazione), dipendenze (salvando non si tolgono quelle che l'utente non vede), copertina
  scelta tra le foto del territorio.
- **Stati** (`studio_set_pack_status`): bozza → in revisione → pubblicato; ritorno in bozza; ritiro. Pubblicare
  richiede il permesso di pubblicazione, nessun blocco nel database (`studio_publish_blockers`: nome, fittizio, almeno
  un luogo, almeno un racconto raccontabile nella lingua principale) e il controllo completo superato: lo Studio
  rilegge il territorio e le sue dipendenze, li valida con lo stesso validatore dei file e compila i bundle per ogni
  lingua. La pubblicazione scrive una riga in `publications` (stato `requested`) con il rapporto.
- **Contenuti** nel nuovo territorio: luoghi (con metodo delle coordinate e geofence di arrivo), fonti, affermazioni
  (con fonte esplicita), racconti (legati alle affermazioni), percorsi, foto e copertina.
- **La PWA non cambia**: legge solo i bundle compilati da `territories/`. Bozze, revisioni e anche i territori
  «pubblicati» nello Studio non vi compaiono finché la pipeline della milestone 5 non compila i bundle da Storage.

Prove: `supabase/tests/30_territories.sql` (ruoli, ambiti, identificativi, dipendenze e cicli, stati, blocchi,
contenuti, copertina, dipendenza nascosta conservata, Portovenere identico prima e dopo) in `npm run db:check`;
`apps/guide/test/readiness.test.ts`; prova end-to-end nel browser su stack locale (23 controlli): una regione di
prova, una destinazione al suo interno, luogo, fonte, affermazione, racconti, percorso, foto e copertina, controllo
superato (bundle it ed en), revisione e pubblicazione, indice della PWA invariato, editor di un altro ambito
respinto, Liguria e Portovenere invariati.

## Eliminazione (2026-10-11)

Migrazione `supabase/migrations/20261019000000_studio_delete.sql` (revoca in `supabase/rollback/`). Ogni elemento
(territorio, luogo, percorso, fonte, affermazione, racconto, foto) ha «Elimina…», che apre una pagina di conferma
(`/studio/<id>/elimina`) con il piano calcolato dal database (`studio_delete_plan`):

- **Cosa sparisce insieme**: un luogo porta con sé i racconti ambientati lì, le affermazioni su di lui e le foto che
  raffigurano solo lui (le foto con altri luoghi restano); un territorio, tutto il suo contenuto.
- **Cosa lo impedisce**: nessun riferimento rotto. Un luogo che è tappa di un percorso, contiene altri luoghi o è
  citato da racconti e affermazioni di altri; una fonte usata come prova; un'affermazione usata da un racconto; un
  territorio che contiene altri territori, è pubblicato o ha prodotti a pagamento. Il piano dice cosa sistemare prima.
- **Chi**: chi modifica il territorio; un'affermazione verificata la elimina un esperto o la redazione; un contenuto
  pubblicato, chi pubblica; un territorio intero solo l'amministratore, riscrivendo l'identificativo per conferma.
- **Copia di sicurezza**: prima di ogni eliminazione il territorio com'era viene salvato per intero in
  `content_revisions` (`table_name = 'pack_snapshot'`, formato di `import_pack`; per un territorio eliminato anche i
  ruoli limitati a quel territorio). Il test riporta un territorio eliminato identico con `import_pack`.
- **File**: lo Studio toglie dal bucket `media` i file rimasti senza foto (mai quelli ancora usati da un'altra foto, mai
  fuori dalla cartella del territorio), con la sessione dell'utente.
- **App**: non cambia. I territori dei file (`territories/`) restano nei file; i territori fittizi di prova non sono più
  compilati nell'app pubblicata (si includono solo con `GUIDE_INCLUDE_FICTIONAL=true`).

Prove: `supabase/tests/40_delete.sql` in `npm run db:check`; prova nel browser su stack locale (17 controlli).
