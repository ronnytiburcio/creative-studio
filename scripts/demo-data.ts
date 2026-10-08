/**
 * The demo's sample data (`npm run demo`, scripts/demo.ts): written ONLY into the demo DB, after the demo media is
 * indexed, so every tab has something to show without a key, Ollama, whisper or any network call.
 *
 * Marked as demo data: `app_settings` `demo:seeded_at` (the one-time part) and `demo:running_day` (the Running numbers'
 * day), hook scores with model `demo` (fixed answers, no Jev call: no ai_calls row), the Shorts cards' job row says so.
 * Idempotent: the one-time part runs once per DB (the marker); the Running numbers are rebuilt for today's date on every
 * run (delete + insert for the two demo ad accounts only), so a second run the same day leaves every row as it was.
 *
 * Written with the app's own store functions where they exist (addTextHooks, addWork, pinHook, addVideoHook,
 * syncEpisodes, insertCards, keepShort, setShortStatus, the hook state / questions / evaluateHook of real scoring),
 * parameterized SQL otherwise. Every name, business, number and line is made up.
 */
import path from "node:path";
import type Database from "better-sqlite3";
import type { StudioConfig } from "../src/lib/config";
import type { JevAnswer, JevQuestion } from "../src/lib/ai/jev";
import { DESCRIBE_PROMPT_VERSION } from "../src/lib/ai/describe";
import { classifyThreshold } from "../src/lib/ai/state";
import { addWork, pinHook } from "../src/lib/hooks/client";
import { loadChannelNotes } from "../src/lib/hooks/notes";
import { buildHookQuestions, buildHookState, evaluateHook, type HookInput } from "../src/lib/hooks/score";
import { addTextHooks, currentRubric, storeHookScore, type HookChannel } from "../src/lib/hooks/store";
import { addVideoHook, videoHookText, videoLines } from "../src/lib/hooks/video";
import type { HookKind, RubricVersion, SectionKey } from "../src/lib/hooks/rubric";
import { addDays, inRange, localDate, metaRange, RUN_WINDOWS, type RunWindow } from "../src/lib/meta/windows";
import { syncEpisodes } from "../src/lib/shorts/episodes";
import { insertCards } from "../src/lib/shorts/moments";
import { keepShort, setShortStatus } from "../src/lib/shorts/board";
import { linkOutput } from "../src/lib/shorts/outputs";
import type { CheckedMoment } from "../src/lib/shorts/rules";
import { CUE_SECONDS, DEMO_PATHS, EPISODE_CUES, type DemoKey } from "./make-demo";

type Sql = Database.Database;

export const DEMO_SEEDED_KEY = "demo:seeded_at";
export const DEMO_RUNNING_DAY_KEY = "demo:running_day";
/** hook_scores.model of every demo score (fixed answers written by this file; never a Jev call). */
export const DEMO_SCORE_MODEL = "demo";
const TZ = "America/New_York";

// ------------------------------------------------------------------------------------------------ descriptions

type Desc = { cls: string; text: string[]; spoken?: string };

/** Fixed descriptions in the describe model's labelled format, so search, the drawer and video hooks work. */
const DESCRIPTIONS: Record<DemoKey, Desc> = {
  episode: {
    cls: "episode",
    text: [
      'First 3 seconds: A title slide reading "Shooting on a Budget" with a small round presenter picture in the corner.',
      "Shows: A slide talk about filming with little gear: light beats gear, window light, sound, framing, batching and a $200 kit.",
      "People: 1, presenter in a small round picture.",
      "Setting: Slides in navy, sand and green.",
      'Text: "Shooting on a Budget" | "Harbor and Pine · Episode 1" | "Light beats gear" | "Fix your sound" | "The $200 kit"',
      "Looks like: screen recording, talking head",
    ],
    spoken: "Welcome back to Harbor and Pine, where we make good video with very little gear. Today is all about shooting on a budget.",
  },
  episodeSrt: { cls: "other", text: [] },
  reel: {
    cls: "short",
    text: [
      "First 3 seconds: A vertical frame with the headline WINDOW LIGHT over a bright window and a presenter.",
      "Shows: A slow push in on a window, a presenter and the headline WINDOW LIGHT.",
      "People: 1, presenter.",
      "Setting: A bright room with a window.",
      'Text: "WINDOW" | "LIGHT" | "A window is the best light you will ever own."',
      "Looks like: video ad with captions, talking head",
    ],
    spoken: "",
  },
  short: {
    cls: "short",
    text: [
      'First 3 seconds: A bright window drawing with the words "Window light in 60 seconds" underneath.',
      "Shows: A slow push in on a window drawing and a title card.",
      "People: none",
      "Setting: A sand colored title card.",
      'Text: "Window light" | "in 60 seconds" | "Harbor and Pine"',
      "Looks like: logo/graphic animation",
    ],
    spoken: "",
  },
  brollHarbor: {
    cls: "broll",
    text: [
      "First 3 seconds: A wide view of a harbor with green hills and small sailboats.",
      "Shows: A slow sideways pan across calm water, sailboats and green hills under a pale sun.",
      "People: none",
      "Setting: A harbor in the morning.",
      "Text: none",
      "Looks like: b-roll",
    ],
    spoken: "",
  },
  brollDesk: {
    cls: "broll",
    text: [
      "First 3 seconds: A desk by a bright window with a monitor and a lamp.",
      "Shows: A slow slider move across a small video desk: window, monitor, lamp and a white bounce board.",
      "People: none",
      "Setting: A home office.",
      "Text: none",
      "Looks like: b-roll",
    ],
    spoken: "",
  },
  talkingHead: {
    cls: "talking_head",
    text: [
      "First 3 seconds: A presenter sits at a desk next to a bright window and starts talking.",
      "Shows: One presenter talking to the camera at a desk by a window.",
      "People: 1, presenter talking to camera.",
      "Setting: A home office.",
      "Text: none",
      "Looks like: talking head",
    ],
    spoken: "Today I want to show you why light beats gear, and it starts with the window behind your desk.",
  },
  thumbnail: {
    cls: "thumbnail",
    text: [
      "Shows: Huge words LIGHT BEATS GEAR next to a presenter in front of a window.",
      "People: 1, presenter.",
      "Setting: A navy background.",
      'Text: "LIGHT" | "BEATS" | "GEAR"',
      "Looks like: thumbnail",
    ],
  },
  mark: {
    cls: "brand_asset",
    text: ["Shows: A rounded navy square with a green pine tree and an orange wave line.", "People: none", "Setting: none", "Text: none", "Looks like: logo/graphic"],
  },
  quote: {
    cls: "brand_asset",
    text: [
      "Shows: A green quote card with a large orange quote mark and white words.",
      "People: none",
      "Setting: none",
      `Text: "The best light you will ever own is free. It's called a window." | "Harbor and Pine"`,
      "Looks like: logo/graphic",
    ],
  },
  crumbBox: {
    cls: "static_ad",
    text: [
      "Shows: A brown gift box with two sourdough loaves on top, a headline and an orange button.",
      "People: none",
      "Setting: A cream background.",
      'Text: "Crumb and Crust Bakery" | "The weekend box feeds four for brunch" | "Two loaves, six pastries, jam." | "Order by Thursday night." | "Order your box"',
      "Looks like: static ad with copy",
    ],
  },
  crumbClass: {
    cls: "static_ad",
    text: [
      "Shows: One large sourdough loaf with scored lines, a headline and an orange button.",
      "People: none",
      "Setting: A cream background.",
      'Text: "Crumb and Crust Bakery" | "Bake real sourdough in one Sunday class" | "Small class, eight seats." | "Save a seat"',
      "Looks like: static ad with copy",
    ],
  },
  crumbBefore: {
    cls: "before_after",
    text: ["Shows: A plain two layer cake with no frosting on a plate.", "People: none", "Setting: A light gray background.", 'Text: "BEFORE" | "Plain layers, no frosting yet"', "Looks like: before/after"],
  },
  crumbAfter: {
    cls: "before_after",
    text: [
      "Shows: A pink frosted birthday cake with four lit candles.",
      "People: none",
      "Setting: A light pink background.",
      'Text: "AFTER" | "Birthday cake, ready for pickup"',
      "Looks like: before/after",
    ],
  },
  crumbBaker: {
    cls: "talking_head",
    text: [
      "First 3 seconds: A baker in a white top stands in front of bread shelves and starts talking.",
      "Shows: One person talking to the camera in a bakery with loaves on the shelves.",
      "People: 1, person talking to camera.",
      "Setting: A bakery.",
      "Text: none",
      "Looks like: talking head",
    ],
    spoken: "Every Saturday we bake forty loaves of sourdough, and they are usually gone by ten.",
  },
  ironFree: {
    cls: "static_ad",
    text: [
      "Shows: A large dumbbell drawing, a headline and an orange button.",
      "People: none",
      "Setting: A pale green background.",
      'Text: "Ironleaf Fitness" | "Your first class is free" | "No contract. No pressure." | "Book a free class"',
      "Looks like: static ad with copy",
    ],
  },
  ironReset: {
    cls: "static_ad",
    text: [
      "Shows: A person under a pull up bar, a white headline on a dark green background and an orange button.",
      "People: 1, person.",
      "Setting: A dark green background.",
      'Text: "Ironleaf Fitness" | "Six weeks to your first real pull up" | "The Six Week Reset starts Monday." | "Join the reset"',
      "Looks like: static ad with copy",
    ],
  },
  ironBroll: {
    cls: "broll",
    text: [
      "First 3 seconds: A small group class stands in a bright studio with dumbbells on the floor.",
      "Shows: A slow pan across a fitness class: four people, posts and dumbbells.",
      "People: 4, people in a class.",
      "Setting: A fitness studio.",
      "Text: none",
      "Looks like: b-roll",
    ],
    spoken: "",
  },
  spokeTune: {
    cls: "static_ad",
    text: [
      "Shows: A blue bike drawing, a headline and an orange button.",
      "People: none",
      "Setting: A pale blue background.",
      'Text: "Spoke and Chain Cycles" | "Spring tune up in 48 hours" | "Or the tune up is free." | "Book a tune up"',
      "Looks like: static ad with copy",
    ],
  },
  spokeBeforeAfter: {
    cls: "before_after",
    text: ["Shows: A rusty gray bike on the left and the same bike clean and blue on the right.", "People: none", "Setting: Split background.", 'Text: "BEFORE" | "AFTER"', "Looks like: before/after"],
  },
};

// ------------------------------------------------------------------------------------------------ hooks

const LANE_A_HOOKS = [
  "Your camera matters far less than your light.",
  "A window is the best light you will ever own, and it is free.",
  "Stop buying gear until you fix this one thing",
  "Three ways to make a phone video look expensive",
  "People forgive bad video. They never forgive bad audio.",
  "I filmed a month of Shorts in one morning. Here is how.",
  "The $20 mic that beats a $900 camera",
  "Why your videos look tired (and the 10 second fix)",
  "New to YouTube? Film these 5 videos first",
  "Turn off the ceiling light before you hit record",
  "My whole video kit costs less than a nice dinner out",
  "If your talking head videos feel stiff, try this",
];

const CLIENT_HOOKS: Record<"crumb" | "ironleaf" | "spoke", string[]> = {
  crumb: [
    "Fresh sourdough every Saturday, but only 40 loaves",
    "Skip the grocery store bread aisle this weekend",
    "Learn to bake real sourdough in one Sunday class",
    "Our weekend box feeds a family of four for brunch",
    "Birthday cakes that taste as good as they look",
  ],
  ironleaf: [
    "Your first class at Ironleaf is free, no contract",
    "Six weeks to your first real pull up",
    "Busy parents: 30 minute classes before school drop off",
    "Hate the gym? You might love a small group class",
    "Coaches who learn your name on day one",
  ],
  spoke: [
    "Spring tune up in 48 hours or it is free",
    "That squeaky chain is costing you speed",
    "Flat tire? Walk in, ride out in 20 minutes",
    "Your commute is faster on two wheels than you think",
    "Kids bikes fitted the right way, free with any purchase",
  ],
};

const SHARED_HOOKS = ["Small local shops deserve ads that sound like them", "Three photos every local shop should post this month"];

const WORKS: [string, string][] = [
  ["crumb", "Scarcity lines (only 40 loaves on Saturday) beat discount lines."],
  ["crumb", "Food first: show the bread before the box."],
  ["ironleaf", "\"Free first class\" and \"no contract\" in the same line."],
  ["spoke", "A clear turnaround time (48 hours) in the headline."],
];

// ------------------------------------------------------------------------------------------------ deterministic numbers

/** FNV-1a: a stable 32 bit hash of a string. */
function h32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 seeded from a string: the same seed always gives the same sequence. */
function rng(seed: string): () => number {
  let a = h32(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Fixed answers in Jev's normalized shape (choice / score / noul), drawn from the hook's own seeded numbers. */
function demoAnswers(text: string, questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  const r = rng(`demo-hook:${text}`);
  const quality = 0.2 + 0.75 * r(); // one hook-wide level so a hook's answers agree with each other
  const out: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "score") {
      const v = clamp(Math.round(quality * 4 + (r() - 0.5) * 1.6), 0, 4);
      const spread = r() < 0.12; // about one answer in eight splits wider (an "unsure" mark, as real scores show)
      const probs: Record<string, number> = {};
      for (let k = 0; k <= 4; k++) probs[String(k)] = 0;
      const nb = v === 4 ? 3 : v === 0 ? 1 : r() < 0.5 ? v - 1 : v + 1;
      if (spread) {
        probs[String(v)] = 0.46;
        probs[String(nb)] = 0.2;
        const other = v === 0 || v === 4 ? 2 : nb === v - 1 ? v + 1 : v - 1;
        probs[String(other)] += 0.2;
      } else {
        probs[String(v)] = 0.74;
        probs[String(nb)] = 0.2;
      }
      const left = 1 - Object.values(probs).reduce((s, p) => s + p, 0);
      const zeros = Object.keys(probs).filter((k) => probs[k] === 0);
      for (const k of zeros) probs[k] = r4(left / zeros.length);
      out[id] = { type: "score", value: v, probabilities: probs, confidence: probs[String(v)] };
    } else if (q.type === "noul") {
      // Mostly a clear yes or no (as Jev answers), now and then an undecided middle (the "unsure" band).
      const lean = quality + (r() - 0.5) * 0.5;
      const mid = r() < 0.1;
      const p = r4(mid ? 0.35 + 0.3 * r() : lean > 0.5 ? 0.78 + 0.19 * r() : 0.04 + 0.18 * r());
      out[id] = { type: "noul", value: p, probabilities: { yes: p, no: r4(1 - p) }, confidence: null };
    } else {
      const options = Object.keys(q.criteria);
      let pick = options[Math.floor(r() * options.length) % options.length];
      if (id === "avatar" && r() < 0.3 && options.includes("none")) pick = "none";
      const top = r() < 0.15 ? 0.55 : 0.84;
      const probabilities = Object.fromEntries(options.map((o) => [o, o === pick ? top : r4((1 - top) / Math.max(1, options.length - 1))]));
      out[id] = { type: "choice", value: pick, probabilities, confidence: top };
    }
  }
  return out;
}

type HookRow = { id: number; kind: HookKind; section: SectionKey; text: string; client_id: number | null; asset_id: number | null };

/** The same input the worker's HookScoreQueue builds for a hook (channel notes + the video lines). */
function hookInput(sql: Sql, row: HookRow): HookInput {
  let video: HookInput["video"] = null;
  if (row.kind === "video" && row.asset_id) {
    const a = sql.prepare("select description, spoken_open from assets where id = ?").get(row.asset_id) as { description: string | null; spoken_open: string | null } | undefined;
    if (a) {
      const lines = videoLines(a.description, a.spoken_open);
      video = { firstSeconds: lines.opening, earlyFrame: lines.earlyFrame, onScreenText: lines.onScreen, spokenOpening: lines.spoken, textFrom: videoHookText(lines)?.from };
    }
  }
  return { ...loadChannelNotes(sql, row.section, row.client_id), id: row.id, kind: row.kind, text: row.text, video };
}

/** Score every live hook that has no score on the current rubric version with fixed demo answers. Returns how many. */
export function scoreDemoHooks(sql: Sql, now: number): number {
  const rubric: RubricVersion = currentRubric(sql);
  const rows = sql
    .prepare(
      `select h.id, h.kind, s.key as section, h.text, h.client_id, h.asset_id from hooks h join sections s on s.id = h.section_id
        where h.archived_at is null and (h.parent_id is null or h.kept = 1)
          and not exists (select 1 from hook_scores hs where hs.hook_id = h.id and hs.rubric_version = ?)
        order by h.id`,
    )
    .all(rubric.version) as HookRow[];
  const threshold = classifyThreshold(sql);
  const clear = sql.prepare("update hooks set score_requested_at = null, score_error = null where id = ?");
  for (const row of rows) {
    const input = hookInput(sql, row);
    const questions = buildHookQuestions(rubric, input);
    const { notesFp } = buildHookState(rubric, input);
    const ev = evaluateHook(rubric, input, demoAnswers(row.text, questions), threshold);
    storeHookScore(sql, { hookId: row.id, version: rubric.version, ev, notesFp, model: DEMO_SCORE_MODEL, callId: null, now });
    clear.run(row.id);
  }
  return rows.length;
}

// ------------------------------------------------------------------------------------------------ Shorts board

/** Cue i of Episode 1 in master seconds, padded 0.2 s like a checked moment. */
const cueStart = (i: number) => Math.max(0, i * CUE_SECONDS - 0.2);
const cueEnd = (i: number) => (i + 1) * CUE_SECONDS + 0.2;

type CardDef = { from: number; to: number; cold: number; words: string; why: string; layout: CheckedMoment["layout"] };
const CARDS: CardDef[] = [
  { from: 3, to: 9, cold: 4, words: "LIGHT *BEATS* GEAR", why: "A clear claim in the first line, then the free fix (the window).", layout: "stack" },
  { from: 8, to: 14, cold: 9, words: "FIX YOUR *SOUND*", why: "Opens on a surprising rule about audio and pays it off with one cheap tool.", layout: "stack" },
  { from: 19, to: 25, cold: 20, words: "ONE *MORNING* A WEEK", why: "A time saving promise with a concrete routine.", layout: "center" },
  { from: 22, to: 27, cold: 23, words: "THE *$200* KIT", why: "A short list with a price people can check.", layout: "stack" },
  { from: 4, to: 10, cold: 5, words: "WINDOW *LIGHT*", why: "One visual tip that works on any phone.", layout: "stack" },
  { from: 14, to: 20, cold: 15, words: "FRAME IT *RIGHT*", why: "Two framing rules a viewer can try at once.", layout: "pip" },
];

// ------------------------------------------------------------------------------------------------ Running (Meta)

type AdDef = {
  id: string;
  name: string;
  status: "ACTIVE" | "PAUSED";
  file: DemoKey | null;
  video: boolean;
  hook: string;
  /** Daily spend ($), CPM ($), CTR (%), leads per link click, hook rate (video). */
  spend: number;
  cpm: number;
  ctr: number;
  conv: number;
  hookRate?: number;
  /** First day (days ago) and, for a paused ad, the last day it delivered (days ago). */
  startDaysAgo: number;
  stopDaysAgo?: number;
  /** CTR drops over the last 7 days and the 7 day frequency is high (the "fatiguing" flag). */
  fatigue?: boolean;
};

type AccountDef = { code: "crumb" | "ironleaf"; act: string; campaignId: string; campaign: string; adset: string; ads: AdDef[] };

export const DEMO_ACCOUNTS: AccountDef[] = [
  {
    code: "crumb",
    act: "act_100000000000021",
    campaignId: "120000000000002101",
    campaign: "Crumb and Crust | Always on",
    adset: "Neighborhood 5 km",
    ads: [
      { id: "120000000000210001", name: "crumb-weekend-box-01", status: "ACTIVE", file: "crumbBox", video: false, hook: CLIENT_HOOKS.crumb[3], spend: 18, cpm: 15.5, ctr: 1.6, conv: 0.09, startDaysAgo: 29 },
      { id: "120000000000210002", name: "crumb-sourdough-class-02", status: "ACTIVE", file: "crumbClass", video: false, hook: CLIENT_HOOKS.crumb[2], spend: 12, cpm: 17, ctr: 1.2, conv: 0.07, startDaysAgo: 21 },
      { id: "120000000000210003", name: "crumb-baker-video-03", status: "ACTIVE", file: "crumbBaker", video: true, hook: CLIENT_HOOKS.crumb[0], spend: 22, cpm: 13, ctr: 1.9, conv: 0.16, hookRate: 0.31, startDaysAgo: 24 },
      { id: "120000000000210004", name: "crumb-cake-before-after-04", status: "PAUSED", file: "crumbAfter", video: false, hook: CLIENT_HOOKS.crumb[4], spend: 9, cpm: 19, ctr: 0.9, conv: 0.05, startDaysAgo: 28, stopDaysAgo: 6 },
    ],
  },
  {
    code: "ironleaf",
    act: "act_100000000000022",
    campaignId: "120000000000002201",
    campaign: "Ironleaf | Free first class",
    adset: "Parents 25 to 45",
    ads: [
      { id: "120000000000220001", name: "ironleaf-first-class-free-01", status: "ACTIVE", file: "ironFree", video: false, hook: CLIENT_HOOKS.ironleaf[0], spend: 25, cpm: 16, ctr: 1.8, conv: 0.2, startDaysAgo: 29 },
      { id: "120000000000220002", name: "ironleaf-six-week-reset-02", status: "ACTIVE", file: "ironReset", video: false, hook: CLIENT_HOOKS.ironleaf[1], spend: 20, cpm: 14.5, ctr: 2.1, conv: 0.06, startDaysAgo: 29, fatigue: true },
      { id: "120000000000220003", name: "ironleaf-class-video-03", status: "ACTIVE", file: "ironBroll", video: true, hook: CLIENT_HOOKS.ironleaf[2], spend: 15, cpm: 12, ctr: 1.4, conv: 0.08, hookRate: 0.27, startDaysAgo: 17 },
      { id: "120000000000220004", name: "ironleaf-gym-haters-04", status: "PAUSED", file: null, video: false, hook: CLIENT_HOOKS.ironleaf[3], spend: 10, cpm: 18, ctr: 0.8, conv: 0.04, startDaysAgo: 26, stopDaysAgo: 9 },
    ],
  },
];

type Day = { date: string; spend: number; impressions: number; reach: number; clicks: number; linkClicks: number; leads: number; v3: number; thru: number };

/** One ad's daily rows ending today (today is a partial day). Seeded by the ad id and the day offset only. */
function adDays(ad: AdDef, today: string): Day[] {
  const out: Day[] = [];
  let acc = 0;
  for (let k = ad.startDaysAgo; k >= 0; k--) {
    if (ad.stopDaysAgo != null && k < ad.stopDaysAgo) continue;
    const r = rng(`demo-ad:${ad.id}:${k}`);
    const date = addDays(today, -k);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const part = k === 0 ? 0.45 : 1;
    const spend = r2(ad.spend * part * (0.8 + 0.4 * r()) * (dow === 0 || dow === 6 ? 1.15 : 1));
    const impressions = Math.round((spend / ad.cpm) * 1000 * (0.9 + 0.2 * r()));
    const ctr = ad.ctr * (ad.fatigue && k <= 7 ? 0.55 : 1) * (0.85 + 0.3 * r());
    const clicks = Math.round((impressions * ctr) / 100);
    const linkClicks = Math.round(clicks * (0.55 + 0.15 * r()));
    const before = Math.floor(acc);
    acc += linkClicks * ad.conv;
    const leads = Math.floor(acc) - before;
    const v3 = ad.video ? Math.round(impressions * (ad.hookRate ?? 0.3) * (0.9 + 0.2 * r())) : 0;
    out.push({ date, spend, impressions, reach: Math.round(impressions / (1.05 + 0.1 * r())), clicks, linkClicks, leads, v3, thru: Math.round(v3 * 0.32) });
  }
  return out;
}

/** The 7 day / 14 day / lifetime frequency Meta would report (fixed per ad; the fatiguing ad is high). */
const windowFrequency = (ad: AdDef, w: RunWindow) =>
  w === "today" ? 1.02 : w === "7d" ? (ad.fatigue ? 3.6 : 1.35) : w === "14d" ? (ad.fatigue ? 4.1 : 1.7) : ad.fatigue ? 5.2 : 2.3;

/** Rebuild the two demo accounts' Running numbers for today (delete + insert; only these accounts' rows). */
export function refreshDemoRunning(sql: Sql, drivePath: string, now: number, hookIds: Map<string, number>): void {
  const today = localDate(now, TZ);
  const fkbpros = sql.prepare("select id from sections where key = 'fkbpros'").pluck().get() as number;
  sql.transaction(() => {
    for (const acc of DEMO_ACCOUNTS) {
      const accountId = sql.prepare("select id from ad_accounts where act_id = ?").pluck().get(acc.act) as number | undefined;
      if (!accountId) throw new Error(`demo data: ad account ${acc.act} is missing (is demo/studio.config.json the config?)`);
      sql
        .prepare(
          `update ad_accounts set section_id = ?, timezone = ?, campaign_source = 'account', last_sync_at = ?, last_attempt_at = ?, error = null,
             leads_source = 'meta', ghl_synced_at = null, ghl_error = null where id = ?`,
        )
        .run(fkbpros, TZ, now, now, accountId);
      sql.prepare("delete from ad_metrics where account_id = ?").run(accountId);
      sql.prepare("delete from channel_metrics where account_id = ?").run(accountId);
      sql.prepare(`delete from ad_windows where meta_ad_id in (select value from json_each(?))`).run(JSON.stringify(acc.ads.map((a) => a.id)));
      const days = new Map(acc.ads.map((a) => [a.id, adDays(a, today)]));
      const first = [...days.values()].flat().reduce((m, d) => (d.date < m ? d.date : m), today);
      sql
        .prepare(
          `insert into meta_campaigns (id, account_id, name, effective_status, start_date, backfilled_at, synced_through, synced_at)
           values (?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
           on conflict (id) do update set account_id = excluded.account_id, name = excluded.name, effective_status = excluded.effective_status,
             start_date = excluded.start_date, backfilled_at = excluded.backfilled_at, synced_through = excluded.synced_through, synced_at = excluded.synced_at`,
        )
        .run(acc.campaignId, accountId, acc.campaign, first, now, today, now);
      const insMetric = sql.prepare(
        `insert into ad_metrics (meta_ad_id, date, account_id, ad_name, spend, impressions, reach, frequency, clicks, ctr, cpm, link_clicks,
           cost_per_link_click, meta_leads, video_3s, thruplays, synced_at)
         values (@id, @date, @account, @name, @spend, @impressions, @reach, @frequency, @clicks, @ctr, @cpm, @link, @cplc, @leads, @v3, @thru, @now)`,
      );
      const insWindow = sql.prepare("insert into ad_windows (meta_ad_id, window, reach, impressions, frequency, synced_at) values (?, ?, ?, ?, ?, ?)");
      for (const ad of acc.ads) {
        const rows = days.get(ad.id)!;
        for (const d of rows) {
          insMetric.run({
            id: ad.id,
            date: d.date,
            account: accountId,
            name: ad.name,
            spend: d.spend,
            impressions: d.impressions,
            reach: d.reach,
            frequency: d.reach ? r4(d.impressions / d.reach) : null,
            clicks: d.clicks,
            ctr: d.impressions ? r4((d.clicks / d.impressions) * 100) : null,
            cpm: d.impressions ? r4((d.spend / d.impressions) * 1000) : null,
            link: d.linkClicks,
            cplc: d.linkClicks ? r4(d.spend / d.linkClicks) : null,
            leads: d.leads,
            v3: d.v3,
            thru: d.thru,
            now,
          });
        }
        for (const w of RUN_WINDOWS) {
          const range = metaRange(w, today);
          const impressions = rows.filter((d) => inRange(d.date, range)).reduce((s, d) => s + d.impressions, 0);
          if (!impressions) continue;
          const f = windowFrequency(ad, w);
          insWindow.run(ad.id, w, Math.round(impressions / f), impressions, f, now);
        }
        const spent = rows.filter((d) => d.spend > 0).map((d) => d.date);
        const creative = {
          headlines: [ad.hook],
          primaries: [],
          descriptions: [],
          ctas: ["LEARN_MORE"],
          videoIds: [],
          imageHashes: [],
          isVideo: ad.video,
          link: `https://example.com/${acc.code}`,
        };
        const asset = ad.file ? (sql.prepare("select id from assets where path = ?").pluck().get(path.join(drivePath, DEMO_PATHS[ad.file])) as number | undefined) ?? null : null;
        sql
          .prepare(
            `insert into ads (meta_ad_id, account_id, campaign_id, campaign_name, adset_id, adset_name, name, effective_status, configured_status,
               created_time, first_spend_date, last_spend_date, creative, matched_asset_id, match_source, match_detail, first_seen_at, last_synced_at)
             values (@id, @account, @campaign, @campaignName, @adset, @adsetName, @name, @status, @status, @created, @first, @last, @creative,
               @asset, @source, @detail, @now, @now)
             on conflict (meta_ad_id) do update set account_id = excluded.account_id, campaign_id = excluded.campaign_id,
               campaign_name = excluded.campaign_name, adset_id = excluded.adset_id, adset_name = excluded.adset_name, name = excluded.name,
               effective_status = excluded.effective_status, configured_status = excluded.configured_status, created_time = excluded.created_time,
               first_spend_date = excluded.first_spend_date, last_spend_date = excluded.last_spend_date, creative = excluded.creative,
               last_synced_at = excluded.last_synced_at`,
          )
          .run({
            id: ad.id,
            account: accountId,
            campaign: acc.campaignId,
            campaignName: acc.campaign,
            adset: `${acc.campaignId}9`,
            adsetName: acc.adset,
            name: ad.name,
            status: ad.status,
            created: Date.parse(`${addDays(today, -ad.startDaysAgo)}T14:00:00Z`),
            first: spent[0] ?? null,
            last: spent[spent.length - 1] ?? null,
            creative: JSON.stringify(creative),
            asset,
            source: asset ? "manual" : null,
            detail: asset ? "demo data: linked by the demo script" : null,
            now,
          });
        const hookId = hookIds.get(`${acc.code}:${ad.hook}`);
        if (hookId) sql.prepare("insert or ignore into hook_ads (hook_id, meta_ad_id, role, created_at) values (?, ?, 'headline', ?)").run(hookId, ad.id, now);
        if (asset && ad.video) {
          const vh = sql.prepare("select id from hooks where asset_id = ? and kind = 'video' and parent_id is null").pluck().get(asset) as number | undefined;
          if (vh) sql.prepare("insert or ignore into hook_ads (hook_id, meta_ad_id, role, created_at) values (?, ?, 'video', ?)").run(vh, ad.id, now);
        }
      }
      // The channel's widget numbers: Meta's date presets over the account's campaign (here: the sums of its ads).
      const all = [...days.values()].flat();
      const insCm = sql.prepare(
        `insert into channel_metrics (account_id, window, date_start, date_stop, spend, impressions, reach, clicks, ctr, cpm, link_clicks,
           cost_per_link_click, meta_leads, synced_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const w of RUN_WINDOWS) {
        const range = metaRange(w, today);
        const rows = all.filter((d) => inRange(d.date, range));
        const sum = (k: keyof Day) => rows.reduce((s, d) => s + (d[k] as number), 0);
        const spend = r2(sum("spend"));
        const impressions = sum("impressions");
        const clicks = sum("clicks");
        const link = sum("linkClicks");
        insCm.run(
          accountId,
          w,
          rows.length ? (range.from ?? first) : null,
          rows.length ? range.to : null,
          spend,
          impressions,
          Math.round(sum("reach") * 0.8),
          clicks,
          impressions ? r4((clicks / impressions) * 100) : null,
          impressions ? r4((spend / impressions) * 1000) : null,
          link,
          link ? r4(spend / link) : null,
          sum("leads"),
          now,
        );
      }
    }
    sql.prepare("insert into app_settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(DEMO_RUNNING_DAY_KEY, today);
  })();
}

// ------------------------------------------------------------------------------------------------ the whole seed

const setSetting = (sql: Sql, key: string, value: string) =>
  sql.prepare("insert into app_settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);

/** Hook ids by `<channel>:<text>` (channel = rtm | shared | a client code), for the ad links. */
function hookIdMap(sql: Sql): Map<string, number> {
  const rows = sql
    .prepare(
      `select h.id, h.text, s.key as section, c.code from hooks h join sections s on s.id = h.section_id left join clients c on c.id = h.client_id
        where h.kind = 'text' and h.parent_id is null`,
    )
    .all() as { id: number; text: string; section: string; code: string | null }[];
  return new Map(rows.map((r) => [`${r.code ?? (r.section === "rtm" ? "rtm" : "shared")}:${r.text}`, r.id]));
}

export type DemoSeedResult = { seeded: boolean; hooksScored: number; runningDay: string };

/**
 * Seed the demo DB (after the demo media is indexed). The one-time part runs when `demo:seeded_at` is missing; the
 * Running numbers are rebuilt for today on every call. Throws when a demo file is not in the index.
 */
export function seedDemoData(sql: Sql, cfg: Pick<StudioConfig, "drivePath" | "fakeUnmounted" | "driveMode" | "visionModel">, now = Date.now()): DemoSeedResult {
  const missing = (Object.keys(DEMO_PATHS) as DemoKey[])
    .filter((k) => k !== "episodeSrt")
    .filter((k) => !sql.prepare("select 1 from assets where path = ? and missing = 0").get(path.join(cfg.drivePath, DEMO_PATHS[k])));
  if (missing.length) throw new Error(`demo data: ${missing.length} demo file(s) are not indexed yet (${missing.slice(0, 3).join(", ")})`);
  let seeded = false;
  let scored = 0;
  if (!sql.prepare("select 1 from app_settings where key = ?").get(DEMO_SEEDED_KEY)) {
    seeded = true;
    sql.transaction(() => {
      // Every paid / network queue stays off in the demo (there is no key or token either).
      for (const key of ["describe:paused", "classify:paused", "hooks:paused", "meta:paused", "youtube:paused"]) setSetting(sql, key, "1");

      // Descriptions (fixed text in the describe model's format) + a manual category per file.
      const insDesc = sql.prepare(
        `insert or ignore into descriptions (sha256, model, prompt_version, text, spoken_open, ms, spoken_ms, first_image, created_at)
         values (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      );
      const setAsset = sql.prepare(
        `update assets set description = ?, description_model = ?, description_version = ?, spoken_open = ?, described_at = ?, describe_error = null,
           asset_class = ?, class_source = 'manual', class_confidence = null where id = ?`,
      );
      for (const key of Object.keys(DESCRIPTIONS) as DemoKey[]) {
        if (key === "episodeSrt") continue;
        const d = DESCRIPTIONS[key];
        const a = sql.prepare("select id, sha256, kind from assets where path = ?").get(path.join(cfg.drivePath, DEMO_PATHS[key])) as { id: number; sha256: string; kind: string };
        const text = d.text.join("\n");
        const spoken = a.kind === "video" ? (d.spoken ?? "") : null;
        insDesc.run(a.sha256, cfg.visionModel, DESCRIBE_PROMPT_VERSION, text, spoken, a.kind === "video" ? "opening" : null, now);
        setAsset.run(text, cfg.visionModel, DESCRIBE_PROMPT_VERSION, spoken, now, d.cls, a.id);
      }

      // Text hooks per channel (the app's own insert: dedupe + norm).
      const add = (ch: HookChannel, texts: string[]) => addTextHooks(sql, ch, texts.map((text) => ({ text, source: "manual" })), now);
      add({ section: "rtm", clientCode: null }, LANE_A_HOOKS);
      for (const [code, texts] of Object.entries(CLIENT_HOOKS)) add({ section: "fkbpros", clientCode: code }, texts);
      add({ section: "fkbpros", clientCode: null }, SHARED_HOOKS);

      // What works here + one pinned hook (before scoring: both ride along in the client's notes fingerprint).
      for (const [code, body] of WORKS) addWork(sql, code, body, now);
      const pinned = hookIdMap(sql).get(`crumb:${CLIENT_HOOKS.crumb[0]}`);
      if (pinned) pinHook(sql, pinned, now);

      // Video hooks (the drawer's "Add as hook"): the Lane A short + talking head, the two client ad videos.
      for (const key of ["short", "talkingHead", "crumbBaker", "ironBroll"] as DemoKey[]) {
        const id = sql.prepare("select id from assets where path = ?").pluck().get(path.join(cfg.drivePath, DEMO_PATHS[key])) as number;
        const r = addVideoHook(sql, id, now);
        if (!r.ok) throw new Error(`demo data: video hook for ${DEMO_PATHS[key]}: ${r.error}`);
      }

      // Shorts board: the episode (the worker's own sync over the guarded SRT read), a finished moments job, six cards.
      syncEpisodes(sql, { drivePath: cfg.drivePath, fakeUnmounted: cfg.fakeUnmounted, driveMode: cfg.driveMode }, now);
      const ep = sql.prepare("select id from episodes where gone_at is null order by num limit 1").pluck().get() as number | undefined;
      if (!ep) throw new Error("demo data: the demo episode was not found (Episode 1.srt next to the episode master)");
      const job = Number(
        sql
          .prepare("insert into jobs (type, asset_id, input, result, status, attempts, created_at, started_at, finished_at) values ('short_moments', null, ?, ?, 'done', 1, ?, ?, ?)")
          .run(JSON.stringify({ episodeId: ep }), JSON.stringify({ attempts: [], survivors: [], note: "Demo data: these cards were written by the demo script, not by claude." }), now, now, now)
          .lastInsertRowid,
      );
      const moments: CheckedMoment[] = CARDS.map((c) => ({
        start: cueStart(c.from),
        end: cueEnd(c.to),
        startCue: c.from,
        endCue: c.to,
        firstLine: EPISODE_CUES[c.from],
        hookWords: c.words,
        why: c.why,
        layout: c.layout,
        cold: { start: cueStart(c.cold), end: cueEnd(c.cold), startUnit: c.cold, endUnit: c.cold, text: EPISODE_CUES[c.cold] },
        coldDropped: null,
      }));
      const cards = insertCards(sql, ep, job, moments, now);
      sql.prepare("update jobs set result = ? where id = ?").run(
        JSON.stringify({ attempts: [], survivors: cards, note: "Demo data: these cards were written by the demo script, not by claude." }),
        job,
      );
      keepShort(sql, cards[2], now);
      setShortStatus(sql, cards[3], "cutting", now);
      setShortStatus(sql, cards[5], "cutting", now);
      const reel = sql.prepare("select id from assets where path = ?").pluck().get(path.join(cfg.drivePath, DEMO_PATHS.reel)) as number;
      linkOutput(sql, cards[4], reel, { drivePath: cfg.drivePath, fakeUnmounted: cfg.fakeUnmounted, driveMode: cfg.driveMode }, now); // Link a file: Idea -> Review

      scored = scoreDemoHooks(sql, now);
      setSetting(sql, DEMO_SEEDED_KEY, String(now));
    })();
  }
  refreshDemoRunning(sql, cfg.drivePath, now, hookIdMap(sql));
  return { seeded, hooksScored: scored, runningDay: localDate(now, TZ) };
}

/** Row counts of the tables the demo seed writes (the smoke compares two runs). The table names interpolated into the SQL are
 * the constant list below, never input. */
export function demoCounts(sql: Sql): Record<string, number> {
  const tables = ["assets", "descriptions", "hooks", "hook_scores", "client_works", "episodes", "shorts", "jobs", "ads", "ad_metrics", "ad_windows", "channel_metrics", "meta_campaigns", "hook_ads", "ai_calls", "meta_calls", "yt_calls"];
  return Object.fromEntries(tables.map((t) => [t, sql.prepare(`select count(*) from ${t}`).pluck().get() as number]));
}
