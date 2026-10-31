# Acquisto progressivo

Decisioni del proprietario del 31/10/2026, migrazione `supabase/migrations/20261107000000_progressive_purchase.sql`.
Si aggiunge a catalogo ([CATALOGO.md](CATALOGO.md)), pagamenti ([PAGAMENTI.md](PAGAMENTI.md)) e consegna
([CONSEGNA-CONTENUTI.md](CONSEGNA-CONTENUTI.md)), senza cambiare ciò che c'era: i prodotti e i prezzi esistenti restano
come sono.

## Livelli

| Livello | Prodotto | Diritto | Comprende | Listino proposto |
|---|---|---|---|---|
| Contenuto singolo | `unit` | `unit` | un sottoluogo (un luogo principale si compra solo intero, migrazione `20261108000000`) | 0,99 € |
| Luogo principale | `place` | `place` | il luogo e tutti i suoi sottoluoghi, **anche quelli aggiunti dopo** | 2,99 € |
| Destinazione | `explore` | `explore` | ogni luogo della destinazione, anche quelli aggiunti dopo | 9,99 € |
| Tutte le destinazioni | `all` (senza destinazione) | `all` | ogni destinazione con l'esplorazione a pagamento, **anche quelle pubblicate dopo** | 19,99 € |

I percorsi restano separati: non contano nei calcoli e nessun livello li comprende. Chi compra singoli contenuti riceve
solo quelli: i contenuti aggiunti in seguito arrivano solo a chi ha il luogo, la destinazione o tutte.

## Unità acquistabili

Il calcolo conta le **unità** (`commerce_units`), con un criterio rigoroso (decisione del 01/11/2026): solo contenuti
**pubblicati, verificati e disponibili**. Un luogo non gratuito è un'unità solo se, nella pubblicazione in linea (l'ultima
riuscita, la stessa dell'indice pubblico) e nella lingua principale della destinazione:

- ha il suo file privato `unit-<luogo>` (i suoi racconti a pagamento: per un luogo principale quelli oltre la
  panoramica, che resta gratuita);
- quel file è presente nel bucket `premium`;
- il file contiene almeno un racconto con **tutte** le affermazioni verificate.

La pubblicazione scrive nel manifest pubblico, per ogni file `unit`, solo due numeri: `stories` (racconti propri del
luogo) e `verifiedStories` (quelli senza affermazioni in revisione). Contenuti in revisione, in bozza, non ancora
pubblicati, senza file o di una pubblicazione non riuscita non contano. Prima della prima pubblicazione con questi file
non c'è nessuna unità: niente sconti e niente contenuti singoli, i pacchetti costano il loro listino.

**Portovenere** (fase `research`, affermazioni ancora in revisione) oggi non ha unità: i suoi prodotti esistenti
restano in vendita come prima, al loro prezzo, finché la redazione non verifica i fatti e ripubblica.

I luoghi gratuiti (scheda Vendita) non sono unità. Ogni unità si conta una volta sola: un luogo comprato copre tutte le sue unità, la destinazione tutte
quelle della destinazione, «tutte» ogni unità.

## Prezzo

Il prezzo lo calcola solo il database (`commerce_quote`), sia per mostrarlo sia al checkout (`checkout_open`): il
browser invia solo il prodotto.

```
prezzo = arrotondamento al centesimo di  listino × (unità che mancano ÷ unità del livello)
```

- **Lo sconto raggiunto non scende.** Quando si aggiungono contenuti, vale la quota più alta registrata negli acquisti
  ancora validi dell'utente per quel livello (`purchases.progress`, in punti base).
- **Mai più dei singoli**, allo stesso modo per luogo, destinazione e tutte le destinazioni. Il prezzo non supera la
  somma dei contenuti singoli che mancano, ciascuno al **suo prezzo effettivo** (`commerce_single_price`: il prezzo
  proprio o di listino del suo prodotto «Contenuto singolo»; se non si vende da solo, la tariffa del contenuto singolo).
  Per questo un luogo con un solo contenuto costa quanto il singolo, e il singolo di quel luogo non si vende a parte
  (`catalog_problem_unit`).
- **Serve la tariffa del contenuto singolo.** Sconto e tetto valgono solo con la tariffa del contenuto singolo
  pubblicata; senza, i pacchetti costano il loro listino (come prima della migrazione). «Pubblica il listino» rifiuta
  di pubblicare le tariffe di luogo, destinazione o tutte se manca quella del contenuto singolo.
- **Minimo 0,50 €.** Se il resto costa meno di 0,50 € (il minimo di un pagamento con Stripe) il pacchetto non si vende:
  si comprano i singoli che mancano (esito `below_minimum`, messaggio nell'app e nella pagina d'acquisto).
- Esiti del preventivo: `ok`, `unpriced` (nessun prezzo pubblicato), `owned` (lo ha già), `complete` (ha già tutte le
  unità del livello: niente da comprare), `below_minimum`.

Esempio: un luogo da 2,99 € con 4 contenuti, di cui 2 già comprati: 2,99 × 2/4 = 1,495 → **1,50 €** (se i due singoli
che mancano costano di più, come 2 × 0,99 = 1,98 €).

## Listino

Tabella `price_tiers`, un prezzo per livello, uguale per tutte le destinazioni. Come i prezzi dei prodotti: bozza →
«Pubblica il listino» → pubblicato; un prezzo pubblicato non si cambia, si archivia. **La migrazione crea le quattro
tariffe in bozza: finché l'amministratore non le pubblica non cambia nulla.**

Un prodotto con un proprio prezzo pubblicato lo tiene (i prodotti esistenti, per esempio i luoghi a 1,99 €, non
cambiano). Nella sua scheda dello Studio, «Segui il listino» archivia il prezzo proprio e da quel momento vale la
tariffa del livello.

## Studio (scheda Vendita, sezione 3)

Solo l'amministratore della piattaforma.

- **Listino**: tariffa in bozza per livello, «Pubblica il listino».
- **Contenuti singoli**: «Metti in vendita i contenuti singoli» crea un prodotto `unit` attivo, al prezzo di listino,
  per ogni unità di un luogo che ne ha almeno due, e ritira quelli non più vendibili. Poi «Ripubblica con le
  modifiche», perché l'app riceva i file dei contenuti singoli.
- **Tutte le destinazioni**: si mette in vendita solo con almeno due destinazioni pubblicate con l'esplorazione a
  pagamento.
- **Ordini da rivedere**: vedi Rimborsi.

## Consegna

La pubblicazione produce, oltre ai file esistenti, un file privato `unit-<luogo>` per ogni luogo a pagamento, con i soli
racconti a pagamento di quel luogo (più ciò che serve a capirli). Lo legge solo chi ha il diritto `unit` su quel luogo
(`has_unit_right`): chi ha il luogo, la destinazione o tutte riceve gli stessi racconti dal file del luogo o
dell'esplorazione. `has_active_right('explore', …)` vale anche con il diritto `all`. I file `place-<luogo>` restano
uguali (compatibilità con le app già installate).

## Rimborsi

Il rimborso (totale o parziale) di un acquisto che ha contribuito allo sconto di un acquisto successivo
(`purchases.discount.basis`) segna quest'ultimo «da rivedere» (`review_reason`): compare nello Studio, che lo chiude con
«Rivisto». Nessuna revoca automatica dell'acquisto successivo; il diritto dell'acquisto rimborsato si revoca come
sempre (rimborso totale). Lo stesso vale per una contestazione persa.

## Sicurezza

- `commerce_quote`, `commerce_coverage`, `commerce_progress_*` accettano un id utente: solo il ruolo di servizio e le
  funzioni del database possono chiamarle. L'app usa `my_commerce_quotes`, che usa sempre l'utente della sessione.
- Il prezzo addebitato è quello del preventivo calcolato in `checkout_open`, sotto un lucchetto per utente (due checkout
  dello stesso utente non si sovrappongono); il webhook continua a controllare importo e valuta.
- L'ordine conserva listino, sconto applicato e acquisti che hanno contribuito.

## Note

- Le unità cambiano solo con una pubblicazione: verificare un fatto non basta, serve «Ripubblica con le modifiche».
  Un contenuto che esce dalla pubblicazione smette di contare e il suo prodotto singolo non è più vendibile da solo.
- Portovenere: la ristrutturazione in luoghi principali (borgo, Le Grazie, Fezzano, Palmaria) e sottoluoghi è
  redazionale e si fa nello Studio (scheda del luogo, «È un sottoluogo di»). Nessun dato è stato cambiato dalla
  migrazione.

## Luogo principale solo intero (01/11/2026, migrazione `20261108000000_principal_not_single.sql`)

Un luogo principale non si vende come contenuto singolo: si compra intero, con i suoi sottoluoghi. Come contenuto
singolo si vendono solo i sottoluoghi. I racconti propri del principale restano un'unità nel conteggio (comprati con il
luogo, la destinazione o tutte) e nel tetto dei singoli valgono la tariffa del contenuto singolo. I prodotti «Contenuto
singolo» di principali già creati escono subito dal listino; «Metti in vendita i contenuti singoli» li passa a
«ritirato». Chi li ha già comprati tiene il diritto. Nell'app la scheda di un principale non propone mai «Solo …».
