import type { Metadata } from "next";
import "./globals.css";

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='24' fill='%230e1730'/%3E%3Crect x='24' y='20' width='38' height='50' rx='4' fill='%23ffffff'/%3E%3Crect x='30' y='34' width='26' height='9' rx='2' fill='%23ddf75a'/%3E%3Cline x1='30' y1='52' x2='54' y2='52' stroke='%230e1730' stroke-width='3' stroke-linecap='round'/%3E%3Cline x1='30' y1='60' x2='46' y2='60' stroke='%230e1730' stroke-width='3' stroke-linecap='round'/%3E%3Ccircle cx='68' cy='66' r='15' fill='none' stroke='%23ddf75a' stroke-width='6'/%3E%3Cline x1='79' y1='77' x2='88' y2='86' stroke='%23ddf75a' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: "stacks — ask your documents",
  description:
    "Ask questions about your documents in any language and get cited answers grounded only in what you've uploaded. Runs on Cloudflare AI Search.",
  icons: { icon: FAVICON },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
