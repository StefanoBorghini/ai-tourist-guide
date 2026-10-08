import { PACK_SCHEMA_VERSION, PREDICATES } from "@guide/domain";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "64px 16px" }}>
      <p style={{ letterSpacing: "0.12em", textTransform: "uppercase", fontSize: 12, opacity: 0.7 }}>
        AI Guide Engine
      </p>
      <h1 style={{ fontSize: 32, lineHeight: 1.2, margin: "8px 0 16px" }}>La guida che racconta il territorio.</h1>
      <p style={{ lineHeight: 1.6, opacity: 0.85 }}>
        In costruzione. Fase 0: grafo di conoscenza, formato dei Territory Pack, motore di contesto.
      </p>
      <p style={{ marginTop: 32, fontSize: 13, opacity: 0.6 }}>
        Territory Pack schema v{PACK_SCHEMA_VERSION} · {PREDICATES.length} predicati nell&apos;ontologia
      </p>
    </main>
  );
}
