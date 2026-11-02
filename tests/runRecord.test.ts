import { describe, expect, test } from "bun:test";
import { finalizeRunRecord, validateRunRecord } from "../core/runRecord";
import type { Evidence } from "../core/verificationLevels";

const EVIDENCE: Evidence[] = [
  {
    level: "written",
    verification: "REAL",
    verdict: "SUCCESS",
    at: 1_700_000_000_000,
    tool: "filesystem",
    detail: "2 files",
    source: "tool",
  },
  {
    level: "compiled",
    verification: "REAL",
    verdict: "SUCCESS",
    at: 1_700_000_001_000,
    tool: "arm-none-eabi-gcc",
    detail: "exit 0",
    source: "tool",
  },
];

const record = {
  id: "run-1",
  createdAt: 1_700_000_000_000,
  profile: "DEMO-BOARD-01",
  request: "blink the LED",
  branch: "job/run-1",
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
      // Model claims success; only a compile was measured.
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
      changes: [],
      evidence: [
        EVIDENCE[0]!,
        EVIDENCE[1]!,
        { ...EVIDENCE[1]!, level: "flashed" },
        { ...EVIDENCE[1]!, level: "observed" },
      ],
    });

    expect(derived.level).toBe("observed");
    expect(derived.status).toBe("SUCCESS");
    expect(derived.record.modelText).toBeNull();
    expect("level" in derived.record).toBe(false);
  });
});
