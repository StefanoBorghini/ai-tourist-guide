# Contenuti gratuiti e a pagamento

Data: 2026-10-11 · Branch: `commercio` · Riferimenti: `PIANO-COMMERCIALE.md` (decisioni D1, D9, D10, D11), piano tecnico della Fase 4.

Primo passo del piano commerciale: separare i contenuti gratuiti da quelli a pagamento **prima** di prezzi, account e Stripe.
Finché non si configura nulla, ogni territorio resta tutto gratuito e i suoi bundle sono identici byte per byte a prima
(verificato su Portovenere).

## Regole (D1)

Ogni destinazione ha una configurazione «accesso» (`config.yaml` → `access`, nel database `packs.config -> 'access'`):

| Campo | Valori | Effetto sul bundle pubblico |
|---|---|---|
| `explore` | `free` (predefinito) / `premium` | `premium`: dei racconti restano solo le **aperture dei luoghi introduttivi**, più i racconti di contesto che servono a capirle; i fatti citati solo dai racconti esclusi non entrano |
| `introPlaces` | fino a 3 luoghi della destinazione | i luoghi i cui racconti d'apertura restano gratuiti |
| `freePlaces` | luoghi della destinazione, senza limite (dal 2026-10-18, migrazione 20261029000000) | i luoghi con tutti i racconti gratuiti; non si vendono da soli |
| `premiumRoutes` | percorsi della destinazione | non entrano nel bundle pubblico; l'app ne riceve solo nome e durata (`locked.routes`) |

Restano sempre pubblici: mappa, elenco e schede dei luoghi, nomi dei nodi, percorsi non premium, foto, note di sicurezza.

Il bundle pubblico dichiara cosa manca (`locked`); la compilazione restituisce a parte le **parti a pagamento**
(`premium`: l'esplorazione completa e un pacchetto per ogni percorso premium, con i racconti delle tappe), che però
**non vengono ancora pubblicate**: serviranno con gli acquisti (bucket privato, licenza offline, D3 ancora aperta).
Fino ad allora un contenuto segnato come a pagamento, dalla ripubblicazione successiva, non è visibile a nessuno.

Le domande all'AI usano solo il bundle pubblico: senza diritto non possono rivelare i contenuti a pagamento (D10).

## Correzioni della revisione tecnica (2026-10-12)

La revisione del branch ha trovato vie alternative ai contenuti a pagamento oltre al bundle principale. Correzioni:

| # | Problema | Correzione |
|---|---|---|
| P1 | I bundle compilati dai file del repository (`/bundles/`) ignorano l'accesso deciso nello Studio | Elenco esplicito `territories/static-bundles.json`: solo le destinazioni elencate hanno bundle dai file (fino al 2026-10-17 Portovenere; dal 2026-10-17 nessuna: Portovenere arriva solo dallo Studio, per poterla vendere). Le elencate non possono avere `config.access` nei file (il build si ferma) e lo Studio rifiuta di salvarle o pubblicarle con contenuti a pagamento (`lib/static-bundles.ts`, controllo di pubblicazione, `compilePublication`). Per vendere una destinazione elencata: toglierla dall'elenco e ridistribuire l'app |
| P2 | Con l'indice pubblicato illeggibile, app e AI ricadevano sui bundle dei file | L'esito della lettura è esplicito (`fetchPublishedIndex`: assente, HTTP, JSON non valido, forma inattesa, rete). Una destinazione solo dello Studio risulta «temporaneamente non disponibile»: l'AI risponde 503, l'app lo dice. Il ripiego sui file resta solo per le destinazioni elencate, che per P1 sono sempre gratuite |
| P3 | Elenco anonimo del bucket e versioni precedenti mai cancellate | Migrazione `20261023000000_bundles_storage.sql` (non applicata): elenco dei file solo a chi pubblica quel territorio; chi pubblica può cancellare i contenuti superati. Dopo una pubblicazione con contenuti a pagamento la pipeline cancella le versioni precedenti dei contenuti, dopo i manifest e prima di registrare l'esito, mentre la presa in carico è valida (se la pulizia non riesce resta un avviso e la pubblicazione vale comunque). L'app, quando riscarica un territorio, toglie dalla cache le versioni superate. *Pulizia sostituita da R2 (sotto): si cancellano solo cartelle di pubblicazioni morte* |
| P4 | Note di curatela e nomi dei nodi anticipavano i racconti esclusi | Con contenuti a pagamento le note di curatela non entrano nel bundle; con l'esplorazione a pagamento restano solo i nodi citati da ciò che è pubblico |
| P5 | Modello dei diritti ambiguo (l'esplorazione concedeva tutti i percorsi) | Migrazione `20261024000000_entitlements.sql` (non applicata): vedi «Diritti» |
| P6 | Cosa comprende un percorso premium | Regola prudente: vedi «Percorsi» |

## Correzioni della revisione finale (M1–M4, 2026-10-12)

| # | Problema | Correzione |
|---|---|---|
| M1 | Due pubblicazioni concorrenti dello stesso territorio: la pulizia della prima poteva cancellare il contenuto appena pubblicato dalla seconda | Una pubblicazione alla volta per territorio: la pipeline prende in carico la propria richiesta (`studio_publication_claim`, stato `building`, in `20261023000000_bundles_storage.sql`) prima di toccare il bucket; un'altra già in corso la ferma («riprova tra qualche minuto»). Una presa in carico senza esito da 15 minuti si considera interrotta. L'esito (riuscito o fallito) si registra solo con l'identificativo della pubblicazione presa in carico, di chi chiama e di quel territorio, e solo se è ancora in corso: una pubblicazione scaduta non può completare, fallire o toccare quella che l'ha sostituita (R1); la forma senza identificativo, per i server precedenti, chiude solo richieste non prese in carico. La pulizia avviene mentre la tiene e rilegge il manifest pubblicato: se è illeggibile o non è più il proprio non cancella nulla (`removeSupersededContent`, *sostituita da R2: `removeDeadVersions`*). Nessuna tabella o colonna nuova |
| M2 | `grant_product` non era idempotente: un evento di pagamento ripetuto duplicava i diritti (e, dopo una modifica del pacchetto, ne aggiungeva) | Per gli acquisti la concessione blocca la riga dell'acquisto e, se l'acquisto ha già dei diritti, non crea nulla e restituisce 0. Indice unico `entitlements_purchase_scope_key` (acquisto, ambito, percorso): neanche una scrittura diretta duplica, e un evento ripetuto dopo una revoca non fa rivivere il diritto |
| M3 | La revoca della migrazione dei diritti li allargava (un'esplorazione tornava `pack_access`, cioè tutti i percorsi; i percorsi premium configurati risultavano liberi) | La revoca si ferma, prima di cambiare dati o permessi e con un messaggio esplicito, se esistono prodotti, diritti o percorsi premium configurati; è in una transazione unica |
| M4 | Un prodotto ritirato dopo il pagamento impediva di concedere il diritto dell'acquisto | Un acquisto completato concede i diritti anche se il prodotto è stato ritirato; concessioni manuali e promozioni vogliono ancora un prodotto attivo. I diritti già concessi non dipendono dallo stato del prodotto. Un prodotto già acquistato non cambia più tipo, destinazione o percorso (nome, descrizione e stato sì) |

**Seconda revisione (R2, R6, R9; R1 è nella riga M1):**

| # | Problema | Correzione |
|---|---|---|
| R2 | Una pubblicazione che ha perso la presa in carico poteva ancora sovrascrivere i manifest o cancellare file | Pubblicazioni immutabili (migrazione 23, pipeline, app): ogni pubblicazione scrive manifest e contenuti in una cartella propria, solo finché la tiene in carico; nessun file del bucket si sovrascrive; l'indice pubblico è una serie di fotografie numerate; si cancellano solo versioni che l'indice servito non può più usare. Dettagli, garanzie e limiti in «Pubblicazioni immutabili (R2)» qui sotto. Il rinnovo (`studio_publication_renew`) resta: ferma presto chi ha perso la presa, ma la sicurezza non dipende più da lui |
| R6 | Tra il controllo della revoca e le modifiche si potevano salvare prodotti o percorsi premium | La revoca blocca subito, nello stesso ordine, le tabelle che controlla e cambia (`ACCESS EXCLUSIVE`, il livello che prende comunque) e ha `lock_timeout` di 10 secondi per ciascun lock (vedi punto 6 della procedura) |
| R9 | `remote-check.sql` non verificava le migrazioni 23 e 24 | Presenza delle migrazioni (funzioni, policy, tabelle), privilegi di esecuzione, `search_path` uguale a quello delle migrazioni, indice unico (colonne e predicato), trigger attivi e operativi, regole del bucket, presa in carico e rinnovo, concessione e revoca (`revoke_purchase`), diritti. Esito «superato» solo se tutto è stato verificato; altrimenti «incompleto» con l'elenco dei controlli non verificati |

**Limite (M4):** l'acquisto non conserva una copia di cosa conteneva il pacchetto al momento del pagamento (lo schema
non ha un campo adatto: `purchases.raw` è l'ultimo evento del fornitore, non una copia del prodotto). Se la concessione
arriva dopo una modifica del pacchetto, vale il contenuto al momento della concessione. Il futuro webhook deve quindi
concedere subito dopo il pagamento; una copia immutabile del contenuto acquistato richiede una decisione (campo nuovo).

## Percorsi premium (P6)

**Decisione (2026-10-18):** l'acquisto di un percorso sblocca l'itinerario completo **e i racconti delle sue tappe**
(con quelli che servono a capirli), anche senza l'esplorazione completa. Con l'esplorazione gratuita quei racconti sono
già pubblici e il file del percorso contiene solo l'itinerario. Regola commerciale aperta: chi compra poi anche
l'esplorazione non deve pagare due volte gli stessi racconti (da risolvere prima di attivare le vendite). Consegna e
verifiche: `CONSEGNA-CONTENUTI.md`.

## Diritti (P5)

| Prodotto | Diritti creati | Cosa sblocca |
|---|---|---|
| `explore` (prezzo da definire, vedi `PIANO-COMMERCIALE.md` §0) | uno, ambito `explore` sulla destinazione | i racconti dell'esplorazione completa; **non** i percorsi premium |
| `route` | uno, ambito `route` sul percorso | solo quel percorso |
| `bundle` (pacchetto) | un `route` per ogni percorso del pacchetto **al momento della concessione** | solo quei percorsi; se il pacchetto cambia dopo, chi l'ha comprato non riceve né perde nulla |
| catalogo delle attività locali | nessuno | gratuito, non è un prodotto |

- I diritti si concedono solo da `grant_product()` (ruolo di servizio: il server, in futuro dopo il webhook di pagamento,
  e solo per acquisti completati dell'utente giusto; idempotente per acquisto, vedi M2) o `admin_grant_product()` (amministratore, con motivo). Nessuna
  scrittura diretta nella tabella, neanche dell'amministratore. `revoke_purchase()` revoca i diritti di un acquisto.
- `can_access_explore(destinazione)` e `can_access_route(percorso)` leggono la configurazione «accesso» e i diritti
  attivi dell'utente. Stessa regola nel codice: `allowedPremiumParts()` (`packages/bundle/src/access.ts`).
- Prezzi, checkout, webhook e account dei visitatori **non** ci sono ancora.

## Limiti che il codice non può superare

- **Copie già scaricate:** un dispositivo che ha scaricato una versione gratuita la conserva finché non torna online e
  riscarica il territorio. Revocare un accesso non cancella nulla da un dispositivo offline.
- **Cache intermedie:** i file dei contenuti hanno l'impronta nel nome e un anno di cache. Dopo la cancellazione dal
  bucket, cache CDN e browser possono servirne una copia per un periodo che dipende dal fornitore (da verificare sul
  progetto reale). Chi conosce già l'indirizzo di un file lo scarica finché il file esiste.
- **Bucket pubblico:** i bundle pubblici restano scaricabili da chiunque (sono gratuiti per definizione). I contenuti a
  pagamento non vanno mai nel bucket pubblico: le parti a pagamento oggi non si pubblicano affatto.

## Chi decide (D9)

- Solo l'**amministratore della piattaforma**, dalla scheda **Accesso** dello Studio. Gli altri la vedono in sola lettura.
- Il database lo impone anche alle richieste dirette (`packs_guard`): nessun editor, nemmeno di un'organizzazione cliente,
  può cambiare o creare la configurazione.
- Un luogo introduttivo o un percorso premium **non si elimina né si rinomina** finché è nella configurazione (D11):
  prima si toglie dalla scheda Vendita (punto 1).

## File

| Area | File |
|---|---|
| Formato e validatore | `packages/domain/src/pack-schema.ts` (`access`), `vocabulary.ts` (`ACCESS_TIERS`), `packages/territory-pack/src/validate.ts` (`checkAccess`) |
| Compilazione | `packages/bundle/src/build.ts` (separazione, `withPrerequisites`), `format.ts` (`locked`, `PremiumPart`) |
| Database | `supabase/migrations/20261022000000_access.sql` (+ revoca), test `supabase/tests/70_access.sql` |
| Studio | `apps/guide/app/studio/[pack]/vendita/access-section.tsx` (scheda «Vendita»), azione `setAccess` |

## Verifiche

| Prova | Esito |
|---|---|
| Test unitari: validatore (4 nuovi), bundle (5 nuovi: nessun testo a pagamento nei file pubblici, parti a pagamento complete, pianificatore con il solo bundle pubblico) | superati (`npm run ci`) |
| Bundle di Portovenere senza configurazione | identici a prima (stesso hash dei contenuti) |
| `npm run db:check` con `70_access.sql`: staff e clienti rifiutati anche via UPDATE/INSERT diretti, limiti (3 luoghi, luoghi e percorsi esistenti, solo destinazioni), eliminazione e rinomina bloccate, esportazione e importazione senza perdite, ritorno al gratuito, revoca e riapplicazione | superati |
| Prova nel browser (stack locale): scheda Accesso, salvataggio, rifiuto di 4 luoghi, ripubblicazione senza i testi e i fatti a pagamento, domande sul bundle ridotto, app funzionante, editor in sola lettura, ritorno al gratuito con bundle identico | 19/19 |
| Regressione Studio, pubblicazione, territori, eliminazione | 31/31, 19/19, 24/24, 17/17 |
| Dopo le correzioni M1–M4: test dell'app (pulizia con due pubblicazioni intrecciate, manifest illeggibile), `80_bundles_storage.sql` (presa in carico concorrente, esito alla pubblicazione giusta, presa in carico interrotta), `90_entitlements.sql` (eventi ripetuti, anche dopo revoca e modifica del pacchetto; prodotto ritirato), revoca dei diritti fermata con dati presenti e verifica dopo la revoca (`supabase/tests/rollback/`) | superati in locale (`npm run ci`, `npm run db:check`); non verificati sul progetto reale |
| Seconda revisione (R1, R2, R6, R9): `80_bundles_storage.sql` (esito per identificativo, rinnovo), suite `publication-pipeline.test.ts` (presa persa prima e tra i manifest, prima della pulizia, errore di rete, errore intermedio), `concurrent.sh` (due sessioni reali: rinnovo contro sostituzione nei due ordini; revoca con percorso premium o prodotto scritti in parallelo; tabella occupata), `remote-check.sql` su database con un guasto alla volta | superati in locale; non verificati sul progetto reale |
| `remote-check.sql` rafforzato (R9): su database usa e getta, senza guasti `superato`, con un guasto alla volta (migrazione mancante, policy pubblica rimasta, `search_path` diverso, funzione non SECURITY DEFINER, indice senza predicato o con colonne diverse, trigger solo in replica o con funzione diversa, trigger svuotato, `revoke_purchase` eseguibile dai client o che non revoca) il «FALLITO» atteso, cancellazione diretta vietata → `incompleto` | superati in locale; il ramo «service_role non assumibile» non è provabile in locale (superutente) |
| R2 (pubblicazioni immutabili): `80_bundles_storage.sql` (scritture solo nella propria cartella in corso, mai nelle altre né nella struttura precedente; nessun aggiornamento; cancellazione solo di cartelle morte e solo dopo un indice che contiene la sostituta; indici numerati: solo numeri emessi, una volta, mai cancellati; esito che punta a un'altra cartella rifiutato), `50_publication.sql`, `60_hardening.sql`, `10_platform_security.sql` aggiornati; `concurrent.sh` (fotografia dell'indice presa mentre una pubblicazione va in linea, due sessioni reali); `remote-check.sql`; `publication-pipeline.test.ts` (9 casi: processo sospeso prima del manifest e prima del caricamento, fotografia tardiva, indice della sostituta non caricato, file dichiarato caricato ma assente, errori, ripubblicazione, tre di fila); verifica a mutazioni: 14 modifiche alla migrazione e 12 al codice, ciascuna rilevata da almeno un test | superati in locale; Storage reale da verificare (vedi R2) |
| R2 nel browser (stack locale con gateway che imita Storage): pubblicazione, concorrenza, accesso a pagamento, Studio, eliminazione, territori, territorio nuovo offline; passaggio di struttura (dispositivo con il territorio offline nella struttura precedente → ripubblicazione nella nuova: offline la copia vecchia funziona, online passa alla nuova, offline la nuova funziona) | 19/19, 11/11, 16/16, 31/31, 17/17, 24/24, 10/10, 9/9 |
| Dopo le correzioni della revisione: prova nel browser (Portovenere rifiutata a pagamento anche con l'impostazione scritta nel DB; destinazione solo dello Studio pubblicata senza testi, nodi e percorsi a pagamento; niente bundle statico; elenco anonimo del bucket vuoto; versione precedente cancellata; domande sul bundle ridotto) e regressioni | 16/16; 31/31, 19/19, 24/24, 17/17, 10/10 |

## Procedura di rilascio (R3)

**Questa procedura è documentazione, non un'autorizzazione.** Ogni passo segnato *remoto* richiede l'autorizzazione
esplicita del proprietario, data per quel passo. I passi *locali* non toccano nulla fuori dalla macchina di lavoro.
Decisione del proprietario (2026-10-11): **un solo progetto Supabase**, quello del sito; Vercel promuove la
produzione a mano.

### 1. Prima di tutto (locale)

1. Git: branch e commit attesi, `git status` senza sorprese; copia dei diff locali (`git diff > copia.diff` e copia
   dei file non tracciati) prima di qualsiasi altra operazione.
2. Test: `npm run ci` e `npm run db:check` verdi. `db:check` applica tutte le migrazioni in ordine, esegue
   `remote-check.sql` (atteso `superato | 0 | 0 | nessuno`: nel database di prova non ci sono amministratori), i test SQL, le prove a due sessioni
   (`supabase/tests/concurrent.sh`), le revoche in ordine inverso e la riapplicazione.
3. Prove nel browser sullo stack locale (Studio, pubblicazione, concorrenza, accesso) verdi.
4. Privilegi e policy: rileggere il diff delle migrazioni 22–24 (funzioni con i privilegi del proprietario solo con
   `search_path` fissato; nessuna funzione interna eseguibile dai client; nessuna scrittura diretta sui diritti).
   `remote-check.sql` controlla gli stessi punti dopo l'applicazione.

### 2. Stato del progetto reale (remoto, sola lettura, con autorizzazione)

Prima di applicare, capire cosa c'è già. Nel SQL Editor (non scrive nulla):

```sql
select m.migration, to_regprocedure(m.sig) is not null as presente from (values
  ('20261022000000_access', 'studio_set_access(text,jsonb)'),
  ('20261023000000_bundles_storage', 'studio_publication_claim(text)'),
  ('20261023000000_bundles_storage', 'studio_publication_renew(text,uuid)'),
  ('20261023000000_bundles_storage', 'studio_publication_finish(text,boolean,jsonb,jsonb,uuid)'),
  ('20261023000000_bundles_storage', 'studio_index_snapshot()'),
  ('20261023000000_bundles_storage', 'studio_index_reflects(bigint)'),
  ('20261024000000_entitlements', 'grant_product(uuid,uuid,text,uuid,text)')) as m(migration, sig);
select status, count(*) from publications group by 1;          -- nessuna «building» o «requested» in sospeso
select count(*) from products; select count(*) from entitlements;  -- la 24 si ferma se trova dati dei tipi precedenti
```

Copia di sicurezza: `select pack_snapshot('it.liguria.sp.portovenere');` salvata in un file, e l'elenco dei file del
bucket `bundles` (dalla dashboard). Se una migrazione risulta presente solo in parte, fermarsi (vedi 6).

### 3. Finestra di transizione: niente pubblicazioni da server vecchi o anteprime

Dall'applicazione della 23 al deploy dello Studio nuovo **nessuno pubblica**: né dallo Studio in produzione (il
codice vecchio non prende in carico le pubblicazioni e può caricare file nel bucket mentre il nuovo pulisce), né da
anteprime Vercel collegate allo stesso Supabase. Avvisare chi usa lo Studio; la finestra va tenuta più breve
possibile. La lettura (app, domande) non è toccata.
Dalla 23 lo Studio precedente **non riesce più a pubblicare** (il bucket rifiuta manifest e `index.json` della
struttura precedente, e la forma dell'esito senza identificativo non mette in linea nulla): la pubblicazione risulta
fallita senza toccare la versione in linea. Il divieto resta, perché un tentativo lascerebbe file media orfani e
pubblicazioni fallite da spiegare.
Dopo il deploy, l'app nuova legge sia la struttura precedente (`index.json`, finché non c'è un indice numerato) sia
la nuova. Una scheda dell'app aperta **prima** del deploy e mai ricaricata ha ancora il codice precedente: non apre i
territori ripubblicati nella struttura nuova finché non si ricarica (la copia offline già scaricata resta usabile).

### 4. Migrazioni (remoto, con autorizzazione), in ordine obbligatorio 22 → 23 → 24

I file delle migrazioni 22, 23 e 24 non contengono comandi di transazione (i `begin` che si leggono sono dentro le
funzioni). Per ciascuna: incollare il file nel SQL Editor **racchiuso tra `begin;` e `commit;`**, così un errore annulla
tutta la migrazione (provato in locale con `psql`: con un errore forzato a metà della 24 non resta nulla; come il SQL
Editor reale gestisce un errore dentro una transazione esplicita **non è verificato**: dopo un errore controllare con
la query del punto 2). Una sola migrazione per volta; se una fallisce, non applicare le successive.

1. `20261022000000_access.sql` (non cambia dati: nessun territorio ha la configurazione «accesso»);
2. `20261023000000_bundles_storage.sql`;
3. `20261024000000_entitlements.sql` (si ferma da sola se trova prodotti dei tipi precedenti o diritti già presenti).

### 5. Verifica dopo le migrazioni (remoto, con autorizzazione)

1. `supabase/tests/remote-check.sql` nel SQL Editor: atteso `superato | 0 | N | nessuno`, dove N è il numero di
   amministratori della piattaforma (almeno 1 sul progetto reale; il valore va confrontato con quello noto). Un
   «FALLITO» (lo script si ferma con l'errore) o l'esito `incompleto` (ultima colonna con i controlli non verificati)
   fermano il rilascio finché non sono chiariti: un controllo non verificato **non** è superato (per esempio, se il
   progetto vieta le cancellazioni dirette in `storage.objects`, la cancellazione dei contenuti superati va provata
   dalla Storage API; se il ruolo `service_role` non si può assumere dal SQL Editor, concessione e revoca vanno
   provate con la chiave di servizio, dal server).
2. Il bucket `bundles` resta pubblico: `/pub/index.json` e i file dei territori si scaricano ancora dall'app.
3. L'elenco anonimo del bucket è vuoto tranne `index/` (lo prova `remote-check.sql` sulle righe; il servizio HTTP va
   provato a parte, vedi «Verifiche Storage da fare sul progetto reale» in R2).

### 6. Se una migrazione fallisce o lo stato è parziale

- Con `begin; … commit;` un errore non lascia nulla: correggere la causa in locale, ripassare da 1, riprovare.
- Se la query del punto 2 mostra una migrazione presente solo in parte (per esempio applicata senza transazione),
  **non** applicare le successive e non deployare: annotare lo stato, confrontarlo con il file e decidere con il
  proprietario se completare o revocare.
- Revoche disponibili (solo queste), in ordine inverso:
  1. `supabase/rollback/20261024000000_entitlements.down.sql`: contiene già `begin;`, `lock_timeout`, i blocchi e
     `commit;`. Va incollata **così com'è, senza** racchiuderla di nuovo (un `commit` interno chiuderebbe la transazione
     esterna prima del previsto). Si ferma senza cambiare nulla se esistono prodotti, diritti o percorsi premium
     configurati, o se non ottiene un blocco entro 10 secondi. Il limite vale **per ciascun blocco**: le cinque
     tabelle si bloccano una dopo l'altra, quindi nel caso peggiore l'attesa arriva a circa 50 secondi, durante i
     quali le tabelle già bloccate fermano letture e scritture dello Studio e delle concessioni (i visitatori dell'app
     no: leggono i bundle). Un deadlock con una concessione in corso è possibile (dedotto dal codice, non provato):
     PostgreSQL interrompe una delle due transazioni, che non lascia modifiche e va ripetuta.
  2. `20261023000000_bundles_storage.down.sql` e 3. `20261022000000_access.down.sql` (toglie anche le configurazioni
     «accesso» salvate): non contengono comandi di transazione, vanno racchiuse tra `begin;` e `commit;`. Prima di revocare la 23 lo Studio in produzione deve essere quello precedente: lo Studio nuovo
  senza `studio_publication_claim` non pubblica (si ferma senza danni, ma non funziona).
  **Revoca della 23 dopo pubblicazioni nella struttura nuova:** l'app precedente legge solo `index.json`, fermo
  all'ultima pubblicazione prima della 23, e non sa leggere i manifest nelle cartelle delle pubblicazioni; i contenuti
  della struttura precedente dei territori ripubblicati sono già stati cancellati. Tornando al deploy precedente quei
  territori non si aprono finché lo Studio precedente non li ripubblica (dopo la revoca della 23). Prima di
  revocare, elencarli: `select distinct pack_id from publications where status = 'published' and report ? 'indexGeneration';`.
  Se il problema non è nella 23, è preferibile correggere in avanti.

### 7. Condizioni per il deploy (remoto, con autorizzazione)

Tutte vere: punti 1 e 5 superati senza voci «non verificati»; nessuna pubblicazione `building` o `requested` in
sospeso; finestra di transizione annunciata; copia di sicurezza fatta; build dell'anteprima del branch verde.
Il deploy (promozione su Vercel) lo fa il proprietario.

### 8. Dopo il deploy (remoto) e criteri di arresto

Verifiche: la pagina iniziale e Portovenere si aprono (anche offline dopo il primo scaricamento); `/pub/index.json`
risponde; lo Studio si apre e mostra i territori. Una pubblicazione di prova solo con autorizzazione esplicita, su un
territorio scelto dal proprietario, controllando poi che il manifest punti a un contenuto presente.
**Arresto** (non proseguire, avvisare il proprietario): un «FALLITO», un errore dello Studio sulla presa in carico,
`/pub/` che non risponde, un territorio che sparisce dall'app. In quel caso si torna al deploy precedente (Vercel) e
si valuta la revoca (punto 6).

### Locale, remoto, autorizzazioni

| Attività | Dove | Autorizzazione |
|---|---|---|
| Test, `db:check`, prove nel browser, revisione dei diff | locale | no |
| Query di sola lettura, copia di sicurezza | remoto | sì |
| Migrazioni, `remote-check.sql` (crea dati di prova e li annulla) | remoto | sì, per ciascuna |
| Deploy, promozione, ritorno al deploy precedente | remoto | sì (lo fa il proprietario) |
| Pubblicazioni dallo Studio durante la finestra di transizione | remoto | vietate |

### Pubblicazioni immutabili (R2)

**Struttura nel bucket `bundles`.** Ogni pubblicazione scrive `manifest.json` e `content.<impronta>.json` in
`<territorio>/<lingua>-full/<id pubblicazione>/`; i media restano in `<territorio>/<lingua>-full/media/` (impronta nel
nome, condivisi, mai cancellati). Nel manifest i percorsi sono relativi alla cartella della lingua
(`<id>/content.….json`, `media/….jpg`); l'app ricava quella cartella dall'indirizzo del manifest (`bundleBase`).
L'indice pubblico è `index/<numero di 20 cifre>.json`; `/pub/index.json` (proxy e domande) serve quello col numero più
alto, oppure `index.json` della struttura precedente se non ce n'è ancora nessuno; se l'elenco non risponde, 503
(mai un indice più vecchio al suo posto).

**Regole del bucket (migrazione 23).** Nessuna policy di aggiornamento: nessun file si sovrascrive (niente upsert). Si
inseriscono solo: media del territorio (chi lo pubblica); file nella cartella di una pubblicazione `building`, di chi
l'ha presa in carico; indici con un numero già emesso da `studio_index_snapshot` (staff della piattaforma). Si
cancellano solo: cartelle di pubblicazioni fallite; cartelle di pubblicazioni sostituite, ma solo quando un indice
caricato contiene la sostituta; contenuti della struttura precedente, solo quando un indice caricato contiene una
pubblicazione del territorio nella struttura nuova. L'esito riuscito accetta solo bundle nella cartella della propria
pubblicazione.

**Numerazione dell'indice e ordine delle pubblicazioni.** La sequenza da sola non basta: un numero preso prima di una
pubblicazione e una fotografia letta dopo darebbero un indice più alto con meno pubblicazioni (provato con due
sessioni reali: senza blocco il numero più alto vede meno). Per questo `studio_index_snapshot` prende un blocco di
transazione (`pg_advisory_xact_lock`), poi il numero, poi legge l'indice; l'esito riuscito prende lo stesso blocco e
registra l'ultimo numero emesso `g` (`report.indexGeneration`). Ne segue: ogni indice con numero > `g` è stato
fotografato dopo che l'esito era confermato e lo contiene; l'app serve il numero più alto; quindi, appena esiste un
indice caricato con numero > `g`, l'indice servito non può più puntare alla versione sostituita, né ora né dopo (gli
indici non si cancellano e un numero non emesso non si può caricare). Su questo si basa la cancellazione
(`studio_publication_dead`, `studio_index_reflects`). Una fotografia caricata in ritardo ha un numero più basso di
quelle successive e non torna in vigore. Prova a due sessioni in `concurrent.sh`; togliendo uno dei due blocchi la
prova fallisce.

**Garanzie dimostrate in locale** (Postgres con le policy reali, pipeline con un bucket finto che applica le stesse
regole, browser con un gateway che imita Storage): una pubblicazione sospesa e ripresa non scrive nulla dopo aver perso
la presa, non cambia la versione servita e non cancella file usati dall'indice servito; non sovrascrive i file della
pubblicazione successiva (cartelle diverse e nessun aggiornamento); l'indice servito va solo avanti e punta sempre a
file presenti; i dispositivi con la struttura precedente in cache continuano a funzionare offline e passano alla nuova
online.

**Limiti residui.** Chi conosce l'indirizzo di un file lo scarica finché esiste; le cache (CDN, browser, dispositivi)
possono conservarlo dopo la cancellazione. Se un territorio è ripubblicato ma il caricamento del suo indice fallisce,
la versione precedente resta servita (e non cancellata) finché un'altra pubblicazione, di qualunque territorio, non
carica un indice; la pipeline lo segnala come errore. Le voci della struttura precedente restano nella cache di un
dispositivo finché il territorio non viene riscaricato esplicitamente (come prima di R2). Media, manifest della
struttura precedente e indici numerati non si cancellano mai (crescono nel tempo; una pulizia andrebbe progettata a
parte). Una scheda dell'app aperta prima del deploy non legge la struttura nuova finché non si ricarica.

**Verifiche Storage da fare sul progetto reale** (non dimostrabili in locale: in locale si provano solo le righe di
`storage.objects` e le policy; il servizio Storage è imitato):

1. caricamento con `upsert: false` di un nome esistente → errore (409), file invariato; con `upsert: true` →
   rifiutato (nessuna policy di aggiornamento);
2. la riga in `storage.objects` compare solo a caricamento completato (altrimenti la verifica dei file e la regola
   «indice caricato» potrebbero considerare presente un file non ancora scaricabile);
3. elenco anonimo `POST /storage/v1/object/list/bundles` con `prefix: "index"` e `sortBy: name desc`, `limit: 1` →
   restituisce l'indice col numero più alto; con altri prefissi → vuoto;
4. cancellazione dalla Storage API (`remove`) → rispetta la policy di cancellazione (cartella in uso o in corso: nulla
   cancellato, senza errore; cartella morta: cancellata, file non più scaricabile);
5. intestazioni di `/pub/index.json` attraverso il proxy e la CDN: l'indice numerato si rivalida a ogni richiesta
   (`cacheControl: "0"` al caricamento);
6. `studio_index_reflects` (funzione con i privilegi del proprietario che legge `storage.objects`) vede le righe del
   bucket sul progetto reale come `media_file_exists`.

### Presa in carico: durata (R2b)

La presa in carico scade dopo **15 minuti** senza rinnovo (invariato). La pipeline la rinnova dopo ogni gruppo di
caricamenti e prima di ogni manifest e di ogni cancellazione, quindi una pubblicazione lunga ma attiva non scade.
Per accorciare la durata servono dati che oggi mancano: le durate reali delle pubblicazioni
(`select report -> 'pipeline' ->> 'ms' from publications where status = 'published' order by created_at desc limit 20;`
sul progetto reale) e il limite effettivo delle funzioni su Vercel (`maxDuration = 60` è dichiarato in
`app/studio/[pack]/panoramica/page.tsx`; che valga per le azioni avviate da quella pagina sul piano attuale non è
verificato). Con la durata attuale, un processo interrotto blocca nuove pubblicazioni dello stesso territorio fino a
15 minuti.
