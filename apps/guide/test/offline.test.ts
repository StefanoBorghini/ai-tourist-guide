import { describe, expect, it } from "vitest";
import { bundleUrls, INDEX_URL, staleBundleUrls } from "../lib/offline";

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

  it("a un nuovo scaricamento si tolgono le versioni superate della stessa cartella, e solo quelle", () => {
    const manifest = { files: [{ path: "content.nuovo.json", sha256: "a", bytes: 1 }, { path: "media/0123.jpg", sha256: "b", bytes: 2 }] };
    const cached = [
      INDEX_URL,
      "/pub/index.json",
      "/pub/x/it-full/manifest.json",
      "/pub/x/it-full/content.vecchio.json",
      "/pub/x/it-full/content.nuovo.json",
      "/pub/x/it-full/media/0123.jpg",
      "/pub/x/it-full/media/tolta.jpg",
      "/pub/x/en-full/content.vecchio.json",
      "/pub/y/it-full/content.vecchio.json",
    ];
    expect(staleBundleUrls(cached, "/pub/x/it-full/manifest.json", manifest)).toEqual([
      "/pub/x/it-full/content.vecchio.json",
      "/pub/x/it-full/media/tolta.jpg",
    ]);
  });

  it("pubblicazione immutabile (R2): manifest e contenuto nella cartella della pubblicazione, media nella cartella della lingua", () => {
    const id = "bbbbbbbb-0000-4000-8000-00000000000b";
    const manifestUrl = `/pub/x/it-full/${id}/manifest.json`;
    const manifest = { files: [{ path: `${id}/content.nuovo.json`, sha256: "a", bytes: 1 }, { path: "media/0123.jpg", sha256: "b", bytes: 2 }] };
    expect(bundleUrls(manifestUrl, manifest)).toEqual([INDEX_URL, "/pub/index.json", manifestUrl, `/pub/x/it-full/${id}/content.nuovo.json`, "/pub/x/it-full/media/0123.jpg"]);
  });

  it("passaggio dalla struttura precedente alla nuova: via il vecchio manifest e il vecchio contenuto, i media ancora usati restano", () => {
    const a = "aaaaaaaa-0000-4000-8000-00000000000a";
    const b = "bbbbbbbb-0000-4000-8000-00000000000b";
    const manifest = { files: [{ path: `${b}/content.nuovo.json`, sha256: "a", bytes: 1 }, { path: "media/0123.jpg", sha256: "b", bytes: 2 }] };
    const cached = [
      INDEX_URL,
      "/pub/index.json",
      "/pub/x/it-full/manifest.json",
      "/pub/x/it-full/content.vecchio.json",
      `/pub/x/it-full/${a}/manifest.json`,
      `/pub/x/it-full/${a}/content.intermedio.json`,
      `/pub/x/it-full/${b}/manifest.json`,
      `/pub/x/it-full/${b}/content.nuovo.json`,
      "/pub/x/it-full/media/0123.jpg",
      "/pub/x/en-full/content.vecchio.json",
    ];
    expect(staleBundleUrls(cached, `/pub/x/it-full/${b}/manifest.json`, manifest)).toEqual([
      "/pub/x/it-full/manifest.json",
      "/pub/x/it-full/content.vecchio.json",
      `/pub/x/it-full/${a}/manifest.json`,
      `/pub/x/it-full/${a}/content.intermedio.json`,
    ]);
  });
});
