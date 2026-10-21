import { describe, expect, it } from "vitest";
import { geoPlatform, shouldResume } from "../lib/geo-permission.ts";
import { UI } from "../lib/i18n.ts";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

describe("posizione bloccata: istruzioni per il telefono in uso", () => {
  it("riconosce telefono e app installata", () => {
    expect(geoPlatform(ANDROID, false)).toBe("android");
    expect(geoPlatform(ANDROID, true)).toBe("android-app");
    expect(geoPlatform(IPHONE, false)).toBe("ios");
    expect(geoPlatform(IPHONE, true)).toBe("ios-app");
    expect(geoPlatform(IPAD_DESKTOP, false)).toBe("ios");
    expect(geoPlatform(DESKTOP, false)).toBe("other");
  });

  it("riparte solo se era bloccata e ora è concessa", () => {
    expect(shouldResume("granted", "denied")).toBe(true);
    expect(shouldResume("denied", "denied")).toBe(false);
    expect(shouldResume("prompt", "denied")).toBe(false);
    expect(shouldResume("granted", null)).toBe(false);
    expect(shouldResume("granted", "timeout")).toBe(false);
    expect(shouldResume(null, "denied")).toBe(false);
  });

  it("istruzioni presenti per ogni telefono, in italiano e in inglese", () => {
    for (const lang of ["it", "en"] as const) {
      for (const p of ["android", "android-app", "ios", "ios-app", "other"] as const) {
        expect(UI[lang].gpsBlocked.steps[p].length, `${lang} ${p}`).toBeGreaterThan(1);
      }
      expect(UI[lang].gpsBlocked.how).not.toBe("");
    }
  });
});
