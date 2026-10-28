import { describe, expect, it } from "vitest";
import { detectEmergency } from "../lib/emergency.ts";

describe("riconoscimento delle emergenze senza modello", () => {
  it("riconosce le emergenze in italiano", () => {
    for (const q of [
      "Mi sento male, ho un forte dolore al petto.",
      "mio figlio si è perso vicino al castello, cosa faccio?",
      "Aiuto!",
      "aiutatemi per favore",
      "Mia moglie è svenuta",
      "Mio padre è caduto dalle scale e non risponde più",
      "non riesco a respirare",
      "C'è un incendio sulla collina",
      "Qualcuno sta annegando vicino agli scogli",
      "Abbiamo avuto un incidente sulla strada",
      "Sono stato punto da una medusa",
      "Mi serve un'ambulanza",
      "Si è fatto male, sanguina tanto",
      "Qual è il numero di emergenza?",
      "Devo chiamare il 118?",
      "Sono in pericolo",
    ]) {
      expect(detectEmergency(q), q).toBe(true);
    }
  });

  it("riconosce le emergenze in inglese", () => {
    for (const q of [
      "I have chest pain",
      "My son is missing!",
      "My son got lost near the castle, what should I do?",
      "I lost my daughter near the church",
      "Help!",
      "Help me please",
      "Someone is drowning",
      "My wife fainted",
      "He can't breathe",
      "There's been an accident",
      "Call an ambulance",
      "I think he is having a stroke",
      "There is a fire near the castle",
    ]) {
      expect(detectEmergency(q), q).toBe(true);
    }
  });

  it("non scatta sulle domande di storia e di visita", () => {
    for (const q of [
      "È vero che Byron partì a nuoto da questa grotta?",
      "Byron annegò davvero?",
      "Il castello è caduto in mano ai genovesi?",
      "Quando fu l'incendio della chiesa di San Pietro?",
      "La tradizione della festa si è persa?",
      "Il sentiero AV5T è pericoloso con la pioggia?",
      "Aiutami a capire la storia del borgo",
      "Cosa racconta la leggenda della Madonna Bianca?",
      "Help me understand the history of the castle",
      "Did Shelley drown in this gulf?",
      "Tell me about Shelley's drowning",
      "The tower collapsed in the war?",
      "Was the castle set on fire?",
      "Look at the brush strokes of the painting",
      "Was the village in danger during the siege?",
      "Quanto dista il castello?",
    ]) {
      expect(detectEmergency(q), q).toBe(false);
    }
  });
});
