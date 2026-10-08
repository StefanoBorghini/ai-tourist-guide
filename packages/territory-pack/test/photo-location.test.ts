import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readPhotoLocation } from "../src/photo-location.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = resolve(here, "../../../territories/_synthetic/it.test.borgo-di-prova/media/files");
const read = (name: string) => new Uint8Array(readFileSync(resolve(FILES, name)));

describe("posizione dalle foto", () => {
  it("legge coordinate, quota e data dall'EXIF", () => {
    expect(readPhotoLocation(read("porta-del-borgo-fittizia.jpg"))).toEqual({
      location: [0.00102, 0.00101],
      altitudeM: 12,
      takenAt: "2026-05-15",
    });
    const torre = readPhotoLocation(read("torre-fittizia.jpg"))!;
    expect(torre.location[0]).toBeCloseTo(0.00298, 6);
    expect(torre.location[1]).toBeCloseTo(0.00301, 6);
  });

  it("restituisce null per file che non sono JPEG o senza EXIF", () => {
    expect(readPhotoLocation(new TextEncoder().encode("non è una foto"))).toBeNull();
    expect(readPhotoLocation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
    expect(readPhotoLocation(new Uint8Array())).toBeNull();
  });
});
