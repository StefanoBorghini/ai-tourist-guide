# Pubblicazione dallo Studio all'app (milestone 5, 2026-10-11)

Un territorio pubblicato dallo Studio arriva nell'app subito, senza un nuovo deploy, e funziona anche senza rete.

## Come funziona

1. **Approva e pubblica** (o **Ripubblica con le modifiche**) nella panoramica del territorio. Lo Studio ripete il
   controllo di pubblicazione; il database registra la richiesta (`publications`, stato `requested`).
2. **Compilazione** (`lib/studio/publish.ts`, sul server dell'app, con la sessione di chi pubblica): istantanee del
   territorio e delle sue dipendenze (`pack_snapshot`), file media scaricati dal bucket privato `media` e verificati con
   l'impronta registrata, stesso validatore e stesso `buildBundle` del build dai file. Un test controlla che dal database
   si ottengano gli stessi bundle che dai file del repository.
3. **Presa in carico e caricamento.** Prima di toccare il bucket la pipeline (`runPublication` in `lib/studio/server.ts`)
   prende in carico la richiesta (`studio_publication_claim`: stato `building`, una pubblicazione alla volta per
   territorio; se un'altra è in corso si ferma) e ne riceve l'identificativo. Poi carica nel bucket pubblico `bundles`,
   sempre senza sovrascrivere (`upsert: false`): foto e video in `<territorio>/<lingua>-full/media/` (quelli già presenti
   non si ricaricano), il contenuto in `<territorio>/<lingua>-full/<id pubblicazione>/` e, per ultimi, i `manifest.json`
   nella stessa cartella. Al massimo tre caricamenti insieme; gli errori temporanei dello Storage (sovraccarico, per
   esempio «Too many connections issued to the database», tempi scaduti) si riprovano fino a tre volte con attese
   crescenti (`uploadRetrying` in `lib/studio/publish.ts`), gli altri errori no. Rinnova la presa in carico dopo i caricamenti di ogni lingua e prima di ogni manifest
   (`studio_publication_renew`); se l'ha persa (scade dopo 15 minuti senza rinnovo) si ferma. Indipendentemente dalla
   pipeline, il bucket accetta file nella cartella di una pubblicazione solo da chi l'ha presa in carico e solo finché
   è in corso.
4. **Esito** nel database. Dalla migrazione `20261023000000_bundles_storage.sql` (R2) ogni pubblicazione ha una cartella
   propria: `manifest.json` e `content.<impronta>.json` stanno in `<territorio>/<lingua>-full/<id pubblicazione>/`, i
   media restano condivisi in `<territorio>/<lingua>-full/media/`; nel manifest i percorsi sono relativi alla cartella
   della lingua (`<id>/content.….json`, `media/….jpg`). Nessun file del bucket si sovrascrive. Prima dell'esito la
   pipeline rilegge il bucket e controlla che ci siano tutti i file richiesti. L'esito si registra solo per
   identificativo, sulla pubblicazione presa in carico (`studio_publication_finish` con `p_publication`) e solo se è
   ancora in corso: un record in `bundles` per lingua, con versione progressiva, e la pubblicazione `published` con le
   voci dell'indice; un bundle che punta fuori dalla cartella della propria pubblicazione è rifiutato. Se qualcosa va
   storto la pubblicazione è `failed`, lo Studio mostra l'errore e **la versione nell'app resta quella di prima**.
5. **Indice e pulizia.** L'indice pubblico non si riscrive: ogni aggiornamento è una nuova fotografia numerata e
   immutabile, `index/<numero di 20 cifre>.json`, con numero e contenuto da `studio_index_snapshot()` (ricalcolato dal
   database con `public_bundle_index()`: le destinazioni in stato `published` con la loro ultima pubblicazione
   riuscita). La scrive lo staff della piattaforma; **Ritira dall'app** ne scrive una senza il territorio.
   `/pub/index.json` serve la fotografia col numero più alto (oppure `index.json` della struttura precedente, finché
   non ce n'è nessuna; 503 se l'elenco non risponde). Dopo che la propria fotografia è caricata e in vigore, la
   pipeline cancella le versioni morte del territorio: cartelle di pubblicazioni fallite o sostituite, e contenuti
   della struttura precedente; il bucket lo permette solo quando un indice caricato non può più usarle. Media,
   manifest della struttura precedente e indici non si cancellano. Dettagli, garanzie e limiti:
   «Pubblicazioni immutabili (R2)» in `ACCESSO-CONTENUTI.md`.

Nessuna chiave di servizio: tutto avviene con la sessione di chi pubblica e lo decidono le policy di Storage
(migrazione 23). Media e cartella della pubblicazione: chi può pubblicare quel territorio (`can_publish_pack`), la
cartella solo come detto al punto 3. Indice: solo chi `studio_can_publish_any()` riconosce come staff della piattaforma
(migrazione 21: amministratore della piattaforma, oppure `platform_editor` o `territory_editor` di un'organizzazione di
tipo piattaforma); `studio_index_snapshot()` lo richiede di nuovo e assegna il numero, e il bucket accetta solo numeri
già assegnati. Chi pubblica per un'organizzazione territoriale manda in linea il territorio nel database, ma non
aggiorna l'indice: lo Studio lo segnala come errore («l'indice dell'app lo aggiorna lo staff della piattaforma») e
l'app continua a mostrare la versione precedente finché lo staff non scrive un nuovo indice. Che cosa c'è nell'indice
lo decide il database (`public_bundle_index()`).

## L'app

- Legge due indici: `/bundles/index.json` (bundle compilati dai file del repository al build) e `/pub/index.json`
  (bundle pubblicati dallo Studio). Una destinazione pubblicata dallo Studio **sostituisce** quella dei file, in tutte le
  lingue (`lib/bundle-index.ts`, `mergeIndexes`).
- `/pub/` è il bucket pubblico di Supabase servito dallo stesso dominio dell'app. La riscrittura è in `proxy.ts`;
  `next.config.ts` non riscrive nulla (contiene solo un commento che rimanda al proxy), perché le intestazioni di
  `next.config` non arrivano alle risposte riscritte verso un altro dominio.
  - `/pub/<percorso>` → `<NEXT_PUBLIC_SUPABASE_URL>/storage/v1/object/public/bundles/<percorso>`, con
    `X-Content-Type-Options: nosniff` e una `Content-Security-Policy` restrittiva (i file sono dati, mai pagine).
  - `/pub/index.json` è gestito a parte: il proxy elenca `index/` con la chiave pubblica
    (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) e riscrive verso la fotografia numerata più alta, oppure verso il vecchio
    `index.json` se non ce n'è nessuna; senza chiave o se l'elenco non risponde, 503 con `no-store`.
  - Senza un `NEXT_PUBLIC_SUPABASE_URL` valido `/pub/` risponde 404 e l'app usa solo i bundle dei file.
  - Service worker, cache e uso senza rete funzionano come per `/bundles/`.
  - **Non verificato:** il proxy imposta `Cache-Control: no-cache` sull'indice, ma nella prova locale la risposta
    portava l'intestazione dell'oggetto caricato (`max-age=0`, da `cacheControl: "0"`). Quale intestazione arrivi
    davvero con Supabase Storage e la CDN di Vercel va controllato sul progetto reale.
- Le domande alla guida (`lib/ask-server.ts`) usano lo stesso indice unito; l'indice pubblicato si ricontrolla ogni minuto.
  Non passano dal proxy: leggono direttamente il bucket, con la stessa scelta della fotografia (`currentIndexObject`).

## Territori nati dai file (Liguria, Portovenere)

Il database ha i metadati delle foto (autore, licenza, luoghi, impronta) ma non i file. Nella pagina **Foto** dello
Studio, **Copia i file dal repository** li carica nel bucket `media`, solo se identici a quelli registrati. Si fa una volta
prima della prima pubblicazione. Da quando un territorio è pubblicato dallo Studio, **la sua fonte è il database**: le
modifiche ai file del repository non arrivano più all'app per quel territorio (i file restano utili come copia).

## Foto

Lo Studio riduce le foto prima del caricamento (lato lungo 2048 px, JPEG/WebP di buona qualità, senza dati EXIF):
pesano poco nel pacchetto offline. Una foto sopra 2,5 MB genera un avviso alla pubblicazione.

## Prove

- `supabase/tests/50_publication.sql`: chi chiude una pubblicazione, bundle e indice, fallimento che non tocca la versione
  in linea, ritiro, policy del bucket (in `npm run db:check`; `remote-check.sql` aggiornato).
- `apps/guide/test/publish.test.ts`: compilazione, impronte, file mancanti, parità database ↔ file, unione degli indici.
- Prova nel browser su stack locale (19 controlli): copia dei file dal repository, foto nuova, nome cambiato, pubblicazione
  (circa 4 s), app che mostra nome e foto nuovi, modifica che arriva solo ripubblicando, domande sulla versione
  pubblicata, uso senza rete, ritiro. E un territorio creato da zero nello Studio che compare nella pagina iniziale.

### Pubblicazioni immutabili (R2, 2026-10-13)

**Test locali** (eseguiti, superati; `npm run ci` e `npm run db:check`):

- Postgres locale con le policy reali (`npm run db:check`): `80_bundles_storage.sql` (scritture solo nella cartella della
  propria pubblicazione in corso, mai in altre né nella struttura precedente; nessun aggiornamento; cancellazione solo
  di cartelle morte e solo dopo un indice caricato che contiene la sostituta; indici numerati solo con numeri emessi,
  una volta, mai cancellati; esito che punta a un'altra cartella rifiutato); `50_publication.sql`, `60_hardening.sql` e
  `10_platform_security.sql` aggiornati alla nuova struttura; `remote-check.sql`.
- Due sessioni reali in parallelo (`concurrent.sh`): fotografia dell'indice presa mentre una pubblicazione va in linea.
- App (vitest): `publication-pipeline.test.ts` (9 casi, con un bucket finto che applica le stesse regole: processo
  sospeso prima del manifest e prima del caricamento, fotografia tardiva, indice della sostituta non caricato, file
  dichiarato caricato ma assente, errori intermedi, ripubblicazione, tre pubblicazioni di fila);
  `premium-leaks.test.ts` (cartella della pubblicazione, scelta dell'indice, pulizia); `offline.test.ts` (cache con le
  due strutture).
- Verifica a mutazioni (copie fuori dal repository): 14 modifiche alla migrazione e 12 al codice, ciascuna rilevata da
  almeno un test.

**Simulazioni con il gateway locale** (nel browser; il gateway imita Auth e Storage sopra il Postgres locale, non è
Supabase): pubblicazione 19/19, pubblicazioni concorrenti 11/11, accesso a pagamento 16/16, Studio 31/31, eliminazione
17/17, territori 24/24, territorio nuovo anche offline 10/10, passaggio dalla struttura precedente alla nuova con il
territorio già scaricato offline 9/9. Il gateway e gli script di queste prove sono strumenti locali, non sono nel
repository.

**Da verificare sul vero Supabase Storage** (non dimostrabile in locale): rifiuto di un caricamento su un nome
esistente, con e senza upsert; comparsa della riga in `storage.objects` solo a caricamento completato; elenco anonimo
di `index/` ordinato per nome decrescente (e vuoto per gli altri prefissi); `remove` che rispetta la policy di
cancellazione; intestazioni di cache di `/pub/index.json` attraverso proxy e CDN; lettura di `storage.objects` da
parte di `studio_index_reflects`. Elenco completo in «Pubblicazioni immutabili (R2)», `ACCESSO-CONTENUTI.md`.
