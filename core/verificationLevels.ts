/**
 * Verification levels.
 *
 *   written → compiled → flashed → observed → confirmed
 *
 * A level is reached ONLY when the run record contains evidence for it, and that
 * evidence is `REAL` + `SUCCESS`. Levels are consecutive: a flash without a
 * compile does not move the state.
 *
 * `observed` is stricter: every acceptance criterion declared by the product
 * profile must have its own REAL, passing evidence. One failed or unmeasured
 * criterion blocks the level, because "it ran" is not "it met the spec".
 *
 * `confirmed` additionally requires an event whose actor is a human: no tool and
 * no agent can award it.
 */
import type { Verification, Verdict } from "./types";

export const VERIFICATION_LEVELS = [
  "written",
  "compiled",
  "flashed",
  "observed",
  "confirmed",
] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** Who produced the evidence. `confirmed` accepts only "human". */
export type EvidenceActor = "agent" | "tool" | "human";

export interface Evidence {
  level: VerificationLevel;
  verification: Verification;
  verdict: Verdict;
  /** When the evidence was produced (epoch ms). */
  at: number;
  actor: EvidenceActor;
  /** Concrete identity: tool name, model id, person id. */
  actorId: string;
  tool: string | null;
  detail: string | null;
  /** Required on `observed` evidence: which profile criterion it evaluates. */
  criterion?: string | null;
}

export function levelRank(level: VerificationLevel): number {
  return VERIFICATION_LEVELS.indexOf(level);
}

/** True only when this single piece of evidence can back this level. */
export function qualifies(evidence: Evidence, level: VerificationLevel): boolean {
  if (evidence.level !== level) return false;
  if (evidence.verification !== "REAL") return false;
  if (evidence.verdict !== "SUCCESS") return false;
  if (level === "confirmed" && evidence.actor !== "human") return false;
  return true;
}

function criteriaSatisfied(evidence: readonly Evidence[], requiredCriteria: readonly string[]): boolean {
  if (requiredCriteria.length === 0) return false;
  return requiredCriteria.every((id) =>
    evidence.some(
      (entry) => entry.level === "observed" && entry.criterion === id && qualifies(entry, "observed"),
    ),
  );
}

/**
 * Highest consecutive level backed by evidence; null when nothing was proven.
 * `requiredCriteria` are the profile criterion ids: if any is missing or failed,
 * `observed` (and therefore `confirmed`) is unreachable.
 */
export function deriveLevel(
  evidence: readonly Evidence[],
  requiredCriteria: readonly string[] = [],
): VerificationLevel | null {
  let reached: VerificationLevel | null = null;
  for (const level of VERIFICATION_LEVELS) {
    if (level === "observed") {
      if (!criteriaSatisfied(evidence, requiredCriteria)) break;
      reached = level;
      continue;
    }
    if (!evidence.some((entry) => qualifies(entry, level))) break;
    reached = level;
  }
  return reached;
}

/**
 * Overall run status, derived from evidence only.
 *
 * SUCCESS means "verified on the target" (observed or confirmed), not "the code
 * compiled": compiled-only runs are UNKNOWN by design.
 */
export function deriveStatus(
  evidence: readonly Evidence[],
  level: VerificationLevel | null = deriveLevel(evidence, []),
): Verdict {
  if (evidence.some((entry) => entry.verdict === "FAILURE")) return "FAILURE";
  if (level === "observed" || level === "confirmed") return "SUCCESS";
  return "UNKNOWN";
}

/** Human-readable sentence: what was proven and what was not. */
export function describeLevel(level: VerificationLevel | null): string {
  if (level === null) return "nothing was proven: no evidence in the run record";
  const missing = VERIFICATION_LEVELS[VERIFICATION_LEVELS.indexOf(level) + 1] ?? null;
  return missing
    ? `proven up to ${level}; ${missing} has no evidence yet`
    : "proven up to confirmed (human sign-off)";
}
