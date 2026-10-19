import { describe, expect, it } from "vitest";
import { installSummary, type InstallEntry } from "../lib/install-status.ts";

const clock = (t: number) => `t${t}`;

describe("stato dell'installazione (pannello di prova)", () => {
  it("aperta come app: tutto bene, qualunque sia il diario", () => {
    expect(installSummary([], true, clock)).toEqual({ line: "aperta come app installata", level: "good" });
  });

  it("nessun evento: il browser non l'ha offerta", () => {
    expect(installSummary([], false, clock).level).toBe("warn");
  });

  it("offerta e non scelta", () => {
    const s = installSummary([{ step: "offered", at: 1 }], false, clock);
    expect(s.level).toBe("warn");
    expect(s.line).toContain("t1");
  });

  it("accettata ma mai completata: è il caso da segnalare", () => {
    const log: InstallEntry[] = [{ step: "offered", at: 1 }, { step: "accepted", at: 2 }];
    const s = installSummary(log, false, clock);
    expect(s.level).toBe("bad");
    expect(s.line).toContain("non ha confermato");
  });

  it("accettata e completata", () => {
    const log: InstallEntry[] = [{ step: "offered", at: 1 }, { step: "accepted", at: 2 }, { step: "installed", at: 3 }];
    expect(installSummary(log, false, clock)).toMatchObject({ level: "good" });
  });

  it("un nuovo «accetta» dopo un'installazione vecchia torna a contare", () => {
    const log: InstallEntry[] = [{ step: "installed", at: 1 }, { step: "offered", at: 2 }, { step: "accepted", at: 3 }];
    expect(installSummary(log, false, clock).level).toBe("bad");
  });

  it("rifiutata", () => {
    const log: InstallEntry[] = [{ step: "offered", at: 1 }, { step: "dismissed", at: 2 }];
    expect(installSummary(log, false, clock).line).toContain("rifiutata");
  });
});
