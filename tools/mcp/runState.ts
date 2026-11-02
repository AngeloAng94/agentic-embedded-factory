/**
 * Per-MCP-session run state.
 *
 * The MCP server is the boundary where a model asks for actions. It must not
 * trust the model's prose: every result is appended as structured evidence, and
 * `flash` is gated by this state, never by the caller saying "the map is fine".
 *
 * The gate is intentionally about the exact bytes: the ELF is hashed again at
 * flash time, so a memory_map_check followed by a rebuild does not unlock the
 * new binary. A successful check on another file is not enough either.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProductProfile } from "../../core/profile";
import type { Verification, Verdict } from "../../core/types";
import type { ProfileDoctorReport } from "../doctor";
import type { MemoryMapReport } from "../memoryMap";

export type ToolGroup = "read-only" | "side-effects";

/** Evidence produced by one MCP tool call. It is deliberately not a level claim. */
export interface ToolEvidence {
  at: number;
  tool: string;
  group: ToolGroup;
  actor: "tool";
  actorId: string;
  verification: Verification;
  verdict: Verdict;
  detail: string;
  artifact: string | null;
  sha256: string | null;
}

export interface MemoryMapRecord {
  at: number;
  artifact: string;
  sha256: string;
  verdict: MemoryMapReport["verdict"];
  report: MemoryMapReport;
}

export interface DoctorRecord {
  at: number;
  report: ProfileDoctorReport;
}

export interface RunCriterion {
  id: string;
  description: string;
}

export interface McpRunRecord {
  id: string;
  startedAt: number;
  profile: string;
  criteria: RunCriterion[];
  evidence: ToolEvidence[];
  memoryMapChecks: MemoryMapRecord[];
  doctor: DoctorRecord | null;
  artifact: string | null;
}

export type FlashGate =
  | { ok: true; sha256: string }
  | { ok: false; sha256: string | null; reason: string };

export function hashArtifact(filePath: string): { ok: true; sha256: string } | { ok: false; reason: string } {
  try {
    return {
      ok: true,
      sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `cannot read the ELF to flash: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function criteriaFromProfile(profile: ProductProfile): RunCriterion[] {
  return profile.criteri.map((criterion, index) => {
    if ("seriale_contiene" in criterion) {
      return {
        id: `serial-contains-${index + 1}`,
        description: `serial output contains ${JSON.stringify(criterion.seriale_contiene)}`,
      };
    }
    if ("log_non_contiene" in criterion) {
      return {
        id: `log-forbids-${index + 1}`,
        description: `serial log does not contain ${criterion.log_non_contiene.map((item) => JSON.stringify(item)).join(", ")}`,
      };
    }
    return {
      id: `target-test-${index + 1}`,
      description: "the on-target test passes",
    };
  });
}

export class McpRunState {
  readonly id: string;
  readonly startedAt: number;
  readonly profile: string;
  readonly criteria: RunCriterion[];

  private readonly evidenceList: ToolEvidence[] = [];
  private readonly memoryMapRecords: MemoryMapRecord[] = [];
  private doctorRecord: DoctorRecord | null = null;
  private latestArtifact: string | null = null;
  private readonly now: () => number;

  constructor(
    profile: ProductProfile,
    options: { id?: string; startedAt?: number; now?: () => number } = {},
  ) {
    this.profile = profile.prodotto;
    this.criteria = criteriaFromProfile(profile);
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
    this.id = options.id ?? `mcp-${this.startedAt}`;
  }

  get evidence(): readonly ToolEvidence[] {
    return this.evidenceList;
  }

  get memoryMapChecks(): readonly MemoryMapRecord[] {
    return this.memoryMapRecords;
  }

  get doctor(): DoctorRecord | null {
    return this.doctorRecord;
  }

  get artifact(): string | null {
    return this.latestArtifact;
  }

  recordEvidence(
    input: Omit<ToolEvidence, "at" | "actor" | "actorId"> & {
      at?: number;
      actorId?: string;
    },
  ): ToolEvidence {
    const evidence: ToolEvidence = {
      ...input,
      at: input.at ?? this.now(),
      actor: "tool",
      actorId: input.actorId ?? `py-bench-mcp/${input.tool}`,
    };
    this.evidenceList.push(evidence);
    if (input.artifact !== null) this.latestArtifact = input.artifact;
    return evidence;
  }

  recordMemoryMap(report: MemoryMapReport, at = this.now()): MemoryMapRecord {
    const record: MemoryMapRecord = {
      at,
      artifact: report.artifact,
      sha256: report.sha256,
      verdict: report.verdict,
      report,
    };
    this.memoryMapRecords.push(record);
    this.latestArtifact = report.artifact;
    return record;
  }

  recordDoctor(report: ProfileDoctorReport, at = this.now()): DoctorRecord {
    const record: DoctorRecord = { at, report };
    this.doctorRecord = record;
    return record;
  }

  /**
   * Returns the reason a flash is refused, or the exact hash that was checked.
   *
   * Both conditions are evaluated against the current record:
   *  - a successful memory_map_check for the same sha256 (the latest check for
   *    that hash must be SUCCESS, so a newer failed check cannot be ignored);
   *  - the latest doctor run must not have marked the target unreliable. A
   *    later doctor run with readsReliable=true is the only thing that clears
   *    a stale unreliable result.
   */
  canFlash(artifact: string): FlashGate {
    const hash = hashArtifact(artifact);
    if (!hash.ok) return { ok: false, sha256: null, reason: hash.reason };

    const matching = this.memoryMapRecords.filter((record) => record.sha256 === hash.sha256);
    if (matching.length === 0) {
      const latest = this.memoryMapRecords[this.memoryMapRecords.length - 1];
      const detail = latest
        ? ` The latest check was for ${latest.artifact} (sha256 ${latest.sha256}, verdict ${latest.verdict}).`
        : " No memory_map_check has run in this MCP session.";
      return {
        ok: false,
        sha256: hash.sha256,
        reason: `flash refused: no memory_map_check SUCCESS matches this ELF (sha256 ${hash.sha256}).${detail} Run memory_map_check on this exact ELF and wait for SUCCESS (same sha256) before flashing.`,
      };
    }

    const latest = matching[matching.length - 1]!;
    if (latest.verdict !== "SUCCESS") {
      return {
        ok: false,
        sha256: hash.sha256,
        reason: `flash refused: the latest memory_map_check for this ELF (sha256 ${hash.sha256}, ${latest.artifact}) ended ${latest.verdict}. Fix the memory map and rerun memory_map_check to SUCCESS before flashing.`,
      };
    }

    if (this.doctorRecord && this.doctorRecord.report.target.readsReliable === false) {
      const target = this.doctorRecord.report.target;
      const detail = target.reason ? `: ${target.reason}` : "";
      return {
        ok: false,
        sha256: hash.sha256,
        reason: `flash refused: the latest doctor marked the target as unreliable (${target.state}${detail}). Do not flash from an unverified target: rerun doctor after fixing the probe/flash mismatch and wait for target.readsReliable=true.`,
      };
    }

    return { ok: true, sha256: hash.sha256 };
  }

  snapshot(): McpRunRecord {
    return {
      id: this.id,
      startedAt: this.startedAt,
      profile: this.profile,
      criteria: this.criteria.map((criterion) => ({ ...criterion })),
      evidence: this.evidenceList.map((entry) => ({ ...entry })),
      memoryMapChecks: this.memoryMapRecords.map((entry) => ({ ...entry })),
      doctor: this.doctorRecord ? { ...this.doctorRecord } : null,
      artifact: this.latestArtifact,
    };
  }
}
