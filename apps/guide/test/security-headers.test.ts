import { describe, expect, it } from "vitest";
import nextConfig, { SECURITY_HEADERS } from "../next.config.ts";

describe("intestazioni di sicurezza", () => {
  it("valgono per ogni percorso dell'app", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: "/:path*", headers: SECURITY_HEADERS }]);
  });

  it("nessuna pagina dentro un riquadro di un altro sito, niente interpretazione del tipo, referrer ridotto", () => {
    const h = Object.fromEntries(SECURITY_HEADERS.map(({ key, value }) => [key, value]));
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });
});
