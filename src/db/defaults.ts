/** Starter categories, seeded on first setup. Everything except system categories is editable. */
export const DEFAULT_CATEGORIES: {
  name: string;
  kind: "income" | "expense" | "transfer";
  systemKey?: string;
}[] = [
  { name: "Booth Rent", kind: "income", systemKey: "booth_rent" },
  { name: "Product Sales", kind: "income" },
  { name: "Other Income", kind: "income" },

  { name: "Rent & Lease", kind: "expense" },
  { name: "Utilities", kind: "expense" },
  { name: "Supplies", kind: "expense" },
  { name: "Equipment & Furniture", kind: "expense" },
  { name: "Repairs & Maintenance", kind: "expense" },
  { name: "Cleaning & Laundry", kind: "expense" },
  { name: "Insurance", kind: "expense" },
  { name: "Marketing & Advertising", kind: "expense" },
  { name: "Software & Subscriptions", kind: "expense" },
  { name: "Bank & Payment Fees", kind: "expense" },
  { name: "Professional Fees", kind: "expense" },
  { name: "Licenses & Permits", kind: "expense" },
  { name: "Taxes", kind: "expense" },
  { name: "Other Expense", kind: "expense" },

  { name: "Owner Draw", kind: "transfer" },
  { name: "Owner Contribution", kind: "transfer" },
  { name: "Transfer Between Accounts", kind: "transfer" },
];

export const BOOTH_RENT_KEY = "booth_rent";

export const SETTING_KEYS = {
  totalChairs: "total_chairs",
  openingBalance: "opening_balance",
} as const;

export type OpeningBalance = { cents: number; asOf: string };
