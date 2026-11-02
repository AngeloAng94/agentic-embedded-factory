/**
 * On-target test (`test_su_target: pass`).
 *
 * The check itself always depends on hardware: a serial exchange, a probe
 * command or a firmware self-test. Until an orchestrator wires one, the honest
 * answer is NOT_AVAILABLE. This function never returns `passed: true` on its own.
 */
import { notAvailable, type ToolOutcome } from "../core/toolResult";

export type TargetTestRunner = () => Promise<ToolOutcome<{ passed: boolean }>>;

export async function runTargetTest(
  runner: TargetTestRunner | null,
): Promise<ToolOutcome<{ passed: boolean }>> {
  if (!runner) {
    return notAvailable(
      "no on-target test is configured: the orchestrator must wire it to serial output or a probe",
    );
  }
  return runner();
}
