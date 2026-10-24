import Link from "next/link";
import { getBankAttention } from "@/lib/data";
import { BRIDGE_FIX_URL } from "@/lib/bank-status";

/** Shown on the Dashboard and Inbox when the bank feed errored or hasn't synced in 3+ days. Render inside Suspense. */
export async function BankBanner() {
  const message = await getBankAttention();
  if (!message) return null;
  return (
    <div role="alert" className="rounded-2xl bg-bad-bg px-4 py-3 text-sm text-bad">
      <p className="font-semibold">BMO connection needs attention</p>
      <p className="mt-0.5 break-words">{message}</p>
      <p className="mt-1">
        <a href={BRIDGE_FIX_URL} target="_blank" rel="noreferrer" className="underline">
          Fix it at SimpleFIN Bridge
        </a>
        <span className="text-bad/70"> · then press Sync now in </span>
        <Link href="/settings" className="underline">
          Settings
        </Link>
      </p>
    </div>
  );
}
