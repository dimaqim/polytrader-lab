import type { Metadata, Viewport } from "next";
import "@fontsource-variable/mulish";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "PolyTrader Lab — Журнал сделок",
  description: "Paper Trading на Polymarket. Исследуйте стратегии, риски и реальные рыночные данные.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" suppressHydrationWarning>
    <body><Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />{children}</body>
  </html>;
}
