"use client";

import { useActionState } from "react";
import { connectBankAction, disconnectBankAction, saveBankSetupAction, syncBankNowAction } from "@/app/actions/bank";
import { Button, ErrorText, Field, Money, Pill, inputClass } from "@/components/ui";
import { formatDate } from "@/lib/dates";

export type BankCardAccount = {
  id: string;
  name: string;
  orgName: string;
  balanceCents: number | null;
  balanceDate: string | null; // local YYYY-MM-DD
  include: boolean;
};
export type BankCardConnection = {
  id: string;
  label: string;
  cutoverDate: string;
  lastSyncedAt: string | null; // preformatted
  lastError: string | null;
  active: boolean;
  accounts: BankCardAccount[];
};

function Status({ state }: { state: { error?: string; ok?: string } | undefined }) {
  return (
    <>
      <ErrorText>{state?.error}</ErrorText>
      {state?.ok ? <p className="text-sm text-good">{state.ok}</p> : null}
    </>
  );
}

function AccountLine({ a }: { a: BankCardAccount }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm">{a.name}</span>
      <span className="block text-xs text-ink-2">
        {a.orgName ? `${a.orgName} · ` : ""}
        {a.balanceCents === null ? "no balance" : <Money cents={a.balanceCents} />}
        {a.balanceDate ? ` as of ${formatDate(a.balanceDate)}` : ""}
      </span>
    </span>
  );
}

export function ConnectForm() {
  const [state, action, pending] = useActionState(connectBankAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-ink-2">
        Link BMO through SimpleFIN Bridge (read-only, $15/year) and new transactions show up on their own. Get a setup token
        at{" "}
        <a href="https://beta-bridge.simplefin.org" target="_blank" rel="noreferrer" className="text-accent underline">
          beta-bridge.simplefin.org
        </a>{" "}
        and paste it here. A token works once.
      </p>
      <Field label="Setup token">
        <textarea name="token" required rows={3} autoComplete="off" spellCheck={false} className={`${inputClass} font-mono text-xs`} />
      </Field>
      <Status state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}

export function SetupForm({ conn }: { conn: BankCardConnection }) {
  const [state, action, pending] = useActionState(saveBankSetupAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="connectionId" value={conn.id} />
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Accounts to sync</legend>
        <ul className="divide-y divide-line">
          {conn.accounts.map((a) => (
            <li key={a.id}>
              <label className="flex min-h-11 items-center gap-3 py-1.5">
                <input type="checkbox" name="accountId" value={a.id} defaultChecked={a.include} className="h-4 w-4 accent-[var(--accent)]" />
                <AccountLine a={a} />
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <Field
        label="Start syncing from"
        hint="Feed transactions before this date are ignored, and CSV imports from this date on are skipped. Default is the day after your latest transaction."
      >
        <input name="cutoverDate" type="date" required defaultValue={conn.cutoverDate} className={inputClass} />
      </Field>
      <Status state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Syncing…" : conn.active ? "Save" : "Start syncing"}
      </Button>
    </form>
  );
}

export function SyncNow({ connectionId }: { connectionId: string }) {
  const [state, action, pending] = useActionState(syncBankNowAction, undefined);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="connectionId" value={connectionId} />
      <Status state={state} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Syncing…" : "Sync now"}
      </Button>
    </form>
  );
}

export function ConnectedView({ conn }: { conn: BankCardConnection }) {
  const included = conn.accounts.filter((a) => a.include);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {conn.lastError ? <Pill tone="bad">Needs attention</Pill> : <Pill tone="good">Connected</Pill>}
        <span className="text-ink-2">
          {conn.lastSyncedAt ? `Last synced ${conn.lastSyncedAt}` : "Not synced yet"} · from {formatDate(conn.cutoverDate)}
        </span>
      </div>
      {conn.lastError ? <ErrorText>{conn.lastError}</ErrorText> : null}
      <ul className="divide-y divide-line">
        {included.map((a) => (
          <li key={a.id} className="flex items-center gap-3 py-2">
            <AccountLine a={a} />
          </li>
        ))}
      </ul>
      <SyncNow connectionId={conn.id} />
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-2">Change accounts or start date</summary>
        <div className="mt-3">
          <SetupForm conn={conn} />
        </div>
      </details>
      <form action={disconnectBankAction}>
        <input type="hidden" name="connectionId" value={conn.id} />
        <p className="mb-2 text-xs text-ink-2">Disconnecting removes the link and its saved credentials. Transactions already in your books stay.</p>
        <Button type="submit" variant="danger">
          Disconnect
        </Button>
      </form>
    </div>
  );
}
