/**
 * `memory_map_check`.
 *
 * Reads the real ELF and compares its allocated sections with the memory the
 * profile declares:
 *
 *   - FLASH usage = every allocated section that has file bytes (.text, .rodata,
 *     .data, .vectors, …)
 *   - RAM usage   = every allocated writable section (.data, .bss, reserved
 *     stack/heap sections, …)
 *   - no two allocated sections may claim the same address range
 *   - the entry point must fall inside an executable section
 *
 * No external size/readelf tool is needed: the numbers come from the ELF bytes.
 * If the ELF has no section headers (stripped image) the check is NOT_AVAILABLE
 * instead of guessing from the file size. Over budget is a FAILURE, never a
 * warning.
 */
import {
  readElfImage,
  SHF_ALLOC,
  SHF_EXECINSTR,
  SHF_WRITE,
  SHT_NOBITS,
  type ElfSection,
} from "../core/elfImage";
import type { ProductProfile } from "../core/profile";
import {
  invalidRequest,
  notAvailable,
  toolOk,
  type ToolOutcome,
} from "../core/toolResult";

export type MemoryCheckStatus = "PASS" | "FAIL" | "NOT_AVAILABLE";

export interface MemoryMapCheck {
  id: string;
  label: string;
  status: MemoryCheckStatus;
  detail: string;
}

export interface MemoryMapReport {
  artifact: string;
  elfClass: "ELF32" | "ELF64";
  entry: string;
  flashUsed: number;
  flashTotal: number;
  ramUsed: number;
  ramTotal: number;
  checks: MemoryMapCheck[];
  verdict: "SUCCESS" | "FAILURE" | "UNKNOWN";
}

function hex(address: number): string {
  return `0x${address.toString(16)}`;
}

function bytes(value: number): string {
  return `${value} B`;
}

function usage(used: number, total: number): string {
  if (total <= 0) return bytes(used);
  const percent = ((used / total) * 100).toFixed(1);
  return `${bytes(used)} / ${bytes(total)} (${percent}%)`;
}

function findOverlap(sections: readonly ElfSection[]): [ElfSection, ElfSection] | null {
  const sorted = [...sections].sort((left, right) => left.address - right.address);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.address + previous.size > current.address) return [previous, current];
  }
  return null;
}

function verdictOf(checks: readonly MemoryMapCheck[]): MemoryMapReport["verdict"] {
  if (checks.some((check) => check.status === "FAIL")) return "FAILURE";
  if (checks.some((check) => check.status === "NOT_AVAILABLE")) return "UNKNOWN";
  return "SUCCESS";
}

export function checkMemoryMap(
  profile: ProductProfile,
  options: { artifactPath: string },
): ToolOutcome<MemoryMapReport> {
  if (!options.artifactPath || options.artifactPath.trim() === "") {
    return invalidRequest("memory_map_check needs the path of the built ELF");
  }

  const parsed = readElfImage(options.artifactPath);
  if (!parsed.ok) {
    return notAvailable(`cannot check the memory map: ${parsed.reason}`);
  }
  const image = parsed.image;

  const allocated = image.sections.filter(
    (section) => (section.flags & SHF_ALLOC) !== 0 && section.size > 0,
  );
  if (allocated.length === 0) {
    return notAvailable(
      "the ELF has no allocated sections (stripped image?): FLASH/RAM usage cannot be measured",
    );
  }

  const flashSections = allocated.filter((section) => section.type !== SHT_NOBITS);
  const ramSections = allocated.filter((section) => (section.flags & SHF_WRITE) !== 0);
  const flashUsed = flashSections.reduce((sum, section) => sum + section.size, 0);
  const ramUsed = ramSections.reduce((sum, section) => sum + section.size, 0);
  const flashTotal = profile.chip.flash_kb * 1024;
  const ramTotal = profile.chip.ram_kb * 1024;

  const checks: MemoryMapCheck[] = [];

  checks.push({
    id: "flash.fits",
    label: "FLASH fits the profile",
    status: flashUsed <= flashTotal ? "PASS" : "FAIL",
    detail:
      flashUsed <= flashTotal
        ? usage(flashUsed, flashTotal)
        : `uses ${bytes(flashUsed)} but the profile declares ${bytes(flashTotal)}`,
  });

  checks.push({
    id: "ram.fits",
    label: "RAM fits the profile",
    status: ramUsed <= ramTotal ? "PASS" : "FAIL",
    detail:
      ramUsed <= ramTotal
        ? usage(ramUsed, ramTotal)
        : `uses ${bytes(ramUsed)} but the profile declares ${bytes(ramTotal)}`,
  });

  const overlap = findOverlap(allocated);
  checks.push({
    id: "sections.overlap",
    label: "sections do not overlap",
    status: overlap === null ? "PASS" : "FAIL",
    detail:
      overlap === null
        ? `${allocated.length} allocated section(s) checked`
        : `${overlap[0].name || "(unnamed)"} ${hex(overlap[0].address)}+${bytes(overlap[0].size)} overlaps ${overlap[1].name || "(unnamed)"} at ${hex(overlap[1].address)}`,
  });

  const executable = allocated.filter((section) => (section.flags & SHF_EXECINSTR) !== 0);
  if (executable.length === 0) {
    checks.push({
      id: "entry.executable",
      label: "entry point is executable",
      status: "NOT_AVAILABLE",
      detail: "the ELF has no executable allocated section to place the entry point in",
    });
  } else {
    const inside = executable.some(
      (section) =>
        image.entry >= section.address && image.entry < section.address + section.size,
    );
    checks.push({
      id: "entry.executable",
      label: "entry point is executable",
      status: inside ? "PASS" : "FAIL",
      detail: inside
        ? `${hex(image.entry)} lies in an executable section`
        : `${hex(image.entry)} is outside every executable section`,
    });
  }

  return toolOk({
    artifact: options.artifactPath,
    elfClass: image.class,
    entry: hex(image.entry),
    flashUsed,
    flashTotal,
    ramUsed,
    ramTotal,
    checks,
    verdict: verdictOf(checks),
  });
}
