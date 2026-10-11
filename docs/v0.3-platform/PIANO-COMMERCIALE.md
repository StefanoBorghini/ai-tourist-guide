# AI Tourist Guide — Piano tecnico: account, catalogo commerciale, Stripe, diritti e contenuti protetti

Data: 2026-10-11 · Stato: **proposta da approvare. Nessuna implementazione.**
Integra due richieste: «Catalogo commerciale CMS e integrazione Stripe» e «Specifica account, autenticazione e acquisti».
Prerequisito: l'hardening del CMS (`CMS-SECURITY-HARDENING.md`) applicato e verificato su Supabase Preview.

**Regole che il piano rispetta:**
- marchio unico «AI Tourist Guide»;
- download e anteprima gratuiti, senza account;
- account obbligatorio solo per acquistare;
- ogni destinazione si compra separatamente;
- un percorso non sblocca altri percorsi, salvo quelli inclusi in un pacchetto acquistato;
- niente abbonamenti B2B e niente monetizzazione delle domande AI in questa fase.

---

## 1. Stato attuale (verificato nel repository)

| Componente | Stato | Dove |
|---|---|---|
| Stripe | **Assente**: nessuna dipendenza, variabile, route o tabella | — |
| Account visitatori nella PWA | **Assenti**: nessuna registrazione, login o profilo nell'app | `apps/guide` (lo Studio ha solo l'accesso dello staff) |
| Supabase Auth | In uso solo per lo Studio: email e password, cookie `@supabase/ssr`, `proxy.ts` solo su `/studio` | `lib/studio/server.ts` |
| Profilo, consensi, cancellazione, esportazione dati | **Presenti nel DB, non usati**: `profiles` (creato da `handle_new_user`), `consents`, `delete_my_account()`, `export_my_data()`, policy «solo i propri» | `20261014000000_platform_accounts_cms.sql` §8 e §10 |
| Catalogo | **Predisposto, non usato**: `products` (`pack_access`, `route_access`, `feature`; stato `draft`/`active`/`retired`; **nessun prezzo**) | stesso file, §9 |
| Ordini | **Predisposti**: `purchases` (`provider`, `provider_ref` unico, stato `pending`/`completed`/`refunded`/`failed`/`disputed`, `raw`); **nessun importo né valuta** | §9 |
| Diritti | **Predisposti**: `entitlements` (utente, prodotto, origine, acquisto, stato, validità), `has_entitlement()`, `can_access_route()` | §9 |
| Livello di accesso | `routes.access_tier` e `narrative_units.access_tier` (`free`/`premium`) **solo nel database**: non sono nel formato dei Territory Pack, non passano da `import_pack`/`pack_snapshot` e **i bundle includono tutto** | `build.ts` non li considera |
| Distribuzione dei contenuti | Bundle **pubblici**: file dei repository e bucket `bundles` letto da `/pub/`, scaricabili da chiunque | `PUBBLICAZIONE.md` |

**Cosa ne consegue:**
- `can_access_route()` oggi concede tutti i percorsi di una destinazione a chi ha `pack_access`. È in contrasto con la regola «l'esplorazione non sblocca i percorsi premium».
- **Oggi nessun contenuto è protetto.** Un contenuto premium messo in un bundle attuale è scaricabile gratis.

## 2. Schema dati proposto (riuso prima di tutto)

Tutti gli importi sono interi in **centesimi** (`integer`, mai `numeric` o `float`). La valuta è un codice ISO 4217 (`'EUR'`).

### Tabelle riusate ed estese

| Tabella | Modifica | Perché |
|---|---|---|
| `products` | `kind` ammette `explore` (esplorazione di una destinazione), `route` (un percorso), `bundle` (pacchetto di percorsi). `pack_id` sempre valorizzato (la destinazione del prodotto). Si aggiungono `availability` (`available`/`hidden`/`sold_out`) e `sort_order`. `pack_access` e `route_access` restano finché non sono migrati | Un prodotto appartiene sempre a una destinazione: niente acquisti «trasversali» |
| `purchases` → **ordine** | Nuove colonne: `unit_amount`, `amount_total`, `currency`, `price_id`, `product_snapshot jsonb` (nome, tipo, destinazione, percorsi inclusi al momento dell'acquisto), `stripe_checkout_session_id` (unico), `stripe_payment_intent_id`, `stripe_customer_id`, `stripe_refund_ids text[]`, `paid_at`, `refunded_at`. Stati espliciti: `pending`, `paid`, `failed`, `expired`, `canceled`, `refunded`, `partially_refunded`, `disputed`. `user_id` **obbligatorio** al momento dell'ordine (`set null` solo dopo la cancellazione dell'account, per gli obblighi fiscali) | Il prezzo dell'ordine è una **copia**: le modifiche del catalogo non toccano gli ordini passati |
| `entitlements` | Nuove colonne: `pack_id`, `route_id`, `scope` (`explore` / `route`). Un diritto per ogni cosa sbloccata, creato dal webhook a partire dalla copia nell'ordine. Il prodotto resta per la tracciabilità | Se un pacchetto cambia composizione, chi l'ha comprato conserva esattamente ciò che ha pagato |
| `routes.access_tier`, `narrative_units.access_tier` | Entrano nel formato dei Territory Pack, nell'import/export e nella pipeline | Senza questo la protezione non può funzionare |

### Tabelle nuove (solo dove non esiste un'entità adatta)

| Tabella | Contenuto |
|---|---|
| `product_routes (product_id, route_id)` | Percorsi inclusi in un pacchetto. Stesso territorio del prodotto, imposto da un trigger |
| `product_prices` | `id`, `product_id`, `currency`, `unit_amount`, `status` (`draft`/`published`/`archived`), `published_at`, `published_by`, `stripe_price_id` (facoltativo). Al massimo **un prezzo pubblicato** per prodotto e valuta (indice unico parziale). Lo storico resta |
| `payment_events` | `stripe_event_id` (unico), `type`, `purchase_id`, `received_at`, `processed_at`, `status`, `error`. Serve all'**idempotenza** dei webhook e alla diagnosi. Niente dati delle carte |

### Funzioni

| Funzione | Cosa fa | Chi la chiama |
|---|---|---|
| `public_catalog(pack)` | Prezzi **pubblicati** e prodotti attivi di una destinazione | Anonimi: l'app mostra i prezzi senza ripubblicare il territorio |
| `checkout_quote(product)` | Prezzo pubblicato attuale, prodotto attivo, destinazione pubblicata, già posseduto | Server |
| `grant_purchase(purchase)` / `revoke_purchase(purchase, motivo)` | Concessione e revoca dei diritti | Solo `service_role` |
| `can_access(pack, route)` | Accesso dell'utente corrente | Sostituisce `can_access_route()` con la semantica nuova |
| `my_purchases()` | Ordini e diritti dell'utente, per «I miei acquisti» | Utente |

**RLS:**
- ogni utente legge **solo** i propri ordini e diritti;
- nessuna scrittura diretta per `authenticated`: ordini, diritti ed eventi li scrive solo il server, con `service_role`;
- prezzi e prodotti li scrivono gli amministratori della piattaforma. Gli editor delle organizzazioni clienti non toccano i prezzi in questa fase (decisione D9).

## 3. Modifiche al CMS (Studio)

Nuova scheda **«Catalogo»** per ogni destinazione, visibile solo all'amministratore della piattaforma:

- **Esplorazione libera:** prezzo in bozza e prezzo pubblicato. Il prezzo iniziale proposto è 99 centesimi, EUR.
- **Percorsi:** per ogni percorso, gratuito o premium. Per un percorso premium: prodotto, prezzo in bozza e pubblicato, stato attivo/inattivo, disponibilità.
- **Pacchetti:**
  - nome it/en;
  - percorsi inclusi (solo della stessa destinazione);
  - prezzo, stato, disponibilità.
- **«Pubblica i prezzi»:**
  - porta le bozze a `published` e archivia il prezzo precedente;
  - nessun deploy, nessuna ripubblicazione del territorio;
  - l'app legge `public_catalog()`.
- **Per ogni prodotto si vedono:** prezzo pubblicato, prezzo in bozza, numero di ordini pagati (senza dati personali), ultima modifica.

**Regole:**
- importo inserito in euro con due decimali e convertito in centesimi **sul server**, con controllo dei limiti (per esempio da 0,50 € a 999 €);
- nessuna modifica agli ordini esistenti;
- un prodotto con ordini non si elimina, si ritira.

## 4. Ordini, Stripe e diritti

### Flusso di acquisto

1. **Anteprima gratuita, senza account.** Al tocco su «Sblocca», se l'utente non è autenticato si apre registrazione o accesso.
2. **`POST /api/checkout { productId }`** (route del server):
   1. verifica dell'utente con `getUser()` sul server Auth;
   2. `checkout_quote()`: prodotto attivo e disponibile, prezzo **pubblicato** letto dal DB, destinazione pubblicata, non già posseduto;
   3. creazione dell'ordine `pending` con la copia di prezzo e prodotto;
   4. creazione della **Checkout Session** con `price_data` dall'importo del DB, `client_reference_id` = id dell'ordine, `metadata` {order, user}, `customer_email` precompilata ma non usata per collegare, chiave di idempotenza = id dell'ordine;
   5. risposta: solo l'URL di Stripe.

   Il browser invia **solo** `productId`. Prezzo, utente e importo non vengono mai accettati dal client.
3. **Ritorno dal checkout** (`/acquisto?ordine=…`):
   - mostra lo stato **letto dal DB**: «in attesa di conferma», «pagato», «non riuscito»;
   - **non concede nulla.** L'accesso arriva solo dal webhook.
4. **`POST /api/stripe/webhook`:**
   1. verifica della firma con il corpo grezzo e `STRIPE_WEBHOOK_SECRET`; firma non valida → 400, nessun effetto;
   2. inserimento in `payment_events` con `stripe_event_id` unico: se l'evento c'è già → 200 senza ripetere nulla (**idempotenza**);
   3. stato rileggo da Stripe (`sessions.retrieve`) prima di decidere: gli eventi possono arrivare **fuori ordine**;
   4. **macchina a stati monotona.** Esempio: un `failed` arrivato dopo un `paid` non annulla il pagamento.

| Evento Stripe | Effetto |
|---|---|
| `checkout.session.completed` con `payment_status = paid`, oppure `checkout.session.async_payment_succeeded` | Ordine `paid`, `grant_purchase()` |
| `checkout.session.async_payment_failed` | `failed` |
| `checkout.session.expired` | `expired` |
| `charge.refunded` | `refunded` o `partially_refunded`; revoca secondo la policy (D2) |
| `charge.dispute.created` | `disputed`, diritti sospesi |
| `charge.dispute.closed` | Ripristino o revoca |

5. **Riconciliazione e assistenza.** Nell'ordine sono registrati gli id di Checkout Session, PaymentIntent, cliente e rimborsi. Un comando di riconciliazione confronta gli ordini `pending` vecchi con Stripe.

**Cosa non si memorizza mai:** dati delle carte (li vede solo Stripe). La chiave segreta Stripe esiste solo sul server Vercel; la PWA non riceve chiavi Stripe.

### Diritti

| Acquisto | Diritti creati |
|---|---|
| `explore` | `scope = explore` sulla sola destinazione del prodotto. Non sblocca altre destinazioni né i percorsi premium (D1) |
| `route` | Un diritto `scope = route` su quel percorso |
| `bundle` | Un diritto `route` per ogni percorso nella copia dell'ordine. Nient'altro |

- **Recupero su un nuovo dispositivo:** i diritti sono legati all'**ID utente Supabase**, non all'email. Dopo il login, «I miei acquisti» e i contenuti si ripristinano. Un prodotto già posseduto non si può ricomprare: il server lo blocca.
- **Rimborsi** (D2): un rimborso totale revoca i diritti dell'ordine; il rimborso parziale e le contestazioni seguono la regola che deciderai.

## 5. Account e autenticazione nella PWA

Supabase Auth, lo stesso progetto dello Studio.

**Metodi:**
- email e password, con **verifica dell'email** obbligatoria («Confirm email»);
- Google OAuth;
- Sign in with Apple.

**Flusso:**
- PKCE e route `/auth/callback`, che scambia il codice e gestisce gli errori con messaggi chiari: annullato, email già usata con un altro metodo, link scaduto;
- recupero password con `resetPasswordForEmail` e pagina `/auth/reimposta`;
- logout locale e su tutti i dispositivi.

**Sessioni nella PWA:**
- cookie `@supabase/ssr` per il server e client nel browser;
- il service worker **non** mette in cache le pagine di account e acquisto né le API (come già per `/studio`).

**Account collegati** (requisito: niente unione automatica solo per email):
- Supabase **collega automaticamente** un'identità OAuth a un utente esistente con la stessa email **verificata**. È un comportamento della piattaforma da verificare e configurare in fase di implementazione: non lo do per scontato (D5).
- **Proposta:**
  - collegamento **manuale ed esplicito** dalla pagina profilo (`linkIdentity`), con l'utente già autenticato;
  - in caso di email già registrata con un altro metodo, messaggio «accedi con il metodo usato prima, poi collega questo dal profilo».
- **Con Apple e «Nascondi la mia email»** l'email è un relay: il collegamento è solo manuale.

**Profilo e account:**
- dati del profilo, metodi di accesso collegati, «I miei acquisti», esportazione dei dati (`export_my_data`);
- **cancellazione dell'account** (`delete_my_account`, con conferma):
  - diritti eliminati;
  - ordini conservati **senza** collegamento all'utente, per gli obblighi fiscali (D8);
  - informativa che spiega cosa si perde.

**Separazione dei ruoli:**
- un visitatore non ha `memberships` e quindi non entra nello Studio;
- lo staff che usa la PWA è un visitatore come gli altri: nessun diritto d'acquisto deriva dai ruoli editoriali, a meno di una concessione esplicita (`source = grant`).

**Privacy:**
- informativa per registrazione, acquisti e accesso social;
- consensi registrati in `consents`;
- minimizzazione dei dati: nome facoltativo, nessun dato di pagamento.

## 6. Protezione dei contenuti premium e uso offline

**Principio:** un contenuto è «protetto» solo se non è in nessun file pubblico.

1. **La pipeline di pubblicazione produce due insiemi:**
   - **bundle pubblico:** anteprima, luoghi, mappa, percorsi gratuiti, racconti `free`. Resta scaricabile da chiunque e funziona offline senza account;
   - **pacchetti protetti per diritto:**
     - `premium/<destinazione>/<lingua>/explore.<hash>.json`: i racconti dell'esplorazione completa;
     - `premium/<destinazione>/<lingua>/route-<slug>.<hash>.json`: un percorso premium con i suoi racconti.

     Stanno in un bucket **privato** `premium`.
2. **Lettura** con la sessione dell'utente: una policy di Storage su `premium` consente la lettura solo se `can_access(…)` è vero per quel file. Non serve una chiave di servizio. L'app chiede un indirizzo firmato di pochi minuti, scarica e verifica con l'hash.
3. **Licenza offline:**
   - il server emette una licenza firmata con: utente, diritti, scadenza (proposta 30 giorni, D3);
   - l'app conserva contenuto e licenza;
   - offline, il contenuto si usa finché la licenza è valida;
   - online, la licenza si rinnova. Se il diritto è stato revocato (rimborso), l'app cancella la copia locale.
4. **Limiti dichiarati: non è DRM.** Chi ha già scaricato un contenuto può estrarlo dal proprio dispositivo. Una revoca ha effetto alla prima connessione o alla scadenza della licenza. La protezione impedisce l'accesso a chi non ha comprato, non la copia da parte di chi ha comprato.
5. **Domande AI:** il server delle domande usa solo il bundle pubblico, e le parti premium solo se l'utente ha il diritto. Altrimenti le risposte rivelerebbero il contenuto a pagamento (D10).

## 7. Migrazioni e rollback

| # | Migrazione | Contenuto | Revoca |
|---|---|---|---|
| 1 | `…_catalog.sql` | Estensioni di `products`, `product_prices`, `product_routes`, `public_catalog()`, policy | Elimina le tabelle nuove (vuote prima del lancio) e ripristina i vincoli |
| 2 | `…_orders.sql` | Estensioni di `purchases` ed `entitlements`, `payment_events`, `grant_purchase`, `revoke_purchase`, `can_access`, `my_purchases` | Elimina funzioni e colonne nuove; `can_access_route` torna come prima |
| 3 | `…_premium_storage.sql` | Bucket privato `premium` e policy di lettura per diritto | Elimina policy e bucket (vuoto) |
| 4 | Formato dei pack | `accessTier` in `routes.yaml` e `units.yaml` (zod), `import_pack`/`pack_snapshot`, pipeline divisa in pubblico + protetto, test di parità | Il campo è facoltativo: i pack esistenti restano validi e tutti «free» |

Ogni migrazione ha il suo `*.down.sql`, è provata da `npm run db:check` (applicazione, revoca, riapplicazione) e viene applicata al remoto solo con la tua autorizzazione, prima in Preview.

**Compatibilità:**
- Portovenere resta tutto gratuito finché non configuri prodotti e prezzi;
- i bundle e la pubblicazione restano come oggi per i territori senza contenuti premium.

## 8. Test e criteri di accettazione

| Area | Test | Ambiente |
|---|---|---|
| Account | Anteprima senza account; acquisto bloccato senza login; registrazione email con verifica; login e logout; recupero password; Google e Apple (successo, annullamento, errore, callback con codice non valido) | E2E con Auth simulato + verifica manuale in Preview (Google e Apple richiedono configurazione reale) |
| Prezzi | Prezzo o prodotto alterati dal browser (il server usa solo `productId`); prodotto inattivo, nascosto o esaurito; prodotto di un'altra destinazione; prezzo in bozza non usato; ordine con copia del prezzo invariata dopo una modifica del catalogo | Unità + DB + E2E |
| Webhook | Firma non valida (nessun effetto); evento duplicato (un solo diritto); fuori ordine (`failed` dopo `paid`); pagamento fallito; sessione scaduta; rimborso totale e parziale; contestazione | Unità con eventi firmati dalla libreria Stripe in modalità test; Stripe CLI in Preview |
| Diritti | Destinazione A non sblocca B; percorso X non sblocca Y; pacchetto: solo i percorsi inclusi; ripristino su un secondo dispositivo (nuovo login); utente A non vede ordini e diritti di B; nessuna scrittura diretta di ordini, diritti o prezzi via REST | DB (RLS, due utenti) + E2E |
| Contenuti protetti | Il bundle pubblico non contiene testi premium (verifica sul file); `premium/` senza diritto → negato; con diritto → indirizzo firmato; offline con licenza valida; licenza scaduta; revoca dopo rimborso alla riconnessione | DB + E2E (offline) |
| Organizzazioni | Isolamento del catalogo e degli ordini tra organizzazioni (dopo l'hardening) | DB |

**Pagamenti:** solo Stripe in **modalità test**, con chiavi di test in locale o in Preview. Nessun pagamento reale.

## 9. Configurazione richiesta (da fare tu, quando approvato)

**Supabase (Preview):**
- Auth: «Confirm email» attivo;
- URL di redirect dell'anteprima;
- provider Google e Apple con le credenziali dei rispettivi pannelli;
- template email in italiano;
- impostazioni di collegamento delle identità (D5).

**Google Cloud:** client OAuth (tipo Web) con il callback di Supabase.

**Apple Developer:** Services ID, chiave «Sign in with Apple», dominio e redirect verificati. Serve un account Apple Developer a pagamento.

**Stripe** (modalità test), variabili solo **Server** in Vercel Preview:
- `STRIPE_SECRET_KEY`;
- `STRIPE_WEBHOOK_SECRET`;
- endpoint webhook verso l'anteprima;
- Stripe Tax o regole IVA (D4).

**Vercel Preview:** `SUPABASE_SERVICE_ROLE_KEY`, solo server, per il webhook che scrive ordini e diritti (D7).

Nomi esatti e segnaposto li fornisco al momento. **Non incollare mai i valori in chat.**

## 10. Rischi e decisioni che richiedono la tua approvazione

| # | Decisione | Proposta |
|---|---|---|
| D1 | Cosa è gratuito nell'anteprima e cosa sblocca l'esplorazione a pagamento | Anteprima: mappa, elenco dei luoghi, racconto d'apertura di alcuni luoghi, percorsi gratuiti. Esplorazione (0,99 €): tutti i racconti dei luoghi della destinazione. **Non** include i percorsi premium |
| D2 | Rimborsi e contestazioni | Rimborso totale → revoca; parziale → nessuna revoca automatica (decisione manuale); contestazione → sospensione fino all'esito |
| D3 | Durata della licenza offline | 30 giorni, rinnovata a ogni accesso online |
| D4 | IVA sui servizi digitali B2C (regime OSS), ricevute e fatture, soggetto che vende | Prezzi IVA inclusa; Stripe Tax o configurazione con il commercialista; **da decidere prima del lancio** |
| D5 | Collegamento degli account con la stessa email | Solo manuale ed esplicito; verifica del comportamento automatico di Supabase e sua configurazione |
| D6 | **App store** (Capacitor, fase successiva) | Apple e Google richiedono il loro sistema di pagamento per i contenuti digitali dentro le app native. Il modello Stripe vale per la PWA sul web; per le app native servirà una decisione dedicata |
| D7 | Chiave di servizio Supabase sul server Vercel | Necessaria al webhook (nessun utente nella richiesta). Solo server, solo Preview prima |
| D8 | Conservazione degli ordini dopo la cancellazione dell'account | Conservati per gli obblighi fiscali senza collegamento all'utente; periodo indicato dal commercialista |
| D9 | Chi gestisce i prezzi | Solo l'amministratore della piattaforma in questa fase; le organizzazioni clienti più avanti, con il B2B |
| D10 | Domande AI sui contenuti premium | Solo con il diritto; altrimenti la base di conoscenza è quella pubblica |
| D11 | Contenuti cambiati dopo l'acquisto (percorso eliminato, territorio ritirato) | Il diritto resta; se il contenuto non esiste più, rimborso su richiesta; mai eliminare un percorso venduto senza ritirarlo prima dal catalogo |
| D12 | Valute | Solo EUR all'inizio |

**Rischi principali:**
1. **Contenuti premium oggi non protetti.** Finché il formato dei pack e la pipeline non distinguono `free`/`premium` (migrazione 4), nessun prezzo va attivato.
2. **Configurazione OAuth e Apple** esterna al repository: le verifiche si fanno solo in Preview.
3. **IVA e app store:** non sono questioni tecniche, ma condizionano il lancio.
4. **Hardening:** va applicato prima, perché il catalogo si appoggia ai permessi per organizzazione.

## 11. Ordine di lavoro proposto (dopo l'approvazione)

1. Applicazione dell'hardening in Preview e verifica.
2. `accessTier` nel formato dei pack e pipeline pubblico/protetto, senza prezzi: i test dimostrano che il bundle pubblico non contiene testi premium.
3. Account nella PWA: email e password, poi Google, poi Apple; profilo, «I miei acquisti» (vuoto), cancellazione.
4. Catalogo nello Studio (prezzi in bozza e pubblicati) e `public_catalog()`.
5. Checkout, webhook e diritti in modalità test; licenza offline; collaudo in Preview con le carte di test di Stripe.
