import { describe, expect, test } from "bun:test";
import {
  deriveLevel,
  deriveStatus,
  describeLevel,
  qualifies,
  type Evidence,
  type VerificationLevel,
} from "../core/verificationLevels";

function evidence(
  level: VerificationLevel,
  overrides: Partial<Evidence> = {},
): Evidence {
  return {
    level,
    verification: "REAL",
    verdict: "SUCCESS",
    at: 1_700_000_000_000,
    tool: "tool",
    detail: null,
    source: "tool",
    ...overrides,
  };
}

describe("verification levels", () => {
  test("nothing in the record means nothing was proven", () => {
    expect(deriveLevel([])).toBeNull();
    expect(describeLevel(null)).toContain("nothing was proven");
  });

  test("levels are consecutive: a flash without a compile does not count", () => {
    expect(deriveLevel([evidence("written")])).toBe("written");
    expect(deriveLevel([evidence("written"), evidence("flashed")])).toBe("written");
    expect(deriveLevel([evidence("written"), evidence("compiled")])).toBe("compiled");
  });

  test("the full chain reaches confirmed only with a human sign-off", () => {
    const chain = (["written", "compiled", "flashed", "observed"] as VerificationLevel[]).map((level) =>
      evidence(level),
    );

    expect(deriveLevel(chain)).toBe("observed");
    expect(deriveLevel([...chain, evidence("confirmed")])).toBe("observed");
    expect(deriveLevel([...chain, evidence("confirmed", { source: "human", tool: "human" })])).toBe(
      "confirmed",
    );
  });

  test("SIMULATED or FAILURE evidence never advances a level", () => {
    const base = [evidence("written"), evidence("compiled")];
    expect(deriveLevel([...base, evidence("flashed", { verification: "SIMULATED" })])).toBe("compiled");
    expect(deriveLevel([...base, evidence("flashed", { verdict: "FAILURE" })])).toBe("compiled");
    expect(deriveLevel([...base, evidence("flashed", { verification: "NOT_AVAILABLE" })])).toBe("compiled");
  });

  test("qualifies is strict about REAL + SUCCESS", () => {
    expect(qualifies(evidence("compiled"), "compiled")).toBe(true);
    expect(qualifies(evidence("compiled", { verification: "SIMULATED" }), "compiled")).toBe(false);
    expect(qualifies(evidence("compiled", { verdict: "UNKNOWN" }), "compiled")).toBe(false);
    expect(qualifies(evidence("confirmed", { source: "tool" }), "confirmed")).toBe(false);
  });

  test("status is derived: compiled-only is UNKNOWN, observed is SUCCESS", () => {
    expect(deriveStatus([])).toBe("UNKNOWN");
    expect(deriveStatus([evidence("written"), evidence("compiled")])).toBe("UNKNOWN");
    expect(
      deriveStatus([
        evidence("written"),
        evidence("compiled"),
        evidence("flashed"),
        evidence("observed"),
      ]),
    ).toBe("SUCCESS");
    expect(deriveStatus([evidence("written"), evidence("compiled", { verdict: "FAILURE" })])).toBe(
      "FAILURE",
    );
  });

  test("describeLevel names the missing next level", () => {
    expect(describeLevel("compiled")).toContain("flashed has no evidence");
    expect(describeLevel("confirmed")).toContain("human sign-off");
  });
});
