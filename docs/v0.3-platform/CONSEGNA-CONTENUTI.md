# Consegna dei contenuti acquistati (2026-10-18)

Come arrivano all'app i contenuti a pagamento a chi li ha comprati. Il resto (formato, separazione pubblico/premium,
diritti) è in `ACCESSO-CONTENUTI.md`; pagamenti in `PAGAMENTI.md`; progetto in `PIANO-COMMERCIALE.md` §6.

## Decisioni del proprietario (2026-10-18)

| Punto | Decisione |
|---|---|
| Percorso a pagamento | Itinerario completo (tappe e ordine) **più i racconti delle sue tappe**, anche offline: un'esperienza autonoma, non una traccia muta. |
| Doppio pagamento | **Risolto (2026-10-18):** i racconti di un percorso acquistato valgono in tutta la guida: i luoghi del percorso compaiono sbloccati anche nell'esplorazione libera. L'unione dei contenuti comprati con quelli pubblici (`mergePremium`, `packages/bundle/src/merge.ts`, testata) non duplica mai un racconto e dà lo stesso risultato in qualunque ordine arrivino gli acquisti. Il prezzo dell'esplorazione per chi ha già dei percorsi resta una scelta commerciale nello Studio (per esempio un pacchetto). |
| Uso senza rete | 30 giorni dall'ultima convalida online, rinnovati a ogni ritorno online se il diritto è ancora valido. Dopo rimborso o revoca il server nega l'accesso e l'app cancella la copia alla prima riconnessione. Una copia su un dispositivo che resta offline non si può cancellare prima della scadenza locale. |
| Singolo luogo | **(2026-10-18)** Con l'esplorazione a pagamento ogni luogo non introduttivo si può comprare anche da solo. Il prezzo si decide nello Studio; quello proposto è **0,50 €**, il minimo che Stripe accetta (lo 0,19 € inizialmente richiesto non è addebitabile); prezzo pieno, nessuno sconto automatico su un acquisto successivo dell'esplorazione. |
| Domande all'AI | Per ora solo sui contenuti pubblici. In una fase successiva anche sui contenuti comprati, verificando i diritti sul server prima di leggere qualsiasi contenuto protetto. |

## Come funziona

1. **Compilazione** (`packages/bundle/src/build.ts`): il bundle pubblico non contiene i contenuti a pagamento; a parte
   escono le parti a pagamento: «esplorazione completa» e una per ogni percorso a pagamento (itinerario + racconti delle
   tappe non già pubblici, con i racconti che servono a capirli). Con l'esplorazione gratuita il file del percorso ha
   solo l'itinerario, perché i racconti sono già pubblici. Con l'esplorazione a pagamento esce anche una parte per ogni
   luogo non introduttivo che ha racconti (i suoi racconti, con quelli che servono a capirli).
2. **Bucket privato `premium`** (migrazione `20261027000000_premium_storage.sql`), senza tabelle nuove:
   - nomi `<destinazione>/<lingua>/<pubblicazione>/explore.<impronta>.json`, `…/route-<percorso>.<impronta>.json` e
     `…/place-<luogo>.<impronta>.json` (questi ultimi dalla migrazione `20261028000000_place_products.sql`);
   - **lettura** (`premium_object_readable`): `explore` solo con il diritto «explore» attivo e valido ora su quella
     destinazione; `route-<percorso>` solo con il diritto «route» su quel percorso; `place-<luogo>` solo con il diritto
     «place» su quel luogo (`has_place_right`). Un contenuto tornato gratuito è già
     nel bundle pubblico: il file a pagamento rimasto resta riservato a chi l'aveva comprato;
   - **scrittura**: solo chi pubblica il territorio, solo nella cartella della propria pubblicazione in corso, nessuna
     sovrascrittura; **cancellazione** solo delle pubblicazioni superate (stessa regola dei bundle);
   - bucket non pubblico: senza autorizzazione nessun indirizzo funziona. L'app chiederà un indirizzo firmato di pochi
     minuti con la sessione dell'utente (nessuna chiave di servizio).
3. **Pubblicazione** (`lib/studio/publish.ts`, `server.ts`): «Ripubblica» carica le parti nel bucket privato, nella
   cartella della pubblicazione, prima del manifest; il manifest pubblico ne elenca solo nomi e impronte
   (`premium`); la pulizia toglie le parti delle pubblicazioni superate.
4. **`/api/premium`**: con la sessione dell'utente, indirizzi firmati di 5 minuti per i soli file per cui ha un diritto
   (`premium_object_readable`), più la scadenza dell'uso offline (30 giorni). Regole pure in `lib/premium.ts`. Le policy
   del bucket lasciano leggere i file anche a chi pubblica il territorio (serve alla pipeline): fino al 2026-10-18
   questo bastava a sbloccare tutto nella guida della redazione, ora conta solo il diritto.
5. **App** (`lib/premium-client.ts`, `GuideApp`): all'apertura di un bundle con contenuti a pagamento usa subito la
   copia sul dispositivo (se valida), poi convalida online: scarica ciò che manca verificando l'impronta, cancella ciò
   che non è più concesso (rimborso), unisce con `mergePremium`. Una visita in corso non cambia a metà. La pagina
   dell'ordine riuscito ha «Apri nella guida». Mappa dell'esplorazione libera: solo luoghi gratuiti o acquistati;
   elenco e «Vicino a te» mostrano anche quelli a pagamento, con «Sblocca». A pagamento sono solo i luoghi che hanno
   racconti a pagamento (`content.locked.places`): un luogo introduttivo, o senza racconti, si mostra gratuito. La scheda di un luogo bloccato offre
   «Solo questo luogo» (se il luogo è in vendita) e «Tutti i luoghi» (l'esplorazione completa); un luogo comprato da
   solo si sblocca ovunque, gli altri restano bloccati.

Prova completa sullo stack locale (Studio, pubblicazione, acquisto con Stripe simulato, sblocco, uso senza rete,
rimborso): 16/16. Da provare in Preview: indirizzi firmati della Storage API reale.

## Singoli luoghi: migrazione 28

`supabase/migrations/20261028000000_place_products.sql` (revoca in `supabase/rollback/`, test `supabase/tests/98_places.sql`
L1–L5 e blocco «singolo luogo» di `remote-check.sql`). Nessuna tabella nuova: colonne `place_id` in `products` ed
`entitlements`, tipo di prodotto e ambito di diritto «place», `has_place_right`, catalogo, ordini e lettura dei file
`place-<luogo>`. Nello Studio, scheda Vendita: «Metti in vendita i luoghi» crea un prodotto «Luogo» attivo per ogni
luogo vendibile senza prodotto, con il prezzo in bozza (0,50 € proposto), che vale dopo «Pubblica i prezzi». I file dei
luoghi escono alla prossima «Ripubblica». La revoca si ferma se esistono già prodotti o diritti sui luoghi.

## Luoghi gratuiti: migrazione 29

Decisione del 2026-10-18: nella scheda Vendita ogni luogo si sceglie fra **A pagamento** (si sblocca con
l'esplorazione completa o comprandolo da solo), **Introduttivo** (gratuito il racconto d'apertura, al massimo 3) e
**Gratuito** (tutti i suoi racconti nell'app pubblica; non si vende). L'elenco sta in `config.access.freePlaces`
(nessuna tabella nuova); `supabase/migrations/20261029000000_free_places.sql` aggiorna `studio_access`,
`studio_set_access`, la protezione dei luoghi in uso e `catalog_problem_place` (un luogo gratuito non si vende).
Test `supabase/tests/99_free_places.sql` (G1–G4); la revoca si ferma se esistono luoghi gratuiti. Cambia nell'app
alla prossima «Ripubblica».

## Verifiche richieste prima di applicare la migrazione al database reale

| | Verifica | Dove è provata | Esito locale |
|---|---|---|---|
| V1 | Senza diritti nessun file a pagamento si legge (anonimo, visitatore, diritto di un'altra destinazione, diritto scaduto) | `supabase/tests/97_premium.sql`; `remote-check.sql` (anonimo, visitatore senza diritti) | superata |
| V2 | Un percorso acquistato non apre gli altri percorsi né l'esplorazione | `97_premium.sql`; `remote-check.sql` (l'esplorazione non apre il percorso); `packages/bundle/test/bundle.test.ts` («un percorso dà solo quel percorso…») | superata |
| V3 | I racconti delle tappe di un percorso acquistato sono accessibili senza l'esplorazione | `bundle.test.ts` («la parte a pagamento ha l'itinerario e i racconti delle sue tappe»): i racconti sono nel file del percorso; `97_premium.sql`: quel file si legge con il solo diritto sul percorso | superata |
| V4 | Un rimborso revoca solo i diritti di quell'acquisto | `97_premium.sql` (rimborso del percorso: resta l'esplorazione; l'acquisto di un altro utente resta); `remote-check.sql` (dopo il rimborso il file non si legge) | superata |
| V5 | Nessun contenuto a pagamento nei bundle pubblici né leggibile da indirizzi senza autorizzazione | `97_premium.sql` e `remote-check.sql` (bucket privato, nessuna scrittura da visitatori, nessun file a pagamento nel bucket pubblico, pipeline solo nella propria pubblicazione); `apps/guide/test/premium-leaks.test.ts` e `bundle.test.ts` (nessun testo o identificativo a pagamento nei file pubblici) | superata |

Non verificabile con SQL, da provare in Preview dopo l'applicazione: la Storage API via HTTP (indirizzo firmato
negato senza diritto, concesso con il diritto; indirizzo pubblico del bucket `premium` che risponde «non trovato»).

La revoca (`supabase/rollback/20261027000000_premium_storage.down.sql`) non cancella mai contenuti: con file nel
bucket si ferma senza cambiare nulla (provato da `npm run db:check`).
