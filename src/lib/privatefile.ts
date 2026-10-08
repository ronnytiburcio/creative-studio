/**
 * Shared helpers for Studio's few writers OUTSIDE its cache / DB / logs (server only; no imports from the rest of the
 * app, so config.ts can use them): the Cut reel hand-off writer (src/lib/shorts/handoff.ts) and the PAUSED-ad order
 * writer (src/lib/meta/orders.ts).
 *
 *   - path helpers: `isUnderPath` (lexical, separator aware), `realishPath` (the real path of a path that may not exist
 *     yet), `onDrive` (lexically or by real path under the media drive, also through a symlinked drive path);
 *   - `writeNewPrivateFile`: O_CREAT | O_EXCL | O_NOFOLLOW, 0600 (fchmod against the umask), write, fsync. An existing
 *     name throws EEXIST (never overwritten); callers map errors to their own terse messages;
 *   - the order lock (`withOrderLock`): `.<order file name>.lock` in the order's own folder, created with the same
 *     O_EXCL | O_NOFOLLOW 0600 call, removed after. Studio's Cancel and the apply scripts (studio_common.py, same name,
 *     same rules) take it around every read-check-write of an order file, so a cancel and an apply claim can never
 *     interleave. A lock older than LOCK_STALE_MS (2 minutes: no holder keeps it longer than one read + write) is stale
 *     and may be broken (the caller gets a note).
 */
import fs from "node:fs";
import path from "node:path";

/** p equals base or sits under it (lexical, separator aware). */
export function isUnderPath(p: string, base: string): boolean {
  return p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/** The nearest existing ancestor's real path + the rest (a path that may not exist yet). */
export function realishPath(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when p (lexically, or by the real path of it / its nearest existing ancestor) lies on the media drive. */
export function onDrive(p: string, drivePath: string): boolean {
  const abs = path.resolve(p);
  const drive = path.resolve(drivePath);
  let realDrive = drive;
  try {
    realDrive = fs.realpathSync(drive);
  } catch {
    /* unplugged: the lexical path is all there is */
  }
  const real = realishPath(abs);
  return isUnderPath(abs, drive) || isUnderPath(real, drive) || isUnderPath(real, realDrive);
}

/**
 * Create a NEW private file (0600) and write `text` to it: O_CREAT | O_EXCL | O_NOFOLLOW, fchmod, write, fsync, close.
 * Throws the raw fs error (EEXIST when the name is taken: never overwritten).
 */
export function writeNewPrivateFile(target: string, text: string | Buffer): void {
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, typeof text === "string" ? Buffer.from(text) : text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ------------------------------------------------------------------------------------------------ the order lock

export const LOCK_STALE_MS = 2 * 60_000;

export class OrderLockedError extends Error {}

/** The lock file next to an order (`.<name>.lock`, same folder). */
export function orderLockPath(orderFile: string): string {
  return path.join(path.dirname(orderFile), `.${path.basename(orderFile)}.lock`);
}

export type LockResult<T> = { value: T; brokeStale: boolean };

/**
 * Run `fn` holding the order's lock. A fresh lock held by someone else throws OrderLockedError (nothing ran). A lock
 * older than 2 minutes is broken (re-checked right before the unlink: same inode and mtime) and `brokeStale` is true.
 * The lock is always removed after `fn` (only when it is still ours).
 */
export function withOrderLock<T>(orderFile: string, holder: string, fn: () => T, now: () => number = Date.now): LockResult<T> {
  const lock = orderLockPath(orderFile);
  const body = `${JSON.stringify({ holder, pid: process.pid, at: new Date(now()).toISOString() })}\n`;
  let brokeStale = false;
  for (let attempt = 0; ; attempt++) {
    try {
      writeNewPrivateFile(lock, body);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new OrderLockedError("The order is being applied, try again.");
        throw e;
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(lock);
      } catch {
        continue; // released meanwhile: try once more
      }
      if (now() - st.mtimeMs < LOCK_STALE_MS) throw new OrderLockedError("The order is being applied, try again.");
      // Stale: break it, but only the very file judged stale.
      try {
        const again = fs.lstatSync(lock);
        if (again.ino !== st.ino || again.mtimeMs !== st.mtimeMs) throw new OrderLockedError("The order is being applied, try again.");
        fs.unlinkSync(lock);
        brokeStale = true;
      } catch (err) {
        if (err instanceof OrderLockedError) throw err;
        /* gone meanwhile: the next attempt decides */
      }
    }
  }
  const mine = fs.lstatSync(lock).ino;
  try {
    return { value: fn(), brokeStale };
  } finally {
    try {
      if (fs.lstatSync(lock).ino === mine) fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}
