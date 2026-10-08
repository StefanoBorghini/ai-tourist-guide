import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "AI Guide Engine",
  description: "Guida turistica AI territoriale",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b1d2a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#0b1d2a",
          color: "#f2efe8",
        }}
      >
        {children}
      </body>
    </html>
  );
}
