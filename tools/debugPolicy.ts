/**
 * GDB command policy.
 *
 * `debug` is allowed to control execution (breakpoints, halt/continue,
 * detach), read memory/registers, and write RAM or registers. It is not a second
 * flash path: `load`, `restore` to FLASH, programming `monitor` commands and
 * OpenOCD/probe-rs flash commands are rejected before GDB starts.
 *
 * Address handling is intentionally conservative. A write is allowed only when
 * the command contains an explicit numeric address inside a declared RAM
 * region. Symbolic or computed addresses (`&foo`, `$sp+4`, …) are refused
 * because the policy cannot prove they do not point at FLASH.
 */
import type { ProductProfile } from "../core/profile";
import { invalidRequest, toolOk, type ToolOutcome } from "../core/toolResult";

const READ_COMMANDS = new Set([
  "x",
  "info",
  "p",
  "print",
  "disassemble",
  "list",
  "bt",
  "backtrace",
  "frame",
  "thread",
  "registers",
  "show",
  "dump",
  "compare-sections",
]);

const BREAKPOINT_COMMANDS = new Set([
  "break",
  "b",
  "tbreak",
  "hbreak",
  "thbreak",
  "rbreak",
  "delete",
  "d",
  "disable",
  "enable",
  "condition",
  "ignore",
  "clear",
]);

const CONTROL_COMMANDS = new Set([
  "interrupt",
  "halt",
  "continue",
  "c",
  "detach",
]);

const FIRMWARE_WRITE_COMMANDS = new Set([
  "load",
  "flash",
  "program",
  "download",
]);

const MONITOR_PROGRAMMING = /^(program|program_image|flash|erase|write|write_image|load|load_image|restore|download|mass_erase|unlock|protect)\b/i;

function hex(address: number): string {
  return `0x${address.toString(16)}`;
}

function parseAddress(token: string): number | null {
  const cleaned = token.trim();
  if (/^0x[0-9a-f]+$/i.test(cleaned)) {
    const parsed = Number.parseInt(cleaned.slice(2), 16);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffff_ffff ? parsed : null;
  }
  if (/^\d+$/.test(cleaned)) {
    const parsed = Number.parseInt(cleaned, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffff_ffff ? parsed : null;
  }
  return null;
}

function regionAt(profile: ProductProfile, address: number) {
  return profile.chip.regioni.find(
    (region) => address >= region.origine && address < region.origine + region.dimensione,
  );
}

function checkMemoryAddress(
  profile: ProductProfile,
  address: number,
  command: string,
): string | null {
  const region = regionAt(profile, address);
  if (region?.tipo === "flash") {
    return `debug refused: "${command}" writes ${hex(address)} inside FLASH region "${region.nome}"; firmware writes must go through flash, not debug.`;
  }
  if (region?.tipo === "ram") return null;
  return `debug refused: "${command}" writes ${hex(address)}, which is outside every declared RAM region; the policy cannot prove it is not FLASH.`;
}

function exactAddress(text: string): number | null {
  // One cast and one dereference are allowed around the literal; arithmetic or
  // symbolic expressions are not, because they could resolve into FLASH.
  const lhs = text.split("=")[0]!.trim();
  const match = /^(?:\([^)]*\)\s*)?(?:\*\s*)?(0x[0-9a-f]+|\d+)\s*$/i.exec(lhs);
  return match ? parseAddress(match[1]!) : null;
}

function validateSet(profile: ProductProfile, segment: string): string | null {
  const rest = segment.slice(3).trim();
  if (rest === "") return `debug refused: "set" needs an explicit register or RAM address.`;

  // Register writes (set $r0 = ..., set $pc = ...) are allowed.
  if (/^\$[a-z_][a-z0-9_]*/i.test(rest)) return null;

  let addressText: string | null = null;
  if (rest.startsWith("{")) {
    const close = rest.indexOf("}");
    if (close === -1) {
      return `debug refused: "${segment}" has a malformed memory cast.`;
    }
    addressText = rest.slice(close + 1).trim();
  } else if (rest.startsWith("*")) {
    addressText = rest.slice(1).trim();
  } else {
    // `set var x = ...` and GDB settings do not provide a provable RAM address.
    return `debug refused: "${segment}" does not name a register or an explicit RAM address; use set {type}0x... or set $register.`;
  }

  const address = exactAddress(addressText);
  if (address === null) {
    return `debug refused: "${segment}" does not contain an explicit numeric address; the policy cannot prove it is RAM, not FLASH.`;
  }
  return checkMemoryAddress(profile, address, segment);
}

function validateRestore(profile: ProductProfile, segment: string): string | null {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return `debug refused: "restore" needs a file and an explicit RAM address; use flash for firmware images.`;
  }
  const address = parseAddress(tokens[tokens.length - 1]!);
  if (address === null) {
    return `debug refused: "${segment}" has no explicit numeric address; restore is only allowed into a declared RAM region.`;
  }
  return checkMemoryAddress(profile, address, segment);
}

function validateMonitor(profile: ProductProfile, segment: string): string | null {
  const rest = segment.slice("monitor".length).trim();
  const [sub = "", ...args] = rest.split(/\s+/).filter(Boolean);
  const lower = sub.toLowerCase();

  if (lower === "reset" || lower === "halt" || lower === "resume" || lower === "reg" || lower === "info") {
    return null;
  }
  if (lower === "mdw" || lower === "mdb" || lower === "mdh") return null;
  if (lower === "mww" || lower === "mwb" || lower === "mwh") {
    const address = parseAddress(args[0] ?? "");
    if (address === null) {
      return `debug refused: "${segment}" needs an explicit numeric address.`;
    }
    return checkMemoryAddress(profile, address, segment);
  }
  if (lower === "flash") {
    const action = (args[0] ?? "").toLowerCase();
    if (action === "banks" || action === "list" || action === "info") return null;
    return `debug refused: "${segment}" is a FLASH programming command; use flash instead.`;
  }
  if (MONITOR_PROGRAMMING.test(rest)) {
    return `debug refused: "${segment}" is a FLASH programming command; use flash instead.`;
  }
  return `debug refused: "${segment}" is not one of the allowed monitor operations (reset, halt, resume, register/memory reads, RAM writes).`;
}

function validateSegment(profile: ProductProfile, segment: string): string | null {
  const first = segment.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (first === "") return null;

  if (FIRMWARE_WRITE_COMMANDS.has(first)) {
    return `debug refused: "${segment}" writes firmware; use the flash tool, which checks the memory map and SHA-256 first.`;
  }
  if (first === "restore") return validateRestore(profile, segment);
  if (first === "set") return validateSet(profile, segment);
  if (first === "monitor") return validateMonitor(profile, segment);
  // GDB puts format suffixes directly on some read commands: x/4xb, p/x, …
  if (/^(x|p|print|disassemble|bt)\//.test(first)) return null;
  if (READ_COMMANDS.has(first) || BREAKPOINT_COMMANDS.has(first) || CONTROL_COMMANDS.has(first)) {
    return null;
  }

  return `debug refused: "${segment}" is outside the allowed operations (breakpoints, halt/continue, RAM/register reads and writes, detach).`;
}

/**
 * Splits a command on `;`/newlines and validates every part, so a permitted
 * read cannot smuggle a `load` or a FLASH write into the same `-ex` argument.
 */
export function validateDebugCommands(
  profile: ProductProfile,
  commands: readonly string[],
): ToolOutcome<string[]> {
  if (commands.length === 0) {
    return invalidRequest("debug needs at least one explicit GDB command");
  }

  for (const command of commands) {
    const parts = command
      .split(/[;\n]/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (parts.length === 0) {
      return invalidRequest("debug received an empty command");
    }
    for (const part of parts) {
      const reason = validateSegment(profile, part);
      if (reason !== null) return invalidRequest(reason);
    }
  }

  return toolOk([...commands]);
}
