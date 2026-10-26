# Esempi di riferimento di Gaia

Bozza 0.1 · primo passo verso un modello aperto allenato per Gaia, per non dipendere da un solo fornitore.

## A cosa servono

Per ogni domanda della suite di prova (`GAIA-EVAL.<lingua>.json` nel Territory Pack) c'è la risposta che
vorremmo da Gaia, scritta solo con le affermazioni della base e con le loro citazioni. Servono a:

- **misurare** un modello: quanto le sue risposte si avvicinano a quelle approvate;
- **allenare** un modello aperto (LoRA o fine-tuning) a parlare come Gaia e a rispettare le regole: citare, non
  inventare, dichiarare la certezza, rimandare al 112 nelle emergenze, restare neutrale.

L'allenamento non aggiunge conoscenze: i fatti restano nel Territory Pack e arrivano al modello con la base,
come oggi. Un modello allenato impara la voce e il comportamento, non la storia dei luoghi.

## Il file

`territories/<destinazione>/GAIA-EXAMPLES.<lingua>.json`:

```json
{
  "suite": "GAIA-EXAMPLES",
  "version": "0.1.0",
  "destination": "it.liguria.sp.portovenere",
  "locale": "it",
  "questions": "GAIA-EVAL.it.json",
  "examples": [
    {
      "id": "a01-sl-com-e",
      "status": "answered",
      "answer": "San Lorenzo è una chiesa romanica a tre navate. …",
      "citations": ["sl-romanica", "sl-facciata"],
      "approved": false,
      "by": "redazione, 2026-10-23",
      "note": "facoltativa"
    }
  ]
}
```

- `id` è quello della domanda di prova; `status` e `citations` come nella risposta della produzione.
- Le citazioni possono essere brevi (`sl-romanica`); `context:position` per le distanze calcolate dal sistema,
  `persona:gaia` per le frasi su di sé. Un'emergenza (`safety`) non cita nulla.
- `approved` lo mette a `true` solo la redazione, dopo aver letto la risposta.

## Controllo

```
npm run gaia:examples -w @guide/app -- --file ../../territories/<id>/GAIA-EXAMPLES.it.json
```

Senza opzioni il controllo usa il bundle pubblicato. Per una destinazione con l'esplorazione a pagamento, il bundle pubblico ha solo le panoramiche: gli esempi che citano altri fatti non passano. Per controllarli sulla base completa, compilata sul proprio computer da una fotografia del database o dai file, si usa `--pack <cartella> --full` (solo valutazione locale, vedi `PROVIDER-ALTERNATIVI.md` §6.1). Il 26/10, sulla fotografia del 25/10, sono passati 162 esempi su 163 con la base completa e 69 su 163 con quella pubblica.

Nessuna chiamata a modelli, nessun costo. Ogni esempio passa dagli stessi controlli della produzione
(`checkModelAnswer`: citazioni esistenti, numeri e secoli presi dalle fonti, 112 nelle emergenze) e dal punteggio
automatico (`lib/eval-score.ts`: esito e citazioni attesi, parole vietate, niente markdown, lunghezza). Le righe con
`!` vanno rilette: per esempio una caratteristica attribuita apertamente a un altro luogo, lecita solo se la
risposta lo dice.

## Approvazione

La redazione legge ogni risposta con le rubriche (`RUBRICHE.md`) e la Character Bible, corregge il testo se
serve, rilancia il controllo e solo allora mette `approved: true` e `by`. Un esempio che non supera il controllo
non si approva: insegnerebbe a sbagliare.

Le risposte rispecchiano la base del momento. Quando la base cambia (affermazioni nuove, verificate o ritirate),
gli esempi interessati si riscrivono e si riapprovano. Oggi la base di Porto Venere è un'anteprima con affermazioni
in revisione, per questo molte risposte dicono «secondo le informazioni raccolte finora».

## Esportazione per l'allenamento

```
npm run gaia:examples -w @guide/app -- --file … --out allenamento.jsonl
```

Scrive solo gli esempi approvati, uno per riga, nel formato a messaggi (`system`, `user`, `assistant`) accettato
dai principali strumenti di fine-tuning. `system` è il prompt della produzione (regole, persona, base), `user` il
contesto e la domanda come li costruisce l'app, `assistant` la risposta in JSON. Il modello allenato risponde così
nel formato che la produzione si aspetta, e le sue risposte passano dagli stessi controlli. `--include-drafts`
esporta anche le bozze: solo per provare gli strumenti, mai per un allenamento vero.

## Prossimi passi (ciascuno da autorizzare)

1. Approvazione degli esempi italiani; versione inglese da `GAIA-EVAL.en.json`.
2. Più esempi: alcune centinaia per lingua, comprese le domande vere dei visitatori (anonimizzate) e le
   conversazioni a più turni.
3. Confronto di 2–3 modelli aperti sulla suite, senza allenamento (`ASK_PROVIDER=openai-compatible`).
4. Allenamento leggero del migliore sugli esempi approvati, e confronto con il modello di oggi.
