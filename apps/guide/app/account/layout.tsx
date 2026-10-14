import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Account · AI Guide", robots: { index: false, follow: false } };
// Pagine con la sessione dell'utente: sempre generate al momento, mai statiche.
export const dynamic = "force-dynamic";

export default function AccountLayout({ children }: { children: ReactNode }) {
  return children;
}
