"use client";

/**
 * Last-resort boundary: an error thrown by the root layout itself (fonts,
 * globals) lands here, outside every layout, so this page carries its own
 * html and body. Plain words, no message, digest or stack. Inline styles only:
 * globals.css may be the thing that failed. Colours are the design tokens.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#FBFAF8",
          color: "#16222E",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          padding: "24px",
        }}
      >
        <main style={{ maxWidth: 400, textAlign: "center" }}>
          <h1 style={{ fontSize: 28, lineHeight: "36px", margin: "0 0 8px", fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, lineHeight: "20px", color: "#5C6B7A", margin: "0 0 16px" }}>
            That did not load. Try again in a moment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              height: 44,
              padding: "0 20px",
              borderRadius: 8,
              border: 0,
              background: "#5B4BC4",
              color: "#FFFFFF",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
