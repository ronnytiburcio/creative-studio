import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { boardData } from "@/lib/shorts/board";
import { listEpisodes, notPreppedFolders } from "@/lib/shorts/episodes";
import { momentJobs } from "@/lib/shorts/moments";
import { readKitVersion } from "@/lib/shorts/kit";
import { BoardView } from "./board-view";

type SP = Record<string, string | string[] | undefined>;

/**
 * Lane A Shorts tab, the Shorts board (server, Phase 6 slice 1): the five columns with their cards, the episodes "New short"
 * can start from (and the folders not prepped yet), and the moments jobs to show on the board (active ones, plus the
 * latest failure per episode when it is newer than its last success). `?newshort=<episode id>` opens the picker on that
 * episode (cmd+K "New short from Ep N"), `?cutreel=<episode id>` opens Cut reel on one (cmd+K "Cut reel · Ep N"). Reads
 * the DB only: the worker keeps `episodes` in step with the drive and makes the automatic moves.
 */
export function BoardSection({ searchParams }: { searchParams: SP }) {
  const sql = getDb().sqlite;
  const cfg = getConfig();
  const raw = typeof searchParams.newshort === "string" ? searchParams.newshort : undefined;
  const newShort = raw && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  const rawCut = typeof searchParams.cutreel === "string" ? searchParams.cutreel : undefined;
  const cutReel = rawCut && /^\d{1,9}$/.test(rawCut) ? Number(rawCut) : null;
  const episodes = listEpisodes(sql);
  const jobs = momentJobs(sql, 40);
  const seen = new Set<number>();
  const shown = jobs.filter((j) => {
    if (j.status === "pending" || j.status === "running") return true;
    if (seen.has(j.episodeId)) return false;
    seen.add(j.episodeId);
    return j.status === "error";
  });
  return (
    <BoardView
      board={boardData(sql)}
      episodes={episodes}
      notPrepped={notPreppedFolders(sql, cfg)}
      jobs={shown}
      openEpisode={newShort != null && episodes.some((e) => e.id === newShort) ? newShort : null}
      openCutReel={cutReel != null && episodes.some((e) => e.id === cutReel && e.keptIdeas > 0) ? cutReel : null}
      kitVersion={readKitVersion(cfg.reelKitDir, cfg.drivePath)}
    />
  );
}
