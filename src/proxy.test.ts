import { describe, expect, it } from "vitest";
import { config } from "./proxy";

// Next compiles the matcher with path-to-regexp; a plain anchored RegExp behaves the same for this pattern.
const re = new RegExp(`^${config.matcher[0]}$`);
const guarded = (path: string) => re.test(path);

describe("proxy matcher", () => {
  it.each([
    "/login",
    "/login/",
    "/login/reset",
    "/_next/static/chunks/app.js",
    "/_next/image",
    "/favicon.ico",
    "/icon.png",
    "/icon1.svg",
    "/apple-icon.png",
    "/manifest.webmanifest",
    "/manifest.json",
  ])("skips %s", (p) => expect(guarded(p)).toBe(false));

  it.each([
    "/",
    "/transactions",
    "/transactions?month=2026-09".split("?")[0],
    "/transactions/abc.png",
    "/stylists/x.png",
    "/transactions/x.svg",
    "/reports/export",
    "/loginx",
    "/login-evil",
    "/iconography",
    "/icon",
    "/icons/x.png",
    "/foo/favicon.ico",
    "/foo/icon.png",
    "/foo/manifest.json",
    "/x/_next/static/a.js",
    "/_next/data/abc.json",
  ])("guards %s", (p) => expect(guarded(p)).toBe(true));
});
