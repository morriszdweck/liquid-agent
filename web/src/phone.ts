// Phones: the touches that make Liquid Agent feel like an app. Swipe the drawer open and
// shut, the top bar's hairline once something scrolls under it, the small title
// once a page's big one scrolls away, and press-and-hold menus on chats.

import { useEffect, useState } from "react";
import { useStore } from "./store";

/** The phone layout. styles.css and phone.css use the same test. */
export const PHONE = "(max-width: 820px), (max-height: 500px) and (pointer: coarse)";
const phoneQuery = matchMedia(PHONE);
export const isPhone = () => phoneQuery.matches;

export function usePhone() {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const update = () => setPhone(phoneQuery.matches);
    phoneQuery.addEventListener("change", update);
    return () => phoneQuery.removeEventListener("change", update);
  }, []);
  return phone;
}

/** Touch screens shouldn't pop the keyboard up just because a chat opened. */
export const touchFirst = () => matchMedia("(pointer: coarse)").matches;

function scrollState() {
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.matches(".thread, .page-scroll, .welcome, .modal-body")) return;
      const frame = el.closest(".page, .modal");
      frame?.classList.toggle("scrolled", el.scrollTop > 2);
      frame?.classList.toggle("past-title", el.scrollTop > 40);
    },
    { capture: true, passive: true },
  );
}

/** Whether a touch started on something that moves sideways by itself. */
function ownsSideways(el: Element | null) {
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.matches("input, textarea, select, .effort-track, .menu, .modal-backdrop, .welcome-ideas, .filters")) return true;
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

function drawerSwipe() {
  let start: { x: number; y: number; t: number; open: boolean } | null = null;
  let mode: "drag" | "none" | null = null;
  let width = 300;
  let dx = 0;
  const app = () => document.querySelector<HTMLElement>(".app");

  document.addEventListener(
    "touchstart",
    (e) => {
      start = null;
      if (!isPhone() || e.touches.length !== 1 || document.querySelector(".modal-backdrop")) return;
      const target = e.target as Element;
      const open = useStore.getState().sidebarOpen;
      if (open ? !target.closest(".sidebar, .sidebar-scrim") : !target.closest(".main") || ownsSideways(target)) return;
      const t = e.touches[0];
      // In a Safari tab the left edge already means "go back".
      if (!open && t.clientX < 20 && !matchMedia("(display-mode: standalone)").matches && !("standalone" in navigator && navigator.standalone)) return;
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp, open };
      mode = null;
      dx = 0;
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!start || mode === "none") return;
      const t = e.touches[0];
      dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!mode) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) mode = "none";
        else if (Math.abs(dx) > 10 && (start.open ? dx < 0 : dx > 0)) {
          mode = "drag";
          width = document.querySelector<HTMLElement>(".sidebar")?.offsetWidth || 300;
          app()?.classList.add("dragging");
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
        if (mode !== "drag") return;
      }
      e.preventDefault();
      const shown = Math.min(1, Math.max(0, (start.open ? width + dx : dx) / width));
      app()?.style.setProperty("--drawer", String(shown));
    },
    { passive: false },
  );

  const end = (e: TouchEvent) => {
    if (start && mode === "drag") {
      const speed = dx / Math.max(1, e.timeStamp - start.t);
      const open = start.open ? !(dx < -width / 3 || speed < -0.35) : dx > width / 3 || speed > 0.35;
      const el = app();
      el?.classList.remove("dragging");
      el?.style.removeProperty("--drawer");
      useStore.setState({ sidebarOpen: open });
    }
    start = null;
    mode = null;
  };
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", end, { passive: true });
}

/** Press and hold anything with data-hold to tap the button its value names. */
function pressAndHold() {
  let timer = 0;
  let at = { x: 0, y: 0 };
  const cancel = () => clearTimeout(timer);
  document.addEventListener(
    "touchstart",
    (e) => {
      cancel();
      const row = (e.target as Element).closest<HTMLElement>("[data-hold]");
      if (!row || e.touches.length !== 1) return;
      at = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      timer = window.setTimeout(() => {
        const button = row.querySelector<HTMLElement>(row.dataset.hold!);
        if (!button) return;
        navigator.vibrate?.(8);
        // The finger lifting would otherwise also tap the row.
        const swallow = (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
        };
        document.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 600);
        button.click();
      }, 450);
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - at.x, t.clientY - at.y) > 8) cancel();
    },
    { passive: true },
  );
  document.addEventListener("touchend", cancel, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });
}

/** Whether something under the finger can scroll along this axis. */
function canScroll(el: Element | null, axis: "x" | "y") {
  for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (axis === "y" ? el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(style.overflowY) : el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(style.overflowX)) return true;
  }
  return false;
}

/** Like an app, the page itself stays put: no pinch or double-tap zoom, and no
 *  sliding the whole page around (or out from under the keyboard). Drags over
 *  something that scrolls (the chat, lists, sheets, the ideas strip) work as usual. */
function lockPage() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta && !meta.content.includes("maximum-scale")) meta.content += ", maximum-scale=1, user-scalable=no";
  // Safari ignores user-scalable=no; its own pinch events can still be refused.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });

  let target: Element | null = null;
  let at = { x: 0, y: 0 };
  let allow: boolean | null = null;
  document.addEventListener(
    "touchstart",
    (e) => {
      target = e.target as Element;
      at = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      allow = null;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length > 1) {
        if (e.cancelable) e.preventDefault(); // pinch
        return;
      }
      if (allow === null) {
        const dx = Math.abs(e.touches[0].clientX - at.x);
        const dy = Math.abs(e.touches[0].clientY - at.y);
        if (!dx && !dy) return;
        // Sliders, pickers and the effort slider handle their own drags.
        allow = !!target?.closest('input[type="range"], select, .effort-track') || canScroll(target, dy >= dx ? "y" : "x");
      }
      if (!allow && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
}

export function setUpPhone() {
  scrollState();
  if (!matchMedia("(pointer: coarse)").matches) return;
  lockPage();
  drawerSwipe();
  pressAndHold();
}
