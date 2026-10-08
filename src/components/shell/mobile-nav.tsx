"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Sidebar, type SidebarProps } from "./sidebar";

/**
 * Narrow screens (under 768 px, e.g. the Running tab on a phone): the sidebar lives in a slide-over opened from the
 * header's menu button; it closes on navigation. Wider screens keep the fixed sidebar.
 */
export function MobileNav(props: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(pathname);
  if (at !== pathname) {
    setAt(pathname);
    setOpen(false);
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-hover hover:text-foreground md:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-5" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[248px] max-w-[85vw] p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar {...props} />
        </SheetContent>
      </Sheet>
    </>
  );
}
