# Sfondo della mappa: stile senza attività commerciali

Data: 2026-10-28 · Stato: **codice pronto**. Lo stile e le variabili sono da impostare (vedi sotto).

## Perché

I tile di OpenStreetMap disegnano già ristoranti, bar e negozi come icone fisse nell'immagine. Nella modalità «Locali e attività» si confondono con le attività della directory, che sono gli unici segni quadrati e vengono dallo Studio.

Un'immagine non si può filtrare per categoria. Serve uno **stile personalizzato** di un fornitore:
- **spento:** ristorazione, negozi e alloggi;
- **acceso:** chiese, monumenti, musei, panorami, spiagge, trasporti, parcheggi, servizi pubblici.

C'è anche un secondo motivo. La politica d'uso dei tile di openstreetmap.org non va bene per un'app in produzione, quindi un fornitore con licenza serve comunque.

## Come funziona nel codice

- `lib/map-view.ts`: `tileSourceFrom()` e `tileUrl()`, logica pura e testata in `test/map-tiles.test.ts`. Il modello si accetta solo se è https, contiene `{z}`, `{x}` e `{y}` e non ha spazi. Altrimenti resta OpenStreetMap: nessuna configurazione sbagliata spegne la mappa.
- `components/MapView.tsx` legge al build:
  - `NEXT_PUBLIC_MAP_TILES_URL`, il modello dei tile da 256 px. `{r}` facoltativo diventa `@2x` sugli schermi ad alta densità;
  - `NEXT_PUBLIC_MAP_TILES_ATTRIBUTION`, l'attribuzione, mostrata come solo testo, senza link.
- I nostri luoghi, le attività, la posizione e i controlli non cambiano: si sovrappongono allo sfondo come prima.

## Cosa fare (fornitore consigliato: MapTiler)

1. Crea un account su MapTiler Cloud.
2. Parti da uno stile chiaro e leggibile, per esempio «Streets» o «Basic». Aprilo nell'editor degli stili (Customize).
3. Nei livelli dei punti d'interesse (POI):
   - **spegni** le classi di ristorazione (ristoranti, bar, caffè, pub, fast food, gelaterie), commercio (negozi, supermercati) e alloggio (hotel, B&B);
   - **lascia accese** luoghi di culto, monumenti, castelli, musei, attrazioni, panorami, spiagge, porti e traghetti, fermate, parcheggi, servizi igienici, farmacie e ospedali.

   I nomi dei livelli possono variare secondo lo stile e la versione dell'editor: conta il risultato sulla mappa di prova.
4. Salva e pubblica lo stile. Copia l'indirizzo dei **tile raster da 256 px**, quello con `{z}/{x}/{y}`.
5. Nelle impostazioni della chiave, limita le **origini consentite** ai domini dell'app: quello di produzione e quelli delle anteprime di Vercel.
6. Su Vercel, Preview prima e poi Production solo dopo la prova, imposta:
   - `NEXT_PUBLIC_MAP_TILES_URL` = l'indirizzo copiato, con `{r}` prima dell'estensione se vuoi i tile nitidi sui telefoni (esempio in `.env.example`);
   - `NEXT_PUBLIC_MAP_TILES_ATTRIBUTION` = `© MapTiler © OpenStreetMap contributors`.
7. Rifai il deploy: le variabili `NEXT_PUBLIC_*` entrano nel build.

La chiave nel modello è pubblica per natura: la vede chiunque usi l'app. La protezione è la limitazione ai domini, al punto 5. Non va mai usata una chiave con permessi di gestione dell'account.

Costi: MapTiler ha un piano gratuito con un limite di caricamenti di mappe al mese, poi è a pagamento. Prima della produzione va controllato il piano adatto al traffico previsto e il suo uso commerciale. Alternative equivalenti: Stadia Maps, Thunderforest.
