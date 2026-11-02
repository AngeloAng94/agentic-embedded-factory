/**
 * Every tool answers with this shape.
 *
 * `verification` is REAL only when a process actually ran; SIMULATED exists for
 * test doubles and can never become evidence. When a tool is absent we return
 * NOT_AVAILABLE with the reason, never a fake success.
 */

export type ToolErrorCode = "NOT_AVAILABLE" | "FAILED" | "INVALID_PROFILE" | "INVALID_REQUEST";

export type ToolOutcome<T> =
  | { ok: true; verification: "REAL" | "SIMULATED"; value: T }
  | { ok: false; code: ToolErrorCode; reason: string };

export function toolOk<T>(value: T, verification: "REAL" | "SIMULATED" = "REAL"): ToolOutcome<T> {
  return { ok: true, verification, value };
}

export function notAvailable<T>(reason: string): ToolOutcome<T> {
  return { ok: false, code: "NOT_AVAILABLE", reason };
}

export function toolFailed<T>(reason: string): ToolOutcome<T> {
  return { ok: false, code: "FAILED", reason };
}

export function invalidProfile<T>(reason: string): ToolOutcome<T> {
  return { ok: false, code: "INVALID_PROFILE", reason };
}

export function invalidRequest<T>(reason: string): ToolOutcome<T> {
  return { ok: false, code: "INVALID_REQUEST", reason };
}
