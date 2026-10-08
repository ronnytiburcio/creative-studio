"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStatus } from "@/components/shell/status-provider";
import { needsDriveText, useGenerate } from "./generate-provider";

/** "Generate" in every channel header. Disabled (same tooltip pattern as Reveal in Finder) while the drive is unplugged. */
export function GenerateButton() {
  const { drive } = useStatus();
  const g = useGenerate();
  const button = (
    <Button
      variant="outline"
      className="h-9 gap-1.5 bg-card px-3 text-[13.5px]"
      disabled={!drive.mounted}
      onClick={() => (g.open ? g.close() : g.openPanel())}
      aria-pressed={g.open}
    >
      <Sparkles className="text-brand-text" />
      Generate
    </Button>
  );
  if (drive.mounted) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{needsDriveText(drive)}</TooltipContent>
    </Tooltip>
  );
}
