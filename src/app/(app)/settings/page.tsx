import type { Metadata } from "next";
import { Suspense } from "react";
import { addCategory, addRule, deleteRule, renameCategory, toggleCategoryArchived } from "@/app/actions/settings";
import { applyRulesToUncategorized } from "@/app/actions/transactions";
import { Button, Card, Empty, PageHeader, Pill, Skeleton, cx, inputClass } from "@/components/ui";
import { getCategories, getRules, getSettings } from "@/lib/data";
import { BusinessForm } from "./business-form";

export const metadata: Metadata = { title: "Settings" };

const kindLabel = { income: "Money in", expense: "Money out", transfer: "Transfers" } as const;

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <Suspense fallback={<Skeleton rows={4} />}>
        <SettingsContent />
      </Suspense>
    </>
  );
}

async function SettingsContent() {
  const [settings, categories, rules] = await Promise.all([getSettings(), getCategories({ includeArchived: true }), getRules()]);
  const active = categories.filter((c) => !c.archived);

  return (
    <div className="space-y-4">
      <Card title="The salon">
        <BusinessForm totalChairs={settings.totalChairs} opening={settings.openingBalance} />
      </Card>

      <Card
        title="Rules"
        action={
          <form action={applyRulesToUncategorized}>
            <button type="submit" className="text-sm text-accent">
              Apply to Inbox
            </button>
          </form>
        }
      >
        <p className="mb-3 text-sm text-ink-2">
          When a bank description contains the text, it gets the category. Stylist rent is matched automatically from the
          Stylists page.
        </p>
        {rules.length ? (
          <ul className="mb-4 divide-y divide-line text-sm">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="font-mono text-xs">{r.pattern}</span>
                  <span className="text-ink-2"> → {r.categoryName}</span>
                  {r.direction !== "any" ? (
                    <span className="ml-1">
                      <Pill>{r.direction === "in" ? "money in" : "money out"}</Pill>
                    </span>
                  ) : null}
                </span>
                <form action={deleteRule}>
                  <input type="hidden" name="id" value={r.id} />
                  <button type="submit" className="text-xs text-bad" aria-label={`Delete rule ${r.pattern}`}>
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mb-4">
            <Empty>No rules yet. You can also create them from the Inbox.</Empty>
          </div>
        )}
        <form action={addRule} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
          <input name="pattern" required minLength={3} maxLength={100} placeholder="Text to match, e.g. SALLY BEAUTY" className={inputClass} aria-label="Text to match" />
          <select name="categoryId" required defaultValue="" className={inputClass} aria-label="Category">
            <option value="" disabled>
              Category…
            </option>
            {(["expense", "income", "transfer"] as const).map((k) => (
              <optgroup key={k} label={kindLabel[k]}>
                {active
                  .filter((c) => c.kind === k)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <select name="direction" defaultValue="any" className={inputClass} aria-label="Applies to">
            <option value="any">In or out</option>
            <option value="out">Money out</option>
            <option value="in">Money in</option>
          </select>
          <Button type="submit" variant="secondary">
            Add rule
          </Button>
        </form>
      </Card>

      <Card title="Categories">
        {(["income", "expense", "transfer"] as const).map((kind) => (
          <section key={kind} className="mb-4">
            <h3 className="mb-1 text-sm font-medium">{kindLabel[kind]}</h3>
            {kind === "transfer" ? (
              <p className="mb-1 text-xs text-ink-2">Moves money without being profit or loss, like owner draws.</p>
            ) : null}
            <ul className="divide-y divide-line">
              {categories
                .filter((c) => c.kind === kind)
                .map((c) => (
                  <li key={c.id} className={cx("flex items-center gap-2 py-1.5", c.archived && "opacity-50")}>
                    <form action={renameCategory} className="flex min-w-0 flex-1 items-center gap-2">
                      <input type="hidden" name="id" value={c.id} />
                      <input
                        name="name"
                        defaultValue={c.name}
                        maxLength={60}
                        className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm hover:border-line focus:border-accent focus:outline-none"
                        aria-label={`Rename ${c.name}`}
                      />
                      <button type="submit" className="text-xs text-ink-2 hover:text-ink">
                        Rename
                      </button>
                    </form>
                    {c.systemKey ? (
                      <Pill>Built in</Pill>
                    ) : (
                      <form action={toggleCategoryArchived}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="archived" value={String(!c.archived)} />
                        <button type="submit" className="text-xs text-ink-2 hover:text-ink">
                          {c.archived ? "Restore" : "Hide"}
                        </button>
                      </form>
                    )}
                  </li>
                ))}
            </ul>
          </section>
        ))}
        <form action={addCategory} className="grid grid-cols-[1fr_auto_auto] gap-2">
          <input name="name" required maxLength={60} placeholder="New category" className={inputClass} aria-label="New category name" />
          <select name="kind" defaultValue="expense" className={inputClass} aria-label="Type">
            <option value="expense">Out</option>
            <option value="income">In</option>
            <option value="transfer">Transfer</option>
          </select>
          <Button type="submit" variant="secondary">
            Add
          </Button>
        </form>
      </Card>
    </div>
  );
}
