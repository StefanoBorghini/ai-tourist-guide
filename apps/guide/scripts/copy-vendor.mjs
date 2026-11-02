// Copia in public/vendor/ i file che una libreria carica da sola a runtime e che il bundler non include: il worker
// di MapLibre (un unico file, senza dipendenze). Generati, non versionati; il componente li indica con la versione
// della libreria nell'indirizzo, così una versione nuova non usa un file vecchio dalla cache.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.css"));
const out = resolve(here, "../public/vendor");
mkdirSync(out, { recursive: true });
copyFileSync(join(dist, "maplibre-gl-worker.mjs"), join(out, "maplibre-gl-worker.mjs"));
console.log("✓ public/vendor/maplibre-gl-worker.mjs");
