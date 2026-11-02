/**
 * FAKE hardware runner, for tests only.
 *
 * Every answer is marked SIMULATED and the object says it is fake. It exists so
 * tests can exercise flows without a board; it must never be accepted as
 * evidence of anything that happened on hardware.
 */
import { toolOk, type ToolOutcome } from "../../core/toolResult";

export const FAKE_RUNNER = {
  kind: "FAKE",
  simulated: true,
  device: "DEMO-BOARD-01 (simulated)",
} as const;

export function fakeBuild(): ToolOutcome<{ exitCode: number; stdout: string }> {
  return toolOk({ exitCode: 0, stdout: "[fake] build ok\n" }, "SIMULATED");
}

export function fakeFlash(): ToolOutcome<{ exitCode: number }> {
  return toolOk({ exitCode: 0 }, "SIMULATED");
}

export function fakeRead(): ToolOutcome<{ bytes: number[]; stable: boolean }> {
  return toolOk({ bytes: [0xde, 0xad], stable: true }, "SIMULATED");
}
