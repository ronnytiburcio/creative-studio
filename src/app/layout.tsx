import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { getConfig, IDENTITY } from "@/lib/config";
import { brandUrls } from "@/lib/brand";
import { GENERIC_BRAND } from "@/lib/profile-shared";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

/** The ONE app name (the Studio config's `app.name`, else the install identity's); a config error never breaks the page. */
function appName(): string {
  try {
    return getConfig().appName;
  } catch {
    return IDENTITY.appName;
  }
}

/** The tab icon: the install's own mark (STUDIO_BRAND_DIR) or the generic one; a config error never breaks the page. */
function iconUrl(): string {
  try {
    return brandUrls(getConfig()).markInk;
  } catch {
    return GENERIC_BRAND.markInk;
  }
}

export function generateMetadata(): Metadata {
  const name = appName();
  return {
    title: { default: name, template: `%s · ${name}` },
    description: "Local creative ops: a media library, hooks, ads and shorts for your own brands and clients",
    icons: { icon: iconUrl() },
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${outfit.variable} h-full`} suppressHydrationWarning>
      <body className="h-full overflow-hidden">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
          <TooltipProvider delayDuration={200}>
            {children}
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
