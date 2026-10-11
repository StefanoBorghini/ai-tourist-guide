import { describe, expect, it } from "vitest";
import { bundleUrls, INDEX_URL } from "../lib/offline";

describe("uso offline", () => {
  it("mette in cache indice, manifest e tutti i file del bundle", () => {
    const urls = bundleUrls("/bundles/x/it-full/manifest.json", {
      files: [
        { path: "content.abc.json", sha256: "a", bytes: 1 },
        { path: "media/0123.jpg", sha256: "b", bytes: 2 },
      ],
    });
    expect(urls).toEqual([
      INDEX_URL,
      "/bundles/x/it-full/manifest.json",
      "/bundles/x/it-full/content.abc.json",
      "/bundles/x/it-full/media/0123.jpg",
    ]);
  });

  it("un bundle pubblicato dallo Studio porta in cache anche il suo indice", () => {
    const urls = bundleUrls("/pub/x/it-full/manifest.json", { files: [{ path: "content.abc.json", sha256: "a", bytes: 1 }] });
    expect(urls).toEqual([INDEX_URL, "/pub/index.json", "/pub/x/it-full/manifest.json", "/pub/x/it-full/content.abc.json"]);
  });
});
