/**
 * ELF image parsing without external tools.
 *
 * The memory map and the doctor must read the same bytes the linker produced:
 * no `readelf`, no `objdump`, no shell. Supports ELF32/ELF64, little and big
 * endian. Only what is needed is decoded: the entry point, PT_LOAD segments
 * (used to compare flash with the expected image) and section headers (used to
 * compute FLASH/RAM usage).
 *
 * A malformed table is reported, never skipped silently.
 */
import { readFileSync } from "node:fs";

export const PT_LOAD = 1;
export const SHT_NOBITS = 8;
export const SHT_STRTAB = 3;
export const SHF_WRITE = 1;
export const SHF_ALLOC = 2;
export const SHF_EXECINSTR = 4;

export interface ElfSegment {
  /** Physical load address, falling back to the virtual address. */
  address: number;
  bytes: Uint8Array;
  flags: number;
}

export interface ElfSection {
  name: string;
  type: number;
  flags: number;
  address: number;
  size: number;
}

export interface ElfImage {
  class: "ELF32" | "ELF64";
  endianness: "little" | "big";
  entry: number;
  segments: ElfSegment[];
  sections: ElfSection[];
}

export type ElfParseResult = { ok: true; image: ElfImage } | { ok: false; reason: string };

function fail(reason: string): ElfParseResult {
  return { ok: false, reason };
}

export function parseElfImage(bytes: Uint8Array): ElfParseResult {
  if (bytes.length < 4 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    return fail("file is not an ELF image (bad magic)");
  }
  if (bytes.length < 52) return fail("file is too short to be an ELF image");

  const classByte = bytes[4] ?? 0;
  if (classByte !== 1 && classByte !== 2) return fail(`unknown ELF class ${classByte}`);
  const is64 = classByte === 2;

  const dataByte = bytes[5] ?? 0;
  if (dataByte !== 1 && dataByte !== 2) return fail(`unknown ELF endianness ${dataByte}`);
  const little = dataByte === 1;
  const endianness = little ? "little" : "big";

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number): number => view.getUint16(offset, little);
  const u32 = (offset: number): number => view.getUint32(offset, little);
  const u64 = (offset: number): number => Number(view.getBigUint64(offset, little));

  const headerSize = is64 ? 64 : 52;
  if (bytes.length < headerSize) return fail("ELF header is truncated");

  const entry = is64 ? u64(24) : u32(24);
  const phoff = is64 ? u64(32) : u32(28);
  const shoff = is64 ? u64(40) : u32(32);
  const phentsize = is64 ? u16(54) : u16(42);
  const phnum = is64 ? u16(56) : u16(44);
  const shentsize = is64 ? u16(58) : u16(46);
  const shnum = is64 ? u16(60) : u16(48);
  const shstrndx = is64 ? u16(62) : u16(50);

  const phEntrySize = is64 ? 56 : 32;
  const shEntrySize = is64 ? 64 : 40;
  if (phnum > 0 && (phentsize < phEntrySize || phoff + phnum * phentsize > bytes.length)) {
    return fail("program header table is outside the file");
  }
  if (shnum > 0 && (shentsize < shEntrySize || shoff + shnum * shentsize > bytes.length)) {
    return fail("section header table is outside the file");
  }

  const segments: ElfSegment[] = [];
  for (let index = 0; index < phnum; index += 1) {
    const base = phoff + index * phentsize;
    if (u32(base) !== PT_LOAD) continue;

    let flags: number;
    let offset: number;
    let vaddr: number;
    let paddr: number;
    let filesz: number;
    if (is64) {
      flags = u32(base + 4);
      offset = u64(base + 8);
      vaddr = u64(base + 16);
      paddr = u64(base + 24);
      filesz = u64(base + 32);
    } else {
      offset = u32(base + 4);
      vaddr = u32(base + 8);
      paddr = u32(base + 12);
      filesz = u32(base + 16);
      flags = u32(base + 24);
    }

    if (filesz === 0) continue;
    if (offset + filesz > bytes.length) {
      return fail(`PT_LOAD segment ${index} points outside the file`);
    }
    segments.push({
      address: paddr === 0 && vaddr !== 0 ? vaddr : paddr,
      bytes: bytes.slice(offset, offset + filesz),
      flags,
    });
  }

  interface RawSection {
    nameOffset: number;
    type: number;
    flags: number;
    address: number;
    offset: number;
    size: number;
  }

  const rawSections: RawSection[] = [];
  for (let index = 0; index < shnum; index += 1) {
    const base = shoff + index * shentsize;
    rawSections.push(
      is64
        ? {
            nameOffset: u32(base),
            type: u32(base + 4),
            flags: u64(base + 8),
            address: u64(base + 16),
            offset: u64(base + 24),
            size: u64(base + 32),
          }
        : {
            nameOffset: u32(base),
            type: u32(base + 4),
            flags: u32(base + 8),
            address: u32(base + 12),
            offset: u32(base + 16),
            size: u32(base + 20),
          },
    );
  }

  const shstr = shstrndx > 0 && shstrndx < rawSections.length ? rawSections[shstrndx] : null;
  let names: Uint8Array | null = null;
  if (shstr && shstr.type === SHT_STRTAB && shstr.offset + shstr.size <= bytes.length) {
    names = bytes.subarray(shstr.offset, shstr.offset + shstr.size);
  }

  const nameAt = (offset: number): string => {
    if (!names || offset >= names.length) return "";
    let end = offset;
    while (end < names.length && names[end] !== 0) end += 1;
    return new TextDecoder().decode(names.subarray(offset, end));
  };

  const sections: ElfSection[] = [];
  for (const raw of rawSections) {
    if (raw.type !== SHT_NOBITS && raw.size > 0 && raw.offset + raw.size > bytes.length) {
      return fail(`section "${nameAt(raw.nameOffset)}" points outside the file`);
    }
    sections.push({
      name: nameAt(raw.nameOffset),
      type: raw.type,
      flags: raw.flags,
      address: raw.address,
      size: raw.size,
    });
  }

  return {
    ok: true,
    image: {
      class: is64 ? "ELF64" : "ELF32",
      endianness,
      entry,
      segments,
      sections,
    },
  };
}

/** Reads and parses one ELF file; a missing file or bad bytes is a reason, not an empty image. */
export function readElfImage(filePath: string): ElfParseResult {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(filePath));
  } catch (error) {
    return fail(
      `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseElfImage(bytes);
}
