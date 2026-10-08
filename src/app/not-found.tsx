import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid h-full place-items-center bg-background px-6">
      <div className="text-center">
        <div className="text-[11px] font-semibold tracking-[0.16em] text-brand-text uppercase">404</div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">Nothing at this address</h1>
        <p className="mt-1 text-[13.5px] text-muted-foreground">That channel, tab or file is not in the Studio.</p>
        <Link
          href="/rtm/library"
          className="mt-4 inline-flex h-9 items-center rounded-lg bg-primary px-4 text-[13.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Back to the Library
        </Link>
      </div>
    </div>
  );
}
