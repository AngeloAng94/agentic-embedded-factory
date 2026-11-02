/**
 * Byte-accurate synthetic ELF32 (little endian) for tests.
 *
 * No compiler, no toolchain, no platform dependency: the parser sees a real ELF
 * header, a real program header table and a real section header table.
 */

export interface FixtureSegment {
  /** Physical load address (p_paddr). */
  address: number;
  /** Virtual address (p_vaddr); defaults to `address`. */
  vaddr?: number;
  bytes: number[];
  /** PF_R=4, PF_W=2, PF_X=1; default R|X. */
  flags?: number;
}

export interface FixtureSection {
  name: string;
  /** SHT_PROGBITS=1 (default), SHT_NOBITS=8, … */
  type?: number;
  /** SHF_WRITE=1, SHF_ALLOC=2, SHF_EXECINSTR=4. */
  flags: number;
  /** VMA (sh_addr). */
  address: number;
  bytes?: number[];
  size?: number;
  /** LMA; creates a PT_LOAD segment with this p_paddr and VMA = address. */
  loadAddress?: number;
}

export interface ElfFixtureOptions {
  entry: number;
  segments?: FixtureSegment[];
  sections?: FixtureSection[];
}

const ELF_HEADER_SIZE = 52;
const PROGRAM_HEADER_SIZE = 32;
const SECTION_HEADER_SIZE = 40;
const PT_LOAD = 1;
const SHT_PROGBITS = 1;
const SHT_NOBITS = 8;
const SHT_STRTAB = 3;

/** Little-endian Cortex-M vector table: word 0 = initial SP, word 1 = reset. */
export function vectorBytes(stack: number, reset: number, size = 256): number[] {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, stack >>> 0, true);
  view.setUint32(4, reset >>> 0, true);
  return [...bytes];
}

export function buildElf32(options: ElfFixtureOptions): Uint8Array {
  const sections = options.sections ?? [];
  const explicitSegments = options.segments ?? [];
  const encoder = new TextEncoder();

  const implicitSegments: FixtureSegment[] = sections
    .filter((section) => section.loadAddress !== undefined && section.type !== SHT_NOBITS)
    .map((section) => ({
      address: section.loadAddress!,
      vaddr: section.address,
      bytes: section.bytes ?? new Array<number>(section.size ?? 0).fill(0),
      flags: 4 | (section.flags & 2 ? 2 : 0) | (section.flags & 4 ? 1 : 0),
    }));
  const segments = [...explicitSegments, ...implicitSegments];

  const names = [...sections.map((section) => section.name), ".shstrtab"];
  const nameBytes: number[] = [0];
  const nameOffsets: number[] = [];
  for (const name of names) {
    nameOffsets.push(nameBytes.length);
    nameBytes.push(...encoder.encode(name), 0);
  }

  const phoff = ELF_HEADER_SIZE;
  const dataStart = phoff + segments.length * PROGRAM_HEADER_SIZE;

  const blob: number[] = [];
  const segmentOffsets: number[] = [];
  for (const segment of segments) {
    segmentOffsets.push(dataStart + blob.length);
    blob.push(...segment.bytes);
  }

  const sectionOffsets: number[] = [];
  for (const section of sections) {
    const type = section.type ?? SHT_PROGBITS;
    if (type === SHT_NOBITS) {
      sectionOffsets.push(0);
      continue;
    }
    sectionOffsets.push(dataStart + blob.length);
    blob.push(...(section.bytes ?? new Array<number>(section.size ?? 0).fill(0)));
  }

  const shstrOffset = dataStart + blob.length;
  blob.push(...nameBytes);

  const shoff = dataStart + blob.length;
  const sectionCount = sections.length + 2; // null + user sections + shstrtab
  const bytes = new Uint8Array(shoff + sectionCount * SECTION_HEADER_SIZE);
  const view = new DataView(bytes.buffer);

  // ELF header
  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
  bytes[4] = 1; // ELF32
  bytes[5] = 1; // little endian
  bytes[6] = 1; // EV_CURRENT
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, 40, true); // EM_ARM
  view.setUint32(20, 1, true);
  view.setUint32(24, options.entry, true);
  view.setUint32(28, phoff, true);
  view.setUint32(32, shoff, true);
  view.setUint16(40, ELF_HEADER_SIZE, true);
  view.setUint16(42, PROGRAM_HEADER_SIZE, true);
  view.setUint16(44, segments.length, true);
  view.setUint16(46, SECTION_HEADER_SIZE, true);
  view.setUint16(48, sectionCount, true);
  view.setUint16(50, sections.length + 1, true); // index of .shstrtab

  bytes.set(blob, dataStart);

  segments.forEach((segment, index) => {
    const base = phoff + index * PROGRAM_HEADER_SIZE;
    view.setUint32(base, PT_LOAD, true);
    view.setUint32(base + 4, segmentOffsets[index]!, true);
    view.setUint32(base + 8, segment.vaddr ?? segment.address, true);
    view.setUint32(base + 12, segment.address, true);
    view.setUint32(base + 16, segment.bytes.length, true);
    view.setUint32(base + 20, segment.bytes.length, true);
    view.setUint32(base + 24, segment.flags ?? 5, true);
    view.setUint32(base + 28, 4, true);
  });

  sections.forEach((section, index) => {
    const base = shoff + (index + 1) * SECTION_HEADER_SIZE;
    const type = section.type ?? SHT_PROGBITS;
    const size = section.bytes?.length ?? section.size ?? 0;
    view.setUint32(base, nameOffsets[index]!, true);
    view.setUint32(base + 4, type, true);
    view.setUint32(base + 8, section.flags, true);
    view.setUint32(base + 12, section.address, true);
    view.setUint32(base + 16, type === SHT_NOBITS ? 0 : sectionOffsets[index]!, true);
    view.setUint32(base + 20, size, true);
    view.setUint32(base + 32, 1, true);
  });

  const shstrBase = shoff + (sections.length + 1) * SECTION_HEADER_SIZE;
  view.setUint32(shstrBase, nameOffsets[sections.length]!, true);
  view.setUint32(shstrBase + 4, SHT_STRTAB, true);
  view.setUint32(shstrBase + 16, shstrOffset, true);
  view.setUint32(shstrBase + 20, nameBytes.length, true);
  view.setUint32(shstrBase + 32, 1, true);

  return bytes;
}
