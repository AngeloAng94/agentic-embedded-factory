/**
 * Artifact validation (Node only).
 *
 * A build is only useful if the firmware image it produced really exists and is
 * really what it claims to be. This module reads the bytes: size, sha256, magic
 * number and — for ELF images — the ELF header itself, decoded without any
 * external tool so it works on a bare machine.
 *
 * It also parses the two real evidence sources for flash/RAM usage:
 *  - the Zephyr linker's "Memory region ... Used Size ... Region Size" report
 *  - the binutils `size` output (text/data/bss)
 *
 * Nothing here ever invents a value: a missing file returns null.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ArtifactFormat, ArtifactInfo, ElfHeader, MemoryUsage } from "./types";

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // \x7f E L F
const UF2_MAGIC = [0x55, 0x46, 0x32, 0x0a]; // "UF2\n"

const ELF_CLASSES: Record<number, string> = {
  1: "ELF32",
  2: "ELF64",
};

const ELF_DATA: Record<number, string> = {
  1: "little",
  2: "big",
};

const ELF_TYPES: Record<number, string> = {
  0: "NONE",
  1: "REL",
  2: "EXEC",
  3: "DYN",
  4: "CORE",
};

/** e_machine values that Zephyr actually targets, plus the common hosts. */
const ELF_MACHINES: Record<number, string> = {
  2: "SPARC",
  3: "x86",
  8: "MIPS",
  20: "PowerPC",
  21: "PowerPC64",
  40: "ARM",
  62: "x86_64",
  83: "AVR",
  93: "ARC",
  106: "Blackfin",
  113: "NIOS-II",
  183: "AArch64",
  188: "TI C6000",
  220: "Xtensa",
  243: "RISC-V",
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) return false;
  }
  return true;
}

/** Detects the format from the real bytes first, then from the extension. */
export function detectFormat(fileName: string, bytes: Uint8Array): ArtifactFormat {
  if (startsWith(bytes, ELF_MAGIC)) return "elf";
  if (startsWith(bytes, UF2_MAGIC)) return "uf2";
  if (bytes.length > 0 && bytes[0] === 0x3a) {
    // Intel HEX: ':' followed by hex digits
    const head = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
    if (/^:[0-9A-Fa-f]{10}/.test(head)) return "hex";
  }
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".elf") return "elf";
  if (ext === ".bin") return "bin";
  if (ext === ".hex") return "hex";
  if (ext === ".uf2") return "uf2";
  if (ext === ".map") return "map";
  if (ext === ".txt" || ext === ".md") return "text";
  return "other";
}

/** Decodes the ELF header straight from the file. No readelf/objdump needed. */
export function parseElfHeader(bytes: Uint8Array): ElfHeader | null {
  if (!startsWith(bytes, ELF_MAGIC)) return null;
  if (bytes.length < 24) return null;

  const elfClass = bytes[4] ?? 0;
  const data = bytes[5] ?? 0;
  const little = data !== 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const type = view.getUint16(16, little);
  const machine = view.getUint16(18, little);

  let entry: string | null = null;
  try {
    entry = little ? `0x${view.getBigUint64(24, true).toString(16)}` : `0x${view.getBigUint64(24, false).toString(16)}`;
  } catch {
    entry = null;
  }

  const architecture = ELF_MACHINES[machine] ?? null;
  return {
    class: ELF_CLASSES[elfClass] ?? null,
    endianness: ELF_DATA[data] ?? null,
    type: ELF_TYPES[type] ?? `0x${type.toString(16)}`,
    machine: machine in ELF_MACHINES ? `${ELF_MACHINES[machine]} (e_machine=${machine})` : `e_machine=${machine}`,
    entry,
    architecture,
  };
}

/** "41236 B", "256 KB", "1 MB", "2 GB", "1.5 KB" -> bytes. */
export function parseHumanSize(value: string): number | null {
  const match = /([0-9]+(?:\.[0-9]+)?)\s*([KMG])?B?/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? "").toUpperCase();
  const factor = unit === "K" ? 1024 : unit === "M" ? 1024 * 1024 : unit === "G" ? 1024 * 1024 * 1024 : 1;
  return Math.round(amount * factor);
}

/**
 * Parses the Zephyr linker report:
 *
 *   Memory region         Used Size  Region Size  %age Used
 *              FLASH:       41236 B       256 KB     15.73%
 *                RAM:        9536 B        64 KB     14.55%
 */
export function parseMemoryReport(stdout: string): MemoryUsage | null {
  if (typeof stdout !== "string" || !stdout.includes("Memory region")) return null;

  const line = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s+([0-9.]+\s*[KMG]?B?)\s+([0-9.]+\s*[KMG]?B?)\s+([0-9.]+)\s*%\s*$/;
  const evidence: string[] = [];
  let flashUsed: number | null = null;
  let flashTotal: number | null = null;
  let ramUsed: number | null = null;
  let ramTotal: number | null = null;

  for (const raw of stdout.split("\n")) {
    const match = line.exec(raw);
    if (!match) continue;
    const name = (match[1] ?? "").toUpperCase();
    const used = parseHumanSize(match[2] ?? "");
    const total = parseHumanSize(match[3] ?? "");
    evidence.push(raw.replace(/\s+$/, ""));
    if (name === "FLASH" || name === "ROM") {
      flashUsed = used;
      flashTotal = total;
    } else if (name === "RAM") {
      ramUsed = used;
      ramTotal = total;
    }
  }

  if (flashUsed === null && ramUsed === null) return null;
  return {
    flashUsed,
    flashTotal,
    ramUsed,
    ramTotal,
    sections: null,
    report: evidence.join("\n"),
  };
}

/**
 * Parses binutils `size` output:
 *
 *    text    data     bss     dec     hex filename
 *    1234      56     789    2079     81f build/zephyr/zephyr.elf
 */
export function parseGnuSize(
  stdout: string,
): { text: number; data: number; bss: number } | null {
  if (typeof stdout !== "string") return null;
  const numeric = /^\s*(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+([0-9a-fA-F]+)\s+\S+\s*$/;
  let last: { text: number; data: number; bss: number } | null = null;
  for (const raw of stdout.split("\n")) {
    const match = numeric.exec(raw);
    if (!match) continue;
    last = {
      text: Number((match[1] ?? "0").replace(/,/g, "")),
      data: Number((match[2] ?? "0").replace(/,/g, "")),
      bss: Number((match[3] ?? "0").replace(/,/g, "")),
    };
  }
  return last;
}

/** Combines the linker report and the `size` sections into one honest object. */
export function mergeMemoryUsage(
  report: MemoryUsage | null,
  sections: { text: number; data: number; bss: number } | null,
): MemoryUsage | null {
  if (!report && !sections) return null;
  if (!sections) return report;
  const base: MemoryUsage = report ?? {
    flashUsed: sections.text + sections.data,
    flashTotal: null,
    ramUsed: sections.data + sections.bss,
    ramTotal: null,
    sections: null,
    report: null,
  };
  return { ...base, sections };
}

/** Reads one file and returns its validated metadata, or null if unreadable. */
export function inspectArtifactFile(absolutePath: string, relativePath: string): ArtifactInfo | null {
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) return null;
    const bytes = new Uint8Array(readFileSync(absolutePath));
    return {
      path: relativePath.split(path.sep).join("/"),
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      format: detectFormat(relativePath, bytes),
      elf: parseElfHeader(bytes),
    };
  } catch {
    return null;
  }
}

/** Inspects project-relative artifact paths; unreadable entries are dropped. */
export function inspectArtifacts(root: string, relativePaths: string[]): ArtifactInfo[] {
  const infos: ArtifactInfo[] = [];
  for (const relativePath of relativePaths) {
    const info = inspectArtifactFile(path.join(root, relativePath), relativePath);
    if (info) infos.push(info);
  }
  return infos;
}
