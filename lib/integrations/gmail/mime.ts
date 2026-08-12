import type { GmailMessage, GmailPayload } from "./types";

/** Base64url without padding — the Gmail API's `raw` encoding. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * RFC 2047 "encoded-word" for a header value, so non-ASCII subjects/names send
 * correctly. Kept simple: encode the whole value as one UTF-8 base64 word.
 */
function encodeHeader(value: string): string {
  // Printable ASCII needs no encoding; anything else becomes an RFC 2047
  // encoded-word. The range avoids control chars, so no-control-regex is moot.
  if (!/[^\x20-\x7E]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export type OutgoingEmail = {
  from: string; // e.g. "Business Name <orders@business.com>" or bare address
  to: string;
  subject: string;
  /** Plain-text body. Rendered HTML is derived from it (paragraphs + links). */
  text: string;
  html?: string;
  /** Set on a reply so the client threads it (References/In-Reply-To). */
  inReplyToMessageId?: string;
  attachments?: OutgoingAttachment[];
};

export type OutgoingAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

/**
 * Build an RFC822 MIME message. Sends a multipart/alternative body, optionally
 * wrapped in multipart/mixed when attachments are present.
 */
export function buildMimeMessage(email: OutgoingEmail): Buffer {
  const altBoundary = `=_alpha_alt_${Math.random().toString(36).slice(2)}`;
  const mixedBoundary = `=_alpha_mix_${Math.random().toString(36).slice(2)}`;
  const html = email.html ?? textToHtml(email.text);
  const headers = [
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${encodeHeader(email.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (email.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${email.inReplyToMessageId}`);
    headers.push(`References: ${email.inReplyToMessageId}`);
  }
  if (email.attachments?.length) {
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  } else {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  }

  const alternative = [
    `--${altBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    email.text,
    "",
    `--${altBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
    `--${altBoundary}--`,
    "",
  ];

  let body: string[];
  if (email.attachments?.length) {
    body = [
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      alternative.join("\r\n"),
      ...email.attachments.flatMap((attachment) => [
        `--${mixedBoundary}`,
        `Content-Type: ${attachment.contentType}; name="${encodeHeader(attachment.filename)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${encodeHeader(attachment.filename)}"`,
        "",
        wrapBase64(attachment.content.toString("base64")),
        "",
      ]),
      `--${mixedBoundary}--`,
      "",
    ];
  } else {
    body = alternative;
  }

  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body.join("\r\n")}`, "utf8");
}

/**
 * Build a base64url-encoded MIME message for the JSON users.messages.send path.
 */
export function buildRawMessage(email: OutgoingEmail): string {
  return b64url(buildMimeMessage(email));
}

function wrapBase64(input: string): string {
  return input.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** Minimal, safe text→HTML: escape, linkify http(s) URLs, paragraphs from blank lines. */
export function textToHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linkify = (s: string) =>
    s.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}">${url}</a>`);
  const paras = text
    .split(/\n{2,}/)
    .map((p) => `<p>${linkify(esc(p)).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#16222E;line-height:1.5">${paras}</div>`;
}

/* --- inbound parsing ---------------------------------------------------- */
export function header(message: GmailMessage, name: string): string | null {
  const h = message.payload?.headers?.find(
    (x) => x.name.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? null;
}

/** Best-effort plain-text extraction from a Gmail message payload. */
export function extractPlainText(message: GmailMessage): string {
  const payload = message.payload;
  if (!payload) return message.snippet ?? "";
  const fromPart = (part: GmailPayload): string | null => {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return decodeB64Url(part.body.data);
    }
    for (const child of part.parts ?? []) {
      const found = fromPart(child);
      if (found) return found;
    }
    return null;
  };
  const text = fromPart(payload);
  if (text) return text.trim();
  // No text/plain part — fall back to the API-provided snippet.
  return (message.snippet ?? "").trim();
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
