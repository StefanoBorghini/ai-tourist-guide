# AI Tourist Guide — Directory gratuita delle attività locali

Data: 2026-10-11 · Stato: **implementata il 2026-10-28** (migrazione `20261105000000_local_businesses.sql`), con le proposte del §2 per le decisioni D13–D17. Immagini delle attività: secondo passo.
Documento collegato: `PIANO-COMMERCIALE.md`.
Prerequisito, prima di pianificare l'implementazione: l'hardening del CMS (`CMS-SECURITY-HARDENING.md`) completato e verificato in Preview.

## 1. Decisioni approvate

**Oggetto.** Una directory **gratuita** di attività locali, consultabile senza account e senza acquisti:
- ristoranti, trattorie e pizzerie;
- bar, caffè, gelaterie e locali;
- negozi;
- strutture ricettive;
- servizi turistici;
- altre attività approvate dalla redazione.

Non è limitata alle attività affiliate a Portovenere.com.

**Parità di trattamento:**
- compare ogni attività **approvata e pubblicata** nel CMS, affiliata o no;
- nessuna etichetta, badge o indicatore di affiliazione;
- nessun ordinamento che favorisca le affiliate;
- la presenza non implica affiliazione, pagamento o approvazione commerciale da parte di Portovenere.com.

**Niente AI e niente web.** Consultare una scheda:
- non esegue ricerche sul web;
- non attiva domande o risposte dell'AI;
- non genera chiamate a modelli;
- mostra solo i dati approvati e salvati nel CMS.

Le funzioni AI degli altri contenuti restano come previsto.

**Prodotti separati:**
- La directory non richiede l'acquisto di una destinazione, di un percorso o di un pacchetto.
- Consultarla non sblocca racconti né percorsi premium.
- La monetizzazione delle domande AI resta fuori da questa decisione.

**Gestione da CMS.** Una volta implementata, la directory si aggiorna dallo Studio, senza codice né deploy. **Contenuto di ogni scheda:**
- nome;
- categoria e sottocategoria;
- territorio;
- descrizione;
- indirizzo e coordinate, se disponibili;
- recapiti e sito, se disponibili;
- orari di apertura, se verificati;
- immagini autorizzate;
- stato editoriale: bozza, pubblicata, ritirata;
- data dell'ultima verifica.

**Visibilità:** solo le schede pubblicate sono visibili; quelle ritirate spariscono dalla directory pubblica.

## 2. Note architetturali per la pianificazione (proposte, da approvare)

Queste note non cambiano il software. Indicano dove la directory si innesta nell'architettura attuale e quali scelte vanno prese prima di implementarla.

| Tema | Proposta | Motivo |
|---|---|---|
| Modello dati | **Tabella dedicata** `local_businesses` (territorio, slug, categoria, sottocategoria, nomi e descrizioni per lingua, indirizzo, posizione, recapiti, orari, stato, data di verifica), non i nodi `place` dei racconti | Le attività hanno un ciclo di vita diverso (orari, recapiti, verifiche periodiche). Non devono entrare nel motore di contesto (niente geofence né proposte di racconto) né nella base di conoscenza dell'AI |
| Affiliazione | Tabella **interna separata** (per esempio `business_affiliations`), leggibile solo dallo staff autorizzato, **mai** inclusa nei dati pubblici | Separata fisicamente, non può finire per errore nella directory pubblica né influenzare ordinamento o presentazione |
| Immagini | Riuso del bucket privato `media` e delle regole su autore e licenza. Il collegamento foto ↔ attività è una tabella di collegamento: `media_subjects` punta ai nodi | Stesse garanzie di licenza delle altre immagini |
| Pubblicazione | Un file pubblico per territorio (per esempio `pub/<territorio>/directory.<hash>.json`) generato da **«Pubblica la directory»** nello Studio, indipendente dalla ripubblicazione dei racconti; oppure una funzione pubblica di sola lettura | Il file funziona offline e da CDN, non carica il database e non richiede un deploy |
| Ordinamento | Neutro e deterministico: per distanza dalla posizione (se disponibile), altrimenti alfabetico; filtri per categoria | Requisito di parità di trattamento |
| Sicurezza | Policy RLS e trigger come per gli altri contenuti, permessi per organizzazione dopo l'hardening, scritture dirette vincolate; affiliazione mai esposta via REST agli utenti finali | Criterio di accettazione 8 |
| AI | Le attività **escluse** dalla base di conoscenza del server delle domande, salvo decisione diversa | Evita che una risposta dell'AI sembri una raccomandazione commerciale |

### Decisioni aperte

| # | Decisione | Proposta |
|---|---|---|
| D13 | Tabella dedicata o riuso dei nodi | Tabella dedicata (sopra) |
| D14 | Chi gestisce le schede | Redazione della piattaforma ed editor del territorio; in futuro anche le attività stesse, con revisione redazionale |
| D15 | Orari «verificati» | Mostrati solo con la data dell'ultima verifica; oltre una soglia (per esempio 6 mesi) avviso «da verificare» o nascosti |
| D16 | Attività nella mappa della guida | Livello attivabile separato dai luoghi narrativi, con icone per categoria |
| D17 | Responsabilità e richieste di rimozione | Procedura di segnalazione e correzione per le attività; informativa sulla neutralità dell'elenco |

## 3. Criteri di accettazione (per la fase di implementazione)

1. Un visitatore senza account consulta le attività pubblicate.
2. Sono incluse le attività approvate, affiliate o no.
3. Nessun badge o etichetta distingue le affiliate. Verifica automatica: il file pubblico non contiene campi di affiliazione.
4. La consultazione non attiva ricerche web né domande AI. Verifica: nessuna chiamata a `/api/guide/ask` né al modello durante la navigazione della directory.
5. Le schede non richiedono acquisti.
6. Un redattore autorizzato crea, modifica, pubblica e ritira schede dallo Studio.
7. Le schede ritirate non sono più accessibili dalla directory pubblica.
8. Permessi e regole valgono anche per le richieste dirette al database e alle API: test a due organizzazioni, come in `60_hardening.sql`.

## 4. Implementazione (2026-10-28)

**Dove si inseriscono.** Studio → territorio (una destinazione) → scheda **«Attività»** → «Nuova attività»:
- nome, categoria (ristoranti; bar e caffè; negozi; strutture ricettive; servizi turistici; altro) e tipo libero;
- descrizione e orari per lingua;
- indirizzo e coordinate;
- telefono, email e sito (solo https).

L'attività nasce in **bozza**. Si spunta «Ho verificato ora questi dati», oppure si usa il pulsante «Ho verificato i dati ora», e poi si preme **«Pubblica»**. Compare nella guida entro qualche minuto (cache della CDN di 60 secondi), **senza ripubblicare il territorio** e senza deploy. «Ritira» la toglie.

**Dove si vedono.** Nella visita, sia in esplorazione sia nei percorsi, c'è il riquadro **«Bar, ristoranti e servizi»**:
- filtri per categoria;
- schede con foto, indirizzo, orari, descrizione e i pulsanti Chiama, Mostra sulla mappa, Sito ed Email (vedi §6);
- «Dati verificati il …».

Il riquadro non compare se la destinazione non ha attività pubblicate. Funziona solo online.

| Decisione | Come è stata applicata |
|---|---|
| D13 | Tabella dedicata `local_businesses`, fuori da Territory Pack, bundle, `kbHash` e base dell'AI. Nessuna tabella di affiliazione: non serve alla directory pubblica |
| D14 | Scrivono la redazione e gli editor del territorio (`can_edit_pack`). Pubblica e ritira chi pubblica il territorio (`can_publish_pack`). Un'attività pubblicata o ritirata la elimina solo l'amministratore |
| D15 | Pubblicare richiede la verifica. Cambiare i dati la azzera. Dopo 180 giorni la guida nasconde gli orari («orari da verificare») e lo Studio la elenca in «Da riverificare» |
| D16 | Per ora un elenco nella visita, ordinato dalla più vicina quando si conosce la posizione. Il livello sulla mappa è un passo successivo |
| D17 | Avviso di neutralità sotto l'elenco. La procedura di segnalazione resta da definire |

**Garanzie** (provate in `supabase/tests/99e_local_businesses.sql`):
- il pubblico legge solo `public_local_businesses()`: attività pubblicate di destinazioni pubblicate, campi pubblici elencati uno per uno, in ordine alfabetico, mai note interne né autori;
- nessuna colonna di affiliazione o priorità;
- anon non accede alla tabella;
- lettura e scrittura sono isolate tra organizzazioni.

**Componenti:**
- API `GET /api/v1/businesses?territory=…&lang=…`: `app/api/v1/businesses`, regole in `lib/businesses-api.ts`;
- guida: `components/BusinessesPanel.tsx` con regole pure in `lib/businesses-view.ts`;
- Studio: `app/studio/[pack]/attivita/`, `app/studio/actions-businesses.ts` e `lib/studio/local-businesses.ts`.

## 5. Esplorazione tematica (2026-10-28)

Nell'esplorazione libera di una destinazione, sopra la mappa, c'è un selettore a due schede: **«Storia e cultura»** e
**«Locali e attività»**. La scheda scelta è piena: avorio per la cultura, sabbia per le attività.

| | Storia e cultura | Locali e attività |
|---|---|---|
| Mappa | Spilli dei luoghi (come prima) | Segni quadrati delle attività con coordinate, colorati per categoria. Niente spilli dei luoghi |
| Elenco | Luoghi principali e sottoluoghi | Attività pubblicate, dalla più vicina se c'è la posizione |
| Filtri | — | Per categoria, validi per mappa ed elenco insieme |
| Dettagli | Scheda del luogo, racconti, domande a GAIA, percorsi, eventi | Scheda dell'attività (foto, orari se verificati di recente, Chiama, Mostra sulla mappa, Sito, Email) |
| Vuoto | — | «Nessuna attività a …, per ora», con l'avviso che la consultazione è sempre gratuita |

**La scelta si ricorda.** La modalità scelta resta sul dispositivo (`localStorage` `guide-explore-theme`) e vale anche per le visite nuove. Senza memoria disponibile si parte da «Storia e cultura».

**Una sola mappa.** È la stessa `MapView`, con `layer="venues"`. Le due modalità hanno la stessa struttura di pagina, quindi cambiando modalità la mappa non si ricrea: inquadratura, zoom, GPS, controlli e schermo intero restano come sono.

**Esplorazione libera.** La modalità attività non ha tappe né ordine, e non tocca il motore di contesto. I percorsi guidati non cambiano: nella loro scheda resta il riquadro «Bar, ristoranti e servizi».

**Categorie.** Il database non cambia. Le etichette accolgono anche:
- le enoteche, in «Bar, caffè ed enoteche»;
- le botteghe, in «Negozi e botteghe»;
- le attività ricreative, in «Servizi e tempo libero».

Il «tipo» libero (per esempio «enoteca» o «bottega di ceramiche») compare sulla scheda.

**Codice:**
- `components/GuideApp.tsx`: stato `theme`, `venueCategory`, `selectedVenue`;
- `components/MapView.tsx`: livello `venues`;
- `components/BusinessesPanel.tsx`: `VenueFilters`, `VenueList`, `BusinessCard` e `VenuesEmpty`;
- `lib/businesses-view.ts`: `venueMarkers` ed `ExploreTheme`.

**Domani: soste facoltative nei percorsi.** Le attività hanno un identificativo stabile (`local_businesses.id`) e coordinate, e la mappa sa già mostrarle come livello. Per proporle lungo un itinerario basterà:
1. una tabella di collegamento percorso ↔ attività (sosta facoltativa, posizione nell'ordine), scelta dalla redazione nello Studio;
2. il livello `venues` acceso anche sulla mappa del percorso, con le sole attività collegate.

Le soste resterebbero facoltative: il pianificatore non le conta tra le tappe. Oggi niente di questo è necessario e niente è stato aggiunto.

## 6. Foto e «Mostra sulla mappa» (2026-10-29)

**Niente più Google Maps.** La scheda dell'attività non porta più a mappe esterne. Il pulsante **«Mostra sulla mappa»**
(solo per le attività con coordinate) centra la mappa della guida sull'attività e la porta in vista:
- in «Locali e attività» seleziona l'attività sulla mappa;
- nei percorsi guidati la mostra, evidenziata, tra i luoghi del percorso; toccarla la toglie. Le tappe non cambiano.

**La descrizione letta da GAIA (decisione del 2026-10-29).** Ogni attività ha la sua descrizione, scritta e verificata
dalla redazione nello Studio (per lingua, fino a 1000 caratteri). Sulla scheda il pulsante **«Ascolta»** la fa leggere
alla voce di GAIA, parola per parola: nome dell'attività e descrizione, con il testo a schermo e i comandi della guida
(pausa, avanti, velocità). Toccato di nuovo diventa «Ferma». Non compare se l'attività non ha descrizione o il
dispositivo non ha la sintesi vocale.

**Niente AI per le attività.** La modalità «Locali e attività» non ha la casella delle domande a GAIA, e la lettura non
chiama il modello: nessun testo generato, nessuna domanda sulle attività. Resta valida la regola di §4: le attività non
entrano nei bundle né nella base delle risposte dell'AI.

**Foto come per i luoghi.** Nello Studio, nella pagina dell'attività, la sezione **«Foto»**:
- fino a 6 foto, JPEG, PNG o WebP; il browser le riduce (lato lungo 2048 px) e toglie i dati EXIF, posizione compresa;
- testo alternativo obbligatorio nella lingua principale;
- autore, licenza e provenienza con le stesse regole delle foto dei luoghi: autore salvo pubblico dominio, riferimento
  all'accordo per le licenze concesse per iscritto, indirizzo originale per le foto dal web;
- mai «tutti i diritti riservati»; licenze non commerciali solo se il territorio le ammette (`config.media.allowNonCommercial`);
- la prima è la copertina («Metti per prima» cambia l'ordine); «Elimina» toglie la registrazione e il file;
- eliminando l'attività si tolgono anche i file delle sue foto.

Le foto compaiono subito, senza ripubblicare il territorio, ma solo per le attività pubblicate. Nella guida si vedono
come la galleria dei luoghi, con il credito su ciascuna («Foto: Mario Rossi · CC BY 4.0»; la licenza si nomina quando
la chiede).

| Scelta | Perché |
|---|---|
| Tabella `local_business_photos`, non `media_assets` | Le attività sono dati operativi fuori dal Territory Pack: le loro foto non passano da `pack_snapshot()`, dai bundle né dall'offline |
| Bucket **pubblico** `business-photos` (5 MB per file) | La guida le legge senza sessione e senza chiave di servizio, come i bundle pubblicati. Il percorso è `<territorio>/<id attività>/<nome>-<suffisso casuale>`: il file di una bozza si raggiunge solo conoscendone il nome esatto |
| Elenco pubblico solo da `public_local_businesses()` | Restituisce le foto delle sole attività pubblicate, con indirizzo e crediti; mai la nota dell'accordo, la provenienza o chi le ha caricate |
| Scrittura nel bucket solo per chi modifica il territorio | Policy su `storage.objects`: cartella di un'attività esistente del territorio, `can_edit_pack` |

**Garanzie** (provate in `supabase/tests/99f_business_photos.sql`): file nella cartella giusta e già caricato, testi
alternativi, licenze, tetto di 6, isolamento tra territori, anon senza accesso a tabella e funzioni, foto pubbliche solo
delle attività pubblicate. La revoca (`supabase/rollback/20261106000000_business_photos.down.sql`) si ferma se resta
anche una sola foto o un file.

**Codice:**
- migrazione `supabase/migrations/20261106000000_business_photos.sql`;
- API: `lib/businesses-api.ts` trasforma il percorso nell'indirizzo pubblico (solo nella cartella del territorio richiesto);
- guida: `BusinessCard` in `components/BusinessesPanel.tsx`, `photos` in `lib/businesses-view.ts`, `focus` e
  `pinnedVenue` in `components/MapView.tsx`;
- Studio: `app/studio/[pack]/attivita/[id]/BusinessPhotos.tsx`, azioni in `app/studio/actions-businesses.ts`,
  riduzione delle immagini in `lib/studio/image-upload.ts` (la stessa delle foto dei luoghi).
