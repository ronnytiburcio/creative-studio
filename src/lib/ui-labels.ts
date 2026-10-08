/**
 * The UI labels (Creative Studio slice 1c; server only): the lane display names from the DB (Settings > Lanes) plus the
 * business profile's display texts (owner, lane full names, the sidebar sub label, category / format descriptions, skill
 * names, episode naming) and the brand mark URLs (src/lib/brand.ts).
 * Server components and messages call `uiLabels()`; the app layout hands the same object to client components
 * (`LabelsProvider` / `useLabels`). Helpers that turn it into strings live in src/lib/profile.ts (client safe).
 */
import type Database from "better-sqlite3";
import { getDb } from "./db";
import { laneNames } from "./clients-admin";
import { brandUrls } from "./brand";
import { getConfig } from "./config";
import { profile, profileUi, type UiLabels } from "./profile";

export function uiLabels(sql: Database.Database = getDb().sqlite): UiLabels {
  return profileUi(laneNames(sql), profile(), brandUrls(getConfig()));
}
