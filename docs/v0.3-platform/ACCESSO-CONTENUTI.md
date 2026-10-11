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
| `premiumRoutes` | percorsi della destinazione | non entrano nel bundle pubblico; l'app ne riceve solo nome e durata (`locked.routes`) |

Restano sempre pubblici: mappa, elenco e schede dei luoghi, nomi dei nodi, percorsi non premium, foto, note di sicurezza.

Il bundle pubblico dichiara cosa manca (`locked`); la compilazione restituisce a parte le **parti a pagamento**
(`premium`: l'esplorazione completa e un pacchetto per ogni percorso premium, con i racconti delle tappe), che però
**non vengono ancora pubblicate**: serviranno con gli acquisti (bucket privato, licenza offline, D3 ancora aperta).
Fino ad allora un contenuto segnato come a pagamento, dalla ripubblicazione successiva, non è visibile a nessuno.

Le domande all'AI usano solo il bundle pubblico: senza diritto non possono rivelare i contenuti a pagamento (D10).

## Chi decide (D9)

- Solo l'**amministratore della piattaforma**, dalla scheda **Accesso** dello Studio. Gli altri la vedono in sola lettura.
- Il database lo impone anche alle richieste dirette (`packs_guard`): nessun editor, nemmeno di un'organizzazione cliente,
  può cambiare o creare la configurazione.
- Un luogo introduttivo o un percorso premium **non si elimina né si rinomina** finché è nella configurazione (D11):
  prima si toglie dalla scheda Accesso.

## File

| Area | File |
|---|---|
| Formato e validatore | `packages/domain/src/pack-schema.ts` (`access`), `vocabulary.ts` (`ACCESS_TIERS`), `packages/territory-pack/src/validate.ts` (`checkAccess`) |
| Compilazione | `packages/bundle/src/build.ts` (separazione, `withPrerequisites`), `format.ts` (`locked`, `PremiumPart`) |
| Database | `supabase/migrations/20261022000000_access.sql` (+ revoca), test `supabase/tests/70_access.sql` |
| Studio | `apps/guide/app/studio/[pack]/accesso/page.tsx`, azione `setAccess` |

## Verifiche

| Prova | Esito |
|---|---|
| Test unitari: validatore (4 nuovi), bundle (5 nuovi: nessun testo a pagamento nei file pubblici, parti a pagamento complete, pianificatore con il solo bundle pubblico) | superati (`npm run ci`) |
| Bundle di Portovenere senza configurazione | identici a prima (stesso hash dei contenuti) |
| `npm run db:check` con `70_access.sql`: staff e clienti rifiutati anche via UPDATE/INSERT diretti, limiti (3 luoghi, luoghi e percorsi esistenti, solo destinazioni), eliminazione e rinomina bloccate, esportazione e importazione senza perdite, ritorno al gratuito, revoca e riapplicazione | superati |
| Prova nel browser (stack locale): scheda Accesso, salvataggio, rifiuto di 4 luoghi, ripubblicazione senza i testi e i fatti a pagamento, domande sul bundle ridotto, app funzionante, editor in sola lettura, ritorno al gratuito con bundle identico | 19/19 |
| Regressione Studio, pubblicazione, territori, eliminazione | 31/31, 19/19, 24/24, 17/17 |

## Applicazione al database (con autorizzazione)

Decisione del proprietario (2026-10-11): **un solo progetto Supabase**, quello del sito. Prima di applicare:
1. copia di sicurezza: `select pack_snapshot('it.liguria.sp.portovenere');` salvata in un file;
2. eseguire `20261022000000_access.sql` nel SQL Editor (non cambia nessun dato: nessun territorio ha ancora la configurazione);
3. eseguire `supabase/tests/remote-check.sql` (atteso `superato | 0 | 1`).

La migrazione serve allo Studio del branch `commercio`; lo Studio attuale non la usa e continua a funzionare.
Revoca: `supabase/rollback/20261022000000_access.down.sql` (toglie anche le configurazioni «accesso» eventualmente salvate).
