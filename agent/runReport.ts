/**
 * Human-readable report derived from a `RunRecord`.
 *
 * The report ends with the acceptance-criterion table; there is no prose after
 * it. A criterion is PASS only when its observed evidence is REAL and SUCCESS,
 * so a simulated or missing observation can never look like a pass.
 */
import {
  deriveLevel,
  deriveStatus,
  type VerificationLevel,
} from "../core/verificationLevels";
import { runRecordReason, type RunRecord } from "../core/runRecord";
import type { Verdict } from "../core/types";

export type CriterionOutcomeStatus = "PASS" | "FAIL" | "NOT_EVALUATED";

export interface CriterionOutcome {
  id: string;
  description: string;
  status: CriterionOutcomeStatus;
  detail: string;
}

export function criterionOutcomesFromRecord(record: RunRecord): CriterionOutcome[] {
  if (record.criteria.length === 0) {
    return [
      {
        id: "(none)",
        description: "nessun criterio dichiarato nel profilo",
        status: "NOT_EVALUATED",
        detail:
          "Il profilo non dichiara criteri: il livello massimo raggiungibile è compiled e il verdetto resta UNKNOWN.",
      },
    ];
  }

  return record.criteria.map((criterion) => {
    const observed = record.evidence
      .filter((entry) => entry.level === "observed" && entry.criterion === criterion.id)
      .at(-1);
    if (!observed) {
      return {
        id: criterion.id,
        description: criterion.description,
        status: "NOT_EVALUATED",
        detail: "Nessuna osservazione reale per questo criterio.",
      };
    }
    if (observed.verdict === "FAILURE") {
      return {
        id: criterion.id,
        description: criterion.description,
        status: "FAIL",
        detail: observed.detail ?? "Il criterio è fallito.",
      };
    }
    if (observed.verdict !== "SUCCESS" || observed.verification !== "REAL") {
      return {
        id: criterion.id,
        description: criterion.description,
        status: "NOT_EVALUATED",
        detail:
          observed.detail ??
          (observed.verification !== "REAL"
            ? "L'osservazione non è REAL: non può essere un esito."
            : "Il criterio non è stato valutato."),
      };
    }
    return {
      id: criterion.id,
      description: criterion.description,
      status: "PASS",
      detail: observed.detail ?? "Il criterio è passato su una misura reale.",
    };
  });
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function label(status: CriterionOutcomeStatus): string {
  if (status === "PASS") return "PASS";
  if (status === "FAIL") return "FAIL";
  return "NON VALUTATO";
}

export function formatRunReport(
  record: RunRecord,
  level: VerificationLevel | null = deriveLevel(
    record.evidence,
    record.criteria.map((criterion) => criterion.id),
  ),
  status: Verdict = deriveStatus(record.evidence, level),
  reason: string = runRecordReason(record, level, status),
): string {
  const outcomes = criterionOutcomesFromRecord(record);
  const lines: string[] = [
    `# Run ${record.id}`,
    "",
    `- Profilo: ${record.profile}`,
    `- Richiesta: ${record.request}`,
    `- Livello: ${level ?? "nessuno"}`,
    `- Verdetto: ${status}`,
    `- Motivo: ${reason}`,
    "",
    "## Evidenze",
    "",
  ];

  if (record.evidence.length === 0) {
    lines.push("- Nessuna evidenza registrata.");
  } else {
    for (const entry of record.evidence) {
      lines.push(
        `- ${entry.level}: ${entry.verification} · ${entry.verdict} · ${entry.actorId}${
          entry.criterion ? ` · criterion=${entry.criterion}` : ""
        }${entry.detail ? ` — ${entry.detail}` : ""}`,
      );
    }
  }

  lines.push("");
  lines.push("## Criteri di accettazione");
  lines.push("");
  lines.push("| Criterio di accettazione | Esito |");
  lines.push("| --- | --- |");
  for (const outcome of outcomes) {
    lines.push(`| ${cell(outcome.description)} (\`${cell(outcome.id)}\`) | ${label(outcome.status)} |`);
  }
  return lines.join("\n");
}
