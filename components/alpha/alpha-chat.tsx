"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Bot, X } from "@/components/ui/icons";
import type { Role } from "@/lib/auth/config";

type ChatRole = "user" | "assistant";
type ChatMessage = { id: string; role: ChatRole; content: string; at: number };
type ChatResponse = { answer: string; escalated: boolean; source: "chat" | "ask" | "snapshot" };

const OPEN_EVENT = "alphaos:chat-open";
const HISTORY_LIMIT = 12;

const SUGGESTIONS: Record<Role, string[]> = {
  admin: ["What needs my attention today?", "How loaded are the designers?", "Anything overdue?"],
  va: ["What should I do first?", "Who is waiting on a reply?", "Anything stuck in QC?"],
  designer: ["What is due first?", "What did I earn this week?", "Any revisions for me?"],
};

function sanitizeKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** A tiny inline send glyph -- kept local so this file never touches the
 * shared ui icon set (owned by another workstream). */
function SendGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/**
 * Alpha's floating chat widget -- the same AI manager that answers on
 * WhatsApp, now live inside AlphaOS. Mounted once in AppShell for every
 * role. Persists its thread per user in localStorage; falls back to a calm
 * snapshot-built answer whenever the daemon can't be reached (never an
 * error state in the UI).
 */
export function AlphaChat({ user }: { user: { name: string; email: string; role: Role } }) {
  const pathname = usePathname();
  const storageKey = useMemo(() => `alphaos.chat.${sanitizeKey(user.email || user.name)}`, [user.email, user.name]);

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [slowNote, setSlowNote] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedKey = useRef<string | null>(null);

  useEffect(() => setMounted(true), []);

  // Load this user's thread once, and whenever the storage key changes
  // (e.g. a different person signs in on the same browser).
  useEffect(() => {
    if (loadedKey.current === storageKey) return;
    loadedKey.current = storageKey;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      setMessages(Array.isArray(parsed) ? parsed : []);
    } catch {
      setMessages([]);
    }
  }, [storageKey]);

  // Persist on every change. Best-effort: private browsing / blocked storage
  // must never break the chat itself.
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(messages.slice(-60)));
    } catch {
      /* ignore -- localStorage unavailable */
    }
  }, [storageKey, messages]);

  // Any part of the app can open the widget without importing it, via
  // window.dispatchEvent(new CustomEvent("alphaos:chat-open")).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // Escape closes; body scroll is locked behind the phone full-screen sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const isPhone = window.matchMedia("(max-width: 639px)").matches;
    const prevOverflow = document.body.style.overflow;
    if (isPhone) document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      if (isPhone) document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, pending]);

  const orderId = useMemo(() => {
    const match = pathname?.match(/^\/orders\/([^/?#]+)/);
    return match ? match[1] : null;
  }, [pathname]);

  const clearChat = useCallback(() => {
    setMessages([]);
    setMenuOpen(false);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;
      const userMsg: ChatMessage = { id: makeId(), role: "user", content: trimmed, at: Date.now() };
      const nextHistory = [...messages, userMsg];
      setMessages(nextHistory);
      setInput("");
      setPending(true);
      setSlowNote(false);
      slowTimer.current = setTimeout(() => setSlowNote(true), 8000);

      try {
        const res = await fetch("/api/alpha/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: nextHistory.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content })),
            page: pathname || null,
            orderId,
          }),
        });
        const data = (await res.json().catch(() => null)) as ChatResponse | null;
        const answer = data?.answer?.trim() || "Alpha AI will answer in full shortly.";
        setMessages((cur) => [...cur, { id: makeId(), role: "assistant", content: answer, at: Date.now() }]);
      } catch {
        setMessages((cur) => [
          ...cur,
          { id: makeId(), role: "assistant", content: "Alpha AI could not be reached just now. Try again in a moment.", at: Date.now() },
        ]);
      } finally {
        if (slowTimer.current) clearTimeout(slowTimer.current);
        setPending(false);
        setSlowNote(false);
      }
    },
    [messages, pending, pathname, orderId],
  );

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  if (!mounted) return null;

  return createPortal(
    <>
      {!open && (
        <button
          type="button"
          aria-label="Open Alpha AI"
          onClick={() => setOpen(true)}
          className={cn(
            "fixed z-40 flex items-center gap-2 rounded-full bg-pigment px-4 py-3 text-surface shadow-lg",
            "transition-transform motion-hover hover:opacity-90 active:scale-95",
            "bottom-20 right-4 sm:bottom-6 sm:right-6",
            focusRing,
          )}
        >
          <Bot size={20} />
          <span className="hidden text-sm font-medium sm:inline">Alpha AI</span>
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Alpha AI"
          className={cn(
            "fixed inset-0 z-50 flex flex-col bg-surface",
            "sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[600px] sm:w-[400px] sm:max-h-[calc(100vh-3rem)]",
            "sm:rounded-card sm:border sm:border-line sm:shadow-lg",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-8 items-center justify-center rounded-full bg-pigment-soft text-pigment">
                <Bot size={18} />
              </span>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold text-ink">Alpha AI</span>
                <span className="text-xs text-slate">Your AI manager</span>
              </div>
            </div>
            <div className="relative flex items-center gap-1">
              <div className="relative">
                <button
                  type="button"
                  aria-label="Chat options"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((v) => !v)}
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-input text-slate",
                    "transition-colors motion-hover hover:bg-canvas hover:text-ink",
                    focusRing,
                  )}
                >
                  <span aria-hidden="true" className="text-lg leading-none">
                    &#8942;
                  </span>
                </button>
                {menuOpen && (
                  <div role="menu" className="absolute right-0 top-full z-10 mt-1 min-w-36 rounded-card border border-line bg-surface p-1 shadow-lg">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={clearChat}
                      className={cn(
                        "w-full rounded-input px-2 py-1.5 text-left text-sm text-ink",
                        "transition-colors motion-hover hover:bg-canvas",
                        focusRing,
                      )}
                    >
                      Clear chat
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label="Close Alpha AI"
                onClick={() => setOpen(false)}
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-input text-slate",
                  "transition-colors motion-hover hover:bg-canvas hover:text-ink",
                  focusRing,
                )}
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <span className="inline-flex size-10 items-center justify-center rounded-full bg-pigment-soft text-pigment">
                  <Bot size={22} />
                </span>
                <p className="text-sm text-slate">Ask Alpha AI anything about your day.</p>
                <div className="flex flex-col gap-2">
                  {(SUGGESTIONS[user.role] ?? SUGGESTIONS.va).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      className={cn(
                        "rounded-full border border-line bg-canvas px-3 py-1.5 text-xs text-ink",
                        "transition-colors motion-hover hover:bg-pigment-soft hover:border-pigment/30",
                        focusRing,
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {messages.map((m) => (
                  <div key={m.id} className={cn("flex flex-col gap-1", m.role === "user" ? "items-end" : "items-start")}>
                    <div
                      className={cn(
                        "max-w-[85%] whitespace-pre-wrap rounded-input px-3 py-2 text-sm",
                        m.role === "user" ? "bg-pigment-soft text-ink" : "border border-line bg-surface text-ink",
                      )}
                    >
                      {m.content}
                    </div>
                    <span className="px-1 text-[11px] text-slate/70">{formatTime(m.at)}</span>
                  </div>
                ))}
                {pending && (
                  <div className="flex flex-col gap-1 items-start">
                    <div className="flex items-center gap-1 rounded-input border border-line bg-surface px-3 py-2 text-sm text-slate">
                      <span>Alpha AI is thinking</span>
                      <span className="flex gap-0.5" aria-hidden="true">
                        <span className="motion-safe:animate-bounce">.</span>
                        <span className="motion-safe:animate-bounce [animation-delay:150ms]">.</span>
                        <span className="motion-safe:animate-bounce [animation-delay:300ms]">.</span>
                      </span>
                    </div>
                    {slowNote && <span className="px-1 text-[11px] text-slate/70">Still thinking, answers take a moment.</span>}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-end gap-2 border-t border-line p-3">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.currentTarget.value);
                autoGrow();
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Ask Alpha AI..."
              rows={1}
              disabled={pending}
              className={cn(
                "max-h-[120px] min-h-10 flex-1 resize-none rounded-input border border-line bg-canvas px-3 py-2 text-sm text-ink",
                "placeholder:text-slate/75 focus:bg-surface",
                focusRing,
              )}
            />
            <button
              type="button"
              aria-label="Send"
              disabled={pending || !input.trim()}
              onClick={() => void send(input)}
              className={cn(
                "inline-flex size-10 shrink-0 items-center justify-center rounded-input bg-pigment text-surface",
                "transition-opacity motion-hover hover:opacity-90 disabled:opacity-40",
                focusRing,
              )}
            >
              <SendGlyph />
            </button>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
