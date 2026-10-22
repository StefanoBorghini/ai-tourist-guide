# Catalogo e prezzi nello Studio (2026-10-14)

Passo 4 del piano (`PIANO-COMMERCIALE.md` §2, §3 e §11). Cosa si vende di una destinazione e a quale prezzo, gestito
dall'amministratore della piattaforma nella scheda **Vendita** dello Studio (punto 2, «Prodotti e prezzi»; fino al 2026-10-17 era la scheda «Catalogo»); il listino pubblico lo legge chiunque con
`public_catalog()`. **Gli acquisti non ci sono ancora**: arriveranno con Stripe (passo 5).

Migrazione `supabase/migrations/20261025000000_catalog.sql`, revoca `supabase/rollback/20261025000000_catalog.down.sql`,
test `supabase/tests/95_catalog.sql` e blocco «catalogo» in `remote-check.sql`. Nessuna tabella nuova oltre a
`product_prices`, già prevista dal piano: prodotti e percorsi dei pacchetti usano `products` e `product_routes`.

## Prodotti

| Tipo | Cosa vende | Si attiva solo se |
|---|---|---|
| Esplorazione | L'esplorazione completa della destinazione (uno solo non ritirato per destinazione) | nell'Accesso l'esplorazione è a pagamento |
| Percorso | Un percorso premium (uno solo non ritirato per percorso) | il percorso è premium nell'Accesso |
| Pacchetto | Più percorsi della stessa destinazione | ha almeno un percorso e sono tutti premium |
| Luogo principale | Un luogo principale con i suoi sottoluoghi (uno solo non ritirato per luogo; migrazioni `20261028000000_place_products.sql` e `20261101000000_sub_places.sql`) | l'esplorazione è a pagamento, il luogo non è gratuito e non è un sottoluogo |

I prodotti «Luogo principale» si creano tutti insieme con **«Metti in vendita i luoghi principali»** (prezzo in bozza
proposto: 1,99 €, decisione del 2026-10-22; prima 0,50 € per ogni luogo), che ritira anche i prodotti dei luoghi diventati
sottoluoghi; poi il prezzo di ciascuno si cambia nella sua scheda. Vedi ACCESSO-CONTENUTI.md, «Luoghi principali e
sottoluoghi».

- **Stati:** bozza → in vendita → ritirato. Un prodotto ritirato non torna indietro; uno con acquisti non si elimina.
- **Disponibilità:** disponibile, nascosto (fuori dal listino), esaurito (nel listino, non acquistabile).
- Tipo, destinazione e percorso si scelgono alla creazione e poi non cambiano; nome e descrizione in italiano e inglese.
- Se l'Accesso cambia dopo l'attivazione (per esempio l'esplorazione torna gratuita), il prodotto esce dal listino
  pubblico e la scheda lo segnala come «Non vendibile»: non si vende mai qualcosa che è già gratuito.

## Prezzi

- In **centesimi di euro**, da 0,50 € a 999 €; nello Studio si scrivono come «4,99» (niente arrotondamenti nascosti).
- Si scrivono **in bozza** e valgono solo dopo **«Pubblica i prezzi»**, che pubblica tutte le bozze della
  destinazione insieme e archivia i prezzi che sostituiscono.
- Al massimo una bozza e un prezzo pubblicato per prodotto. Un prezzo pubblicato **non si modifica** (lo impedisce il
  database, anche a chi scrive direttamente): se ne pubblica uno nuovo e il precedente resta nello storico. Gli ordini
  futuri copieranno il prezzo al momento dell'acquisto.

## Listino pubblico

`public_catalog(p_pack)`, eseguibile anche da anonimi: solo prodotti in vendita, non nascosti, con un prezzo pubblicato
e coerenti con l'Accesso. Restituisce id, slug, tipo, nomi, percorso o percorsi, prezzo `{amount, currency}` e
`available` (falso se esaurito). Niente bozze, storico, ordini o identificativi di Stripe. L'app potrà mostrare i
prezzi senza ripubblicare il territorio.

## Chi può fare cosa

- Catalogo e prezzi: solo l'amministratore della piattaforma (funzioni `studio_catalog`, `studio_product_save`,
  `studio_price_draft`, `studio_prices_publish`, con l'identità dell'utente, nessuna chiave di servizio). Redattori ed
  esperti vedono la scheda ma non il catalogo (decisione D9).
- Le regole stanno nel database (trigger e funzioni); `lib/studio/catalog.ts` le ripete solo per dare subito un
  messaggio chiaro (`test/catalog.test.ts`).

## Da applicare al database reale

La migrazione **non è applicata** al progetto Supabase: va incollata nel SQL Editor solo con l'autorizzazione del
proprietario, poi si esegue `supabase/tests/remote-check.sql` (deve finire con «Tutto superato»). La revoca si ferma,
senza cambiare nulla, se esistono prezzi pubblicati o archiviati.

## Prove

- `npm run db:check`: migrazione, `95_catalog.sql`, `remote-check.sql`, revoca e riapplicazione.
- Prova nel browser sullo stack locale (Postgres, PostgREST, gateway di prova): redattore senza catalogo; esplorazione
  rifiutata finché è gratuita; importi non validi o fuori dai limiti; bozza, pubblicazione e storico; listino per anonimi
  solo con prezzi pubblicati; modifica diretta di un prezzo pubblicato rifiutata; pacchetto con percorso non premium
  segnalato; ritiro; revoca interrotta dai prezzi pubblicati.

## Non ancora

- «Esplorazione + AI» con crediti inclusi e le ricariche di crediti: con i crediti AI (passo 6), dopo la misura dei costi.
- Acquisto, webhook e diritti: passo 5 (Stripe in modalità test).
- Prezzi nell'app: arriveranno con il pulsante d'acquisto, leggendo `public_catalog()`.
