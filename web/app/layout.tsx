import type { Metadata } from "next";
import { Shell } from "@/components/Shell";
import { ToastProvider } from "@/components/Toasts";
import { StudioProvider } from "@/lib/studio";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenReup Studio",
  description: "Tải · Dịch · Lồng tiếng AI",
};

// Áp theme + độ rộng thanh bên đã lưu trước khi vẽ trang để không bị nháy.
const BOOT = `(() => {
  const d = document.documentElement;
  d.dataset.theme = localStorage.getItem("theme") || "dark";
  d.dataset.rail = localStorage.getItem("rail") === "open" ? "open" : "closed";
  for (const k of ["sb-w", "rail-w"]) {
    const w = Number(localStorage.getItem(k));
    if (w) d.style.setProperty("--" + k, w + "px");
  }
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans+Text:wght@400;500;700&display=swap" />
      </head>
      <body>
        <ToastProvider>
          <StudioProvider>
            <Shell>{children}</Shell>
          </StudioProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
