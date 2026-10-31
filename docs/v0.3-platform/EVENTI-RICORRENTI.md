# Eventi ricorrenti

Migrazione `supabase/migrations/20261109000000_recurring_events.sql` (revoca in `supabase/rollback/`), test
`supabase/tests/99h_recurring_events.sql`. Si aggiunge agli eventi del giorno (`20261031000000_local_events.sql`) senza
tabelle nuove e senza toccare gli eventi esistenti, che restano «non si ripete».

## Cosa si può scegliere (Studio → Eventi → evento → «Si ripete»)

| Ricorrenza | Opzioni | Esempio |
|---|---|---|
| Ogni giorno | ogni N giorni | «Ogni giorno», «Ogni 3 giorni» |
| Ogni settimana | giorni della settimana, ogni N settimane | «Ogni sabato e domenica», «Ogni 2 settimane: venerdì» |
| Ogni mese | stesso giorno (il 17), stessa posizione (il terzo sabato), l'ultimo di quel giorno (l'ultima domenica); ogni N mesi | «Ogni mese, la terza domenica» |
| Ogni anno | ogni N anni | «Ogni anno, il 17 agosto» |

Per tutte: **fino al** (facoltativo, senza data la serie continua) e **date escluse** (per saltare una singola data).

## Regole

- La data di inizio è la prima data della serie e deve rispettare la regola (un sabato, se si ripete il sabato).
- Ogni data ha gli stessi orari e la stessa durata della prima (anche oltre la mezzanotte).
- Al salvataggio il database controlla ogni data fino alla fine della serie (tre anni se non ha fine, dieci al
  massimo): nessuna sovrapposizione, nessun orario che il cambio dell'ora rende inesistente o doppio.
- Mensile «giorno 31»: i mesi senza il 31 si saltano. Annuale il 29 febbraio: solo negli anni bisestili.
- Cambiare la ricorrenza è come cambiare le date: azzera la verifica della fonte (su un evento pubblicato serve spuntare
  la verifica, o ritirarlo prima).
- Annullato, rinviato, da confermare valgono per tutta la serie. Una data singola annullata va tra le date escluse.
- Una serie è conclusa dopo la sua ultima data; una serie senza fine non si conclude mai.

## Lettura pubblica e app

`public_local_events` (e quindi `GET /api/v1/events`) restituisce un elemento per ogni data della serie nel periodo
richiesto: `id` è `<evento>@<data>`, `eventId` l'evento, `start`/`end`/`startsAt`/`endsAt` quelli di quella data,
`recurrence` la regola (null per un evento singolo, che resta identico a prima). La guida mostra sotto il titolo
«Ogni sabato e domenica» / «Every Saturday and Sunday». Le regole sono le stesse nel database (`local_event_occurs`)
e in `apps/guide/lib/local-events.ts` (`occursOn`, `nextOccurrences`, `recurrenceLabel`), con test su entrambi i lati.
