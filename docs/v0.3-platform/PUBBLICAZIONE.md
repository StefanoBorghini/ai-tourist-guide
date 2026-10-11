# Pubblicazione dallo Studio all'app (milestone 5, 2026-10-11)

Un territorio pubblicato dallo Studio arriva nell'app subito, senza un nuovo deploy, e funziona anche senza rete.

## Come funziona

1. **Approva e pubblica** (o **Ripubblica con le modifiche**) nella panoramica del territorio. Lo Studio ripete il
   controllo di pubblicazione; il database registra la richiesta (`publications`, stato `requested`).
2. **Compilazione** (`lib/studio/publish.ts`, sul server dell'app, con la sessione di chi pubblica): istantanee del
   territorio e delle sue dipendenze (`pack_snapshot`), file media scaricati dal bucket privato `media` e verificati con
   l'impronta registrata, stesso validatore e stesso `buildBundle` del build dai file. Un test controlla che dal database
   si ottengano gli stessi bundle che dai file del repository.
3. **Caricamento** nel bucket pubblico `bundles`, cartella `<territorio>/<lingua>-full/`: prima i file con l'impronta nel
   nome (contenuti, foto, video; quelli già presenti non si ricaricano), poi i `manifest.json`.
4. **Esito** nel database (`studio_publication_finish`): un record in `bundles` per lingua, con versione progressiva, e la
   pubblicazione `published` con le voci dell'indice. Se qualcosa va storto la pubblicazione è `failed`, lo Studio mostra
   l'errore e **la versione nell'app resta quella di prima**.
5. **Indice** `bundles/index.json`, ricalcolato dal database (`public_bundle_index()`): le destinazioni in stato
   `published` con la loro ultima pubblicazione riuscita. **Ritira dall'app** lo ricalcola senza il territorio.

Nessuna chiave di servizio: chi pubblica un territorio può scriverne i file nel bucket (policy di Storage per territorio),
e l'indice lo scrive chi pubblica almeno un territorio. Il database decide che cosa c'è nell'indice.

## L'app

- Legge due indici: `/bundles/index.json` (bundle compilati dai file del repository al build) e `/pub/index.json`
  (bundle pubblicati dallo Studio). Una destinazione pubblicata dallo Studio **sostituisce** quella dei file, in tutte le
  lingue (`lib/bundle-index.ts`, `mergeIndexes`).
- `/pub/` è il bucket pubblico di Supabase servito dallo stesso dominio dell'app (riscrittura in `next.config.ts`):
  service worker, cache e uso senza rete funzionano come per `/bundles/`. Senza `NEXT_PUBLIC_SUPABASE_URL` la
  riscrittura non c'è e l'app usa solo i bundle dei file (come la produzione di oggi).
- Le domande alla guida (`lib/ask-server.ts`) usano lo stesso indice unito; l'indice pubblicato si ricontrolla ogni minuto.

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
