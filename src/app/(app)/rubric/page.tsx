import { getDb } from "@/lib/db";
import { currentRubric, rescorePreview, rubricHistory } from "@/lib/hooks/store";
import { NoteEditor, RescoreBanner, RubricEditor } from "@/components/rubric/rubric-editor";
import { allClientNotes, briefOf, FKB_NOTE_KEY, getNote, getNoteRow, noteLabel, noteLines, type NoteKey } from "@/lib/hooks/notes";
import { laneNames } from "@/lib/clients-admin";
import { avatarSections, avatarsFor, dimensionsFor, PP_CLEAR, sectionVersionsLabel, type Dimension, type SectionKey } from "@/lib/hooks/rubric";
import { clientShortName } from "@/lib/media";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { allCoverage } from "@/lib/hooks/coverage";
import { CoverageTables } from "@/components/hooks/coverage-strip";
import { DraftBadge, EyebrowCard as Card } from "@/components/hooks/ui";
import { calibrationReport, parseCalParams } from "@/lib/calibration/report";
import { getConfig } from "@/lib/config";
import { youtubeKeyStatus } from "@/lib/youtube/auth";
import { testOrderTable } from "@/lib/meta/test-order";
import { CalibrationSection, TestOrderCard } from "@/components/rubric/calibration";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rubric" };

function date(ms: number | null) {
  return ms ? new Date(ms).toLocaleDateString("en-US", { dateStyle: "medium" }) : "";
}

function appliesText(d: Dimension, laneName: Record<SectionKey, string>) {
  const names = d.appliesTo.sections.map((s) => laneName[s]);
  const sections = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : `${names[0]} only`;
  const kinds = d.appliesTo.kinds.length === 2 ? "text and video" : `${d.appliesTo.kinds[0]} only`;
  return `${sections} · ${kinds}`;
}

function Lines({ body }: { body: string | null | undefined }) {
  const lines = noteLines(body);
  if (!lines.length) return <p className="text-[13px] text-muted-foreground">Empty.</p>;
  return (
    <ul className="space-y-1 text-[13px] leading-relaxed">
      {lines.map((l, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-[9px] size-1 shrink-0 rounded-full bg-foreground/35" aria-hidden />
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Global Rubric page (Phase 4 F1 to F3): the current version read only, "Edit rubric" (saves a new version; slice 3),
 * the "N hooks will be rescored" line + Rescore, editable Lane A notes and who's who, client notes (links to the Client
 * tabs), coverage and version history. Phase 5 slice 3: Calibration (scores vs Meta results; URL keys cal_v, cal_view,
 * cal_m) and the test order table. Slice 4: Lane A calibrates on YouTube Shorts (cal_view=rtm); every cell counts ad groups.
 */
export default async function RubricPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sql = getDb().sqlite;
  const calibration = calibrationReport(sql, parseCalParams(await searchParams), youtubeKeyStatus(getConfig()).connected);
  const testOrder = testOrderTable(sql);
  const rubric = currentRubric(sql);
  const history = rubricHistory(sql);
  const notes = (["rtm", "whos_who"] as NoteKey[]).map((k) => ({ key: k, note: getNote(sql, k) }));
  const clients = allClientNotes(sql);
  const coverage = allCoverage(sql);
  const rescore = rescorePreview(sql);
  const fkbNotes = getNoteRow(sql, FKB_NOTE_KEY);
  // Lane B and Lane A list their own avatars; Lane C lists every avatar offered on its hooks (v2: the Lane B ones, same slugs).
  const bySection = (s: SectionKey) => (s === "fkb" ? avatarsFor(rubric, "fkb", false) : rubric.avatars.filter((a) => a.section === s));
  const hasFkb = rubric.dimensions.some((d) => d.appliesTo.sections.includes("fkb"));
  const SECTION_NAME = laneNames(sql);
  const nDims = (s: SectionKey, k: "text" | "video") => dimensionsFor(rubric, s, k).length;

  return (
    <div className="mx-auto max-w-[1080px] px-6 pt-6 pb-16">
      <div className="text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">Hooks</div>
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Rubric</h1>
      <p className="mt-1 max-w-[760px] text-[13px] leading-relaxed text-muted-foreground">
        What Jev scores every hook against: {rubric.dimensions.length} dimensions (5 described levels each, shown 1 to 5), the Three P&apos;s, the
        copy mechanic, the avatar and whether it would stop a scroll. The overall score is the mean of the dimensions that apply (computed in
        code). Current version <span className="font-medium text-foreground">v{rubric.version}</span>, saved {date(rubric.createdAt)}. Editing
        saves a new version; old scores stay, and nothing is rescored until you click Rescore.
      </p>
      <p className="mt-2 max-w-[760px] text-[12.5px] leading-relaxed text-muted-foreground">
        Per section: <span className="font-medium text-foreground tabular">{sectionVersionsLabel(rubric.sectionVersions, SECTION_NAME)}</span>. A section keeps its
        number until its own content changes (dimensions, avatars, mechanics or brief); the copy gate scores and caches by it, so an{" "}
        {SECTION_NAME.rtm} only change never moves {SECTION_NAME.fkbpros} or {SECTION_NAME.fkb}.
      </p>
      <p className="mt-2 text-[12.5px] text-muted-foreground">
        How the scores line up with real Meta results:{" "}
        <a href="#calibration" className="font-medium text-foreground underline-offset-2 hover:underline">
          Calibration
        </a>{" "}
        ·{" "}
        <a href="#test-order" className="font-medium text-foreground underline-offset-2 hover:underline">
          Test order
        </a>
      </p>

      {!rescore.approved && (
        <RescoreBanner
          version={rescore.version}
          count={rescore.count}
          waiting={rescore.waiting}
          usd={rescore.usd}
          paused={rescore.paused}
          sections={sectionVersionsLabel(rubric.sectionVersions, SECTION_NAME)}
        />
      )}

      <RubricEditor
        version={rubric.version}
        initial={{ dimensions: rubric.dimensions, mechanics: rubric.mechanics, avatars: rubric.avatars }}
      >
      <div className="mt-5 space-y-5">
        <Card
          title="Dimensions"
          eyebrow={`v${rubric.version}`}
          aside={`${SECTION_NAME.fkbpros}${hasFkb ? ` and ${SECTION_NAME.fkb}` : ""} text ${nDims("fkbpros", "text")} · video ${nDims("fkbpros", "video")} · ${SECTION_NAME.rtm} text ${nDims("rtm", "text")} · video ${nDims("rtm", "video")}`}
        >
          <div className="space-y-5">
            {rubric.dimensions.map((d) => (
              <div key={d.id}>
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h3 className="text-[14px] font-semibold">{d.label}</h3>
                  <span className="text-[12px] text-muted-foreground">{appliesText(d, SECTION_NAME)}</span>
                </div>
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">{d.question.replace(/`/g, "")}</p>
                <ol className="mt-2 grid gap-1">
                  {d.levels.map((l, i) => (
                    <li key={i} className="grid grid-cols-[28px_1fr] items-start gap-2 text-[13px] leading-snug">
                      <span className="grid h-5 w-6 place-items-center rounded-md bg-muted text-[11.5px] font-medium tabular">{i + 1}</span>
                      <span>{l.replace(/`/g, "")}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </Card>

        <Card title="The Three P's" aside={`Clear = at least ${Math.round(PP_CLEAR * 100)}% yes`}>
          <p className="text-[13px] leading-relaxed">
            Every hook is checked for a clear <b>Person</b> (who it is for, named so they recognize themselves), <b>Pain</b> (the specific problem)
            and <b>Promise</b> (the one outcome). By default the Hooks tab sorts hooks with all three clear first, by score; the rest follow with
            an orange <span className="font-medium text-brand-text">Missing: …</span> note. The score itself is never lowered. &quot;Sort by score
            only&quot; and a &quot;Three P&apos;s clear&quot; filter are on every Hooks tab.
          </p>
        </Card>

        <Card title="Copy mechanics" aside="Jev picks the one a hook leans on most">
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {rubric.mechanics.map((m, i) => (
              <div key={m.id} className="text-[13px] leading-snug">
                <span className="font-medium">
                  {m.id === "none" ? "" : `${i + 1}. `}
                  {m.label}
                </span>
                <span className="text-muted-foreground">: {m.definition}</span>
              </div>
            ))}
          </div>
        </Card>

        {((hasFkb ? ["fkbpros", "fkb", "rtm"] : ["fkbpros", "rtm"]) as SectionKey[]).map((s) => (
          <Card
            key={s}
            title={`Avatars · ${SECTION_NAME[s]}`}
            aside={
              s === "fkbpros"
                ? "One shared list; universal-only ones are offered on shared hooks only"
                : s === "fkb"
                  ? `The ${SECTION_NAME.fkbpros} avatars that are not universal only, same ids (calibration pools them)`
                  : "Starter avatars"
            }
          >
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-left text-[12.5px]">
                <thead className="bg-muted/60 text-[11.5px] text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Avatar</th>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Pain</th>
                    <th className="px-3 py-2 font-medium">Promise</th>
                  </tr>
                </thead>
                <tbody>
                  {bySection(s).map((a) => (
                    <tr key={a.slug} className="border-t border-border align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium">{a.label}</div>
                        <div className="font-mono text-[10.5px] text-muted-foreground">{a.slug}</div>
                        <div className="mt-0.5 flex gap-1">
                          {a.stage && <span className="rounded bg-muted px-1 text-[10.5px] text-muted-foreground">{a.stage === "ps" ? "problem/solution" : "objection"}</span>}
                          {a.universalOnly && <span className="rounded bg-brand/15 px-1 text-[10.5px] font-medium text-brand-text">universal only</span>}
                          {s === "fkbpros" && avatarSections(a).includes("fkb") && (
                            <span className="rounded bg-muted px-1 text-[10.5px] text-muted-foreground">also {SECTION_NAME.fkb}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">{a.person}</td>
                      <td className="px-3 py-2">{a.pain}</td>
                      <td className="px-3 py-2">{a.promise}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>
      </RubricEditor>

      <div className="mt-5 space-y-5">
        {notes.map(({ key, note }) => (
          <Card
            key={key}
            title={noteLabel(key, SECTION_NAME.rtm)}
            eyebrow="Notes"
            aside={
              <span className="flex items-center gap-2">
                {key === "whos_who" ? "Rides along on hook scoring and search by meaning" : `Rides along on ${SECTION_NAME.rtm} hook scoring`}
                <DraftBadge savedAt={note?.savedAt ?? null} />
              </span>
            }
          >
            <NoteEditor noteKey={key} body={note?.body ?? ""}>
              <Lines body={note?.body} />
            </NoteEditor>
          </Card>
        ))}

        <Card title="Channel briefs" eyebrow={`v${rubric.version}`} aside="What Jev reads as channel.brief (part of the rubric version since v3)">
          <div className="space-y-2 text-[13px] leading-relaxed">
            {(["fkbpros", "fkb", "rtm"] as SectionKey[]).map((s) => (
              <p key={s}>
                <span className="font-medium">{SECTION_NAME[s]}: </span>
                {briefOf(rubric, s)}
              </p>
            ))}
          </div>
        </Card>

        <Card title="Brand notes" eyebrow="Notes" aside="Read only here; edit them on each Client tab">
          <div className="space-y-5">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[13.5px] font-semibold">{SECTION_NAME.fkb}</h3>
                <span className="font-mono text-[11px] text-muted-foreground">fkb</span>
                <DraftBadge savedAt={fkbNotes?.savedAt ?? null} />
                <Link href="/fkb/client" className="ml-auto text-[12px] text-muted-foreground hover:text-foreground hover:underline">
                  Edit on the Client tab
                </Link>
              </div>
              <div className="mt-1.5">
                <Lines body={fkbNotes?.body} />
              </div>
            </div>
            {clients.map((c) => (
              <div key={c.code}>
                <div className="flex items-center gap-2">
                  <h3 className="text-[13.5px] font-semibold">{clientShortName(c.name)}</h3>
                  <span className="font-mono text-[11px] text-muted-foreground">{c.code}</span>
                  <DraftBadge savedAt={c.savedAt} />
                  <Link href={`/fkbpros/${c.code}/client`} className="ml-auto text-[12px] text-muted-foreground hover:text-foreground hover:underline">
                    Edit on the Client tab
                  </Link>
                </div>
                <div className="mt-1.5">
                  <Lines body={c.brandNotes} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Coverage"
          eyebrow="Every channel"
          aside="Zero = a gap (orange) · hooks from the current version's style answers · statics from classify"
        >
          <CoverageTables channels={coverage} lanes={SECTION_NAME} />
        </Card>

        <CalibrationSection report={calibration} />

        <div id="test-order" className="scroll-mt-20">
          <TestOrderCard rows={testOrder} />
        </div>

        <Card title="Version history">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11.5px] text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Version</th>
                <th className="py-1.5 pr-3 font-medium">Saved</th>
                <th className="py-1.5 pr-3 font-medium">Hooks scored</th>
                <th className="py-1.5 pr-3 font-medium">Rescore</th>
                <th className="py-1.5 pr-3 font-medium">Sections</th>
                <th className="py-1.5 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {history.map((v) => (
                <tr key={v.version} className="border-t border-border align-top">
                  <td className={cn("py-1.5 pr-3 tabular", v.current && "font-medium")}>
                    v{v.version}
                    {v.current && <span className="ml-1.5 rounded bg-ink px-1 text-[10.5px] text-sand dark:bg-sand dark:text-ink">current</span>}
                  </td>
                  <td className="py-1.5 pr-3">{date(v.createdAt)}</td>
                  <td className="py-1.5 pr-3 tabular">{v.scored.toLocaleString()}</td>
                  <td className="py-1.5 pr-3">
                    {v.version === 1 ? "first version" : v.rescoreAt ? `clicked ${date(v.rescoreAt)}` : <span className="font-medium text-brand-text">waiting for your click</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-[11.5px] whitespace-nowrap text-muted-foreground tabular">{sectionVersionsLabel(v.sectionVersions, SECTION_NAME)}</td>
                  <td className="py-1.5 text-muted-foreground">{v.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
