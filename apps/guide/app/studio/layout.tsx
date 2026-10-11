import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./studio.css";

export const metadata: Metadata = {
  title: "Studio · AI Guide",
  robots: { index: false, follow: false },
};

// Ogni pagina dipende dalla sessione: mai pagine statiche o in cache condivise.
export const dynamic = "force-dynamic";

export default function StudioLayout({ children }: { children: ReactNode }) {
  return <div className="studio">{children}</div>;
}
