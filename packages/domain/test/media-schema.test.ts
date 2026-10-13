import { describe, expect, it } from "vitest";
import { mediaSchema } from "../src/index.ts";

const base = { id: "foto", file: "foto.jpg", subjects: ["luogo"], alt: { it: "Una foto" }, source: "own_photo", author: "Redazione", license: "own" };

describe("media", () => {
  it("le immagini restano il caso predefinito", () => {
    expect(mediaSchema.parse(base).kind).toBe("image");
  });
  it("un video richiede un file video e un poster", () => {
    expect(mediaSchema.safeParse({ ...base, kind: "video", file: "clip.mp4", poster: "clip.jpg" }).success).toBe(true);
    expect(mediaSchema.safeParse({ ...base, kind: "video", file: "clip.mp4" }).success).toBe(false);
    expect(mediaSchema.safeParse({ ...base, kind: "video", file: "clip.jpg", poster: "clip.jpg" }).success).toBe(false);
    expect(mediaSchema.safeParse({ ...base, file: "clip.mp4" }).success).toBe(false);
  });
  it("la copertina è facoltativa", () => {
    expect(mediaSchema.parse({ ...base, cover: true }).cover).toBe(true);
  });
});
