# AI Tourist Guide — Directory gratuita delle attività locali

Data: 2026-10-11 · Stato: **decisioni approvate per la specifica. Non implementato.**
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
