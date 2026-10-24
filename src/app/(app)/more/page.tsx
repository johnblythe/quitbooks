import type { Metadata } from "next";
import Link from "next/link";
import { logout } from "@/app/actions/auth";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "More" };

const links = [
  { href: "/stylists", label: "Stylists", hint: "Who rents a chair and what they pay" },
  { href: "/import", label: "Import from BMO", hint: "Upload a bank CSV" },
  { href: "/transactions/new", label: "Add a transaction", hint: "Cash, or anything not in the bank" },
  { href: "/settings", label: "Settings", hint: "Chairs, bank balance, categories, rules" },
];

export default function MorePage() {
  return (
    <>
      <PageHeader title="More" />
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-surface-2">
              <span>
                <span className="block font-medium">{l.label}</span>
                <span className="text-xs text-ink-2">{l.hint}</span>
              </span>
              <span aria-hidden="true" className="text-ink-2">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <form action={logout} className="mt-6">
        <button type="submit" className="w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-left text-bad hover:bg-surface-2">
          Sign out
        </button>
      </form>
    </>
  );
}
