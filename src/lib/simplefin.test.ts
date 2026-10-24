import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSimplefinUrl,
  buildDescription,
  claimSetupToken,
  collectErrors,
  decodeSetupToken,
  fetchAccountSet,
  mapAccount,
  mapTransaction,
  redactSecrets,
  splitWindows,
  unixToLocalDate,
  type SfAccountSet,
} from "./simplefin";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const fixture: SfAccountSet = JSON.parse(readFileSync("fixtures/simplefin-demo.json", "utf8"));

describe("setup token / SSRF guard", () => {
  it("accepts simplefin.org hosts", () => {
    expect(decodeSetupToken(b64("https://beta-bridge.simplefin.org/simplefin/claim/ABC"))).toBe(
      "https://beta-bridge.simplefin.org/simplefin/claim/ABC",
    );
    expect(decodeSetupToken(b64("https://simplefin.org/claim/x"))).toContain("simplefin.org");
    // tolerates whitespace/newlines from pasting
    expect(decodeSetupToken(`  ${b64("https://bridge.simplefin.org/c").slice(0, 8)}\n${b64("https://bridge.simplefin.org/c").slice(8)} `)).toContain("bridge.simplefin.org");
  });
  it.each([
    ["http", "http://beta-bridge.simplefin.org/claim/x"],
    ["other host", "https://evil.com/simplefin/claim/x"],
    ["suffix trick", "https://evilsimplefin.org/claim/x"],
    ["subdomain of attacker", "https://simplefin.org.evil.com/claim/x"],
    ["userinfo trick", "https://beta-bridge.simplefin.org@evil.com/claim/x"],
    ["embedded credentials", "https://user:pw@beta-bridge.simplefin.org/claim/x"],
    ["ipv4 literal", "https://127.0.0.1/claim/x"],
    ["ipv6 literal", "https://[::1]/claim/x"],
    ["custom port", "https://beta-bridge.simplefin.org:8443/claim/x"],
    ["file", "file:///etc/passwd"],
  ])("rejects %s", (_n, url) => expect(() => decodeSetupToken(b64(url))).toThrow());
  it("rejects non-token garbage", () => {
    expect(() => decodeSetupToken("")).toThrow();
    expect(() => decodeSetupToken("not a token!!")).toThrow();
    expect(() => decodeSetupToken(b64("not a url"))).toThrow();
  });
  it("allows credentials only when asked (Access URLs)", () => {
    expect(() => assertSimplefinUrl("https://u:p@beta-bridge.simplefin.org/simplefin")).toThrow();
    expect(assertSimplefinUrl("https://u:p@beta-bridge.simplefin.org/simplefin", { allowCredentials: true }).username).toBe("u");
  });
});

describe("claim and fetch (injected fetch)", () => {
  it("POSTs the claim URL and validates the Access URL it returns", async () => {
    const calls: { url: string; method?: string }[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response("https://u:p@beta-bridge.simplefin.org/simplefin\n");
    }) as unknown as typeof fetch;
    const access = await claimSetupToken(b64("https://beta-bridge.simplefin.org/simplefin/claim/T"), ok);
    expect(access).toBe("https://u:p@beta-bridge.simplefin.org/simplefin");
    expect(calls).toEqual([{ url: "https://beta-bridge.simplefin.org/simplefin/claim/T", method: "POST" }]);

    const evil = (async () => new Response("https://u:p@evil.com/x")) as unknown as typeof fetch;
    await expect(claimSetupToken(b64("https://beta-bridge.simplefin.org/c"), evil)).rejects.toThrow();
    const used = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(claimSetupToken(b64("https://beta-bridge.simplefin.org/c"), used)).rejects.toThrow(/already used/);
  });
  it("sends credentials as a Basic header, not in the URL", async () => {
    let seen: { url: string; auth: string } | undefined;
    const f = (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>).Authorization };
      return new Response(JSON.stringify({ accounts: [] }));
    }) as unknown as typeof fetch;
    await fetchAccountSet("https://us%40er:pa%3As@beta-bridge.simplefin.org/simplefin", { startUnix: 5, endUnix: 9, balancesOnly: true }, f);
    expect(seen!.url).toBe("https://beta-bridge.simplefin.org/simplefin/accounts?version=2&start-date=5&end-date=9&balances-only=1");
    expect(seen!.auth).toBe(`Basic ${Buffer.from("us@er:pa:s").toString("base64")}`);
  });
  it("maps HTTP failures to clear, credential-free errors", async () => {
    const f = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchAccountSet("https://u:p@beta-bridge.simplefin.org/simplefin", {}, f)).rejects.toThrow(/403/);
    const boom = (async () => {
      throw new Error("connect failed https://u:p@beta-bridge.simplefin.org/simplefin");
    }) as unknown as typeof fetch;
    await expect(fetchAccountSet("https://u:p@beta-bridge.simplefin.org/simplefin", {}, boom)).rejects.toThrow(/\[redacted\]/);
  });
});

describe("redactSecrets / collectErrors", () => {
  it("strips credentials", () => {
    const s = redactSecrets("failed at https://user:pass@host.simplefin.org/x and http://a:b@c/d");
    expect(s).not.toContain("pass");
    expect(s).not.toContain("a:b");
    expect(s).toContain("https://[redacted]@host.simplefin.org/x");
  });
  it("reads errlist and legacy errors", () => {
    expect(collectErrors({ errlist: [{ code: "con.auth", msg: "Re-auth needed" }], errors: ["old https://u:p@x.simplefin.org"] })).toEqual([
      "con.auth: Re-auth needed",
      "old https://[redacted]@x.simplefin.org",
    ]);
  });
});

describe("date mapping", () => {
  it("uses the Indianapolis calendar day", () => {
    // 2026-03-05 02:30 UTC = still Mar 4 evening in Indianapolis (EST, UTC-5)
    expect(unixToLocalDate(Date.UTC(2026, 2, 5, 2, 30) / 1000)).toBe("2026-03-04");
    // 2026-03-05 05:00 UTC = midnight local -> Mar 5
    expect(unixToLocalDate(Date.UTC(2026, 2, 5, 5, 0) / 1000)).toBe("2026-03-05");
    // summer (EDT, UTC-4): 03:59 UTC is still the previous day, 04:00 is the new day
    expect(unixToLocalDate(Date.UTC(2026, 6, 10, 3, 59) / 1000)).toBe("2026-07-09");
    expect(unixToLocalDate(Date.UTC(2026, 6, 10, 4, 0) / 1000)).toBe("2026-07-10");
  });
});

describe("mapTransaction", () => {
  const t = { id: "42", posted: Date.UTC(2026, 2, 5, 2, 30) / 1000, amount: "-1,234.56" };
  it("maps id, date, cents", () => {
    expect(mapTransaction({ ...t, description: "ZELLE JANE" })).toEqual({
      externalId: "42",
      date: "2026-03-04",
      amountCents: -123456,
      description: "ZELLE JANE",
    });
  });
  it("handles positive amounts without float error", () => expect(mapTransaction({ ...t, amount: "0.29", description: "x" })!.amountCents).toBe(29));
  it("skips pending, unposted and unparseable rows", () => {
    expect(mapTransaction({ ...t, pending: true, description: "x" })).toBeNull();
    expect(mapTransaction({ ...t, posted: 0, description: "x" })).toBeNull();
    expect(mapTransaction({ ...t, amount: "abc", description: "x" })).toBeNull();
    expect(mapTransaction({ ...t, id: "", description: "x" })).toBeNull();
  });
  it("builds descriptions without repeating text", () => {
    expect(buildDescription({ description: "Fishing bait", payee: "John's Fishin Shack", memo: "JOHNS FISHIN SHACK BAIT" })).toBe(
      "Fishing bait · John's Fishin Shack · JOHNS FISHIN SHACK BAIT",
    );
    expect(buildDescription({ description: "Grocery store", payee: "grocery STORE" })).toBe("Grocery store");
    expect(buildDescription({ description: "ZELLE FROM JANE DOE", payee: "JANE DOE" })).toBe("ZELLE FROM JANE DOE");
    expect(buildDescription({ payee: "Only payee" })).toBe("Only payee");
  });
});

describe("splitWindows", () => {
  const D = 86_400;
  it("returns nothing for an empty range", () => expect(splitWindows(10, 10)).toEqual([]));
  it("keeps a short range whole", () => expect(splitWindows(0, 10 * D)).toEqual([[0, 10 * D]]));
  it("splits into consecutive windows of at most maxDays", () => {
    const w = splitWindows(0, 100 * D, 45);
    expect(w).toEqual([[0, 45 * D], [45 * D, 90 * D], [90 * D, 100 * D]]);
    for (const [s, e] of w) expect(e - s).toBeLessThanOrEqual(90 * D);
  });
  it("is exact at a boundary", () => expect(splitWindows(0, 90 * D, 45)).toHaveLength(2));
});

describe("demo fixture (real SimpleFIN response)", () => {
  it("maps every account and transaction", () => {
    expect(fixture.accounts.length).toBeGreaterThan(0);
    for (const a of fixture.accounts) {
      const m = mapAccount(a, fixture);
      expect(m.balanceCents).not.toBeNull();
      expect(m.balanceDate).toBeInstanceOf(Date);
      expect(m.orgName).toBe("SimpleFIN Bridge");
      const mapped = (a.transactions ?? []).map((t) => mapTransaction(t));
      expect(mapped.every((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x.date))).toBe(true);
    }
    const checking = fixture.accounts.find((a) => a.id === "Demo Checking")!;
    expect(mapAccount(checking, fixture).balanceCents).toBe(2448555);
  });
});
