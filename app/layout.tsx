import type { Metadata } from "next";
import { Inter, Instrument_Sans } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

// Headings only. Not preloaded (docs/PERF.md): on a slow phone connection the
// preload competed with the CSS and JavaScript the first paint needs; with
// swap and next/font's size-matched fallback the titles paint at once and
// switch face when the file lands (from the device cache after the first visit).
const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "AlphaOS",
  description: "Operations platform for multi-channel commerce.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSans.variable} h-full`}
    >
      <body className="min-h-full flex flex-col font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
