/**
 * The write guard (server only): the ONLY code allowed to create, write, move or trash anything
 * on the media drive, and only inside "<drive>/Studio Generated/". Everything else on the drive
 * stays read only (see fsguard.ts / originals.ts).
 *
 * Every call checks, in order:
 *  - the drive is mounted (never create "/Volumes/<name>/..." on the boot disk when it is unplugged),
 *  - the path is absolute, has no NUL and no ".." segment,
 *  - lexically inside the Studio Generated base,
 *  - the realpath of the parent directory is inside the realpath of the base (no symlink escape),
 *  - the target itself is not a symlink.
 * Directories are created one segment at a time, each checked to be a real directory inside the base.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { driveMounted, type DriveCfg } from "./fsguard";
import { GENERATED_DIRNAME } from "./gen/layout";

export class WriteGuardError extends Error {
  constructor(message: string) {
    super(`write guard: ${message}`);
    this.name = "WriteGuardError";
  }
}

export type WriteGuardOptions = {
  drivePath: string;
  /** Mount check. Production passes driveMounted(cfg); the smoke test passes () => true for a temp stand-in. */
  mounted: () => boolean;
  /** How a checked path reaches the Trash. Default /usr/bin/trash; the smoke test passes a stand-in (keeps the real Trash clean). */
  trashCmd?: (abs: string) => Promise<void>;
};

function macTrash(abs: string): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    execFile("/usr/bin/trash", [abs], { timeout: 30_000 }, (err) => (err ? reject(new WriteGuardError("trash failed")) : resolve())),
  );
}

function inside(child: string, base: string): boolean {
  return child === base || child.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

export class WriteGuard {
  readonly drivePath: string;
  /** "<drive>/Studio Generated" (lexical). */
  readonly base: string;
  private readonly mountCheck: () => boolean;
  private readonly trashCmd: (abs: string) => Promise<void>;

  constructor(opts: WriteGuardOptions) {
    this.drivePath = path.resolve(opts.drivePath);
    this.base = path.join(this.drivePath, GENERATED_DIRNAME);
    this.mountCheck = opts.mounted;
    this.trashCmd = opts.trashCmd ?? macTrash;
  }

  isDriveMounted(): boolean {
    return this.mountCheck();
  }

  /** Lexical + mount checks shared by every operation. Returns the resolved absolute path. */
  private checkPath(p: string): string {
    if (typeof p !== "string" || !p || p.includes("\0")) throw new WriteGuardError("invalid path");
    if (!path.isAbsolute(p)) throw new WriteGuardError("path must be absolute");
    if (p.split(/[\\/]+/).includes("..")) throw new WriteGuardError("'..' is not allowed");
    const abs = path.resolve(p);
    if (!this.mountCheck()) throw new WriteGuardError("drive is not mounted");
    if (!inside(abs, this.base) || abs === this.base) throw new WriteGuardError(`refused: ${abs} is outside ${this.base}`);
    return abs;
  }

  /** realpath(base) must sit inside realpath(drive); base must be a real directory. */
  private realBase(): string {
    let realDrive: string;
    let realBase: string;
    try {
      realDrive = fs.realpathSync(this.drivePath);
      realBase = fs.realpathSync(this.base);
    } catch {
      throw new WriteGuardError("Studio Generated folder is missing");
    }
    if (!inside(realBase, realDrive) || fs.lstatSync(this.base).isSymbolicLink()) {
      throw new WriteGuardError("Studio Generated is not a real folder on the drive");
    }
    return realBase;
  }

  /** The parent of `abs` must exist and resolve (after symlinks) inside the real base. */
  private checkParent(abs: string) {
    const realBase = this.realBase();
    let realParent: string;
    try {
      realParent = fs.realpathSync(path.dirname(abs));
    } catch {
      throw new WriteGuardError("parent folder does not exist");
    }
    if (!inside(realParent, realBase)) throw new WriteGuardError("refused: parent resolves outside Studio Generated");
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) throw new WriteGuardError("refused: target is a symlink");
    } catch (e) {
      if (e instanceof WriteGuardError) throw e;
      /* ENOENT is fine */
    }
  }

  /**
   * mkdir -p for a folder inside Studio Generated (the base itself is created on first use).
   * Only descends below the mounted drive root, one checked segment at a time. Returns the absolute path.
   */
  ensureDir(dir: string): string {
    const abs = dir === this.base ? this.base : this.checkPath(dir);
    if (!this.mountCheck()) throw new WriteGuardError("drive is not mounted");
    const realDrive = fs.realpathSync(this.drivePath);
    const segments = path.relative(this.drivePath, abs).split(path.sep).filter(Boolean);
    let current = this.drivePath;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        fs.mkdirSync(current);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new WriteGuardError(`refused: ${current} is not a real folder`);
      if (!inside(fs.realpathSync(current), realDrive)) throw new WriteGuardError("refused: folder resolves off the drive");
    }
    return abs;
  }

  /** Write a new file (never overwrites: fails if it exists). */
  writeNewFile(file: string, data: string | Buffer) {
    const abs = this.checkPath(file);
    this.checkParent(abs);
    fs.writeFileSync(abs, data, { flag: "wx" });
  }

  /**
   * Move a local file (e.g. a download in STUDIO_CACHE) to `dest` inside Studio Generated.
   * Copies to "<dest>.part" next to the target (not a media extension, so the scanner never indexes it),
   * then renames into place on the same volume and removes the source. Never overwrites an existing target.
   */
  moveIn(src: string, dest: string) {
    const abs = this.checkPath(dest);
    this.checkParent(abs);
    if (fs.existsSync(abs)) throw new WriteGuardError("refused: target already exists");
    const part = `${abs}.part`;
    fs.copyFileSync(src, part, fs.constants.COPYFILE_EXCL);
    try {
      if (fs.existsSync(abs)) throw new WriteGuardError("refused: target already exists");
      fs.renameSync(part, abs);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
    fs.rmSync(src, { force: true });
  }

  /** Move a FILE inside Studio Generated to the macOS Trash (recoverable). Used by Discard. Folders are refused. */
  async trash(file: string): Promise<void> {
    const abs = this.checkPath(file);
    this.checkParent(abs);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      throw new WriteGuardError("nothing to trash");
    }
    if (!st.isFile()) throw new WriteGuardError("refused: only files can be trashed");
    await this.trashCmd(abs);
  }

  /** Remove leftover "*.part" files from an interrupted move (worker start). Stays inside the base. */
  sweepPartFiles(): number {
    if (!this.mountCheck() || !fs.existsSync(this.base)) return 0;
    let removed = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".part")) {
          this.checkPath(full);
          fs.rmSync(full, { force: true });
          removed++;
        }
      }
    };
    walk(this.base, 0);
    return removed;
  }
}

/** The guard for the configured drive. */
export function writeGuardFor(cfg: DriveCfg): WriteGuard {
  return new WriteGuard({ drivePath: cfg.drivePath, mounted: () => driveMounted(cfg) });
}
