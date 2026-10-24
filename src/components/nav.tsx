"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { cx } from "./ui";

const tabs: { href: string; label: string; icon: ReactNode; match: (p: string) => boolean }[] = [
  {
    href: "/",
    label: "Home",
    match: (p) => p === "/",
    icon: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  },
  {
    href: "/transactions",
    label: "Money",
    match: (p) => p.startsWith("/transactions") || p.startsWith("/import"),
    icon: <path d="M4 6h16M4 12h16M4 18h10" />,
  },
  {
    href: "/inbox",
    label: "Inbox",
    match: (p) => p.startsWith("/inbox"),
    icon: <path d="M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />,
  },
  {
    href: "/reports",
    label: "Reports",
    match: (p) => p.startsWith("/reports"),
    icon: <path d="M5 20V10M12 20V4M19 20v-7" />,
  },
  {
    href: "/more",
    label: "More",
    match: (p) => ["/more", "/stylists", "/settings"].some((x) => p.startsWith(x)),
    icon: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  },
];

/** The pathname is request data, so the active-tab highlight streams in behind Suspense. */
export function BottomNav({ inboxBadge }: { inboxBadge?: ReactNode }) {
  return (
    <Suspense fallback={<NavBar pathname={null} inboxBadge={inboxBadge} />}>
      <NavWithPath inboxBadge={inboxBadge} />
    </Suspense>
  );
}

function NavWithPath({ inboxBadge }: { inboxBadge?: ReactNode }) {
  return <NavBar pathname={usePathname()} inboxBadge={inboxBadge} />;
}

function NavBar({ pathname, inboxBadge }: { pathname: string | null; inboxBadge?: ReactNode }) {
  return (
    <nav
      aria-label="Main"
      className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-3xl">
        {tabs.map((t) => {
          const active = pathname !== null && t.match(pathname);
          return (
            <li key={t.href} className="flex-1">
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
                  active ? "text-accent" : "text-ink-2 hover:text-ink",
                )}
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-6 w-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={t.label === "More" ? 3 : 1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {t.icon}
                </svg>
                {t.label}
                {t.href === "/inbox" ? inboxBadge : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
