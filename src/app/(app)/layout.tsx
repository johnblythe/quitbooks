import { Suspense } from "react";
import { BottomNav } from "@/components/nav";
import { countUncategorized } from "@/lib/data";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <main className="mx-auto max-w-3xl px-4 pb-28 pt-[max(1.25rem,env(safe-area-inset-top))]">{children}</main>
      <BottomNav
        inboxBadge={
          <Suspense fallback={null}>
            <InboxBadge />
          </Suspense>
        }
      />
    </>
  );
}

async function InboxBadge() {
  const n = await countUncategorized();
  if (!n) return null;
  return (
    <span className="absolute left-1/2 top-1 ml-2 min-w-5 rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-5 text-accent-ink">
      {n > 99 ? "99+" : n}
      <span className="sr-only"> uncategorized</span>
    </span>
  );
}
