# Domande senza risposta

Registro delle domande dei visitatori a cui la guida non ha saputo rispondere del tutto. Serve alla redazione per
trovare le lacune del Territory Pack. Le domande non diventano mai contenuti da sole: si aggiungono affermazioni
con fonte e verifica, come sempre.

- Migrazione: `supabase/migrations/20261103000000_question_gaps.sql` (revoca in `supabase/rollback/`).
- Codice:
  - `apps/guide/lib/question-gaps.ts`: cosa registrare, logica pura;
  - `apps/guide/lib/question-gaps-server.ts`: chiamata al database;
  - `app/api/guide/ask/route.ts`: collegamento con la route delle domande;
  - scheda «Domande» dello Studio: `app/studio/[pack]/domande/`, `app/studio/actions-questions.ts`, `lib/studio/question-gaps.ts`.
- Test:
  - `test/question-gaps.test.ts` e `test/ask-route.test.ts`;
  - `supabase/tests/99c_question_gaps.sql` e la parte Q8 di `supabase/tests/concurrent.sh`.

## Quando si registra una domanda

Decide l'esito della risposta, non le parole della domanda.

| Tipo | Quando |
|---|---|
| `not_in_knowledge` | il modello dichiara che la base non contiene l'informazione |
| `partial` | la base la contiene solo in parte; anche quando la risposta arriva dalla cache, senza chiamare il modello |
| `rejected` | la risposta del modello non ha superato i controlli di citazioni e numeri |
| `web_answer` | la risposta è stata completata con la ricerca online; le fonti trovate restano da verificare (solo con la ricerca automatica, `ASK_WEB_AUTO=1`) |
| `web_unavailable` | serviva la ricerca online ma non era possibile: spenta, limiti, errore (solo con `ASK_WEB_AUTO=1`) |
| `ambiguous` | la domanda rimandava a un luogo («qui», «questo») ma non c'era un luogo aperto o corrente |

Non si registrano mai:
- le risposte complete;
- le domande fuori tema;
- le emergenze;
- i servizi non disponibili (errori, limiti, budget);
- gli «Approfondisci», perché la prima domanda è già stata contata.

La registrazione parte dopo la risposta al visitatore: non la rallenta, non la cambia e non fa chiamate al modello. Un errore del database lascia solo un log con il codice dell'errore, senza testo e senza chiave.

## Cosa si conserva, e cosa no

**Una riga per domanda distinta**, cioè stessa destinazione, lingua e testo normalizzato (minuscolo, senza punteggiatura). La riga contiene:
- un contatore;
- la prima e l'ultima data (solo il giorno, nessun orario);
- il testo della domanda mascherato, al massimo 300 caratteri;
- il luogo come riferimento del pack, solo se è un luogo della base caricata: i riferimenti arrivano dal dispositivo, e un testo
  qualsiasi al loro posto non si registra;
- il tipo di lacuna e, per le risposte scartate, solo il tipo di controllo non superato (non i dettagli, che riprendono
  testo della risposta del modello);
- per le risposte con ricerca: indirizzo e titolo di al massimo 5 fonti;
- la versione della base e delle istruzioni;
- lo stato della revisione.

**Non si conservano** risposte, cronologia della conversazione, posizione GPS, indirizzo IP, account, dispositivo o orari precisi. L'indirizzo IP serve solo, in memoria, al limite di 5 righe ogni 10 minuti per indirizzo.

**Mascheramento automatico** (`redactForLog` in `lib/ask-web.ts`): indirizzi web, email, IBAN, codici fiscali e numeri di almeno 9 cifre (telefoni, carte).

**Limiti del mascheramento:**
- riconosce solo forme fisse;
- nomi di persone, indirizzi di casa, targhe, date di nascita e riferimenti scritti a parole restano nel testo.

**Il testo quindi non è anonimo**, e non va presentato come tale. Lo proteggono:
- la lettura riservata;
- la scadenza;
- la possibilità di eliminare una domanda dallo Studio.

## Accesso

| Chi | Cosa può fare |
|---|---|
| Browser, visitatori (`anon`, `authenticated` senza permessi) | niente: né leggere né scrivere né eseguire le funzioni |
| Server della guida (ruolo di servizio) | solo `gap_record()`; nessun privilegio diretto sulle tabelle, nemmeno in lettura |
| Chi può modificare il territorio (`can_edit_pack`) | leggere le domande del proprio territorio, cambiarne lo stato, eliminarle, dallo Studio |

**Chiave di servizio:**
- è usata solo in `lib/question-gaps-server.ts`, che chiama soltanto `gap_record()`;
- non arriva al browser e non compare nei log.

**Revisione:** stato e autore li registra il database (`studio_set_question_gap_status`). Gli stati sono:
- da vedere;
- in programma;
- coperta;
- ignorata.

## Scadenza e cancellazione

- **Scadenza:** ogni domanda scade 90 giorni dopo l'ultima volta che è stata fatta. Da quel giorno non si legge più nello Studio.
- **Cancellazione delle scadute:** ogni nuova registrazione cancella fino a 100 righe scadute, senza processi pianificati.
- **Cancellazione a mano:** dallo Studio, con conferma, per chi può modificare il territorio.
- **Revoca della migrazione:** cancella tutte le domande, perché sono dati operativi a scadenza. Se servono, esportale prima.

## Contro abusi e costi

- **Freni prima della registrazione:** la riga si scrive solo dopo password del sito, limite di domande per indirizzo, budget e tetto di spesa. Le emergenze sono escluse.
- **Per indirizzo:** al massimo 5 righe ogni 10 minuti. Il limite è in memoria, quindi vale per istanza del server.
- **Tetto globale:** al massimo **500 righe nuove al giorno** per tutte le destinazioni. Il conteggio è atomico nel database: la riga del giorno è bloccata dall'upsert, quindi le richieste simultanee non superano il tetto. Oltre il tetto le domande già viste continuano a contare.
- **Contatore:** la stessa domanda ripetuta fa crescere un contatore, con un massimo di 10.000, non la tabella. Un abuso può gonfiare un contatore, non riempire il database.
- **Nessuna chiamata AI in più.**
- **Spazio:** con il tetto e la scadenza, la tabella resta sotto circa 45.000 righe, circa 50 MB nel caso peggiore. Rientra nel piano gratuito di Supabase.
- **Tempo:** una chiamata al database dopo la risposta, con un massimo di 2 secondi.

## Attivazione (quando la decide il proprietario)

1. **Database reale:**
   - applicare `20261103000000_question_gaps.sql` dal SQL Editor;
   - eseguire `supabase/tests/remote-check.sql`, che deve dare `superato`.
2. **Informativa privacy:** aggiornarla prima di accendere il registro per il pubblico (vedi sotto).
3. **Variabili del server su Vercel:**
   - `QUESTION_GAPS_ENABLED=1`;
   - `NEXT_PUBLIC_SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` già presenti per Studio e pagamenti.
4. **Redeploy**, poi verifica:
   - una domanda senza risposta compare nello Studio con contatore 1;
   - la stessa domanda di nuovo porta il contatore a 2;
   - nessun orario o indirizzo nella riga.

**Senza `QUESTION_GAPS_ENABLED=1` non si registra nulla**, anche con la migrazione applicata.

## Informativa privacy: testo da aggiungere prima dell'attivazione pubblica

**Dov'è l'informativa.** Non è nel repository. L'app la collega con la variabile `NEXT_PUBLIC_PRIVACY_URL` (pagina di
registrazione degli account), impostata su Vercel. Nell'app non esiste una pagina `/privacy`: se la variabile vale
`/privacy`, il collegamento oggi non funziona. Il testo qui sotto va aggiunto alla pagina indicata da quella variabile.

**Testo proposto.** Da far rivedere a chi cura gli aspetti legali. Le parti tra parentesi quadre restano da completare:
qui non si inventano dati che il codice e la documentazione non stabiliscono.

> **Domande a cui la guida non sa rispondere**
>
> Quando fai una domanda alla guida e la guida non trova la risposta, o la trova solo in parte, ne conserviamo il
> testo per capire quali informazioni mancano e migliorare i contenuti. Non conserviamo le domande a cui la guida
> risponde, le richieste di aiuto in emergenza e le domande non pertinenti alla visita.
>
> **Cosa conserviamo.** Il testo della domanda, al massimo 300 caratteri, dopo aver mascherato in automatico
> indirizzi email, numeri di telefono e altri numeri lunghi, IBAN, codici fiscali e indirizzi web; la lingua; il luogo
> della guida aperto o in cui ti trovi, se c'è (il nome del luogo, non le coordinate); il tipo di esito (per esempio
> «informazione mancante» o «risposta parziale»); il giorno in cui la domanda è stata fatta la prima e l'ultima volta e
> quante volte è stata fatta; se la risposta è stata completata con una ricerca online, l'indirizzo e il titolo delle
> pagine trovate.
>
> **Cosa non conserviamo.** Le risposte della guida, la conversazione, la tua posizione GPS, il tuo indirizzo IP, il
> tuo account, il dispositivo e l'orario.
>
> **Non scrivere dati personali nelle domande.** Il mascheramento automatico riconosce solo alcune forme fisse: nomi,
> indirizzi e altri dati scritti a parole possono restare nel testo.
>
> **Chi può leggerle.** Solo le persone della redazione autorizzate a modificare i contenuti di quel territorio, dallo
> strumento di redazione. Le domande non sono pubbliche e non diventano contenuti della guida da sole.
>
> **Per quanto tempo.** Una domanda si cancella 90 giorni dopo l'ultima volta che qualcuno l'ha fatta: se la stessa
> domanda viene ripetuta, il periodo riparte. La redazione può cancellarla prima.
>
> **Dove.** In un database gestito da Supabase [regione del progetto: da verificare].
>
> **Per quale motivo e su quale base.** Migliorare i contenuti della guida. [Base giuridica: da definire con il
> consulente.]
>
> **I tuoi diritti.** [Titolare e contatti: da completare.] Le domande non sono collegate alla tua identità: per
> chiedere la cancellazione di una domanda indicane il testo.

**Da verificare prima di pubblicare** (il codice non lo stabilisce):
- titolare del trattamento e contatti;
- base giuridica ed eventuale valutazione d'impatto;
- regione del progetto Supabase e accordi con i fornitori (Supabase, Vercel, Anthropic);
- **log del server su Vercel.** Per le domande senza risposta il server scrive anche un log con il testo mascherato (evento
  `knowledge_gap`, già prima di questo registro), conservato secondo il piano di Vercel: circa un'ora sul piano Hobby,
  verificato il 22/10. Va indicato se l'informativa ne parla;
- **invio delle domande al modello.** Ogni domanda, con o senza risposta, è inviata ad Anthropic per generare la
  risposta, ed eventualmente alla sua ricerca online. Va verificato che l'informativa esistente lo dica: non riguarda
  solo questo registro;
- coerenza con il resto dell'informativa, con la versione `NEXT_PUBLIC_LEGAL_VERSION` (che va aumentata se cambia il
  testo accettato alla registrazione) e con la lingua inglese.
