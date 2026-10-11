# Piattaforma: CMS, account, pubblicazione e predisposizione premium

Stato: **milestone 1 completata** (modello dati, permessi e test sul database). Data: 2026-10-10.
Documento di riferimento generale: `docs/v0.2-product-strategy/PRODUCT-STRATEGY-AND-ARCHITECTURE.md` (sezioni J, M, N).

---

## 1. Stato attuale (audit del repository)

| Area | Com'è oggi | Note |
|---|---|---|
| Framework | monorepo npm + turbo; app Next.js 16 (`apps/guide`), pacchetti TypeScript (`packages/*`) | una sola pagina (`/`) e una API (`/api/guide/ask`) |
| Contenuti | **Territory Pack** in YAML (`territories/<id>/`): `pack.yaml`, `config.yaml`, `geography/places.yaml`, `knowledge/{sources,assertions,nodes}.yaml`, `narrative/{units,routes}.yaml`, `media/media.yaml` + file | validati da `guide-pack validate` (schemi zod in `packages/domain`) |
| Distribuzione all'app | al build `scripts/build-bundles.ts` compila un **bundle per lingua** in `public/bundles/` con indice, manifest e hash; l'app legge solo i bundle | ogni modifica ai contenuti oggi richiede un nuovo deploy |
| Database | **schema Supabase già scritto** (`supabase/migrations/`, Postgres + PostGIS + RLS): grafo dei nodi, affermazioni con tipo, certezza, stato e prove, fonti, controversie, luoghi, geofence, unità narrative, percorsi, media con licenza, ruoli × territorio, changeset, destinazioni e bundle | **mai collegato a un progetto**: nessuna variabile, nessun client nel codice |
| Autenticazione | nessuna | nessun account, nessuna sessione |
| Offline | service worker (`public/sw.js`) + `lib/offline.ts`: pagina, bundle e immagini in cache; video esclusi | la guida AI e la ricerca web richiedono rete |
| Servizi esterni | Vercel (hosting), Anthropic (domande alla guida, ricerca web), OpenStreetMap (sfondo mappa, solo prove) | |
| Segreti | solo `ANTHROPIC_API_KEY`, lato server, su Vercel (Production) | `.env*` ignorati da git, salvo `.env.example` |
| Vincoli della guida AI | `/api/guide/ask` legge **il bundle compilato** (non il database) e controlla citazioni e numeri sulle affermazioni del bundle | la pubblicazione deve continuare a produrre bundle |

**Conclusione**: non serve un secondo database né un nuovo servizio di contenuti. Lo schema esistente è già
progettato per Supabase (riferimenti a `auth.users`, `auth.uid()`, RLS) e copre gran parte del CMS; mancavano
utenti, scrittura per territorio, storico, pubblicazione, audio e predisposizione premium.

## 2. Scelte

| Esigenza | Scelta | Motivo |
|---|---|---|
| Database | **Supabase Postgres** (lo schema esistente) | relazionale, PostGIS per le coordinate, RLS per i permessi per riga, già progettato |
| Autenticazione | **Supabase Auth** (email e password, conferma email, recupero password; in seguito accesso con Apple/Google) | stesso servizio: `auth.uid()` usato direttamente dalle policy; sessione gestita con cookie lato server in Next.js |
| File (foto, video, audio) | **Supabase Storage**: bucket `media` privato (originali, percorso `<pack_id>/<file>`), bucket `bundles` pubblico (letto dall'app) | policy sugli oggetti con gli stessi permessi del database; nel database solo metadati e riferimenti |
| Distribuzione all'app | invariata: **bundle statici** (CDN), ora generati dal database alla pubblicazione | l'app e la guida AI non cambiano; nessun deploy del frontend per pubblicare |
| CMS | **sezione privata `/studio` nella stessa app Next.js** | riusa componenti, schemi e validatore; protetta lato server (sessione + ruolo), mai solo nascondendo pulsanti |

**Costi da segnalare**: Supabase ha un piano gratuito (limiti di database, storage e utenti, progetti in pausa
dopo inattività) e un piano a pagamento per la produzione (prezzo da verificare sul sito del fornitore al momento
dell'attivazione). Nessun servizio è stato attivato: serve la tua decisione e il tuo account.

## 3. Flusso dei contenuti

```
CMS (/studio) ──scrive──▶ Supabase (bozze, revisioni, storico)
                              │  «Pubblica» (editor del territorio)
                              ▼
                     export DB → formato Territory Pack
                              │  guide-pack validate (stesse regole di oggi)
                              ▼
                     buildBundle (stesso compilatore) ──▶ Storage «bundles» (CDN) ──▶ app
```

- Il validatore e il compilatore restano **l'unica porta d'ingresso** verso l'app: un contenuto pubblicato dal CMS
  passa dagli stessi controlli dei Territory Pack (affermazioni verificate, coordinate, licenze dei media).
- Il CMS **non trasforma mai** un'affermazione non verificata in un fatto: lo impongono i trigger del database
  (vedi §5), non l'interfaccia.
- I Territory Pack restano finché non è dimostrata la parità: import pack → database, export database → pack,
  confronto dei bundle (stesso `kbHash` e stesso contenuto). Solo dopo il database diventa la fonte di verità.

## 4. Modello dei dati: corrispondenza con i Territory Pack

| Territory Pack | Database | Aggiunte di questa milestone |
|---|---|---|
| `pack.yaml` (id, nomi, lingue, stadio) | `packs` | `locales`, `title`, `description` |
| destinazione | `destinations` | `slug`, `cover_media_id`, `published_at/by` |
| `places.yaml` (coordinate, stato, raggi, info pratiche) | `nodes` + `node_labels` + `places` + `geofences` | — |
| `nodes.yaml` (persone, temi) | `nodes` + `node_labels` | — |
| `sources.yaml` | `sources` | — |
| `assertions.yaml` (tipo: fatto, interpretazione, ipotesi, tradizione, leggenda, controversia; certezza; stato) | `assertions` + `assertion_texts` + `evidence` + `disputes` | regole sugli stati (§5) |
| `units.yaml` | `narrative_units` + `unit_assertions` + … | `access_tier` |
| `routes.yaml` | `routes` + `route_stops` + `route_sources` | `access_tier` |
| `media.yaml` + file | `media_assets` + `media_subjects` + `media_labels` + Storage | audio, formato, dimensioni, stato del caricamento |
| — | `content_revisions` | storico di ogni modifica |
| — | `publications` | richieste ed esiti di pubblicazione |
| — | `profiles`, `favorites`, `route_progress`, `consents` | visitatori |
| — | `products`, `entitlements`, `purchases` | premium, senza prezzi |

Distinzione fatto / tradizione / leggenda / ipotesi: è già nel tipo `assertion_type`, allineato a
`packages/domain/src/vocabulary.ts` da un test. Gli stati: `draft` → `in_review` → `verified` per le affermazioni;
`draft` → `in_review` → `published` → `archived` per unità, percorsi, nodi e destinazioni.

## 5. Ruoli e sicurezza (applicati dal database)

| Ruolo | Può |
|---|---|
| `platform_admin` | tutto; assegna i ruoli; gestisce prodotti e diritti di accesso |
| `platform_editor` | modifica, verifica e pubblica in ogni territorio |
| `territory_editor` | modifica e pubblica **solo nei territori assegnati** (e nei loro sotto-territori) |
| `expert` | verifica le affermazioni nei territori assegnati |
| `institution`, `contributor`, `translator` | leggono i contenuti del territorio; propongono modifiche (changeset) |
| visitatore (qualunque account) | solo i propri profilo, preferiti, avanzamenti, consensi, diritti, acquisti |
| anonimo | nulla nel database; legge solo i bundle pubblici |

Regole imposte da policy RLS e trigger (provate in `supabase/tests/10_platform_security.sql`):

- un'affermazione creata dal CMS nasce in bozza o in revisione; l'autore è l'utente reale, non quello dichiarato;
- solo esperti e redazione la portano a `verified`; **mai l'autore** (regola dei quattro occhi);
- modificare un fatto verificato lo riporta in revisione; un'unità narrativa si pubblica solo se tutte le sue
  affermazioni sono verificate;
- pubblicare o ritirare richiede il permesso di pubblicazione sul territorio;
- file: un editor carica solo sotto `media/<suo territorio>/`; i bundle li scrive solo il servizio di pubblicazione;
- formati e dimensioni dei media: immagini jpeg/png/webp ≤ 15 MB, video mp4/webm ≤ 200 MB, audio mp3/m4a/aac/ogg/wav ≤ 50 MB;
- nessuno si concede un diritto di accesso; l'accesso a un percorso premium si verifica con `can_access_route()` lato server;
- cancellazione dell'account (`delete_my_account()`) ed esportazione dei propri dati (`export_my_data()`).

## 6. Account dei visitatori

- **Facoltativo**: esplorazione, percorsi, racconti e mappa funzionano senza account, come oggi.
- L'account aggiunge: lingua e preferenze di ascolto sincronizzate, preferiti, avanzamento dei percorsi su più dispositivi.
- **Sul server**: profilo, preferenze, preferiti, avanzamenti (solo luoghi raggiunti, mai coordinate GPS), consensi, diritti.
- **Solo sul dispositivo**: posizione GPS, visita in corso, bundle e media scaricati per l'offline, cronologia delle domande.
- I download offline sono separati dal profilo: si gestiscono dal dispositivo e non si sincronizzano.

## 7. Offline e sincronizzazione

- I contenuti continuano ad arrivare come bundle immutabili (hash nel nome): già scaricati, restano disponibili
  senza rete; quando c'è rete l'indice (prima la rete, poi la cache) segnala la versione nuova e l'app la scarica.
- Preferiti e avanzamenti: scritti prima sul dispositivo, poi inviati quando c'è rete (vince il dato più recente).
- Senza rete non funzionano: domande all'AI, ricerca web, login, sfondo della mappa. Il GPS funziona se il
  dispositivo lo fornisce, indipendentemente dalla rete.

## 8. Premium, senza pagamenti

Solo la struttura: `access_tier` (`free` | `premium`) su percorsi e unità narrative; `products` (che cosa si sblocca,
nessun prezzo); `entitlements` (chi ha diritto a cosa, da quando, fino a quando, perché); `purchases` (acquisti presso
un fornitore futuro, con riferimento univoco per la riconciliazione; nessun dato di pagamento). Nessun prezzo, piano o
regola commerciale è stato definito. Il bundle di un contenuto premium non andrà mai sulla CDN pubblica: andrà servito
da un'API che verifica il diritto lato server (milestone 7).

## 9. Milestone

| # | Milestone | Stato |
|---|---|---|
| 1 | Audit, architettura, modello dati, migrazioni, permessi, test sul database | **fatto** (questo documento, `supabase/migrations/20261013500000_*`, `20261014000000_*`, `supabase/tests/`, `supabase/rollback/`) |
| 2 | Progetto Supabase (tuo account) e collegamento: migrazioni applicate a un progetto di prova, verifica sul progetto reale (`supabase/tests/remote-check.sql`), poi variabili d'ambiente solo in Preview | in corso: progetto creato, migrazioni applicate, verifica `superato` sul progetto reale (2026-10-11) dopo la correzione di 9 tabelle senza RLS (`20261015000000_rls_remaining_tables.sql`); restano il primo amministratore e le variabili in Preview |
| 3 | Import pack → database e export database → pack, con prova di parità sui bundle | |
| 4 | Studio minimo: accesso staff, territori, luoghi, percorsi (riordino delle tappe), media library, revisione delle affermazioni | |
| 5 | Pubblicazione: richiesta → validazione → compilazione → bundle su Storage → indice; app che legge l'indice da Storage | |
| 6 | Account visitatori nella PWA: registrazione, conferma, recupero password, profilo, preferiti, avanzamenti, cancellazione | |
| 7 | Premium: API che serve i contenuti premium dopo `can_access_route()`; integrazione del fornitore di pagamenti in una fase successiva | |

## 10. Variabili d'ambiente (segnaposto, nessun valore reale)

| Variabile | Dove | Uso |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client e server | indirizzo del progetto (pubblico) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client e server | chiave pubblica: tutto passa dalle policy RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | **solo server** (pubblicazione, webhook futuri) | ignora le RLS: mai nel client, mai nei log |
| `ANTHROPIC_API_KEY` | solo server | invariata |

Vedi `apps/guide/.env.example`.

## 11. Come si prova

```bash
npm run db:check   # Postgres 16 + PostGIS locali: applica le migrazioni, i test di sicurezza, la revoca e la riapplicazione
```
Il test usa un piccolo strato che imita Supabase (`supabase/tests/00_supabase_stub.sql`: `auth.users`, `auth.uid()`,
ruoli `anon`/`authenticated`/`service_role`, `storage.objects`). Non sostituisce la prova su un progetto Supabase reale:
per quella c'è `supabase/tests/remote-check.sql`, da incollare nel SQL Editor del progetto. Esegue gli stessi controlli
(più: PostGIS, bucket, nessuna tabella di `public` senza RLS, scritture anonime rifiutate) e alla fine annulla tutti i
dati di prova; risponde con una riga `superato` oppure con un errore `FALLITO: …`. `db:check` lo esegue anche in locale.
