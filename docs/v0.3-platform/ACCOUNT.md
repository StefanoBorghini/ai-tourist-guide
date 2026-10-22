# Account dei visitatori nella PWA (2026-10-14)

Passo 3 del piano (`PIANO-COMMERCIALE.md` §5 e §11). Gli account servono solo ad acquistare e a ritrovare gli acquisti:
guida, mappa e racconti gratuiti funzionano senza. **Spenti finché non li attivi** (variabili qui sotto): senza, le
pagine dicono «Gli account non sono ancora disponibili» e la pagina iniziale non mostra il link.

## Cosa c'è

| Pagina | Cosa fa |
|---|---|
| `/account/registrati` | Email, password (8–72 caratteri, ripetuta), lingua, accettazione delle condizioni e presa visione dell'informativa (obbligatorie, controllate anche sul server). Invia l'email di conferma. Stessa risposta per indirizzi nuovi e già registrati: nessuno scopre chi ha un account |
| `/account/conferma` | Dopo la registrazione: cosa fare con l'email, consigli (spam, scadenza del link) e «Invia di nuovo l'email». Pubblica, l'indirizzo non passa nell'URL |
| `/account/accedi` | Email e password; accesso social se attivo. Ritorno alla pagina richiesta solo se interna (`safeNext`) |
| `/account/password` | Link per una nuova password. Stessa risposta per indirizzi registrati e non |
| `/auth/confirm` | Link delle email (conferma, recupero): `token_hash` (consigliato, funziona anche su un altro dispositivo) oppure `code` (modello predefinito di Supabase, solo nello stesso browser) |
| `/auth/reimposta` | Nuova password, dal link di recupero o dal profilo |
| `/auth/callback` | Ritorno dall'accesso social e dal collegamento di un metodo: annullamento, link scaduto e identità già usata diventano messaggi chiari |
| `/account` | Profilo (nome facoltativo, lingua), «I miei acquisti» (vuoto finché non c'è il catalogo), metodi di accesso con «Collega Google/Apple» esplicito, cambio password, scarica i tuoi dati, esci, esci da tutti i dispositivi |
| `/account/esporta` | I dati dell'account in JSON (`export_my_data()` più i dati dell'accesso), mai in cache |
| `/account/elimina` | Eliminazione con conferma scritta («ELIMINA»): `delete_my_account()` cancella utente, profilo, consensi e diritti; gli ordini restano senza collegamento all'utente (D8) |

**Regole:**
- utente sempre verificato sul server (`getUser`), dati solo con l'identità dell'utente e le policy «solo i propri»: nessuna chiave di servizio;
- esiti ed errori nell'indirizzo solo come **codici** (`?ok=`, `?errore=`): un link non può far comparire un messaggio inventato;
- consensi: arrivano nei metadati alla registrazione (prima della conferma non c'è sessione) e si scrivono in `consents` al primo accesso, una volta per versione;
- `/account` e `/auth` mai nel service worker né in cache (`private, no-store`), `noindex`;
- un account visitatore non entra nello Studio: serve un ruolo assegnato dall'amministratore;
- nessuna migrazione: si usano `profiles`, `consents`, `export_my_data()`, `delete_my_account()` già presenti.

Codice: `lib/account/shared.ts` (regole pure, `test/account.test.ts`), `lib/account/server.ts`, `app/account/`,
`app/auth/`, `proxy.ts` (sessione e rinvio all'accesso).

## Configurazione (da fare tu)

### Variabili su Vercel

Le `NEXT_PUBLIC_*` entrano nel codice **al build**: dopo averle cambiate serve un nuovo deploy.

| Variabile | Esempio | Note |
|---|---|---|
| `NEXT_PUBLIC_ACCOUNTS_ENABLED` | `1` | Interruttore. Senza, account spenti |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | già impostate | Le stesse dello Studio |
| `NEXT_PUBLIC_TERMS_URL` | `/condizioni` o `https://…` | Condizioni d'uso. **Testo da far scrivere/verificare**: non lo scrivo io |
| `NEXT_PUBLIC_PRIVACY_URL` | `/privacy` o `https://…` | Informativa privacy (stessa nota) |
| `NEXT_PUBLIC_LEGAL_VERSION` | `2026-10` | Versione dei due testi: registrata con ogni consenso. Cambiala quando cambiano i testi |
| `NEXT_PUBLIC_AUTH_PROVIDERS` | vuota, poi `google` o `google,apple` | Solo dopo averli configurati in Supabase |

Senza condizioni, informativa e versione gli account restano spenti anche con l'interruttore a `1`.

### Supabase → Authentication

1. **Sign In / Providers → Email:** attivo; **Confirm email** attivo; «Allow new users to sign up» attivo.
2. **URL Configuration:** *Site URL* = indirizzo di produzione; *Redirect URLs* = `https://<dominio>/auth/confirm**`,
   `https://<dominio>/auth/callback**` e gli stessi per l'anteprima Vercel.
3. **Emails → SMTP:** un SMTP proprio. Quello incluso in Supabase invia pochissime email l'ora ed è solo per le prove.
4. **Emails → Templates** (italiano, link con `token_hash`):
   - *Confirm signup* — oggetto «Conferma il tuo indirizzo · AI Guide», link:
     `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/account`
   - *Reset password* — oggetto «Nuova password · AI Guide», link:
     `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`

   Con i modelli predefiniti (`{{ .ConfirmationURL }}`) funziona lo stesso, ma solo se il link si apre nello stesso browser.
5. **Password:** lunghezza minima 8 (come l'app); facoltativo il controllo delle password trapelate.
6. **Collegamento delle identità (D5):** attiva *Manual linking* solo quando attivi Google o Apple. Il collegamento
   automatico di Supabase per email verificata va valutato prima: l'app propone solo quello manuale dal profilo.

### L'email di conferma non arriva

Il codice chiede l'invio a Supabase; l'email la manda il servizio configurato in **Emails → SMTP**. Nell'ordine:

1. **SMTP proprio non configurato.** Quello incluso in Supabase scrive solo agli indirizzi del team del progetto e con
   un limite di poche email l'ora: per chiunque altro l'email non parte. Serve un fornitore (per esempio Resend, Brevo,
   Postmark, Amazon SES) con il dominio del mittente verificato (SPF e DKIM), poi host, porta, utente e password in
   *Emails → SMTP* e un mittente del tipo `AI Guide <no-reply@dominio>`.
2. **Limite di invio.** In *Rate Limits* il limite delle email l'ora: con l'SMTP proprio si può alzare.
3. **Spam.** Senza SPF/DKIM sul dominio del mittente le email finiscono spesso nella posta indesiderata.
4. **Link.** *URL Configuration* (punto 2 qui sopra) deve contenere il dominio da cui ci si registra, compresa
   l'anteprima Vercel; altrimenti il link porta al *Site URL*.

L'app aiuta a capirlo: se il servizio rifiuta l'invio il visitatore legge «In questo momento non riusciamo a inviare
l'email» (codice `invio-email`) e nei log del server compare `[account] errore in registrazione: codice=… stato=…`
(mai l'indirizzo email). Dopo la registrazione la pagina `/account/conferma` spiega cosa fare e ha «Invia di nuovo
l'email» (`auth.resend`, stessa risposta per indirizzi registrati e no); l'accesso con l'indirizzo non confermato porta
lì con un link.

### Google e Apple (dopo)

Credenziali nei rispettivi pannelli (client OAuth Web; Services ID e chiave «Sign in with Apple», con account Apple
Developer), poi *Providers* in Supabase, poi `NEXT_PUBLIC_AUTH_PROVIDERS` e nuovo deploy. Il codice è pronto ma non è
provato con i provider reali: si prova in anteprima.

## Prove

- `test/account.test.ts`: configurazione, pagine protette, redirect solo interni (anche «..», «%2e», «//», «\\»),
  password, messaggi solo da codici, errori di Supabase, consensi una volta per versione, service worker.
- Prova end-to-end nel browser (48 controlli) su Postgres con tutte le migrazioni, PostgREST e un sostituto locale
  dell'autenticazione: registrazione con errori, email già registrata, accesso prima della conferma, link non valido,
  conferma, consensi nel database, profilo, esportazione, uscita, ritorno solo interno, recupero password (link usato
  una volta sola), uscita da tutti i dispositivi, niente Studio per un visitatore, eliminazione con verifica nel database,
  telefono. **Non provati con il Supabase reale** né con Google e Apple: vanno verificati in anteprima dopo la configurazione.

## Cosa manca (passi successivi del piano)

Catalogo e prezzi nello Studio, checkout Stripe, diritti dagli acquisti, crediti AI, «I miei acquisti» popolato.
