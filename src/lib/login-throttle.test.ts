import { describe, expect, it } from "vitest";
import { clientIp, isThrottled } from "./login-throttle";

describe("isThrottled", () => {
  it("allows under the thresholds", () => {
    expect(isThrottled({ emailFailures: 0, ipFailures: 0 })).toBe(false);
    expect(isThrottled({ emailFailures: 19, ipFailures: 4 })).toBe(false);
  });
  it("blocks an IP at 5 failures", () => {
    expect(isThrottled({ emailFailures: 0, ipFailures: 5 })).toBe(true);
  });
  it("blocks an email at 20 failures from any mix of IPs, not 5", () => {
    expect(isThrottled({ emailFailures: 5, ipFailures: 0 })).toBe(false);
    expect(isThrottled({ emailFailures: 20, ipFailures: 0 })).toBe(true);
  });
});

describe("clientIp", () => {
  it("takes the first forwarded entry", () => {
    expect(clientIp("1.2.3.4, 10.0.0.1")).toBe("1.2.3.4");
  });
  it("falls back to unknown", () => {
    expect(clientIp(null)).toBe("unknown");
    expect(clientIp("")).toBe("unknown");
    expect(clientIp(" , 1.1.1.1")).toBe("unknown");
  });
});
