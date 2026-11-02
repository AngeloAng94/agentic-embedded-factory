/**
 * ELF → raw binary / Intel HEX derivation.
 *
 * `flash` accepts a checked ELF directly. A `.bin` or `.hex` is accepted only
 * when the MCP server derived it from a checked ELF (or can reproduce the exact
 * derived bytes from a checked source ELF). This module is the only converter.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseElfImage, type ElfSegment } from "../../core/elfImage";
import type { ProductProfile } from "../../core/profile";
import { invalidRequest, notAvailable, toolOk, type ToolOutcome } from "../../core/toolResult";

export type DerivedFormat = "bin" | "hex";
export type ArtifactKind = "elf" | DerivedFormat;

export interface DerivedArtifact {
  sourceArtifact: string;
  sourceSha256: string;
  format: DerivedFormat;
  artifact: string;
  sha256: string;
  bytes: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inFlash(profile: ProductProfile, address: number, size: number): boolean {
  return profile.chip.regioni.some(
    (region) =>
      region.tipo === "flash" &&
      address >= region.origine &&
      address + size <= region.origine + region.dimensione,
  );
}

function flashSegments(profile: ProductProfile, segments: readonly ElfSegment[]) {
  const selected: { address: number; bytes: Uint8Array }[] = [];
  for (const segment of segments) {
    if (segment.bytes.length === 0) continue;
    const address = segment.physicalAddress !== 0 ? segment.physicalAddress : segment.vaddr;
    if (!inFlash(profile, address, segment.bytes.length)) continue;
    selected.push({ address, bytes: segment.bytes });
  }
  return selected.sort((left, right) => left.address - right.address);
}

function toBinary(segments: readonly { address: number; bytes: Uint8Array }[]): Uint8Array {
  const start = segments[0]!.address;
  const end = Math.max(...segments.map((segment) => segment.address + segment.bytes.length));
  const span = end - start;
  const maxSpan = 256 * 1024 * 1024;
  if (span > maxSpan) throw new Error(`derived binary span is ${span} bytes; refusing a padded image larger than ${maxSpan}`);
  const output = new Uint8Array(span);
  for (const segment of segments) {
    output.set(segment.bytes, segment.address - start);
  }
  return output;
}

function intelHexRecord(address: number, type: number, data: readonly number[]): string {
  const body = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
  const sum = body.reduce((total, byte) => total + byte, 0);
  const checksum = (-sum) & 0xff;
  return `:${[...body, checksum].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function toIntelHex(segments: readonly { address: number; bytes: Uint8Array }[]): string {
  const lines: string[] = [];
  let upper = -1;
  for (const segment of segments) {
    let offset = 0;
    while (offset < segment.bytes.length) {
      const address = segment.address + offset;
      const high = Math.floor(address / 0x1_0000);
      if (high !== upper) {
        upper = high;
        lines.push(intelHexRecord(0, 4, [(high >> 8) & 0xff, high & 0xff]));
      }
      const chunk = [...segment.bytes.subarray(offset, offset + 16)];
      lines.push(intelHexRecord(address & 0xffff, 0, chunk));
      offset += chunk.length;
    }
  }
  lines.push(":00000001FF");
  return `${lines.join("\n")}\n`;
}

export function artifactKind(filePath: string): ArtifactKind | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".elf") return "elf";
  if (extension === ".bin") return "bin";
  if (extension === ".hex") return "hex";

  try {
    const head = readFileSync(filePath).subarray(0, 12);
    if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
      return "elf";
    }
    if (head.length >= 3 && head[0] === 0x3a && /^:[0-9a-f]{2}/i.test(head.toString("ascii"))) {
      return "hex";
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Converts one ELF into a binary/HEX file owned by the server. The caller must
 * already have a successful memory_map_check for the source SHA-256; this
 * function itself only reads the source and writes the derived temp file.
 */
export function deriveFromElf(
  profile: ProductProfile,
  sourceArtifact: string,
  format: DerivedFormat,
): ToolOutcome<DerivedArtifact> {
  if (artifactKind(sourceArtifact) !== "elf") {
    return invalidRequest("a derived .bin/.hex must come from an ELF source, not from another format");
  }

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = new Uint8Array(readFileSync(sourceArtifact));
  } catch (error) {
    return notAvailable(
      `cannot read the source ELF for derivation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = parseElfImage(sourceBytes);
  if (!parsed.ok) return notAvailable(`cannot derive from the source ELF: ${parsed.reason}`);

  const segments = flashSegments(profile, parsed.image.segments);
  if (segments.length === 0) {
    return notAvailable(
      "the source ELF has no PT_LOAD bytes inside a declared FLASH region, so a firmware .bin/.hex cannot be derived",
    );
  }

  let output: Uint8Array | string;
  try {
    output = format === "bin" ? toBinary(segments) : toIntelHex(segments);
  } catch (error) {
    return notAvailable(
      `cannot derive the ${format} image: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const outputBytes = typeof output === "string" ? new TextEncoder().encode(output) : output;
  let directory: string;
  try {
    directory = mkdtempSync(path.join(tmpdir(), "py-bench-derived-"));
  } catch (error) {
    return notAvailable(
      `cannot create a directory for the derived ${format}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const artifact = path.join(directory, `firmware.${format}`);
  try {
    writeFileSync(artifact, outputBytes);
  } catch (error) {
    return notAvailable(
      `cannot write the derived ${format}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return toolOk({
    sourceArtifact,
    sourceSha256: sha256(sourceBytes),
    format,
    artifact,
    sha256: sha256(outputBytes),
    bytes: outputBytes.length,
  });
}
