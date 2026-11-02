/**
 * Verification levels.
 *
 *   written → compiled → flashed → observed → confirmed
 *
 * A level is reached ONLY when the run record contains evidence for it, and that
 * evidence is `REAL` + `SUCCESS`. `confirmed` additionally requires a human:
 * no tool can award it. Levels are consecutive: a flash without a compile does
 * not move the state, because the chain would be a claim with a hole in it.
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

export interface Evidence {
  level: VerificationLevel;
  verification: Verification;
  verdict: Verdict;
  /** When the evidence was produced (epoch ms). */
  at: number;
  /** Executable/tool that produced it, or `human` for a confirmation. */
  tool: string | null;
  detail: string | null;
  /** Required for `confirmed`: a person, not a tool. */
  source?: "tool" | "human";
}

export function levelRank(level: VerificationLevel): number {
  return VERIFICATION_LEVELS.indexOf(level);
}

/** True only when this single piece of evidence can back this level. */
export function qualifies(evidence: Evidence, level: VerificationLevel): boolean {
  if (evidence.level !== level) return false;
  if (evidence.verification !== "REAL") return false;
  if (evidence.verdict !== "SUCCESS") return false;
  if (level === "confirmed" && evidence.source !== "human") return false;
  return true;
}

/** Highest consecutive level backed by evidence; null when nothing was proven. */
export function deriveLevel(evidence: readonly Evidence[]): VerificationLevel | null {
  let reached: VerificationLevel | null = null;
  for (const level of VERIFICATION_LEVELS) {
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
  level: VerificationLevel | null = deriveLevel(evidence),
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
