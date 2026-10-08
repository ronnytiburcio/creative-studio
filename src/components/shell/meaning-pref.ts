"use client";

/**
 * The Meaning switch's remembered default (per viewer, this browser only). The URL (`mode=meaning`) is what a search
 * actually uses; this only decides how the switch starts when no search is showing. Storage can be blocked or empty
 * (private window): every access is wrapped and the default is off.
 */
import { useSyncExternalStore } from "react";

const KEY = "rtm:search-meaning";
const EVENT = "rtm:search-meaning-change";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setMeaningPref(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: the switch still works for this search */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useMeaningPref(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
