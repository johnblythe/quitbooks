import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-next";

describe("safeNextPath", () => {
  it("keeps normal same-site paths with their query", () => {
    expect(safeNextPath("/transactions?month=2026-09")).toBe("/transactions?month=2026-09");
    expect(safeNextPath("/")).toBe("/");
  });

  it.each([
    ["backslash host", "/\\evil.example"],
    ["tab host", "/\t/evil.example"],
    ["newline host", "/\n/evil.example"],
    ["protocol-relative", "//evil"],
    ["absolute url", "https://evil"],
    ["javascript scheme", "javascript:alert(1)"],
    ["empty", ""],
    ["relative", "evil"],
  ])("rejects %s", (_name, input) => {
    expect(safeNextPath(input)).toBe("/");
  });

  it("rejects non-strings", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });
});
