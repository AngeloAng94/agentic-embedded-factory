/**
 * Product profile (`profiles/<name>.yaml`).
 *
 * The profile is the only place where board facts live: memory sizes, build
 * command, flash tool, editable anchors and acceptance criteria. Everything the
 * agent does is bounded by it. Validation is explicit and total: a typo must
 * fail loudly here, not produce a silently wrong flash.
 */

export type BuildSystem = "cmake" | "make" | "west";
export type FlashInterface = "swd" | "jtag";

export type Criterion =
  | { seriale_contiene: string }
  | { log_non_contiene: string[] }
  | { test_su_target: "pass" };

export interface ProductProfile {
  prodotto: string;
  chip: { famiglia: string; flash_kb: number; ram_kb: number };
  build: { sistema: BuildSystem; toolchain: string; comando: string };
  flash: { tool: string; interfaccia: FlashInterface };
  debug: { gdb_server: string; access_port: number };
  /** Editable block names: `// [AI_START_<name>]` … `// [AI_END_<name>]`. */
  ancore: string[];
  criteri: Criterion[];
  tentativi_max: number;
}

export type ProfileResult =
  | { ok: true; profile: ProductProfile }
  | { ok: false; errors: string[] };

const TOP_KEYS = new Set([
  "prodotto",
  "chip",
  "build",
  "flash",
  "debug",
  "ancore",
  "criteri",
  "tentativi_max",
]);
const BUILD_SYSTEMS: BuildSystem[] = ["cmake", "make", "west"];
const FLASH_INTERFACES: FlashInterface[] = ["swd", "jtag"];
const ANCHOR_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_ATTEMPTS = 10;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, path: string, errors: string[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path}: must be a non-empty string`);
    return null;
  }
  return value.trim();
}

function integerAt(value: unknown, path: string, errors: string[], min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push(`${path}: must be an integer`);
    return null;
  }
  if (value < min || value > max) {
    errors.push(`${path}: must be between ${min} and ${max}`);
    return null;
  }
  return value;
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: unknown field`);
  }
}

function parseCriterion(raw: unknown, index: number, errors: string[]): Criterion | null {
  const at = `criteri[${index}]`;
  if (!isObject(raw)) {
    errors.push(`${at}: must be an object`);
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    errors.push(`${at}: must contain exactly one criterion (${keys.join(", ") || "none"})`);
    return null;
  }
  const key = keys[0]!;
  if (key === "seriale_contiene") {
    const text = stringAt(raw[key], `${at}.seriale_contiene`, errors);
    return text === null ? null : { seriale_contiene: text };
  }
  if (key === "log_non_contiene") {
    const list = raw[key];
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`${at}.log_non_contiene: must be a non-empty array`);
      return null;
    }
    const forbidden: string[] = [];
    list.forEach((entry, entryIndex) => {
      const text = stringAt(entry, `${at}.log_non_contiene[${entryIndex}]`, errors);
      if (text !== null) forbidden.push(text);
    });
    return forbidden.length === list.length ? { log_non_contiene: forbidden } : null;
  }
  if (key === "test_su_target") {
    if (raw[key] !== "pass") {
      errors.push(`${at}.test_su_target: the only accepted value is "pass"`);
      return null;
    }
    return { test_su_target: "pass" };
  }
  errors.push(`${at}.${key}: unknown criterion`);
  return null;
}

/**
 * Parses and validates profile text. Returns every error, not just the first,
 * so a bad profile can be fixed in one pass.
 */
export function loadProfile(text: string): ProfileResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    // Bun ships a YAML parser; cast keeps this working with older type defs.
    const yaml = (Bun as unknown as { YAML?: { parse(source: string): unknown } }).YAML;
    if (!yaml) return { ok: false, errors: ["YAML support is not available in this Bun runtime"] };
    parsed = yaml.parse(text);
  } catch (error) {
    return { ok: false, errors: [`YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (!isObject(parsed)) return { ok: false, errors: ["profile: must be a YAML mapping"] };
  checkKeys(parsed, [...TOP_KEYS], "profile", errors);

  const prodotto = stringAt(parsed.prodotto, "prodotto", errors);

  let chip: ProductProfile["chip"] | null = null;
  if (!isObject(parsed.chip)) {
    errors.push("chip: must be an object");
  } else {
    checkKeys(parsed.chip, ["famiglia", "flash_kb", "ram_kb"], "chip", errors);
    const famiglia = stringAt(parsed.chip.famiglia, "chip.famiglia", errors);
    const flash = integerAt(parsed.chip.flash_kb, "chip.flash_kb", errors, 1, 16384);
    const ram = integerAt(parsed.chip.ram_kb, "chip.ram_kb", errors, 1, 4096);
    if (famiglia !== null && flash !== null && ram !== null) {
      chip = { famiglia, flash_kb: flash, ram_kb: ram };
    }
  }

  let build: ProductProfile["build"] | null = null;
  if (!isObject(parsed.build)) {
    errors.push("build: must be an object");
  } else {
    checkKeys(parsed.build, ["sistema", "toolchain", "comando"], "build", errors);
    const sistema = parsed.build.sistema;
    if (typeof sistema !== "string" || !BUILD_SYSTEMS.includes(sistema as BuildSystem)) {
      errors.push(`build.sistema: must be one of ${BUILD_SYSTEMS.join(", ")}`);
    }
    const toolchain = stringAt(parsed.build.toolchain, "build.toolchain", errors);
    const comando = stringAt(parsed.build.comando, "build.comando", errors);
    if (build === null && BUILD_SYSTEMS.includes(sistema as BuildSystem) && toolchain && comando) {
      build = { sistema: sistema as BuildSystem, toolchain, comando };
    }
  }

  let flash: ProductProfile["flash"] | null = null;
  if (!isObject(parsed.flash)) {
    errors.push("flash: must be an object");
  } else {
    checkKeys(parsed.flash, ["tool", "interfaccia"], "flash", errors);
    const tool = stringAt(parsed.flash.tool, "flash.tool", errors);
    const interfaccia = parsed.flash.interfaccia;
    if (typeof interfaccia !== "string" || !FLASH_INTERFACES.includes(interfaccia as FlashInterface)) {
      errors.push(`flash.interfaccia: must be one of ${FLASH_INTERFACES.join(", ")}`);
    }
    if (tool && FLASH_INTERFACES.includes(interfaccia as FlashInterface)) {
      flash = { tool, interfaccia: interfaccia as FlashInterface };
    }
  }

  let debug: ProductProfile["debug"] | null = null;
  if (!isObject(parsed.debug)) {
    errors.push("debug: must be an object");
  } else {
    checkKeys(parsed.debug, ["gdb_server", "access_port"], "debug", errors);
    const server = stringAt(parsed.debug.gdb_server, "debug.gdb_server", errors);
    const port = integerAt(parsed.debug.access_port, "debug.access_port", errors, 0, 65535);
    if (server !== null && port !== null) debug = { gdb_server: server, access_port: port };
  }

  const ancore: string[] = [];
  if (!Array.isArray(parsed.ancore) || parsed.ancore.length === 0) {
    errors.push("ancore: must be a non-empty array of block names");
  } else {
    const seen = new Set<string>();
    parsed.ancore.forEach((entry, index) => {
      if (typeof entry !== "string" || !ANCHOR_RE.test(entry)) {
        errors.push(`ancore[${index}]: must match ${ANCHOR_RE.source}`);
        return;
      }
      if (seen.has(entry)) {
        errors.push(`ancore[${index}]: duplicate block ${entry}`);
        return;
      }
      seen.add(entry);
      ancore.push(entry);
    });
  }

  const criteri: Criterion[] = [];
  if (!Array.isArray(parsed.criteri) || parsed.criteri.length === 0) {
    errors.push("criteri: must be a non-empty array");
  } else {
    parsed.criteri.forEach((entry, index) => {
      const criterion = parseCriterion(entry, index, errors);
      if (criterion) criteri.push(criterion);
    });
  }

  const tentativi = integerAt(parsed.tentativi_max, "tentativi_max", errors, 1, MAX_ATTEMPTS);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    profile: {
      prodotto: prodotto!,
      chip: chip!,
      build: build!,
      flash: flash!,
      debug: debug!,
      ancore,
      criteri,
      tentativi_max: tentativi!,
    },
  };
}

/** Block names the agent may edit, in profile order. */
export function editableAnchors(profile: ProductProfile): string[] {
  return [...profile.ancore];
}
