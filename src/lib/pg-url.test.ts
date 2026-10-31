import { describe, expect, it } from "vitest";
import { withVerifyFull } from "./pg-url";

describe("withVerifyFull", () => {
  it("upgrades weaker ssl modes and keeps other params", () => {
    expect(withVerifyFull("postgresql://u:p@h/db?sslmode=require&channel_binding=require")).toBe(
      "postgresql://u:p@h/db?sslmode=verify-full&channel_binding=require",
    );
    expect(withVerifyFull("postgresql://u:p@h/db?a=1&sslmode=prefer")).toBe("postgresql://u:p@h/db?a=1&sslmode=verify-full");
  });
  it("leaves verify-full, disable and urls without sslmode alone", () => {
    for (const url of ["postgresql://h/db?sslmode=verify-full", "postgresql://h/db?sslmode=disable", "postgresql://h/db"]) {
      expect(withVerifyFull(url)).toBe(url);
    }
  });
});
