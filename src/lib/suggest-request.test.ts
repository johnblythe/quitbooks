import { describe, expect, it } from "vitest";
import { isSameOrigin, suggestGroupsInput } from "./suggest-request";

const id = "123e4567-e89b-42d3-a456-426614174000";

describe("suggestGroupsInput", () => {
  it("accepts a valid body", () => {
    expect(suggestGroupsInput.safeParse([{ key: "a", ids: [id] }]).success).toBe(true);
  });
  it.each([
    ["empty array", []],
    ["13 groups", Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, ids: [id] }))],
    ["empty key", [{ key: "", ids: [id] }]],
    ["key too long", [{ key: "x".repeat(201), ids: [id] }]],
    ["no ids", [{ key: "a", ids: [] }]],
    ["501 ids", [{ key: "a", ids: Array.from({ length: 501 }, () => id) }]],
    ["non-uuid id", [{ key: "a", ids: ["nope"] }]],
    ["not an array", { key: "a" }],
  ])("rejects %s", (_n, body) => expect(suggestGroupsInput.safeParse(body).success).toBe(false));

  it("accepts the limits", () => {
    const groups = Array.from({ length: 12 }, (_, i) => ({ key: i ? `k${i}` : "x".repeat(200), ids: Array.from({ length: 500 }, () => id) }));
    expect(suggestGroupsInput.safeParse(groups).success).toBe(true);
  });
});

describe("isSameOrigin", () => {
  it("allows a missing Origin", () => expect(isSameOrigin(null, "app.test")).toBe(true));
  it("allows a matching host", () => expect(isSameOrigin("https://app.test", "app.test")).toBe(true));
  it("allows a matching host with port", () => expect(isSameOrigin("http://localhost:3000", "localhost:3000")).toBe(true));
  it("rejects a different host", () => expect(isSameOrigin("https://evil.test", "app.test")).toBe(false));
  it("rejects a different port", () => expect(isSameOrigin("http://localhost:3001", "localhost:3000")).toBe(false));
  it("rejects a malformed Origin", () => expect(isSameOrigin("null", "app.test")).toBe(false));
  it("rejects when host is missing", () => expect(isSameOrigin("https://app.test", null)).toBe(false));
});
