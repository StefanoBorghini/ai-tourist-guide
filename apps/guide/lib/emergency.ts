/**
 * Riconoscimento delle emergenze senza modello: parole chiave in italiano e in inglese.
 *
 * Un'emergenza (malore, persona dispersa, incidente, pericolo) deve ricevere subito il rimando al 112,
 * anche senza rete, senza modello configurato, oltre i limiti d'uso o se il modello sbaglia
 * classificazione. Per questo il controllo è deterministico e gira prima di tutto: nel browser prima
 * della richiesta, nella route prima di limiti e configurazione, in askGuide prima del modello.
 * Il modello resta una seconda rete (esito "safety") per i casi che le parole chiave non coprono.
 *
 * Meglio un falso positivo (una risposta con il 112 di troppo) che un'emergenza mancata, ma le
 * domande di storia ("Byron annegò?", "il castello è caduto") non devono scattare: i modelli
 * richiedono un soggetto o un tempo presente. Logica pura, importata anche dal client.
 */

/** Testo normalizzato: minuscole, senza accenti, spazi semplici, apostrofi uniformi. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’`´]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const PERSON = "(?:mio|mia|nostro|nostra|un|una|il mio|la mia|il nostro|la nostra|questo|questa|quel|quella)\\s+\\w+";

const PATTERNS: RegExp[] = [
  // ---------------------------------------------------------------- italiano
  /\b(?:mi sento|si sente|sto|sta|stiamo) (?:molto |tanto |davvero )?male\b/,
  /\bdolor[ei] (?:forte |fort[ie] )?(?:al|nel|sul) petto\b/,
  /\bdolore toracico\b/,
  /\b(?:infarto|ictus|arresto cardiaco|shock anafilattico|reazione allergica)\b/,
  /\bnon (?:respira|respiro|respiriamo|riesco a respirare|riesce a respirare)\b/,
  /\b(?:fatica|difficolta) a respirare\b/,
  /\b(?:e|sono) svenut[oaie]\b/,
  /\b(?:ha perso|ho perso) (?:i sensi|conoscenza)\b/,
  /\b(?:incosciente|non risponde piu)\b/,
  /\b(?:sanguina|sanguinando|perde sangue|perdo sangue|emorragia)\b/,
  /\b(?:mi sono|si e|ci siamo|si sono) fatt[oaie] male\b/,
  /\b(?:sono|siamo) cadut[oaie]\b/,
  new RegExp(`\\b${PERSON} e (?:cadut[oa]|svenut[oa]|ferit[oa])\\b`),
  /\b(?:e|sono|siamo) ferit[oaie]\b/,
  /\b(?:sta|stanno|stiamo|sto) annegando\b/,
  // "si è perso" solo per una persona: "la tradizione si è persa" non è un'emergenza.
  /\b(?:figli[oa]|bambin[oa]|nipote|nonn[oa]|amic[oa]|marito|moglie|madre|padre|mamma|papa|fratello|sorella|ragazz[oa]) si e pers[oa]\b/,
  /\bnon (?:trovo|troviamo) piu (?:mio|mia|il mio|la mia|nostro|nostra|i miei|le mie)\b/,
  /\bho perso (?:mio|mia|il mio|la mia|nostro|nostra) (?:figli|bambin|nipot)/,
  /\b(?:c'e|ce|c'e stato|ce stato|abbiamo avuto|ho avuto|ha avuto) un incidente\b/,
  /\b(?:c'e|ce) (?:un )?(?:incendio|fuoco)\b/,
  /\b(?:morso|morsa|punto|punta) da (?:una? )?(?:vipera|serpente|cane|vespa|ape|medusa|calabrone)\b/,
  /\b(?:sono|siamo|qualcuno e|una persona e|un bambino e|una bambina e) in pericolo\b/,
  /\b(?:ambulanza|soccorsi|emergenza)\b/,
  /\baiutatemi\b/,
  /\baiutami\b(?! a (?:capire|trovare|scegliere|organizzare|conoscere|scoprire))/,
  /(?:^|[.!?] ?)aiuto\b(?! a (?:capire|trovare|scegliere))/,
  // ---------------------------------------------------------------- inglese
  /\b(?:i|we|he|she|they|someone|somebody) (?:feel|feels|am|is|are) (?:very |really )?(?:sick|unwell|ill)\b/,
  // "stroke", "seizure", "collapsed" e "drowning" da soli no: pennellate, assedi, torri crollate, Shelley.
  /\b(?:chest pain|heart attack|anaphylactic|allergic reaction)\b/,
  /\b(?:having|had) a (?:stroke|seizure)\b/,
  /\b(?:can'?t|cannot|can not|not|isn'?t|is not) breath(?:e|ing)\b/,
  /\b(?:fainted|passed out|unconscious)\b/,
  /\b(?:i|we|he|she|they|someone|somebody|my \w+) (?:has |have |just )?collapsed\b/,
  /\bbleeding\b/,
  /\b(?:i|we|he|she|they|someone|somebody|my \w+) (?:fell|has fallen|have fallen|got hurt|is hurt|am hurt|are hurt|is injured|am injured|are injured)\b/,
  /\b(?:is|are|am) drowning\b|\bsomeone drowning\b/,
  /\b(?:lost|can'?t find|cannot find) (?:my|our) (?:child|son|daughter|kid|kids|baby|boy|girl|grandson|granddaughter)\b/,
  /\b(?:child|son|daughter|kid|baby|boy|girl|grandson|granddaughter|wife|husband|mother|father|mum|mom|dad|friend) (?:is|got|has got|has gone|went) (?:lost|missing)\b|\bmissing child\b/,
  /\b(?:had|there'?s been|there has been|there is|there'?s) an accident\b|\bcar accident\b/,
  /\b(?:there'?s|there is) a fire\b|\b(?:is|are) on fire\b/,
  /\b(?:bitten|stung) by\b/,
  /\b(?:i am|i'm|we are|we're|someone is|he is|she is|they are) in danger\b/,
  /\b(?:ambulance|emergency)\b/,
  /\bhelp me\b(?! (?:understand|find|choose|plan|learn|know|see|pick|decide|discover|with))/,
  /(?:^|[.!?] ?)help\b(?! (?:me )?(?:understand|find|choose|plan|learn|with))/,
  // ---------------------------------------------------------------- numeri d'emergenza citati
  /\b(?:112|113|115|118|911|999)\b/,
];

/** La domanda segnala un'emergenza? */
export function detectEmergency(question: string): boolean {
  const text = normalize(question);
  return PATTERNS.some((re) => re.test(text));
}
