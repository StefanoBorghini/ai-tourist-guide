# Acquisti con Stripe, modalità test (2026-10-14)

Passo 5 del piano (`PIANO-COMMERCIALE.md` §4 e §11). Il visitatore con un account compra dal listino di una destinazione
e paga su Stripe Checkout. L'acquisto diventa un **diritto** solo quando il webhook firmato di Stripe conferma il pagamento.

**Solo modalità test:** con una chiave `sk_live_…` gli acquisti si spengono da soli. Nessun pagamento reale è possibile
finché il codice non viene cambiato di proposito.

**Non ancora:** i racconti a pagamento non arrivano ancora nell'app a chi compra. Servono i contenuti protetti (bucket
`premium`, §6 del piano) e la licenza offline, che sono il passo successivo. Oggi l'acquisto viene registrato e il diritto
viene creato (`can_access_explore`, `can_access_route` rispondono di sì), ma l'app non ha ancora niente da sbloccare.
La pagina d'acquisto lo dice.

## Flusso

1. **Listino** `/account/acquista?destinazione=<id>`, con account obbligatorio.
   - Mostra i prodotti da `public_catalog()`.
   - Mostra «Già acquistato» per quelli che il visitatore possiede già.
2. **«Acquista»** invia a `POST /api/checkout` solo `prodotto` e `destinazione`. Il server:
   1. accetta solo moduli dello stesso sito (intestazione `Origin`) e verifica l'utente con `getUser()`;
   2. chiama `checkout_open` con l'identità dell'utente: prodotto in vendita, destinazione pubblicata, prezzo **pubblicato**
      letto dal database, utente che non lo possiede già. Crea l'ordine `pending` con la **copia** di prezzo e prodotto;
   3. fa scadere su Stripe eventuali checkout precedenti dello stesso prodotto (doppio clic, ritorno indietro). Se uno
      risulta già pagato si ferma: «c'è un pagamento appena concluso»;
   4. crea la Checkout Session:
      - importo dal database;
      - `client_reference_id` uguale all'ordine;
      - chiave di idempotenza `checkout-<ordine>`;
      - scadenza a 31 minuti;
   5. collega la sessione all'ordine (`checkout_attach`) e manda il browser a Stripe.
3. **Ritorno** `/account/ordine?id=…`:
   - legge lo stato dal database e **non concede nulla**;
   - mentre l'ordine è in attesa la pagina si aggiorna da sola, per al massimo un minuto;
   - con `annullato=1`: «Pagamento annullato, nessun addebito».
4. **Webhook** `POST /api/stripe/webhook`:
   1. verifica la firma sul corpo grezzo: una firma mancante o non valida dà 400, senza effetti;
   2. registra l'evento in `payment_events` (`payment_event_begin`). Un evento già applicato dà 200 senza rifare nulla;
   3. **rilegge da Stripe** sessione, addebito o contestazione: gli eventi possono arrivare fuori ordine;
   4. applica l'esito con una macchina a stati **monotona**. Un «fallito» dopo un «pagato» non cambia nulla, e un evento
      ripetuto non duplica i diritti;
   5. se l'elaborazione non riesce risponde 500, e Stripe riprova.

| Evento Stripe | Effetto |
|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` (sessione pagata) | Ordine `completed` se importo e valuta coincidono con l'ordine; diritti dalla copia nell'ordine (`grant_order`). Importo diverso: niente diritti, nota per la verifica manuale |
| `checkout.session.async_payment_failed` | `failed` (solo da `pending`) |
| `checkout.session.expired` | `expired` (solo da `pending`; un ordine sostituito resta `canceled`) |
| `charge.refunded` | Rimborso totale: `refunded` e diritti revocati. Parziale: `partially_refunded`, nessuna revoca (D2) |
| `charge.dispute.created` | `disputed`, diritti sospesi |
| `charge.dispute.closed` | Vinta: diritti ripristinati. Persa: `refunded`, diritti revocati |

Gli altri eventi si registrano come «ignorati».

**Regole:**
- **Chi decide il prezzo:** il browser non invia mai importi, utenti o prezzi.
- **Chi scrive ordini, diritti ed eventi:** solo le funzioni del database. Nessuna scrittura diretta dall'API, nemmeno
  dell'utente sul proprio ordine.
- **Chiave di servizio:** serve solo al webhook, dove nella richiesta non c'è un utente (D7), e solo per le funzioni
  `payment_*`. Il checkout usa l'identità dell'utente.
- **Composizione di un pacchetto:** un pacchetto cambiato dopo l'ordine non cambia ciò che è stato comprato, perché vale
  la copia nell'ordine. Un percorso eliminato nel frattempo non crea nulla (D11: rimborso su richiesta).
- **Dati salvati:** nessun dato di carte. Si conservano solo gli identificativi di Stripe (sessione, pagamento, cliente),
  per la riconciliazione.
- **Esportazione dei dati** (`export_my_data`): ora include gli ordini.
- **Account cancellato:** gli ordini restano, scollegati dall'utente (D8).

Codice:
- `lib/payments/shared.ts`: regole pure;
- `lib/payments/flows.ts`: checkout e webhook con dipendenze sostituibili;
- `lib/payments/server.ts`: Stripe e Supabase;
- `app/api/checkout`, `app/api/stripe/webhook`, `app/account/acquista`, `app/account/ordine`;
- «I miei acquisti» in `/account`.

Database:
- `supabase/migrations/20261026000000_orders.sql`;
- revoca `supabase/rollback/20261026000000_orders.down.sql`, che si ferma se esistono ordini Stripe;
- test `supabase/tests/96_orders.sql`;
- blocco «ordini» in `remote-check.sql`.

Libreria: `stripe` 22.6.2, versione fissata.

## Configurazione (da fare tu, solo modalità test)

**Non incollare mai i valori in chat.** Le variabili sono tutte solo server: nessuna è `NEXT_PUBLIC_`.

1. **Database:** applica `20261026000000_orders.sql` nel SQL Editor di Supabase, solo con autorizzazione. Poi esegui
   `remote-check.sql`: l'esito atteso è lo stesso di oggi, cioè «incompleto» per la sola cancellazione nel bucket.
2. **Stripe**, in modalità test (interruttore «Test mode» nella dashboard):
   1. *Developers → API keys*: copia la chiave segreta di test `sk_test_…`;
   2. *Developers → Webhooks → Add endpoint*:
      - URL `https://<dominio dell'anteprima>/api/stripe/webhook`;
      - eventi: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
        `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`,
        `charge.dispute.closed`;
      - copia il «Signing secret» `whsec_…`.
3. **Vercel**, solo l'ambiente **Preview** prima, con «Sensitive» attivo:
   - `STRIPE_SECRET_KEY`;
   - `STRIPE_WEBHOOK_SECRET`;
   - `SUPABASE_SERVICE_ROLE_KEY`, da Supabase *Project Settings → API → service_role*.

   Se l'anteprima ha la *Deployment Protection* attiva, Stripe riceve 401: serve un bypass per il percorso del webhook,
   oppure un dominio di anteprima non protetto.
4. **Prova:**
   1. crea un prodotto e un prezzo nello Studio (Catalogo) per una destinazione pubblicata con contenuti a pagamento
      (Accesso);
   2. apri `/account/acquista?destinazione=<id>`;
   3. paga con la carta di prova 4242 4242 4242 4242, una data futura e un CVC qualsiasi;
   4. per i rimborsi e le contestazioni di prova usa la dashboard di Stripe in modalità test (carte di prova dedicate,
      per esempio 4000 0000 0000 0259 per una contestazione).

**Attenzione:** se l'anteprima usa lo stesso progetto Supabase della produzione, gli ordini di prova finiscono nello
stesso database. Si riconoscono dagli identificativi `cs_test_…`. Non concedono nulla fuori da quel progetto e sono
ordini veri ai fini dei test SQL e della revoca della migrazione, che si ferma se esistono ordini Stripe.

## Prove

- **Test unitari** `test/payments.test.ts` (22), con firme vere generate dalla libreria Stripe:
  - configurazione solo test (una chiave live spegne gli acquisti);
  - errori come codici;
  - esiti delle sessioni rilette, anche fuori ordine;
  - checkout: solo il prodotto dal browser, idempotenza, sessioni sostituite, sessione già pagata, Stripe che non risponde;
  - webhook: firma mancante, falsa o con corpo alterato, evento ripetuto, scadenza, pagamento asincrono fallito o in
    corso, rimborso, contestazione, evento ignorato, errore del database.
- **`npm run db:check`:**
  - `96_orders.sql`:
    - nessuna scrittura diretta;
    - copia del prezzo;
    - doppio checkout;
    - prodotti non vendibili;
    - importo diverso;
    - sessione scambiata;
    - idempotenza;
    - fuori ordine;
    - pacchetto cambiato dopo l'ordine;
    - rimborsi;
    - contestazioni;
    - RLS tra due clienti;
    - esportazione;
    - omaggio che conta come posseduto;
  - `remote-check.sql`;
  - revoca, che si ferma con ordini presenti, e riapplicazione.
- **Prova nel browser** sullo stack locale, con Stripe simulato che firma gli eventi come Stripe (28 controlli):
  - accesso con ritorno al listino;
  - checkout rifiutato da un altro sito;
  - prezzo copiato;
  - annullamento;
  - sessione precedente fatta scadere;
  - webhook in ritardo, con la pagina d'ordine che si aggiorna;
  - evento ripetuto e firma falsa;
  - «Già acquistato» e ricompra bloccata;
  - rimborso parziale e totale;
  - contestazione aperta e vinta;
  - scritture dirette rifiutate dall'API.

Con Stripe vero non è stato provato nulla: serve la configurazione qui sopra e il collaudo in Preview.
