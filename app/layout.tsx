import type { Metadata } from "next";
import "./globals.css";

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%233f6b4f'/%3E%3Crect x='26' y='24' width='34' height='46' rx='3' fill='%23f6f1e7'/%3E%3Cline x1='34' y1='36' x2='52' y2='36' stroke='%233f6b4f' stroke-width='3' stroke-linecap='round'/%3E%3Cline x1='34' y1='45' x2='52' y2='45' stroke='%233f6b4f' stroke-width='3' stroke-linecap='round'/%3E%3Ccircle cx='68' cy='62' r='16' fill='none' stroke='%23f6f1e7' stroke-width='6'/%3E%3Cline x1='79' y1='73' x2='88' y2='82' stroke='%23f6f1e7' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: "stacks — ask your documents",
  description: "A small RAG tool on Cloudflare Workers AI and Vectorize: ingest documents, ask questions, get cited answers.",
  icons: { icon: FAVICON },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
