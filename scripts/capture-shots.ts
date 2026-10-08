/**
 * `npx tsx scripts/capture-shots.ts --url http://127.0.0.1:4750`: takes the manual's screenshots from a running demo
 * (`npm run demo`) and writes them to `manual/images/<name>.png`.
 *
 *   --url URL        the running demo (required; only 127.0.0.1 / localhost / [::1] are accepted)
 *   --only a,b       only these slots (names from manual/images/SHOTS.md)
 *   --out DIR        another output folder (default manual/images)
 *   --raw            keep the PNG exactly as Chrome wrote it (no palette recompression)
 *
 * It drives headless Google Chrome over the DevTools protocol with Node's global WebSocket (no extra package): a fresh
 * browser context per slot, light color scheme, a 1440 x 900 window at device scale 1 (the phone slot: 375 x 812 at
 * scale 2 with mobile emulation). Per slot it opens the page, runs the slot's steps (clicks by text or selector, typed
 * text, keys, scrolling), waits for the network to go quiet, the fonts to load and every finite animation to finish,
 * then captures the window (or one element). Each PNG is recompressed with sharp (palette, no metadata) to at most
 * 400 KB; all of them together stay under 6 MB.
 *
 * The slot list lives here (SLOTS) and must match the table in manual/images/SHOTS.md: a name here that the table does
 * not list is refused. Some steps change the demo DB (Keep on a Shorts card, a typed prompt is not saved); run it
 * against a throwaway demo (`npm run demo -- --reset` gives a fresh one). Chrome runs with background networking,
 * component updates, sync and extensions off, so it only talks to the demo URL.
 *
 * Exported code: no owner data, only the demo's made-up names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import sharp from "sharp";
import { parseShots } from "./smoke-manual";

const REPO = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAX_BYTES = 400 * 1024;
const MAX_TOTAL = 6 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------------
// Slot definitions

/** What to click: visible text (exact after trimming, else contained), a CSS selector, or both (text inside matches). */
type Target = {
  text?: string | RegExp;
  selector?: string;
  /** Only inside the first visible element matching this selector. */
  within?: string;
  /** The match closest to this text: the one whose nearest ancestor containing the text is the fewest levels up (a
   * button on the card or row that shows it). */
  near?: string;
  nth?: number;
  exact?: boolean;
  /** A Settings card: the `section` whose h2 reads this. */
  card?: string;
};

type Step =
  | { goto: string }
  | { click: Target; settle?: number; optional?: boolean }
  | { hover: Target }
  | { type: string }
  | { key: string; settle?: number }
  | { scrollTo: Target; block?: "start" | "center" | "end"; offset?: number }
  | { scrollBy: number }
  | { waitFor: Target; timeout?: number }
  | { wait: number }
  | { eval: string };

type Slot = {
  name: string;
  path: string;
  steps?: Step[];
  /** Capture only the box around these elements (padded by `pad` px, default 12), else the whole window. */
  clip?: Target[];
  pad?: number;
  phone?: boolean;
  /** Window height for this slot (default 900). */
  height?: number;
};

/** A Settings card (a `section`) whose h2 reads `title`. */
const card = (title: string): Target => ({ card: title });

const BLUR = "document.activeElement && document.activeElement.blur && document.activeElement.blur()";

export const SLOTS: Slot[] = [
  { name: "readme-library", path: "/rtm/library", steps: [{ click: { text: "intro-take-3.mp4" } }] },
  {
    name: "readme-library-phone",
    path: "/rtm/library",
    phone: true,
    steps: [{ scrollTo: { selector: "button", text: "Sort: Newest" }, block: "center" }],
  },
  { name: "install-settings-paths", path: "/settings", steps: [{ scrollTo: card("Paths"), block: "end", offset: 24 }] },
  { name: "config-settings-lanes-clients", path: "/settings", steps: [{ scrollTo: card("Lanes"), offset: -16 }], clip: [card("Lanes"), card("Clients")] },
  { name: "library-grid", path: "/fkbpros/crumb/library" },
  {
    name: "library-drawer",
    path: "/fkbpros/ironleaf/library",
    height: 1310,
    steps: [{ click: { text: "class-broll.mp4" } }],
    clip: [{ selector: "[role=dialog]" }],
    pad: 0,
  },
  {
    name: "generate-panel",
    path: "/fkbpros/crumb/library",
    steps: [
      { click: { text: "Generate" } },
      { click: { selector: "textarea" } },
      { type: "Warm morning light on a fresh sourdough loaf, flour dusted wooden counter, vertical 9:16" },
      { click: { text: "Use as reference", near: "static-sourdough-class.jpg" } },
      { click: { text: "Use as reference", near: "static-weekend-box.jpg" } },
      { eval: BLUR },
    ],
  },
  { name: "review-queue", path: "/review", steps: [{ key: "?" }, { eval: BLUR }] },
  { name: "hooks-tab", path: "/fkbpros/crumb/hooks" },
  { name: "rubric-page", path: "/rubric" },
  { name: "client-tab", path: "/fkbpros/crumb/client", height: 1300 },
  { name: "running-tab", path: "/fkbpros/all/running", height: 1518 },
  {
    name: "new-paused-ad",
    path: "/fkbpros/ironleaf/hooks",
    height: 1300,
    steps: [
      { click: { text: "New ad", near: "Six weeks to your first real pull up" } },
      { click: { text: "Pick an image" } },
      { click: { text: "static-six-week-reset.jpg", exact: false, nth: 0 } },
      { eval: BLUR },
    ],
  },
  { name: "shorts-board", path: "/rtm/shorts", steps: [{ scrollTo: { selector: "h2", text: "Shorts board" }, offset: -16 }] },
  {
    name: "cut-reel-dialog",
    path: "/rtm/shorts",
    steps: [{ click: { text: "Keep", nth: 0 }, optional: true }, { click: { text: "Cut reel" } }, { eval: BLUR }],
  },
  { name: "jobs-page", path: "/jobs" },
  { name: "settings-top", path: "/settings" },
  { name: "settings-ai-jev", path: "/settings", steps: [{ scrollTo: { selector: "div", text: "Classify (Jev)" }, offset: -24 }] },
  { name: "settings-meta-card", path: "/settings", height: 1300, steps: [{ scrollTo: card("Meta and GHL"), offset: -16 }], clip: [card("Meta and GHL")] },
  { name: "settings-youtube-card", path: "/settings", steps: [{ scrollTo: card("YouTube"), offset: -16 }], clip: [card("YouTube")] },
  { name: "settings-ai-describe", path: "/settings", steps: [{ scrollTo: card("AI"), offset: -16 }] },
  { name: "settings-engines-higgsfield", path: "/settings", steps: [{ scrollTo: card("Generation engines"), offset: -16 }], clip: [card("Generation engines")] },
  { name: "settings-claude-card", path: "/settings", steps: [{ scrollTo: card("Claude"), offset: -16 }], clip: [card("Claude")] },
];

// ---------------------------------------------------------------------------------------------------------------------
// DevTools protocol

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string }; sessionId?: string };

class Cdp {
  private ws: WebSocket;
  private next = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: Msg) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as Msg;
      if (m.id != null) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result ?? {});
      } else for (const l of this.listeners) l(m);
    });
  }

  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot open ${url}`)), { once: true });
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
    });
  }

  on(fn: (m: Msg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.ws.close();
  }
}

/** One tab in its own browser context. */
export class Page {
  private inflight = new Map<string, number>();
  private lastActivity = Date.now();
  private off: () => void;

  constructor(
    readonly cdp: Cdp,
    readonly sessionId: string,
    readonly targetId: string,
    readonly contextId: string,
  ) {
    this.off = cdp.on((m) => {
      if (m.sessionId !== sessionId || !m.method) return;
      const p = m.params as { requestId?: string; type?: string };
      if (m.method === "Network.requestWillBeSent") {
        // Media streams (video previews) never finish while a video plays; they do not count.
        if (p.type !== "Media" && p.type !== "EventSource" && p.type !== "WebSocket") this.inflight.set(p.requestId!, Date.now());
        this.lastActivity = Date.now();
      } else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") {
        if (this.inflight.delete(p.requestId!)) this.lastActivity = Date.now();
      }
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  /** No request in flight (apart from media streams) for `quietMs`, or `maxMs` passed (the status poll never stops). */
  async networkIdle(quietMs = 600, maxMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const now = Date.now();
      // A request hanging for over 8 s (a long poll) is ignored.
      for (const [id, t] of this.inflight) if (now - t > 8000) this.inflight.delete(id);
      if (this.inflight.size === 0 && now - this.lastActivity >= quietMs) return;
      await sleep(100);
    }
  }

  /** Fonts loaded, every finite animation and transition finished (capped), images decoded. */
  async settle(extraMs = 400) {
    await this.networkIdle();
    await this.eval(`(async () => {
      await document.fonts.ready;
      const finite = () => document.getAnimations().filter((a) => {
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        return a.playState === "running" && t && Number.isFinite(t.endTime);
      });
      const end = Date.now() + 4000;
      while (finite().length && Date.now() < end) {
        await Promise.race([Promise.all(finite().map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 500))]);
      }
      await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 3000); })));
      return true;
    })()`);
    await sleep(extraMs);
    await this.networkIdle(400, 4000);
  }

  async goto(url: string) {
    const loaded = new Promise<void>((resolve) => {
      const off = this.cdp.on((m) => {
        if (m.sessionId === this.sessionId && m.method === "Page.loadEventFired") {
          off();
          resolve();
        }
      });
    });
    const r = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (r.errorText) throw new Error(`cannot open ${url}: ${r.errorText}`);
    await Promise.race([loaded, sleep(20_000)]);
    await this.settle();
  }

  /** The center of the target in window coordinates after scrolling it into view, or null. */
  async locate(t: Target, scroll = true): Promise<{ x: number; y: number; w: number; h: number } | null> {
    return this.eval(`(() => {
      const t = ${serializeTarget(t)};
      const el = ${FIND_FN}(t);
      if (!el) return null;
      if (${scroll}) { const r0 = el.getBoundingClientRect(); if (r0.top < 0 || r0.bottom > innerHeight) ${SCROLL_FN}(el, "center", 0); }
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
    })()`);
  }

  async rect(t: Target): Promise<{ left: number; top: number; width: number; height: number } | null> {
    return this.eval(`(() => {
      const el = ${FIND_FN}(${serializeTarget(t)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`);
  }

  async mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse" });
  }

  async click(t: Target) {
    const at = await this.waitForTarget(t, 8000);
    await sleep(150); // let a scroll land
    const p = (await this.locate(t, false)) ?? at;
    await this.mouse("mouseMoved", p.x, p.y);
    await this.mouse("mousePressed", p.x, p.y);
    await this.mouse("mouseReleased", p.x, p.y);
  }

  async hover(t: Target) {
    const p = await this.waitForTarget(t, 8000);
    await this.mouse("mouseMoved", p.x, p.y);
  }

  async waitForTarget(t: Target, timeout: number) {
    const end = Date.now() + timeout;
    for (;;) {
      const p = await this.locate(t);
      if (p && p.w > 0 && p.h > 0) return p;
      if (Date.now() > end) throw new Error(`not found: ${describeTarget(t)}`);
      await sleep(200);
    }
  }

  async key(key: string) {
    const named: Record<string, { code: string; keyCode: number; text?: string }> = {
      Escape: { code: "Escape", keyCode: 27 },
      Enter: { code: "Enter", keyCode: 13, text: "\r" },
      Tab: { code: "Tab", keyCode: 9 },
      ArrowDown: { code: "ArrowDown", keyCode: 40 },
      ArrowUp: { code: "ArrowUp", keyCode: 38 },
      "?": { code: "Slash", keyCode: 191, text: "?" },
    };
    const k = named[key] ?? { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
    const modifiers = key === "?" ? 8 : 0; // Shift
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: k.text, unmodifiedText: k.text, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers });
  }

  async close() {
    this.off();
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
    await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.contextId }).catch(() => {});
  }
}

/**
 * Scroll the element's nearest scrolling ancestor (the app scrolls inside its main column, not the window) so the
 * element sits at the start / center / end, then `off` px further (negative = room above it). The window itself is
 * scrolled only when no ancestor scrolls.
 */
const SCROLL_FN = `((el, block, off) => {
  let sc = el.parentElement;
  while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  const r = el.getBoundingClientRect();
  const box = sc ? sc.getBoundingClientRect() : { top: 0, height: innerHeight, bottom: innerHeight };
  const target = block === "center" ? box.top + (box.height - r.height) / 2 : block === "end" ? box.bottom - r.height : box.top;
  const delta = r.top - target + off;
  if (sc) sc.scrollTop += delta; else window.scrollBy(0, delta);
})`;

/** The element finder that runs in the page: a target -> the first visible match (or the nth). */
const FIND_FN = `((t) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden], [aria-hidden=true]"); };
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  let scope = document;
  if (t.within) { scope = [...document.querySelectorAll(t.within)].find(visible); if (!scope) return null; }
  if (t.card) {
    const h = [...scope.querySelectorAll("section h2")].find((h) => norm(h.textContent) === t.card && visible(h));
    return h ? h.closest("section") : null;
  }
  let els = [...scope.querySelectorAll(t.selector || "button, a, [role=button], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox], label, summary")].filter(visible);
  if (t.text != null) {
    const match = (el) => {
      const s = norm(el.innerText || el.textContent) || norm(el.getAttribute("aria-label")) || norm(el.getAttribute("title"));
      if (t.text.re) return new RegExp(t.text.re, t.text.flags).test(s);
      return t.exact === false ? s.includes(t.text) : s === t.text;
    };
    let hit = els.filter(match);
    if (!hit.length && t.exact == null) hit = els.filter((el) => norm(el.innerText || el.textContent).includes(t.text.re ? "\\u0000" : t.text));
    els = hit;
  }
  if (t.near) {
    const depth = (el) => { let d = 0; for (let a = el; a; a = a.parentElement, d++) if (norm(a.innerText).includes(t.near)) return d; return Infinity; };
    const scored = els.map((el) => [el, depth(el)]).filter((x) => x[1] < Infinity);
    const best = Math.min(...scored.map((x) => x[1]));
    els = scored.filter((x) => x[1] === best).map((x) => x[0]);
  }
  return els[t.nth || 0] || null;
})`;

function serializeTarget(t: Target): string {
  const text = t.text instanceof RegExp ? { re: t.text.source, flags: t.text.flags } : t.text;
  return JSON.stringify({ ...t, text });
}

function describeTarget(t: Target): string {
  return t.card ? `card "${t.card}"` : `${t.selector ?? "clickable"}${t.text != null ? ` with text ${String(t.text)}` : ""}${t.within ? ` in ${t.within}` : ""}${t.near ? ` near ${t.near}` : ""}${t.nth ? ` #${t.nth}` : ""}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------
// Chrome

export async function startChrome(): Promise<{ cdp: Cdp; proc: ChildProcess; dir: string }> {
  if (!fs.existsSync(CHROME)) throw new Error(`Google Chrome not found at ${CHROME} (set CHROME_BIN)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-shots-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-client-side-phishing-detection",
      "--disable-breakpad",
      "--no-pings",
      "--metrics-recording-only",
      "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions",
      "--password-store=basic",
      "--use-mock-keychain",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = path.join(dir, "DevToolsActivePort");
  const end = Date.now() + 15_000;
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n")) {
    if (Date.now() > end || proc.exitCode != null) throw new Error("Chrome did not start");
    await sleep(100);
  }
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  const cdp = await Cdp.open(`ws://127.0.0.1:${port}${wsPath}`);
  return { cdp, proc, dir };
}

/** Close Chrome, wait for it to exit, delete its temp profile. */
export async function stopChrome(c: { cdp: Cdp; proc: ChildProcess; dir: string }) {
  c.cdp.close();
  const exited = c.proc.exitCode != null ? Promise.resolve() : new Promise<void>((r) => c.proc.once("exit", () => r()));
  c.proc.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  if (c.proc.exitCode == null) c.proc.kill("SIGKILL");
  fs.rmSync(c.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export async function newPage(cdp: Cdp, opts: { phone?: boolean; height?: number } = {}): Promise<Page> {
  const { browserContextId } = await cdp.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId, targetId, browserContextId);
  await page.send("Page.enable");
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }] });
  if (opts.phone) {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true, screenWidth: 375, screenHeight: 812 });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  } else {
    const h = opts.height ?? 900;
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: h });
  }
  return page;
}

// ---------------------------------------------------------------------------------------------------------------------
// Capture

async function runSteps(page: Page, base: string, steps: Step[]) {
  for (const s of steps) {
    if ("goto" in s) await page.goto(base + s.goto);
    else if ("click" in s) {
      if (s.optional && !(await page.locate(s.click))) continue;
      await page.click(s.click);
      await page.settle(s.settle ?? 400);
    } else if ("hover" in s) {
      await page.hover(s.hover);
      await page.settle();
    } else if ("type" in s) {
      await page.send("Input.insertText", { text: s.type });
      await page.settle(200);
    } else if ("key" in s) {
      await page.key(s.key);
      await page.settle(s.settle ?? 400);
    } else if ("scrollTo" in s) {
      await page.eval(`(() => {
        const el = ${FIND_FN}(${serializeTarget(s.scrollTo)});
        if (!el) throw new Error("scrollTo: not found ${describeTarget(s.scrollTo).replace(/"/g, "'")}");
        ${SCROLL_FN}(el, ${JSON.stringify(s.block ?? "start")}, ${s.offset ?? 0});
      })()`);
      await page.settle(300);
    } else if ("scrollBy" in s) {
      await page.eval(`(() => { const m = [...document.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.clientHeight > innerHeight / 2); (m || window).scrollBy(0, ${s.scrollBy}); })()`);
      await page.settle(300);
    } else if ("waitFor" in s) await page.waitForTarget(s.waitFor, s.timeout ?? 10_000);
    else if ("wait" in s) await sleep(s.wait);
    else if ("eval" in s) {
      await page.eval(s.eval);
      await page.settle(300);
    }
  }
}

async function capture(page: Page, slot: Slot): Promise<Buffer> {
  // The text cursor and a hovered card would differ between runs: move the mouse to a corner and blur the field.
  await page.eval(`document.activeElement && document.activeElement.blur && document.activeElement.matches("input, textarea") ? null : null`);
  const params: Record<string, unknown> = { format: "png", captureBeyondViewport: false, fromSurface: true };
  if (slot.clip?.length) {
    const rects = [];
    for (const t of slot.clip) {
      const one = await page.rect(t);
      if (!one) throw new Error(`clip not found: ${describeTarget(t)}`);
      rects.push(one);
    }
    const left = Math.min(...rects.map((q) => q.left));
    const top = Math.min(...rects.map((q) => q.top));
    const r = { left, top, width: Math.max(...rects.map((q) => q.left + q.width)) - left, height: Math.max(...rects.map((q) => q.top + q.height)) - top };
    const pad = slot.pad ?? 12;
    const vw = slot.phone ? 375 : 1440;
    const vh = slot.phone ? 812 : (slot.height ?? 900);
    const x = Math.max(0, Math.floor(r.left - pad));
    const y = Math.max(0, Math.floor(r.top - pad));
    params.clip = { x, y, width: Math.min(vw - x, Math.ceil(r.width + 2 * pad)), height: Math.min(vh - y, Math.ceil(r.height + 2 * pad)), scale: 1 };
  }
  const { data } = await page.send<{ data: string }>("Page.captureScreenshot", params);
  return Buffer.from(data, "base64");
}

/**
 * Palette PNG without metadata, at most MAX_BYTES (fewer colors until it fits). `skip` passes over that many fitting
 * variants: compressed bytes can spell a short word by chance, and the leak gate scans images as bytes too.
 */
export async function compress(png: Buffer, skip = 0): Promise<Buffer> {
  for (const colours of [256, 255, 254, 253, 252, 192, 128, 96, 64]) {
    const out = await sharp(png).png({ palette: true, colours, quality: 100, effort: 10, compressionLevel: 9, dither: 0.5 }).toBuffer();
    if (out.length > MAX_BYTES) continue;
    if (skip-- > 0) continue;
    return out;
  }
  throw new Error(`could not compress under ${MAX_BYTES} bytes`);
}

/**
 * When this checkout has a leak denylist (scripts/leak-grep.sh's default, kept outside the export), the image must pass
 * the gate; null = it passes or there is no denylist to check against.
 */
function leakHit(file: string): string | null {
  if (!fs.existsSync(path.join(REPO, "private", "leak-denylist.txt"))) return null;
  const r = spawnSync(path.join(REPO, "scripts", "leak-grep.sh"), [file], { cwd: REPO, encoding: "utf8" });
  return r.status === 0 ? null : (r.stdout || r.stderr || "leak gate failed").trim();
}

function parseArgs(argv: string[]) {
  const a = { url: "", only: [] as string[], out: path.join(REPO, "manual", "images"), raw: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--url") a.url = argv[++i] ?? "";
    else if (v === "--only") a.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "--out") a.out = path.resolve(argv[++i] ?? "");
    else if (v === "--raw") a.raw = true;
    else usage(`unknown argument ${JSON.stringify(v)}`);
  }
  if (!a.url) usage("--url is required");
  let u: URL;
  try {
    u = new URL(a.url);
  } catch {
    usage(`not a URL: ${a.url}`);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) usage("--url must be a local address (127.0.0.1, localhost or [::1])");
  if (u.port === "4747" || u.port === "4748") usage("--url must be the demo (port 4750 by default), never a real install on 4747 / 4748");
  a.url = u.origin;
  return a;
}

function usage(msg: string): never {
  console.error(`capture-shots: ${msg}\nusage: npx tsx scripts/capture-shots.ts --url http://127.0.0.1:4750 [--only name,...] [--out DIR] [--raw]`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const listed = new Set(parseShots(fs.readFileSync(path.join(REPO, "manual", "images", "SHOTS.md"), "utf8")).map((r) => r.name));
  const unknown = SLOTS.filter((s) => !listed.has(s.name)).map((s) => s.name);
  if (unknown.length) usage(`slot(s) not listed in manual/images/SHOTS.md: ${unknown.join(", ")}`);
  const missing = [...listed].filter((n) => !SLOTS.some((s) => s.name === n));
  if (missing.length && !args.only.length) console.warn(`capture-shots: SHOTS.md lists slots this script has no steps for: ${missing.join(", ")}`);
  const badOnly = args.only.filter((n) => !SLOTS.some((s) => s.name === n));
  if (badOnly.length) usage(`unknown slot(s): ${badOnly.join(", ")}`);
  const slots = args.only.length ? SLOTS.filter((s) => args.only.includes(s.name)) : SLOTS;

  const status = await fetch(`${args.url}/api/status`).catch(() => null);
  if (!status?.ok) usage(`no Studio answers at ${args.url} (start it with npm run demo)`);

  fs.mkdirSync(args.out, { recursive: true });
  const chrome = await startChrome();
  const { cdp } = chrome;
  let failed = 0;
  try {
    for (const slot of slots) {
      const page = await newPage(cdp, { phone: slot.phone, height: slot.height });
      try {
        await page.goto(args.url + slot.path);
        await runSteps(page, args.url, slot.steps ?? []);
        await page.mouse("mouseMoved", 1, 1).catch(() => {});
        await page.settle(600);
        const raw = await capture(page, slot);
        const file = path.join(args.out, `${slot.name}.png`);
        let png = args.raw ? raw : await compress(raw);
        fs.writeFileSync(file, png);
        for (let attempt = 1; !args.raw && leakHit(file); attempt++) {
          if (attempt > 6) throw new Error(`the leak gate flags ${slot.name}.png after ${attempt} tries`);
          png = await compress(raw, attempt);
          fs.writeFileSync(file, png);
        }
        console.log(`ok   ${slot.name}.png  ${(png.length / 1024).toFixed(0)} KB`);
      } catch (e) {
        failed++;
        console.error(`FAIL ${slot.name}: ${(e as Error).message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await stopChrome(chrome);
  }
  const total = fs.readdirSync(args.out).filter((f) => f.endsWith(".png")).reduce((n, f) => n + fs.statSync(path.join(args.out, f)).size, 0);
  console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB in ${path.relative(REPO, args.out) || args.out}`);
  if (total > MAX_TOTAL) {
    console.error(`capture-shots: the images add up to more than ${MAX_TOTAL / 1024 / 1024} MB`);
    failed++;
  }
  process.exit(failed ? 1 : 0);
}

function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
}

if (isMain())
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
