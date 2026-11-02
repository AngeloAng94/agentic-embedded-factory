/**
 * Flash adapters, selected by `profile.flash.tool`.
 *
 *   STM32_Programmer_CLI  -c port=SWD|JTAG -w <artifact> -v
 *   openocd               -f interface/stlink.cfg|jlink.cfg -f target/<target>.cfg -c "program … verify reset exit"
 *   probe-rs              download --chip <target> <artifact>
 *   west                  west flash -d build
 *
 * Parameters come from the profile. A missing binary is NOT_AVAILABLE, never a
 * pretend flash.
 */
import type { ProductProfile } from "../core/profile";
import { invalidProfile, notAvailable, toolOk, type ToolOutcome } from "../core/toolResult";
import {
  runCommand,
  systemResolver,
  type BinaryResolver,
  type ExecOptions,
  type ExecResult,
} from "./exec";

export function planFlash(
  profile: ProductProfile,
  artifact: string,
  options: { resolve?: BinaryResolver } = {},
): ToolOutcome<string[]> {
  const resolve = options.resolve ?? systemResolver;
  if (artifact.trim() === "") return invalidProfile("flash needs the artifact path produced by the build");

  const { tool, interfaccia, target } = profile.flash;
  let argv: string[];

  if (tool === "STM32_Programmer_CLI") {
    argv = [tool, "-c", `port=${interfaccia === "swd" ? "SWD" : "JTAG"}`, "-w", artifact, "-v"];
  } else if (tool === "openocd") {
    if (!target) return invalidProfile("flash.tool is openocd but flash.target is missing");
    const interfaceConfig = interfaccia === "swd" ? "interface/stlink.cfg" : "interface/jlink.cfg";
    argv = [
      "openocd",
      "-f",
      interfaceConfig,
      "-f",
      `target/${target}.cfg`,
      "-c",
      `program ${artifact} verify reset exit`,
    ];
  } else if (tool === "probe-rs") {
    if (!target) return invalidProfile("flash.tool is probe-rs but flash.target is missing");
    argv = ["probe-rs", "download", "--chip", target, artifact];
  } else {
    argv = ["west", "flash", "-d", "build"];
  }

  if (!resolve(argv[0]!)) return notAvailable(`"${argv[0]}" is not installed or not in PATH`);
  return toolOk(argv);
}

export function runFlash(
  profile: ProductProfile,
  artifact: string,
  options: ExecOptions & { resolve?: BinaryResolver } = {},
): ToolOutcome<ExecResult> {
  const plan = planFlash(profile, artifact, options);
  if (!plan.ok) return plan;
  return toolOk(runCommand(plan.value, options));
}
