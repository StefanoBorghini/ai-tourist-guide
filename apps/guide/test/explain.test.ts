import { describe, expect, it } from "vitest";
import { explainIssues } from "../lib/studio/explain";
import type { ReadinessIssue } from "../lib/studio/readiness";

const issue = (code: string, message: string, level: "error" | "warning" = "error", pack = "it.liguria.sp.portovenere"): ReadinessIssue =>
  ({ level, code, pack, message });

describe("controllo di pubblicazione in parole semplici", () => {
  it("raggruppa per tipo, con il numero, e mette prima gli errori", () => {
    const g = explainIssues([
      issue("ROUTE_NOT_CALIBRATED", "borgo: tempi da calibrare", "warning"),
      issue("MEDIA_ALT", "foto-1: manca alt"),
      issue("MEDIA_ALT", "foto-2: manca alt"),
      issue("NO_PLACES", "nessun luogo"),
    ], "it.liguria.sp.portovenere");
    expect(g.map((x) => [x.level, x.code, x.count])).toEqual([["error", "MEDIA_ALT", 2], ["error", "NO_PLACES", 1], ["warning", "ROUTE_NOT_CALIBRATED", 1]]);
    expect(g[0]!.title).toBe("2 foto sono senza descrizione");
    expect(g[0]!.fix).toEqual({ tab: "media", label: "Apri le foto" });
    expect(g[0]!.details).toEqual(["foto-1: manca alt", "foto-2: manca alt"]);
    expect(g[1]!.title).toBe("Il territorio non ha ancora luoghi");
  });

  it("fonte di un altro territorio: rimanda al collegamento «fa parte di»", () => {
    const msgs = Array.from({ length: 7 }, (_, i) => issue("SOURCE_NOT_FOUND", `fatto-${i}: fonte non trovata o non raggiungibile: it.liguria:unesco-826`));
    const [g] = explainIssues(msgs, "it.liguria.sp.portovenere");
    expect(g!.title).toBe("7 fatti citano una fonte che non c'è (o non è raggiungibile)");
    expect(g!.todo).toMatch(/territorio it\.liguria/);
    expect(g!.fix?.tab).toBe("panoramica");
  });

  it("fonte dello stesso territorio: rimanda alle fonti", () => {
    const [g] = explainIssues([issue("SOURCE_NOT_FOUND", "a: fonte non trovata o non raggiungibile: it.liguria.sp.portovenere:archivio")], "it.liguria.sp.portovenere");
    expect(g!.title).toBe("Un fatto cita una fonte che non c'è (o non è raggiungibile)");
    expect(g!.fix?.tab).toBe("fonti");
  });

  it("codice sconosciuto: frase generica, dettaglio conservato, problema di un altro territorio indicato", () => {
    const [g] = explainIssues([issue("NUOVO_CODICE", "qualcosa", "error", "it.liguria")], "it.liguria.sp.portovenere");
    expect(g!.title).toBe("Un problema da controllare");
    expect(g!.fix).toBeUndefined();
    expect(g!.details).toEqual(["(it.liguria) qualcosa"]);
  });
});
