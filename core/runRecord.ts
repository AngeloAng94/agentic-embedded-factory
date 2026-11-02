/**
 * The run record: the only source of truth for a job's report.
 *
 * It deliberately stores **no** level and **no** verdict. Those are derived from
 * the evidence and from the profile criteria listed in the record, so a model
 * (or a bug) cannot set them. A record that tries to carry `level`/`status` is
 * rejected as invalid, which is what makes "a level without proof" impossible.
 */
import {
  deriveLevel,
  deriveStatus,
  VERIFICATION_LEVELS,
  type Evidence,
  type EvidenceActor,
  type VerificationLevel,
} from "./verificationLevels";
import type { Verdict } from "./types";

export interface RunChange {
  path: string;
  kind: "create" | "block-edit";
  block?: string | null;
}

/** A criterion from the product profile that must be evaluated on the target. */
export interface RunCriterion {
  /** Stable id referenced by `Evidence.criterion`. */
  id: string;
  description: string;
}

export interface RunRecordInput {
  id: string;
  createdAt: number;
  profile: string;
  request: string;
  branch: string | null;
  criteria: RunCriterion[];
  evidence: Evidence[];
  changes: RunChange[];
  /** Transcript of the model. Never authoritative, kept for auditing. */
  modelText?: string | null;
}

export interface RunRecord extends RunRecordInput {
  modelText: string | null;
}

export interface DerivedRunRecord {
  record: RunRecord;
  level: VerificationLevel | null;
  status: Verdict;
}

const ALLOWED_KEYS = new Set([
  "id",
  "createdAt",
  "profile",
  "request",
  "branch",
  "criteria",
  "evidence",
  "changes",
  "modelText",
]);

const DERIVED_KEYS = new Set(["level", "status", "verdict", "verification"]);
const ACTORS: EvidenceActor[] = ["agent", "tool", "human"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEvidence(raw: unknown, index: number, errors: string[]): Evidence | null {
  const at = `evidence[${index}]`;
  if (!isObject(raw)) {
    errors.push(`${at}: must be an object`);
    return null;
  }
  if (typeof raw.level !== "string" || !VERIFICATION_LEVELS.includes(raw.level as VerificationLevel)) {
    errors.push(`${at}.level: must be one of ${VERIFICATION_LEVELS.join(", ")}`);
  }
  if (raw.verification !== "REAL" && raw.verification !== "SIMULATED" && raw.verification !== "NOT_AVAILABLE") {
    errors.push(`${at}.verification: must be REAL, SIMULATED or NOT_AVAILABLE`);
  }
  if (raw.verdict !== "SUCCESS" && raw.verdict !== "FAILURE" && raw.verdict !== "UNKNOWN") {
    errors.push(`${at}.verdict: must be SUCCESS, FAILURE or UNKNOWN`);
  }
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) errors.push(`${at}.at: must be a timestamp`);
  if (typeof raw.actor !== "string" || !ACTORS.includes(raw.actor as EvidenceActor)) {
    errors.push(`${at}.actor: must be agent, tool or human`);
  }
  if (typeof raw.actorId !== "string" || raw.actorId.trim() === "") {
    errors.push(`${at}.actorId: must identify who produced the evidence`);
  }
  if (raw.tool !== null && typeof raw.tool !== "string") errors.push(`${at}.tool: must be a string or null`);
  if (raw.detail !== null && typeof raw.detail !== "string") errors.push(`${at}.detail: must be a string or null`);
  if (raw.criterion !== undefined && raw.criterion !== null && typeof raw.criterion !== "string") {
    errors.push(`${at}.criterion: must be a criterion id or null`);
  }
  if (raw.level === "observed" && (typeof raw.criterion !== "string" || raw.criterion === "")) {
    errors.push(`${at}.criterion: required on observed evidence`);
  }
  if (raw.level === "confirmed" && raw.actor !== "human") {
    errors.push(`${at}.actor: confirmed evidence must come from a human`);
  }
  if (errors.length > 0) return null;
  return {
    level: raw.level as VerificationLevel,
    verification: raw.verification as Evidence["verification"],
    verdict: raw.verdict as Evidence["verdict"],
    at: raw.at as number,
    actor: raw.actor as EvidenceActor,
    actorId: raw.actorId as string,
    tool: raw.tool as string | null,
    detail: raw.detail as string | null,
    criterion: (raw.criterion as string | null | undefined) ?? null,
  };
}

/**
 * Validates an untrusted record (parsed JSON, a file on disk) and derives its
 * level and status. Unknown keys are rejected: a stored `level` is exactly the
 * kind of claim this product must not accept.
 */
export function validateRunRecord(
  raw: unknown,
): { ok: true; level: VerificationLevel | null; status: Verdict; record: RunRecord } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["record: must be an object"] };

  for (const key of Object.keys(raw)) {
    if (DERIVED_KEYS.has(key)) {
      errors.push(`${key}: is derived from evidence and must not be stored`);
      continue;
    }
    if (!ALLOWED_KEYS.has(key)) errors.push(`${key}: unknown field`);
  }

  if (typeof raw.id !== "string" || raw.id.trim() === "") errors.push("id: must be a non-empty string");
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) {
    errors.push("createdAt: must be a timestamp");
  }
  if (typeof raw.profile !== "string" || raw.profile.trim() === "") {
    errors.push("profile: must name the product profile");
  }
  if (typeof raw.request !== "string") errors.push("request: must be a string");
  if (raw.branch !== null && typeof raw.branch !== "string") errors.push("branch: must be a string or null");
  if (raw.modelText !== undefined && raw.modelText !== null && typeof raw.modelText !== "string") {
    errors.push("modelText: must be a string or null");
  }

  const criteria: RunCriterion[] = [];
  if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) {
    errors.push("criteria: must be a non-empty array");
  } else {
    const seen = new Set<string>();
    raw.criteria.forEach((entry, index) => {
      const at = `criteria[${index}]`;
      if (!isObject(entry)) {
        errors.push(`${at}: must be an object`);
        return;
      }
      if (typeof entry.id !== "string" || entry.id.trim() === "") errors.push(`${at}.id: required`);
      else if (seen.has(entry.id)) errors.push(`${at}.id: duplicate ${entry.id}`);
      else seen.add(entry.id);
      if (typeof entry.description !== "string" || entry.description.trim() === "") {
        errors.push(`${at}.description: required`);
      }
      if (typeof entry.id === "string" && typeof entry.description === "string") {
        criteria.push({ id: entry.id, description: entry.description });
      }
    });
  }

  const evidence: Evidence[] = [];
  if (!Array.isArray(raw.evidence)) {
    errors.push("evidence: must be an array");
  } else {
    raw.evidence.forEach((entry, index) => {
      const parsed = validateEvidence(entry, index, errors);
      if (parsed) evidence.push(parsed);
    });
  }

  const changes: RunChange[] = [];
  if (!Array.isArray(raw.changes)) {
    errors.push("changes: must be an array");
  } else {
    raw.changes.forEach((entry, index) => {
      const at = `changes[${index}]`;
      if (!isObject(entry)) {
        errors.push(`${at}: must be an object`);
        return;
      }
      if (typeof entry.path !== "string" || entry.path.trim() === "") errors.push(`${at}.path: must be a path`);
      if (entry.kind !== "create" && entry.kind !== "block-edit") {
        errors.push(`${at}.kind: must be "create" or "block-edit"`);
      }
      if (entry.block !== undefined && entry.block !== null && typeof entry.block !== "string") {
        errors.push(`${at}.block: must be a string or null`);
      }
      if (entry.kind === "block-edit" && (typeof entry.block !== "string" || entry.block === "")) {
        errors.push(`${at}.block: required for a block-edit`);
      }
      changes.push({
        path: String(entry.path ?? ""),
        kind: entry.kind === "block-edit" ? "block-edit" : "create",
        block: typeof entry.block === "string" ? entry.block : null,
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const record: RunRecord = {
    id: raw.id as string,
    createdAt: raw.createdAt as number,
    profile: raw.profile as string,
    request: raw.request as string,
    branch: raw.branch as string | null,
    criteria,
    evidence,
    changes,
    modelText: (raw.modelText as string | null | undefined) ?? null,
  };

  return {
    ok: true,
    record,
    level: deriveLevel(evidence, criteria.map((criterion) => criterion.id)),
    status: deriveStatus(
      evidence,
      deriveLevel(evidence, criteria.map((criterion) => criterion.id)),
    ),
  };
}

/** Builds a record from trusted inputs, deriving level/status on the spot. */
export function finalizeRunRecord(input: RunRecordInput): DerivedRunRecord {
  const record: RunRecord = { ...input, modelText: input.modelText ?? null };
  const level = deriveLevel(
    record.evidence,
    record.criteria.map((criterion) => criterion.id),
  );
  return { record, level, status: deriveStatus(record.evidence, level) };
}
