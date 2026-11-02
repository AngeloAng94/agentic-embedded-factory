/**
 * `memory_map_check`.
 *
 * The linker already reports sizes. What it accepts in silence is a wrong
 * address, so this tool checks the addresses in the real ELF against the chip
 * regions declared by the profile:
 *
 *   - every allocated section's VMA must be inside a region of the right type,
 *     including its end: a section loaded from FLASH into RAM is valid whatever
 *     its flags (for example `.ramfunc`), while a normal executable or
 *     read-only section belongs in FLASH and a writable section in RAM;
 *   - every section with file bytes and an LMA must also have its LMA inside a
 *     FLASH region;
 *   - the Cortex-M vector table (`chip.vettori`, else the `.vectors`/
 *     `.isr_vector` section, else the start of the lowest FLASH region) must
 *     contain an 8-byte-aligned initial stack pointer inside RAM and a reset
 *     handler inside FLASH with the Thumb bit set;
 *   - the ELF entry point remains a secondary check: it must fall inside an
 *     executable section.
 *
 * Sizes are still reported per region, but they are a consequence of the
 * address checks, not their substitute. A stripped ELF without sections is
 * NOT_AVAILABLE, never a guess from the file size.
 */
import {
  readElfImage,
  SHF_ALLOC,
  SHF_EXECINSTR,
  SHF_WRITE,
  SHT_NOBITS,
  type ElfImage,
  type ElfSection,
} from "../core/elfImage";
import type { MemoryRegion, MemoryRegionType, ProductProfile } from "../core/profile";
import { invalidRequest, notAvailable, toolOk, type ToolOutcome } from "../core/toolResult";

export type MemoryCheckStatus = "PASS" | "FAIL" | "NOT_AVAILABLE";

export interface MemoryMapCheck {
  id: string;
  label: string;
  status: MemoryCheckStatus;
  detail: string;
}

export interface MemoryRegionUsage {
  name: string;
  type: MemoryRegionType;
  origin: number;
  size: number;
  used: number;
}

export interface VectorTableReport {
  source: string;
  address: number;
  stack: number;
  reset: number;
}

export interface MemoryMapReport {
  artifact: string;
  elfClass: "ELF32" | "ELF64";
  entry: string;
  regions: MemoryRegionUsage[];
  vectorTable: VectorTableReport | null;
  flashUsed: number;
  flashTotal: number;
  ramUsed: number;
  ramTotal: number;
  checks: MemoryMapCheck[];
  verdict: "SUCCESS" | "FAILURE" | "UNKNOWN";
}

const ADDRESS_SPACE_END = 0x1_0000_0000;

function hex(address: number): string {
  return `0x${address.toString(16)}`;
}

function bytes(value: number): string {
  return `${value} B`;
}

function regionEnd(region: MemoryRegion): number {
  return region.origine + region.dimensione;
}

function describeRegion(region: MemoryRegion): string {
  return `${region.tipo.toUpperCase()} region "${region.nome}" (${hex(region.origine)}..${hex(regionEnd(region))})`;
}

function regionsOfType(regions: readonly MemoryRegion[], type: MemoryRegionType): MemoryRegion[] {
  return regions.filter((region) => region.tipo === type);
}

function regionList(regions: readonly MemoryRegion[], type: MemoryRegionType): string {
  const list = regionsOfType(regions, type).map(describeRegion);
  return list.length > 0 ? list.join(", ") : "none declared";
}

function sectionLabel(section: ElfSection, index: number): string {
  return section.name ? `section "${section.name}"` : `section #${index}`;
}

function sectionEnd(section: ElfSection): number {
  return section.address + section.size;
}

function usage(used: number, total: number): string {
  if (total <= 0) return bytes(used);
  const percent = ((used / total) * 100).toFixed(1);
  return `${bytes(used)} / ${bytes(total)} (${percent}%)`;
}

type PlacementKind = "fits" | "extends" | "wrong-type" | "outside";

interface Placement {
  kind: PlacementKind;
  region: MemoryRegion | null;
}

/**
 * Places a whole [start, start + size) range in one region of the expected
 * type. A range that starts inside a region but crosses its end is `extends`,
 * not `outside`; the message can then name the region and the end address.
 */
function placeRange(
  start: number,
  size: number,
  expected: MemoryRegionType,
  regions: readonly MemoryRegion[],
): Placement {
  const end = start + size;
  if (end > ADDRESS_SPACE_END) return { kind: "outside", region: null };

  const candidates = regionsOfType(regions, expected);
  for (const region of candidates) {
    if (start >= region.origine && end <= regionEnd(region)) {
      return { kind: "fits", region };
    }
  }

  const sameType = candidates.find(
    (region) => start >= region.origine && start < regionEnd(region),
  );
  if (sameType) return { kind: "extends", region: sameType };

  const otherType = regions.find(
    (region) => start >= region.origine && start < regionEnd(region),
  );
  if (otherType) return { kind: "wrong-type", region: otherType };

  return { kind: "outside", region: null };
}

function placementFailure(
  what: string,
  start: number,
  size: number,
  expected: MemoryRegionType,
  placement: Placement,
  regions: readonly MemoryRegion[],
): string {
  const end = start + size;
  if (placement.kind === "extends" && placement.region) {
    return `${what} (${bytes(size)}) ends at ${hex(end)}, past the end ${hex(regionEnd(placement.region))} of ${describeRegion(placement.region)}; expected a ${expected.toUpperCase()} region`;
  }
  if (placement.kind === "wrong-type" && placement.region) {
    return `${what} is in ${describeRegion(placement.region)}, but a ${expected.toUpperCase()} region was expected`;
  }
  return `${what} is outside every ${expected.toUpperCase()} region declared in the profile (${regionList(regions, expected)})`;
}

function verdictOf(checks: readonly MemoryMapCheck[]): MemoryMapReport["verdict"] {
  if (checks.some((check) => check.status === "FAIL")) return "FAILURE";
  if (checks.some((check) => check.status === "NOT_AVAILABLE")) return "UNKNOWN";
  return "SUCCESS";
}

interface Claim {
  start: number;
  end: number;
  label: string;
}

/** Returns the first overlap between ranges, including load addresses. */
function findOverlap(claims: readonly Claim[]): [Claim, Claim] | null {
  const sorted = [...claims].sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.end > current.start) return [previous, current];
  }
  return null;
}

const VECTOR_SECTION_RE = /^(\.?isr[_-]?vectors?|\.?vectors?|vector[_-]?table)$/i;

/** Reads bytes at a physical address from a section or a PT_LOAD segment. */
function bytesAtAddress(image: ElfImage, address: number, length: number): Uint8Array | null {
  for (const section of image.sections) {
    if (
      section.fileBytes.length >= length &&
      address >= section.address &&
      address + length <= section.address + section.fileBytes.length
    ) {
      const offset = address - section.address;
      return section.fileBytes.subarray(offset, offset + length);
    }
  }
  for (const segment of image.segments) {
    if (
      address >= segment.physicalAddress &&
      address + length <= segment.physicalAddress + segment.bytes.length
    ) {
      const offset = address - segment.physicalAddress;
      return segment.bytes.subarray(offset, offset + length);
    }
  }
  return null;
}

function wordAt(bytes: Uint8Array, little: boolean): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, little);
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
  const regions = profile.chip.regioni;

  const allocated = image.sections.filter(
    (section) => (section.flags & SHF_ALLOC) !== 0 && section.size > 0,
  );
  if (allocated.length === 0) {
    return notAvailable(
      "the ELF has no allocated sections (stripped image?): addresses and the vector table cannot be checked",
    );
  }

  const checks: MemoryMapCheck[] = [];
  const usedByRegion = new Map<string, number>(
    regions.map((region) => [region.nome, 0]),
  );
  const claims: Claim[] = [];

  for (const [index, section] of allocated.entries()) {
    const label = sectionLabel(section, index);
    const vmaRam = placeRange(section.address, section.size, "ram", regions);
    const vmaFlash = placeRange(section.address, section.size, "flash", regions);
    const loadInFlash =
      section.type !== SHT_NOBITS &&
      section.loadAddress !== undefined &&
      placeRange(section.loadAddress, section.size, "flash", regions).kind === "fits";
    // A section whose LMA in FLASH differs from its VMA is copied to RAM; its
    // flags do not decide the destination (`.ramfunc` is executable, not
    // writable, and still runs from RAM).
    const copiedToRam = loadInFlash && section.loadAddress !== section.address;
    const expected: MemoryRegionType =
      copiedToRam || (section.flags & SHF_WRITE) !== 0 ? "ram" : "flash";
    const placement = expected === "ram" ? vmaRam : vmaFlash;

    checks.push({
      id: `section[${index}].vma`,
      label: `${label} execution address`,
      status: placement.kind === "fits" ? "PASS" : "FAIL",
      detail:
        placement.kind === "fits" && placement.region
          ? `${label} VMA ${hex(section.address)} (${bytes(section.size)}) is in ${describeRegion(placement.region)}`
          : placementFailure(
              `${label} VMA ${hex(section.address)}`,
              section.address,
              section.size,
              expected,
              placement,
              regions,
            ),
    });

    if (placement.kind === "fits" && placement.region) {
      usedByRegion.set(
        placement.region.nome,
        (usedByRegion.get(placement.region.nome) ?? 0) + section.size,
      );
    }
    claims.push({
      start: section.address,
      end: sectionEnd(section),
      label: `${label} VMA`,
    });

    // File bytes loaded at a different address need a FLASH LMA. This covers
    // `.data` and copied sections such as `.ramfunc`, whatever their flags.
    if (section.type !== SHT_NOBITS && section.loadAddress !== undefined) {
      const loadPlacement = placeRange(section.loadAddress, section.size, "flash", regions);
      checks.push({
        id: `section[${index}].lma`,
        label: `${label} load address`,
        status: loadPlacement.kind === "fits" ? "PASS" : "FAIL",
        detail:
          loadPlacement.kind === "fits" && loadPlacement.region
            ? `${label} LMA ${hex(section.loadAddress)} (${bytes(section.size)}) is in ${describeRegion(loadPlacement.region)}`
            : placementFailure(
                `${label} LMA ${hex(section.loadAddress)}`,
                section.loadAddress,
                section.size,
                "flash",
                loadPlacement,
                regions,
              ),
      });

      if (loadPlacement.kind === "fits" && loadPlacement.region) {
        usedByRegion.set(
          loadPlacement.region.nome,
          (usedByRegion.get(loadPlacement.region.nome) ?? 0) + section.size,
        );
      }
      if (section.loadAddress !== section.address) {
        claims.push({
          start: section.loadAddress,
          end: section.loadAddress + section.size,
          label: `${label} LMA`,
        });
      }
    } else if (expected === "ram" && section.type !== SHT_NOBITS) {
      checks.push({
        id: `section[${index}].lma`,
        label: `${label} load address`,
        status: "FAIL",
        detail: `${label} has initial data but no PT_LOAD segment maps its load address (LMA); the flash address cannot be checked`,
      });
    }
  }

  const overlap = findOverlap(claims);
  checks.push({
    id: "sections.overlap",
    label: "sections do not overlap",
    status: overlap === null ? "PASS" : "FAIL",
    detail:
      overlap === null
        ? `${claims.length} runtime/load range(s) checked`
        : `${overlap[0].label} ${hex(overlap[0].start)}..${hex(overlap[0].end)} overlaps ${overlap[1].label} at ${hex(overlap[1].start)}`,
  });

  // Vector table: an explicit chip.vettori wins, then a named section, then
  // the start of the lowest FLASH region. A bootloader application uses the
  // explicit address because its vectors are not at the start of FLASH.
  let vectorBytes: Uint8Array | null = null;
  let vectorAddress = 0;
  let vectorSource = "";
  const configuredVectors = profile.chip.vettori;

  if (configuredVectors !== undefined) {
    vectorAddress = configuredVectors;
    vectorSource = "chip.vettori";
    const tablePlacement = placeRange(configuredVectors, 8, "flash", regions);
    if (tablePlacement.kind !== "fits") {
      checks.push({
        id: "vectors.table",
        label: "Cortex-M vector table",
        status: "FAIL",
        detail: placementFailure(
          `chip.vettori ${hex(configuredVectors)}`,
          configuredVectors,
          8,
          "flash",
          tablePlacement,
          regions,
        ),
      });
    } else {
      vectorBytes = bytesAtAddress(image, configuredVectors, 8);
      if (!vectorBytes) {
        checks.push({
          id: "vectors.table",
          label: "Cortex-M vector table",
          status: "NOT_AVAILABLE",
          detail: `chip.vettori ${hex(configuredVectors)} is in FLASH, but no section or PT_LOAD segment contains its first two words`,
        });
      }
    }
  } else {
    const namedVector = allocated
      .filter((section) => VECTOR_SECTION_RE.test(section.name))
      .sort((left, right) => left.address - right.address)[0];

    if (namedVector) {
      vectorAddress = namedVector.address;
      vectorSource = `section "${namedVector.name}"`;
      if (namedVector.fileBytes.length < 8) {
        checks.push({
          id: "vectors.table",
          label: "Cortex-M vector table",
          status: "FAIL",
          detail: `${vectorSource} at ${hex(vectorAddress)} is ${bytes(namedVector.fileBytes.length)}, but the first two words need 8 B`,
        });
      } else {
        vectorBytes = namedVector.fileBytes.subarray(0, 8);
      }
    } else {
      const lowestFlash = [...regionsOfType(regions, "flash")].sort(
        (left, right) => left.origine - right.origine,
      )[0];
      if (!lowestFlash) {
        checks.push({
          id: "vectors.table",
          label: "Cortex-M vector table",
          status: "NOT_AVAILABLE",
          detail: "the profile declares no FLASH region",
        });
      } else {
        vectorAddress = lowestFlash.origine;
        vectorSource = `start of ${describeRegion(lowestFlash)}`;
        vectorBytes = bytesAtAddress(image, vectorAddress, 8);
        if (!vectorBytes) {
          checks.push({
            id: "vectors.table",
            label: "Cortex-M vector table",
            status: "NOT_AVAILABLE",
            detail: `no vector section and no PT_LOAD segment covers the start of ${describeRegion(lowestFlash)} at ${hex(vectorAddress)}`,
          });
        }
      }
    }
  }

  let vectorTable: VectorTableReport | null = null;
  if (vectorBytes) {
    const little = image.endianness === "little";
    const stack = wordAt(vectorBytes.subarray(0, 4), little);
    const reset = wordAt(vectorBytes.subarray(4, 8), little);
    const source = `${vectorSource} at ${hex(vectorAddress)}`;
    vectorTable = { source, address: vectorAddress, stack, reset };

    checks.push({
      id: "vectors.table",
      label: "Cortex-M vector table",
      status: "PASS",
      detail: `${source}; word 0 = ${hex(stack)}, word 1 = ${hex(reset)}`,
    });

    // A full-descending stack starts one byte past the last byte, so the
    // inclusive end of a RAM region is valid; anything beyond it is not.
    const stackRegion = regions.find(
      (region) =>
        region.tipo === "ram" &&
        stack >= region.origine &&
        stack <= regionEnd(region),
    );
    const stackAny = regions.find(
      (region) => stack >= region.origine && stack <= regionEnd(region),
    );
    const stackProblems: string[] = [];
    if (!stackRegion) {
      stackProblems.push(
        stackAny
          ? `initial SP ${hex(stack)} is in ${describeRegion(stackAny)}, but a RAM region was expected`
          : `initial SP ${hex(stack)} is outside every RAM region declared in the profile (${regionList(regions, "ram")})`,
      );
    }
    if (stack % 8 !== 0) {
      stackProblems.push(`initial SP ${hex(stack)} is not 8-byte aligned`);
    }
    checks.push({
      id: "vectors.stack",
      label: "initial stack pointer (vector word 0)",
      status: stackProblems.length === 0 ? "PASS" : "FAIL",
      detail:
        stackProblems.length === 0 && stackRegion
          ? `initial SP ${hex(stack)} is in ${describeRegion(stackRegion)} and 8-byte aligned`
          : stackProblems.join("; "),
    });

    const thumb = (reset & 1) === 1;
    const handler = (reset & 0xffff_fffe) >>> 0;
    const handlerRegion = regions.find(
      (region) =>
        region.tipo === "flash" &&
        handler >= region.origine &&
        handler < regionEnd(region),
    );
    const handlerAny = regions.find(
      (region) => handler >= region.origine && handler < regionEnd(region),
    );
    const resetProblems: string[] = [];
    if (!thumb) {
      resetProblems.push(
        `reset word ${hex(reset)} has the Thumb bit clear (Cortex-M requires bit 0 set)`,
      );
    }
    if (!handlerRegion) {
      resetProblems.push(
        handlerAny
          ? `reset handler ${hex(handler)} is in ${describeRegion(handlerAny)}, but a FLASH region was expected`
          : `reset handler ${hex(handler)} is outside every FLASH region declared in the profile (${regionList(regions, "flash")})`,
      );
    }
    checks.push({
      id: "vectors.reset",
      label: "reset handler (vector word 1)",
      status: resetProblems.length === 0 ? "PASS" : "FAIL",
      detail:
        resetProblems.length === 0 && handlerRegion
          ? `reset handler ${hex(handler)} has the Thumb bit set and is in ${describeRegion(handlerRegion)}`
          : resetProblems.join("; "),
    });
  }

  const executable = allocated.filter((section) => (section.flags & SHF_EXECINSTR) !== 0);
  if (executable.length === 0) {
    checks.push({
      id: "entry.executable",
      label: "entry point is executable (secondary check)",
      status: "NOT_AVAILABLE",
      detail: "the ELF has no executable allocated section to place the entry point in",
    });
  } else {
    const inside = executable.some(
      (section) => image.entry >= section.address && image.entry < sectionEnd(section),
    );
    checks.push({
      id: "entry.executable",
      label: "entry point is executable (secondary check)",
      status: inside ? "PASS" : "FAIL",
      detail: inside
        ? `${hex(image.entry)} lies in an executable section`
        : `${hex(image.entry)} is outside every executable section`,
    });
  }

  const regionUsage: MemoryRegionUsage[] = regions.map((region) => ({
    name: region.nome,
    type: region.tipo,
    origin: region.origine,
    size: region.dimensione,
    used: usedByRegion.get(region.nome) ?? 0,
  }));
  const flashRegions = regionUsage.filter((region) => region.type === "flash");
  const ramRegions = regionUsage.filter((region) => region.type === "ram");
  const flashTotal = flashRegions.reduce((sum, region) => sum + region.size, 0);
  const ramTotal = ramRegions.reduce((sum, region) => sum + region.size, 0);
  const flashUsed = flashRegions.reduce((sum, region) => sum + region.used, 0);
  const ramUsed = ramRegions.reduce((sum, region) => sum + region.used, 0);

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

  return toolOk({
    artifact: options.artifactPath,
    elfClass: image.class,
    entry: hex(image.entry),
    regions: regionUsage,
    vectorTable,
    flashUsed,
    flashTotal,
    ramUsed,
    ramTotal,
    checks,
    verdict: verdictOf(checks),
  });
}
