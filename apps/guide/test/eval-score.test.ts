import { describe, expect, it } from "vitest";
import type { AskAnswer } from "../lib/ask.ts";
import { countSentences, scoreAnswer, scoreNote } from "../lib/eval-score.ts";

const dest = "it.test.borgo-di-prova";
const opts = { destination: dest, locale: "it" as const, depth: "auto" as const };
const answer = (o: Partial<AskAnswer> = {}): AskAnswer => ({ status: "answered", answer: "La porta è medievale. Guarda l'arco.", citations: [`${dest}:porta-arco`], origin: "local", ...o });

describe("punteggio automatico delle prove", () => {
  it("una risposta conforme supera i controlli", () => {
    const s = scoreAnswer({ status: "answered", cite: ["porta-arco"] }, answer(), opts);
    expect(s).toMatchObject({ statusOk: true, missingCites: [], bannedWords: [], markdown: false, tooLong: false, pass: true });
    expect(scoreNote(s)).toBe("—");
  });

  it("accetta più esiti e non giudica l'esito delle risposte con ricerca", () => {
    expect(scoreAnswer({ status: ["partial", "answered"] }, answer(), opts).statusOk).toBe(true);
    expect(scoreAnswer({ status: "not_in_knowledge" }, answer(), opts)).toMatchObject({ statusOk: false, pass: false });
    expect(scoreAnswer({ status: "not_in_knowledge" }, answer({ origin: "web" }), opts).statusOk).toBeNull();
  });

  it("segnala citazioni mancanti, comprese distanze e persona", () => {
    const s = scoreAnswer({ cite: ["porta-arco", "altra", "context:position", "persona:gaia"] }, answer(), opts);
    expect(s.missingCites).toEqual(["altra", "context:position", "persona:gaia"]);
    expect(scoreAnswer({ cite: ["context:position", "persona:gaia"] }, answer({ usedPosition: true, usedPersona: true }), opts).missingCites).toEqual([]);
  });

  it("segnala parole vietate, markdown e risposte troppo lunghe", () => {
    expect(scoreAnswer({}, answer({ answer: "Un panorama mozzafiato." }), opts).bannedWords).toEqual(["mozzafiato"]);
    expect(scoreAnswer({}, answer({ answer: "Date:\n- 1220\n- 1240" }), opts).markdown).toBe(true);
    expect(scoreAnswer({}, answer({ answer: "**Nota**: la porta." }), opts).markdown).toBe(true);
    const long = Array.from({ length: 8 }, (_, i) => `Frase ${i}.`).join(" ");
    expect(scoreAnswer({}, answer({ answer: long }), opts).tooLong).toBe(true);
    expect(scoreAnswer({}, answer({ answer: long }), { ...opts, depth: "deep" }).tooLong).toBe(false);
  });

  it("una risposta scartata dal validatore non supera i controlli", () => {
    expect(scoreAnswer({}, answer({ status: "rejected" }), opts).pass).toBe(false);
  });

  it("riporta le citazioni su un altro luogo", () => {
    const s = scoreAnswer({}, answer({ otherPlaceCitations: [`${dest}:torre-controllo`] }), opts);
    expect(scoreNote(s)).toContain("altro luogo: torre-controllo");
  });

  it("conta le frasi", () => {
    expect(countSentences("Una. Due! Tre? Quattro…")).toBe(4);
    expect(countSentences("")).toBe(0);
  });
});
