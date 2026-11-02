import { describe, expect, test } from "bun:test";
import { finalizeRunRecord, runRecordReason, validateRunRecord } from "../core/runRecord";
import type { Evidence } from "../core/verificationLevels";

const CRITERIA = [
  { id: "seriale", description: "serial contains BOOT OK" },
  { id: "log", description: "log does not contain HardFault" },
];

function ev(level: Evidence["level"], overrides: Partial<Evidence> = {}): Evidence {
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

const EVIDENCE: Evidence[] = [ev("written"), ev("compiled")];

const record = {
  id: "run-1",
  createdAt: 1_700_000_000_000,
  profile: "DEMO-BOARD-01",
  request: "blink the LED",
  branch: "job/run-1",
  criteria: CRITERIA,
  evidence: EVIDENCE,
  changes: [{ path: "src/main.c", kind: "block-edit", block: "APP" }],
  modelText: "DONE — verified on target",
};

describe("run record", () => {
  test("level and status are derived from evidence, not from the model text", () => {
    const result = validateRunRecord(record);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.level).toBe("compiled");
      expect(result.status).toBe("UNKNOWN");
    }
  });

  test("observed needs every profile criterion, and the record carries them", () => {
    const complete = [
      ...EVIDENCE,
      ev("flashed"),
      ev("observed", { criterion: "seriale" }),
      ev("observed", { criterion: "log" }),
    ];
    const result = validateRunRecord({ ...record, evidence: complete });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.level).toBe("observed");
      expect(result.status).toBe("SUCCESS");
    }
  });

  test("a missing criterion keeps the run at flashed", () => {
    const partial = [...EVIDENCE, ev("flashed"), ev("observed", { criterion: "seriale" })];
    const result = validateRunRecord({ ...record, evidence: partial });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.level).toBe("flashed");
      expect(result.status).toBe("UNKNOWN");
    }
  });

  test("a stored level is rejected: it is derived, never written", () => {
    const result = validateRunRecord({ ...record, level: "confirmed" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("derived from evidence");
  });

  test("a stored verdict is rejected too", () => {
    const result = validateRunRecord({ ...record, status: "SUCCESS" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("derived from evidence");
  });

  test("unknown fields are rejected", () => {
    const result = validateRunRecord({ ...record, verified: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("verified: unknown field");
  });

  test("evidence without actor identity is invalid", () => {
    const broken = EVIDENCE.map((evidence) => {
      const copy: Record<string, unknown> = { ...evidence };
      delete copy.actor;
      delete copy.actorId;
      return copy;
    });
    const result = validateRunRecord({ ...record, evidence: broken });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("evidence[0].actor");
      expect(result.errors.join(" ")).toContain("evidence[0].actorId");
    }
  });

  test("confirmed evidence must come from a human", () => {
    const forged = [...EVIDENCE, ev("confirmed", { actor: "agent", actorId: "claude" })];
    const result = validateRunRecord({ ...record, evidence: forged });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("must come from a human");
  });

  test("observed evidence must name the criterion it evaluates", () => {
    const result = validateRunRecord({
      ...record,
      evidence: [...EVIDENCE, ev("observed", { criterion: null })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("required on observed evidence");
  });

  test("criteria may be empty, but their ids must be unique", () => {
    const empty = validateRunRecord({ ...record, criteria: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.level).toBe("compiled");
      expect(empty.status).toBe("UNKNOWN");
    }
    const duplicated = validateRunRecord({ ...record, criteria: [CRITERIA[0], CRITERIA[0]] });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.errors.join(" ")).toContain("duplicate");
  });

  test("a profile without criteria explains why it cannot go above compiled", () => {
    const derived = finalizeRunRecord({
      id: "run-empty-criteria",
      createdAt: 1,
      profile: "NO-CRITERIA",
      request: "build only",
      branch: null,
      criteria: [],
      changes: [],
      evidence: EVIDENCE,
    });

    expect(derived.level).toBe("compiled");
    expect(derived.status).toBe("UNKNOWN");
    expect(runRecordReason(derived.record, derived.level, derived.status)).toContain(
      "No acceptance criteria are declared",
    );
  });

  test("a block edit without a block name is invalid", () => {
    const result = validateRunRecord({
      ...record,
      changes: [{ path: "src/main.c", kind: "block-edit" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("block: required");
  });

  test("invalid evidence shapes are reported", () => {
    const result = validateRunRecord({
      ...record,
      evidence: [{ level: "teleported", verification: "MAYBE", verdict: "SUCCESS", at: "now" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("evidence[0].level");
      expect(result.errors.join(" ")).toContain("evidence[0].verification");
      expect(result.errors.join(" ")).toContain("evidence[0].at");
    }
  });

  test("finalize derives level/status for a freshly built record", () => {
    const derived = finalizeRunRecord({
      id: "run-2",
      createdAt: 1,
      profile: "DEMO-BOARD-01",
      request: "x",
      branch: null,
      criteria: CRITERIA,
      changes: [],
      evidence: [
        ...EVIDENCE,
        ev("flashed"),
        ev("observed", { criterion: "seriale" }),
        ev("observed", { criterion: "log" }),
      ],
    });

    expect(derived.level).toBe("observed");
    expect(derived.status).toBe("SUCCESS");
    expect(derived.record.modelText).toBeNull();
    expect("level" in derived.record).toBe(false);
  });
});
