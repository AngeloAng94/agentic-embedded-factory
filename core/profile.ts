/**
 * Product profile (`profiles/<name>.yaml`).
 *
 * The profile is the only place where board facts live: memory regions, an
 * optional vector-table address, build system, flash tool, editable anchors
 * and acceptance criteria. Everything the agent does is bounded by it.
 * Validation is explicit and total: a typo must fail loudly here, not produce
 * a silently wrong flash.
 */

/** Two build adapters: STM32 with CMake+GCC, Zephyr with west. */
export type BuildSystem = "cmake" | "zephyr-west";
export type FlashInterface = "swd" | "jtag";
export type FlashTool = "STM32_Programmer_CLI" | "openocd" | "probe-rs" | "west";

/** Generation backends. `fake` is test-only and must be opted into. */
export type ModelRuntimeProvider = "llmClient" | "claude-agent-sdk" | "fake";

export interface ModelConfig {
  provider: ModelRuntimeProvider;
  /** Optional model name passed to the selected runtime. */
  model?: string;
}

/** Prudent defaults when the profile does not declare a budget. */
export const DEFAULT_RUN_TIME_BUDGET_MS = 8 * 60 * 1000;
export const DEFAULT_RUN_FLASH_BUDGET = 2;

export interface RunBudget {
  /** Total wall-clock budget for one orchestrated run. */
  tempo_totale_ms: number;
  /** Maximum number of real flash operations in one run. */
  flash_max: number;
}

export type Criterion =
  | { seriale_contiene: string }
  | { log_non_contiene: string[] }
  | { test_su_target: "pass" };

export interface SerialConfig {
  porta: string;
  baud: number;
  /** Optional capture command; `{porta}` and `{baud}` are substituted. */
  comando?: string;
}

export type MemoryRegionType = "flash" | "ram";

export interface MemoryRegion {
  nome: string;
  tipo: MemoryRegionType;
  /** First byte of the region, as a 32-bit address. */
  origine: number;
  /** Region length in bytes. */
  dimensione: number;
}

export interface ProductProfile {
  prodotto: string;
  /** Zephyr board name (e.g. a west board); required for `zephyr-west`. */
  board?: string;
  chip: {
    famiglia: string;
    regioni: MemoryRegion[];
    /** Optional vector-table address for applications behind a bootloader. */
    vettori?: number;
  };
  build: { sistema: BuildSystem; toolchain: string; comando: string };
  flash: { tool: FlashTool; interfaccia: FlashInterface; target?: string };
  debug: { gdb_server: string; access_port: number };
  seriale?: SerialConfig;
  /** Optional generation backend; absent means the existing `llmClient`. */
  llm?: ModelConfig;
  /** Whole-run limits; defaults are applied when this section is absent. */
  budget: RunBudget;
  /** Editable block names: `// [AI_START_<name>]` … `// [AI_END_<name>]`. */
  ancore: string[];
  /** Empty is valid: without criteria the run can never reach `observed`. */
  criteri: Criterion[];
  tentativi_max: number;
}

export type ProfileResult =
  | { ok: true; profile: ProductProfile }
  | { ok: false; errors: string[] };

const TOP_KEYS = new Set([
  "prodotto",
  "board",
  "chip",
  "build",
  "flash",
  "debug",
  "seriale",
  "llm",
  "budget",
  "ancore",
  "criteri",
  "tentativi_max",
]);
const BUILD_SYSTEMS: BuildSystem[] = ["cmake", "zephyr-west"];
const FLASH_INTERFACES: FlashInterface[] = ["swd", "jtag"];
const FLASH_TOOLS: FlashTool[] = ["STM32_Programmer_CLI", "openocd", "probe-rs", "west"];
const MODEL_PROVIDERS: ModelRuntimeProvider[] = ["llmClient", "claude-agent-sdk", "fake"];
const ANCHOR_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_ATTEMPTS = 10;
const MAX_ADDRESS = 0xffff_ffff;
const ADDRESS_SPACE_END = 0x1_0000_0000;

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

function hex(address: number): string {
  return `0x${address.toString(16)}`;
}

/** Accepts a YAML hex integer or an explicit `0x...` string, never a guess. */
function addressAt(value: unknown, path: string, errors: string[]): number | null {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= MAX_ADDRESS) return value;
    errors.push(`${path}: must be an address between 0 and 0xffffffff`);
    return null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (/^0x[0-9a-f]+$/i.test(text)) {
      const parsed = Number.parseInt(text.slice(2), 16);
      if (Number.isSafeInteger(parsed) && parsed <= MAX_ADDRESS) return parsed;
    }
  }
  errors.push(`${path}: must be a hex address (0x...) between 0 and 0xffffffff`);
  return null;
}

function byteSizeAt(value: unknown, path: string, errors: string[]): number | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_ADDRESS
  ) {
    errors.push(`${path}: must be a positive integer number of bytes (1..0xffffffff)`);
    return null;
  }
  return value;
}

function parseRegions(raw: unknown, errors: string[]): MemoryRegion[] {
  const at = "chip.regioni";
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${at}: must be a non-empty list of memory regions`);
    return [];
  }

  const regions: MemoryRegion[] = [];
  const names = new Set<string>();
  raw.forEach((entry, index) => {
    const path = `${at}[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    checkKeys(entry, ["nome", "tipo", "origine", "dimensione"], path, errors);

    const nome = stringAt(entry.nome, `${path}.nome`, errors);
    if (nome !== null) {
      if (names.has(nome)) errors.push(`${path}.nome: duplicate region "${nome}"`);
      else names.add(nome);
    }

    let tipo: MemoryRegionType | null = null;
    if (entry.tipo === "flash" || entry.tipo === "ram") tipo = entry.tipo;
    else errors.push(`${path}.tipo: must be "flash" or "ram"`);

    const origine = addressAt(entry.origine, `${path}.origine`, errors);
    const dimensione = byteSizeAt(entry.dimensione, `${path}.dimensione`, errors);
    if (nome === null || tipo === null || origine === null || dimensione === null) return;
    if (origine + dimensione > ADDRESS_SPACE_END) {
      errors.push(`${path}.dimensione: region "${nome}" ends past 0xffffffff`);
      return;
    }

    regions.push({ nome, tipo, origine, dimensione });
  });

  if (regions.length > 0) {
    if (!regions.some((region) => region.tipo === "flash")) {
      errors.push(`${at}: at least one "flash" region is required`);
    }
    if (!regions.some((region) => region.tipo === "ram")) {
      errors.push(`${at}: at least one "ram" region is required`);
    }
  }

  const sorted = [...regions].sort((left, right) => left.origine - right.origine);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.origine + previous.dimensione > current.origine) {
      errors.push(
        `${at}: region "${previous.nome}" (${hex(previous.origine)}..${hex(previous.origine + previous.dimensione)}) overlaps region "${current.nome}" (${hex(current.origine)}..${hex(current.origine + current.dimensione)})`,
      );
    }
  }

  return regions;
}

function checkKeys(value: Record<string, unknown>, allowed: string[], path: string, errors: string[]): void {
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
    // Bun ships a YAML parser (Bun >= 1.2.21); cast keeps this working with older type defs.
    const yaml = (Bun as unknown as { YAML?: { parse(source: string): unknown } }).YAML;
    if (!yaml) return { ok: false, errors: ["YAML support requires Bun >= 1.2.21"] };
    parsed = yaml.parse(text);
  } catch (error) {
    return { ok: false, errors: [`YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (!isObject(parsed)) return { ok: false, errors: ["profile: must be a YAML mapping"] };
  checkKeys(parsed, [...TOP_KEYS], "profile", errors);

  const prodotto = stringAt(parsed.prodotto, "prodotto", errors);
  const board =
    parsed.board === undefined ? undefined : (stringAt(parsed.board, "board", errors) ?? undefined);

  let chip: ProductProfile["chip"] | null = null;
  if (!isObject(parsed.chip)) {
    errors.push("chip: must be an object");
  } else {
    // Keep the old names in the allowed set so the error is the migration
    // message, not a generic "unknown field" that hides what to do.
    checkKeys(
      parsed.chip,
      ["famiglia", "regioni", "vettori", "flash_kb", "ram_kb"],
      "chip",
      errors,
    );
    for (const legacy of ["flash_kb", "ram_kb"] as const) {
      if (legacy in parsed.chip) {
        errors.push(
          `chip.${legacy}: deprecated — declare chip.regioni: [{ nome, tipo: flash|ram, origine: 0x..., dimensione: <bytes> }] instead`,
        );
      }
    }
    const famiglia = stringAt(parsed.chip.famiglia, "chip.famiglia", errors);
    const regioni = parseRegions(parsed.chip.regioni, errors);

    let vettori: number | undefined;
    let vettoriValid = parsed.chip.vettori === undefined;
    if (parsed.chip.vettori !== undefined) {
      const parsedVettori = addressAt(parsed.chip.vettori, "chip.vettori", errors);
      if (parsedVettori !== null) {
        vettori = parsedVettori;
        const flash = regioni.find(
          (region) =>
            region.tipo === "flash" &&
            parsedVettori >= region.origine &&
            parsedVettori < region.origine + region.dimensione,
        );
        if (flash === undefined) {
          errors.push(
            `chip.vettori: ${hex(parsedVettori)} is not inside a declared FLASH region`,
          );
        } else {
          vettoriValid = true;
        }
      }
    }

    if (famiglia !== null && regioni.length > 0 && vettoriValid) {
      chip = vettori === undefined ? { famiglia, regioni } : { famiglia, regioni, vettori };
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
    if (BUILD_SYSTEMS.includes(sistema as BuildSystem) && toolchain && comando) {
      build = { sistema: sistema as BuildSystem, toolchain, comando };
    }
  }

  if (build?.sistema === "zephyr-west" && !board) {
    errors.push("board: required when build.sistema is zephyr-west");
  }

  let flash: ProductProfile["flash"] | null = null;
  if (!isObject(parsed.flash)) {
    errors.push("flash: must be an object");
  } else {
    checkKeys(parsed.flash, ["tool", "interfaccia", "target"], "flash", errors);
    const tool = stringAt(parsed.flash.tool, "flash.tool", errors);
    const interfaccia = parsed.flash.interfaccia;
    if (typeof interfaccia !== "string" || !FLASH_INTERFACES.includes(interfaccia as FlashInterface)) {
      errors.push(`flash.interfaccia: must be one of ${FLASH_INTERFACES.join(", ")}`);
    }
    if (tool !== null && !FLASH_TOOLS.includes(tool as FlashTool)) {
      errors.push(`flash.tool: must be one of ${FLASH_TOOLS.join(", ")}`);
    }
    const target =
      parsed.flash.target === undefined
        ? undefined
        : (stringAt(parsed.flash.target, "flash.target", errors) ?? undefined);
    if ((tool === "openocd" || tool === "probe-rs") && !target) {
      errors.push(`flash.target: required when flash.tool is ${tool}`);
    }
    if (
      tool !== null &&
      FLASH_TOOLS.includes(tool as FlashTool) &&
      FLASH_INTERFACES.includes(interfaccia as FlashInterface)
    ) {
      flash = { tool: tool as FlashTool, interfaccia: interfaccia as FlashInterface, target };
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

  let budget: RunBudget = {
    tempo_totale_ms: DEFAULT_RUN_TIME_BUDGET_MS,
    flash_max: DEFAULT_RUN_FLASH_BUDGET,
  };
  if (parsed.budget !== undefined) {
    if (!isObject(parsed.budget)) {
      errors.push("budget: must be an object");
    } else {
      checkKeys(parsed.budget, ["tempo_totale_ms", "flash_max"], "budget", errors);
      if (parsed.budget.tempo_totale_ms !== undefined) {
        const tempo = integerAt(
          parsed.budget.tempo_totale_ms,
          "budget.tempo_totale_ms",
          errors,
          1_000,
          24 * 60 * 60 * 1000,
        );
        if (tempo !== null) budget = { ...budget, tempo_totale_ms: tempo };
      }
      if (parsed.budget.flash_max !== undefined) {
        const flashes = integerAt(parsed.budget.flash_max, "budget.flash_max", errors, 0, 20);
        if (flashes !== null) budget = { ...budget, flash_max: flashes };
      }
    }
  }

  let seriale: SerialConfig | undefined;
  if (parsed.seriale !== undefined) {
    if (!isObject(parsed.seriale)) {
      errors.push("seriale: must be an object");
    } else {
      checkKeys(parsed.seriale, ["porta", "baud", "comando"], "seriale", errors);
      const porta = stringAt(parsed.seriale.porta, "seriale.porta", errors);
      const baud = integerAt(parsed.seriale.baud, "seriale.baud", errors, 300, 4_000_000);
      const comando =
        parsed.seriale.comando === undefined
          ? undefined
          : (stringAt(parsed.seriale.comando, "seriale.comando", errors) ?? undefined);
      if (porta !== null && baud !== null) seriale = { porta, baud, comando };
    }
  }

  let llm: ModelConfig | undefined;
  if (parsed.llm !== undefined) {
    if (!isObject(parsed.llm)) {
      errors.push("llm: must be an object");
    } else {
      checkKeys(parsed.llm, ["provider", "model"], "llm", errors);
      const provider = stringAt(parsed.llm.provider, "llm.provider", errors);
      if (provider !== null && !MODEL_PROVIDERS.includes(provider as ModelRuntimeProvider)) {
        errors.push(`llm.provider: must be one of ${MODEL_PROVIDERS.join(", ")}`);
      }
      const model =
        parsed.llm.model === undefined
          ? undefined
          : (stringAt(parsed.llm.model, "llm.model", errors) ?? undefined);
      if (provider !== null && MODEL_PROVIDERS.includes(provider as ModelRuntimeProvider)) {
        llm = { provider: provider as ModelRuntimeProvider, ...(model === undefined ? {} : { model }) };
      }
    }
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
  if (parsed.criteri !== undefined) {
    if (!Array.isArray(parsed.criteri)) {
      errors.push("criteri: must be an array");
    } else {
      parsed.criteri.forEach((entry, index) => {
        const criterion = parseCriterion(entry, index, errors);
        if (criterion) criteri.push(criterion);
      });
    }
  }

  const tentativi = integerAt(parsed.tentativi_max, "tentativi_max", errors, 1, MAX_ATTEMPTS);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    profile: {
      prodotto: prodotto!,
      board,
      chip: chip!,
      build: build!,
      flash: flash!,
      debug: debug!,
      seriale,
      llm,
      budget,
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

/** Stable ids for the acceptance criteria, used by evidence. */
export function profileCriteria(profile: ProductProfile): { id: string; description: string }[] {
  return profile.criteri.map((criterion, index) => {
    if ("seriale_contiene" in criterion) {
      return {
        id: `seriale_contiene[${index}]`,
        description: `serial output contains "${criterion.seriale_contiene}"`,
      };
    }
    if ("log_non_contiene" in criterion) {
      return {
        id: `log_non_contiene[${index}]`,
        description: `log does not contain ${criterion.log_non_contiene.join(", ")}`,
      };
    }
    return { id: `test_su_target[${index}]`, description: "on-target test passes" };
  });
}
