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
