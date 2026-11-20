import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Options Intelligence",
  description: "AI-assisted stock research and defined-risk options decision support.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
