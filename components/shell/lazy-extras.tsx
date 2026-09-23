"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";

import type { Role } from "@/lib/auth/config";
import { tourOpening, type OnboardingState } from "@/lib/tour/state";

/**
 * The Alpha chat and the first-run tour, loaded only when needed (docs/PERF.md).
 *
 * Both render nothing on the server and nothing until mounted, so moving them
 * out of the shell's first-load JavaScript changes no pixel. The tour's code
 * (~20 KB of source) is fetched only when this sign-in should open it, or when
 * someone asks for it ("Show me around"); the chat panel's code loads right
 * after the page is interactive, off the critical path.
 *
 * An open request that arrives before the code does is replayed once the
 * component has mounted and registered its own listener.
 */

// Same event names the components listen for (components/tour/tour.tsx
// TOUR_START_EVENT, components/alpha/alpha-chat.tsx OPEN_EVENT). Kept here as
// plain strings so the shell never imports the tour module just for a name.
export const TOUR_START_EVENT = "alphaos:tour-start";
const CHAT_OPEN_EVENT = "alphaos:chat-open";

type TourProps = { role: Role; firstName: string; onboarding: OnboardingState | null; signedInAt: number };
type ChatProps = { user: { name: string; email: string; role: Role } };

function useLazyOnEvent<P>(
  eventName: string,
  loadNow: boolean,
  load: () => Promise<ComponentType<P>>,
) {
  const [Comp, setComp] = useState<ComponentType<P> | null>(null);
  const pending = useRef<{ detail: unknown } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const start = () => {
      if (started.current) return;
      started.current = true;
      load().then((c) => setComp(() => c)).catch(() => {
        started.current = false;
      });
    };
    if (loadNow) start();
    const onEvent = (e: Event) => {
      if (Comp) return; // the component handles it itself
      pending.current = { detail: (e as CustomEvent).detail };
      start();
    };
    window.addEventListener(eventName, onEvent);
    return () => window.removeEventListener(eventName, onEvent);
  }, [Comp, eventName, load, loadNow]);

  // Children's effects run before this one, so the loaded component's own
  // listener is in place by the time the request is replayed.
  useEffect(() => {
    if (Comp && pending.current) {
      const { detail } = pending.current;
      pending.current = null;
      // Replayed with its detail: "?" > Watch must not arrive as a plain start.
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
  }, [Comp, eventName]);

  return Comp;
}

const loadTour = () => import("@/components/tour/tour").then((m) => m.Tour as ComponentType<TourProps>);
const loadChat = () => import("@/components/alpha/alpha-chat").then((m) => m.AlphaChat as ComponentType<ChatProps>);

export function LazyTour(props: TourProps) {
  const needed = tourOpening(props.onboarding, props.signedInAt).kind !== "none";
  const Tour = useLazyOnEvent<TourProps>(TOUR_START_EVENT, needed, loadTour);
  return Tour ? <Tour {...props} /> : null;
}

export function LazyAlphaChat(props: ChatProps) {
  // Idle-load: the launcher shows a moment after the page is interactive.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) {
      w.requestIdleCallback(() => setIdle(true), { timeout: 2000 });
    } else {
      const t = setTimeout(() => setIdle(true), 300);
      return () => clearTimeout(t);
    }
  }, []);
  const Chat = useLazyOnEvent<ChatProps>(CHAT_OPEN_EVENT, idle, loadChat);
  return Chat ? <Chat {...props} /> : null;
}
