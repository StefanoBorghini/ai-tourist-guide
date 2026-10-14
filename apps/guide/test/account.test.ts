import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authErrorCode,
  checkPassword,
  consentsToRecord,
  errorText,
  messageText,
  readAccountConfig,
  requiresSession,
  safeNext,
} from "../lib/account/shared.ts";

const here = dirname(fileURLToPath(import.meta.url));
const base = {
  NEXT_PUBLIC_ACCOUNTS_ENABLED: "1",
  NEXT_PUBLIC_SUPABASE_URL: "https://progetto.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "chiave-pubblica",
  NEXT_PUBLIC_TERMS_URL: "/condizioni",
  NEXT_PUBLIC_PRIVACY_URL: "https://esempio.it/privacy",
  NEXT_PUBLIC_LEGAL_VERSION: "2026-10",
};

describe("configurazione degli account", () => {
  it("attivi solo con il flag, Supabase e i testi legali", () => {
    const ok = readAccountConfig(base);
    expect(ok).toMatchObject({ ok: true, config: { providers: [], legal: { termsUrl: "/condizioni", version: "2026-10" } } });
    expect(readAccountConfig({ ...base, NEXT_PUBLIC_ACCOUNTS_ENABLED: undefined })).toMatchObject({ ok: false, missing: ["NEXT_PUBLIC_ACCOUNTS_ENABLED=1"] });
    for (const k of ["NEXT_PUBLIC_TERMS_URL", "NEXT_PUBLIC_PRIVACY_URL", "NEXT_PUBLIC_LEGAL_VERSION"] as const) {
      expect(readAccountConfig({ ...base, [k]: "" }).ok, k).toBe(false);
    }
    // Indirizzi legali solo https o percorsi del sito.
    for (const bad of ["http://esempio.it/p", "javascript:alert(1)", "//altro.it/p", "privacy"]) {
      expect(readAccountConfig({ ...base, NEXT_PUBLIC_PRIVACY_URL: bad }).ok, bad).toBe(false);
    }
    expect(readAccountConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: "" }).ok).toBe(false);
  });
  it("accessi social: solo quelli noti, senza doppioni", () => {
    const r = readAccountConfig({ ...base, NEXT_PUBLIC_AUTH_PROVIDERS: " Google,apple,github,google " });
    expect(r.ok && r.config.providers).toEqual(["google", "apple"]);
  });
});

describe("percorsi e redirect", () => {
  it("pagine protette e pagine pubbliche dell'account", () => {
    for (const p of ["/account", "/account/", "/account/elimina", "/account/esporta", "/auth/reimposta"]) expect(requiresSession(p), p).toBe(true);
    for (const p of ["/account/accedi", "/account/registrati", "/account/password", "/auth/confirm", "/auth/callback", "/", "/studio"]) expect(requiresSession(p), p).toBe(false);
  });
  it("dopo l'accesso solo pagine interne note, mai un altro sito", () => {
    expect(safeNext("/account")).toBe("/account");
    expect(safeNext("/account/elimina")).toBe("/account/elimina");
    expect(safeNext("/auth/reimposta")).toBe("/auth/reimposta");
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/account?tab=acquisti")).toBe("/account?tab=acquisti");
    for (const bad of [null, "", "https://altro.it", "//altro.it", "/\\altro.it", "/account/../studio", "/account/%2e%2e/studio", "/studio", "/account/x y", "javascript:alert(1)", "/account?x=<script>"]) {
      expect(safeNext(bad), String(bad)).toBe("/account");
    }
    expect(safeNext("//altro.it", "/")).toBe("/");
  });
});

describe("password, messaggi, errori", () => {
  it("lunghezza minima e massima, conferma", () => {
    expect(checkPassword("corta")).toBe("password-corta");
    expect(checkPassword("abbastanza-lunga")).toBeNull();
    expect(checkPassword("abbastanza-lunga", "diversa-davvero")).toBe("password-diverse");
    expect(checkPassword("è".repeat(40))).toBe("password-lunga");
  });
  it("solo codici noti diventano testo: niente messaggi inventati da un link", () => {
    expect(messageText("controlla-email")).toMatch(/email/);
    expect(errorText("credenziali")).toMatch(/password/);
    expect(messageText("Il tuo account è stato bloccato: chiama questo numero")).toBeNull();
    expect(errorText(undefined)).toBeNull();
    expect(errorText("toString")).toBeNull();
  });
  it("gli errori di Supabase diventano codici, senza il testo originale", () => {
    expect(authErrorCode({ code: "invalid_credentials" })).toBe("credenziali");
    expect(authErrorCode({ message: "Invalid login credentials" })).toBe("credenziali");
    expect(authErrorCode({ code: "email_not_confirmed" })).toBe("non-confermata");
    expect(authErrorCode({ code: "weak_password" })).toBe("password-debole");
    expect(authErrorCode({ code: "otp_expired" })).toBe("link");
    expect(authErrorCode({ code: "over_email_send_rate_limit" })).toBe("troppi-tentativi");
    expect(authErrorCode({ status: 429 })).toBe("troppi-tentativi");
    expect(authErrorCode({ code: "identity_already_exists" })).toBe("gia-collegato");
    expect(authErrorCode({ code: "qualcosa_di_nuovo" })).toBe("servizio");
  });
});

describe("consensi", () => {
  const meta = { consents: { version: "2026-10", terms: true, privacy: true } };
  it("si registrano i consensi dati alla registrazione, una volta per versione", () => {
    expect(consentsToRecord(meta, [])).toEqual([
      { kind: "terms", granted: true, version: "2026-10" },
      { kind: "privacy", granted: true, version: "2026-10" },
    ]);
    expect(consentsToRecord(meta, [{ kind: "terms", version: "2026-10", granted: true }])).toEqual([{ kind: "privacy", granted: true, version: "2026-10" }]);
    expect(consentsToRecord(meta, [{ kind: "terms", version: "2026-09", granted: true }])).toHaveLength(2);
  });
  it("niente consensi senza dichiarazione esplicita o con versione non valida", () => {
    expect(consentsToRecord(undefined, [])).toEqual([]);
    expect(consentsToRecord({ consents: { version: "2026-10", terms: "sì", privacy: false } }, [])).toEqual([]);
    expect(consentsToRecord({ consents: { version: "x y", terms: true, privacy: true } }, [])).toEqual([]);
  });
});

describe("service worker", () => {
  it("account e autenticazione non passano mai dalla cache", () => {
    const sw = readFileSync(resolve(here, "../public/sw.js"), "utf8");
    const bypassed = /\/\^\\\/\(([a-z|]+)\)\(\\\/\|\$\)\//.exec(sw)?.[1]?.split("|") ?? [];
    expect(bypassed).toEqual(expect.arrayContaining(["studio", "account", "auth"]));
  });
});
