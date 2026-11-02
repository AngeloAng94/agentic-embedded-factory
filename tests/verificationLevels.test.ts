import { describe, expect, test } from "bun:test";
import {
  capSimulationLevel,
  deriveLevel,
  deriveStatus,
  describeLevel,
  qualifies,
  type Evidence,
  type VerificationLevel,
} from "../core/verificationLevels";

function evidence(level: VerificationLevel, overrides: Partial<Evidence> = {}): Evidence {
  return {
    level,
    verification: "REAL",
    verdict: "SUCCESS",
    at: 1_700_000_000_000,
    actor: "tool",
    actorId: "arm-none-eabi-gcc",
    tool: "arm-none-eabi-gcc",
    detail: null,
    criterion: level === "observed" ? "seriale" : null,
    ...overrides,
  };
}

const base = () => [evidence("written"), evidence("compiled"), evidence("flashed")];

describe("verification levels", () => {
  test("simulation is capped at compiled", () => {
    expect(capSimulationLevel("flashed", true)).toBe("compiled");
    expect(capSimulationLevel("observed", true)).toBe("compiled");
    expect(capSimulationLevel("confirmed", true)).toBe("compiled");
    expect(capSimulationLevel("compiled", true)).toBe("compiled");
    expect(capSimulationLevel("flashed", false)).toBe("flashed");
    expect(capSimulationLevel(null, true)).toBeNull();
  });

  test("nothing in the record means nothing was proven", () => {
    expect(deriveLevel([])).toBeNull();
    expect(describeLevel(null)).toContain("nothing was proven");
  });

  test("levels are consecutive: a flash without a compile does not count", () => {
    expect(deriveLevel([evidence("written")])).toBe("written");
    expect(deriveLevel([evidence("written"), evidence("flashed")])).toBe("written");
    expect(deriveLevel([evidence("written"), evidence("compiled")])).toBe("compiled");
  });

  test("observed is reached when every profile criterion is REAL and passing", () => {
    const evidenceList = [
      ...base(),
      evidence("observed", { criterion: "seriale" }),
      evidence("observed", { criterion: "log" }),
      evidence("observed", { criterion: "target" }),
    ];
    expect(deriveLevel(evidenceList, ["seriale", "log", "target"])).toBe("observed");
  });

  test("one failed criterion blocks observed", () => {
    const evidenceList = [
      ...base(),
      evidence("observed", { criterion: "seriale" }),
      evidence("observed", { criterion: "log", verdict: "FAILURE" }),
    ];
    expect(deriveLevel(evidenceList, ["seriale", "log"])).toBe("flashed");
    expect(deriveStatus(evidenceList, deriveLevel(evidenceList, ["seriale", "log"]))).toBe("FAILURE");
  });

  test("one criterion that was never evaluated blocks observed", () => {
    const evidenceList = [...base(), evidence("observed", { criterion: "seriale" })];
    expect(deriveLevel(evidenceList, ["seriale", "log"])).toBe("flashed");
  });

  test("a simulated observation never counts", () => {
    const evidenceList = [
      ...base(),
      evidence("observed", { criterion: "seriale", verification: "SIMULATED" }),
    ];
    expect(deriveLevel(evidenceList, ["seriale"])).toBe("flashed");
  });

  test("observed requires the criteria list: no profile means no observed", () => {
    const evidenceList = [...base(), evidence("observed", { criterion: "seriale" })];
    expect(deriveLevel(evidenceList)).toBe("flashed");
  });

  test("confirmed requires a human actor, not an agent or a tool", () => {
    const complete = [
      ...base(),
      evidence("observed", { criterion: "seriale" }),
    ];
    expect(deriveLevel([...complete, evidence("confirmed", { actor: "tool" })], ["seriale"])).toBe(
      "observed",
    );
    expect(deriveLevel([...complete, evidence("confirmed", { actor: "agent", actorId: "claude" })], ["seriale"])).toBe(
      "observed",
    );
    expect(
      deriveLevel(
        [...complete, evidence("confirmed", { actor: "human", actorId: "mario.rossi" })],
        ["seriale"],
      ),
    ).toBe("confirmed");
  });

  test("qualifies is strict about REAL + SUCCESS", () => {
    expect(qualifies(evidence("compiled"), "compiled")).toBe(true);
    expect(qualifies(evidence("compiled", { verification: "SIMULATED" }), "compiled")).toBe(false);
    expect(qualifies(evidence("compiled", { verdict: "UNKNOWN" }), "compiled")).toBe(false);
    expect(qualifies(evidence("confirmed", { actor: "tool" }), "confirmed")).toBe(false);
  });

  test("observed evidence alone is not SUCCESS without the criteria list", () => {
    const partial = [...base(), evidence("observed", { criterion: "seriale" })];
    expect(deriveStatus(partial)).toBe("UNKNOWN");
  });

  test("status is derived: compiled-only is UNKNOWN, observed is SUCCESS", () => {
    expect(deriveStatus([])).toBe("UNKNOWN");
    expect(deriveStatus([evidence("written"), evidence("compiled")])).toBe("UNKNOWN");
    const observed = [...base(), evidence("observed", { criterion: "seriale" })];
    expect(deriveStatus(observed, deriveLevel(observed, ["seriale"]))).toBe("SUCCESS");
    expect(deriveStatus([evidence("written"), evidence("compiled", { verdict: "FAILURE" })])).toBe(
      "FAILURE",
    );
  });

  test("describeLevel names the missing next level", () => {
    expect(describeLevel("compiled")).toContain("flashed has no evidence");
    expect(describeLevel("confirmed")).toContain("human sign-off");
  });
});
