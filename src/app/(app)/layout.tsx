import { Suspense } from "react";
import { getStatus, sidebarData } from "@/lib/queries";
import { getDb } from "@/lib/db";
import { listEpisodes } from "@/lib/shorts/episodes";
import { StatusProvider } from "@/components/shell/status-provider";
import { Sidebar } from "@/components/shell/sidebar";
import { MobileNav } from "@/components/shell/mobile-nav";
import { DriveBanner, SearchBox, StatusPills } from "@/components/shell/topbar";
import { CommandPalette } from "@/components/shell/command-palette";
import { GenerateAware, GenerateProvider } from "@/components/generate/generate-provider";
import { GeneratePanel } from "@/components/generate/generate-panel";
import { QuickToolDialog } from "@/components/generate/quick-tools";
import { NewAdProvider } from "@/components/ads/new-ad-provider";
import { LabelsProvider } from "@/components/shell/labels-provider";
import { uiLabels } from "@/lib/ui-labels";

export const dynamic = "force-dynamic";

export default function AppLayout({ children }: LayoutProps<"/">) {
  const side = sidebarData();
  const status = getStatus();
  const labels = uiLabels();
  const episodes = listEpisodes(getDb().sqlite)
    .filter((e) => e.cueCount > 0)
    .map((e) => ({ id: e.id, num: e.num, title: e.title, keptIdeas: e.keptIdeas }));
  return (
    <LabelsProvider labels={labels}>
    <StatusProvider initial={status}>
      <GenerateProvider>
      <NewAdProvider>
      <div className="flex h-full min-w-0">
        <div className="hidden md:flex">
          <Sidebar sections={side.sections} clients={side.clients} sharedCount={side.sharedCount} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2 md:gap-4 md:px-5">
            <MobileNav sections={side.sections} clients={side.clients} sharedCount={side.sharedCount} />
            <Suspense fallback={<div className="h-9 w-[520px]" />}>
              <SearchBox />
            </Suspense>
            <div className="ml-auto" />
            <div className="hidden sm:block">
              <StatusPills />
            </div>
          </header>
          <DriveBanner />
          <main className="scrollbar-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto" id="main-scroll">
            <GenerateAware>{children}</GenerateAware>
          </main>
        </div>
      </div>
      <GeneratePanel clients={side.clients.map((c) => ({ code: c.code, short: c.short }))} />
      <QuickToolDialog />
      <CommandPalette
        clients={side.clients.map((c) => ({ code: c.code, name: c.name }))}
        lanesOn={side.sections.map((s) => s.key)}
        episodes={side.sections.some((s) => s.key === "rtm") ? episodes : []}
      />
      </NewAdProvider>
      </GenerateProvider>
    </StatusProvider>
    </LabelsProvider>
  );
}
