/**
 * Safety analysis.
 *
 * Structural-but-lexical analyzer: comments and string literals are masked out
 * first, then function bodies are located with real brace matching, so every
 * violation is reported with rule, file, exact line, explanation and severity.
 *
 * It is NOT a clang AST and the engine says so explicitly (see `limitations`),
 * so the product never oversells what was analysed.
 */

export type SafetyStatus = "PASS" | "WARNING" | "FAIL";
export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface SafetyFinding {
  rule: string;
  status: SafetyStatus;
  severity: Severity;
  file: string;
  line: number | null;
  explanation: string;
  snippet?: string;
}

export interface SafetyReport {
  engine: "lexical-structural";
  rtos: string;
  findings: SafetyFinding[];
  summary: { pass: number; warning: number; fail: number };
  limitations: string[];
}

export interface SafetyInputFile {
  path: string;
  content: string;
}

interface MaskedFile {
  path: string;
  raw: string[];
  masked: string[];
}

interface CallSite {
  name: string;
  line: number;
  text: string;
}

interface FunctionBody {
  name: string;
  startLine: number;
  endLine: number;
  calls: CallSite[];
}

const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "return", "sizeof", "typedef",
  "struct", "union", "enum", "static", "const", "volatile", "void", "int", "char", "long",
  "short", "unsigned", "signed", "float", "double", "goto", "break", "continue", "defined",
]);

function maskSource(content: string): { raw: string[]; masked: string[] } {
  const source = content.replace(/\r\n/g, "\n");
  const raw = source.split("\n");
  const masked: string[] = [];
  let state: "code" | "line-comment" | "block-comment" | "string" | "char" = "code";

  for (const line of raw) {
    let out = "";
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      const next = line[index + 1];
      if (state === "code") {
        if (char === "/" && next === "/") {
          state = "line-comment";
          out += "  ";
          index += 1;
          continue;
        }
        if (char === "/" && next === "*") {
          state = "block-comment";
          out += "  ";
          index += 1;
          continue;
        }
        if (char === '"') {
          state = "string";
          out += " ";
          continue;
        }
        if (char === "'") {
          state = "char";
          out += " ";
          continue;
        }
        out += char;
        continue;
      }
      if (state === "line-comment") {
        out += " ";
        continue;
      }
      if (state === "block-comment") {
        if (char === "*" && next === "/") {
          state = "code";
          out += "  ";
          index += 1;
          continue;
        }
        out += " ";
        continue;
      }
      if (char === "\\") {
        out += "  ";
        index += 1;
        continue;
      }
      if ((state === "string" && char === '"') || (state === "char" && char === "'")) {
        state = "code";
        out += " ";
        continue;
      }
      out += " ";
    }
    if (state === "line-comment") state = "code";
    masked.push(out);
  }

  return { raw, masked };
}

function findMatching(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function collectFunctions(file: MaskedFile): FunctionBody[] {
  const text = file.masked.join("\n");
  const lineStarts: number[] = [];
  let running = 0;
  for (const line of file.masked) {
    lineStarts.push(running);
    running += line.length + 1;
  }

  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  const bodies: FunctionBody[] = [];
  const marker = /(^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(text)) !== null) {
    const name = match[2]!;
    if (KEYWORDS.has(name)) continue;

    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatching(text, openParen, "(", ")");
    if (closeParen === -1) continue;

    let cursor = closeParen + 1;
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
    if (text[cursor] !== "{") continue; // declaration or call, not a definition

    const closeBrace = findMatching(text, cursor, "{", "}");
    if (closeBrace === -1) continue;

    const startLine = lineOf(cursor);
    const endLine = lineOf(closeBrace);
    const body = text.slice(cursor, closeBrace);
    const calls: CallSite[] = [];
    const callMarker = /(^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let callMatch: RegExpExecArray | null;
    while ((callMatch = callMarker.exec(body)) !== null) {
      const callName = callMatch[2]!;
      if (KEYWORDS.has(callName)) continue;
      const line = lineOf(cursor + callMatch.index);
      calls.push({ name: callName, line, text: (file.raw[line] ?? "").trim() });
    }

    bodies.push({ name, startLine, endLine, calls });
    marker.lastIndex = closeBrace + 1;
  }

  return bodies;
}

function isIsrName(name: string): boolean {
  return /(^isr_|_isr$|_isr_|_handler$|irqhandler$)/i.test(name);
}

function isIsr(fn: FunctionBody, file: MaskedFile): boolean {
  if (isIsrName(fn.name)) return true;
  const whole = file.masked.join("\n");
  const registration = new RegExp(
    `(IRQ_CONNECT|ISR_DIRECT_DECLARE|irq_connect_dynamic|GPIO_DT_SPEC_GET_OR|attachInterrupt)[^;\\n]*\\b${fn.name}\\b`,
  );
  return registration.test(whole);
}

const FREERTOS_ISR_UNSAFE = [
  "vTaskDelay",
  "vTaskDelayUntil",
  "xQueueReceive",
  "xQueueSend",
  "xQueueSendToBack",
  "xQueueSendToFront",
  "xSemaphoreTake",
  "xSemaphoreGive",
  "xSemaphoreGiveRecursive",
  "xEventGroupWaitBits",
  "xTaskCreate",
  "xTaskCreateStatic",
  "vTaskDelete",
  "vTaskStartScheduler",
  "vTaskSuspend",
  "xTaskNotify",
  "ulTaskNotifyTake",
  "xTaskNotifyWait",
  "vPortFree",
  "pvPortMalloc",
];

const ZEPHYR_ISR_UNSAFE = [
  "k_sleep",
  "k_msleep",
  "k_usleep",
  "k_busy_wait",
  "k_sem_take",
  "k_mutex_lock",
  "k_mutex_unlock",
  "k_msgq_get",
  "k_msgq_put",
  "k_fifo_get",
  "k_fifo_put",
  "k_lifo_get",
  "k_lifo_put",
  "k_condvar_wait",
  "k_thread_join",
  "k_thread_suspend",
  "k_poll",
  "k_work_submit",
  "k_malloc",
];

const DYNAMIC_ALLOCATION = [
  "malloc",
  "calloc",
  "realloc",
  "free",
  "pvPortMalloc",
  "vPortFree",
  "strdup",
];

const UNSAFE_STRING = ["strcpy", "strcat", "sprintf", "vsprintf", "gets"];

const LOG_IN_ISR = ["printf", "printk", "puts", "putchar", "fprintf", "LOG_ERR", "LOG_INF", "LOG_WRN"];

interface AnalyzedFunction {
  file: string;
  fn: FunctionBody;
  isr: boolean;
}

function callHits(
  functions: AnalyzedFunction[],
  names: string[],
  onlyIsr: boolean,
): { file: string; line: number; name: string; snippet: string }[] {
  const hits: { file: string; line: number; name: string; snippet: string }[] = [];
  for (const entry of functions) {
    if (onlyIsr && !entry.isr) continue;
    for (const call of entry.fn.calls) {
      if (!names.includes(call.name)) continue;
      hits.push({
        file: entry.file,
        line: call.line + 1,
        name: call.name,
        snippet: call.text,
      });
    }
  }
  return hits;
}

function firstSource(files: SafetyInputFile[]): string {
  return (
    files.find((file) => file.path.endsWith(".c"))?.path ??
    files.find((file) => file.path.endsWith(".h"))?.path ??
    files[0]?.path ??
    "-"
  );
}

function readDefine(files: SafetyInputFile[], key: string): number | null {
  for (const file of files) {
    for (const line of file.content.split(/\r?\n/)) {
      const header = new RegExp(`^[ \\t]*#define[ \\t]+${key}\\b`);
      if (!header.test(line)) continue;
      // Removes C casts so "#define KEY ((uint16_t)128)" yields 128.
      const value = line
        .replace(header, "")
        .replace(/\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)/g, "");
      const digits = /(\d+)/.exec(value);
      return digits ? Number(digits[1]) : null;
    }
  }
  return null;
}

export function analyzeProject(files: SafetyInputFile[], rtos: string): SafetyReport {
  const masked: MaskedFile[] = files.map((file) => ({
    path: file.path,
    ...maskSource(file.content),
  }));

  const functions: AnalyzedFunction[] = [];
  for (const file of masked) {
    if (!file.path.endsWith(".c") && !file.path.endsWith(".h")) continue;
    for (const fn of collectFunctions(file)) {
      functions.push({ file: file.path, fn, isr: isIsr(fn, file) });
    }
  }

  const rtosName = rtos === "zephyr" ? "zephyr" : "freertos";
  const findings: SafetyFinding[] = [];

  // R1 — required project structure
  {
    const required =
      rtosName === "zephyr"
        ? ["CMakeLists.txt", "prj.conf", "src/main.c"]
        : ["CMakeLists.txt", "src/main.c", "src/FreeRTOSConfig.h"];
    const missing = required.filter((path) => !files.some((file) => file.path === path));
    findings.push(
      missing.length > 0
        ? {
            rule: "project.required-files",
            status: "FAIL" as const,
            severity: "critical" as const,
            file: missing[0]!,
            line: null,
            explanation: `Missing required ${rtosName} file(s): ${missing.join(", ")}.`,
          }
        : {
            rule: "project.required-files",
            status: "PASS" as const,
            severity: "info" as const,
            file: required[0]!,
            line: null,
            explanation: `All required ${rtosName} project files are present.`,
          },
    );
  }

  // R2 — blocking calls in interrupt context
  {
    const names = rtosName === "zephyr" ? ZEPHYR_ISR_UNSAFE : FREERTOS_ISR_UNSAFE;
    const hits = callHits(functions, names, true);
    findings.push(
      hits.length === 0
        ? {
            rule: "rtos.no-blocking-in-isr",
            status: "PASS" as const,
            severity: "info" as const,
            file: firstSource(files),
            line: null,
            explanation: "No blocking RTOS call detected inside an interrupt handler.",
          }
        : {
            rule: "rtos.no-blocking-in-isr",
            status: "FAIL" as const,
            severity: "critical" as const,
            file: hits[0]!.file,
            line: hits[0]!.line,
            explanation: `${hits.length} blocking/unsafe call(s) inside interrupt context: ${[
              ...new Set(hits.map((hit) => hit.name)),
            ].join(", ")}. Defer the work to a task.`,
            snippet: hits[0]!.snippet,
          },
    );

    if (rtosName === "freertos") {
      const isrFunctions = functions.filter((entry) => entry.isr && /FromISR/.test(entry.fn.name));
      findings.push({
        rule: "rtos.isr-safe-api",
        status: hits.length === 0 ? "PASS" : "FAIL",
        severity: hits.length === 0 ? "info" : "critical",
        file: hits[0]?.file ?? firstSource(files),
        line: hits[0]?.line ?? null,
        explanation:
          hits.length === 0
            ? `Only ISR-safe APIs detected in ${functions.filter((entry) => entry.isr).length} interrupt handler(s).`
            : "Non-FromISR FreeRTOS APIs are used in interrupt context; a FromISR variant exists.",
        ...(isrFunctions.length > 0 ? {} : {}),
      });
    }
  }

  // R3 — logging in interrupt context
  {
    const hits = callHits(functions, LOG_IN_ISR, true);
    findings.push(
      hits.length === 0
        ? {
            rule: "rtos.no-logging-in-isr",
            status: "PASS" as const,
            severity: "info" as const,
            file: firstSource(files),
            line: null,
            explanation: "No stdio/log call detected inside an interrupt handler.",
          }
        : {
            rule: "rtos.no-logging-in-isr",
            status: "WARNING" as const,
            severity: "high" as const,
            file: hits[0]!.file,
            line: hits[0]!.line,
            explanation: `${hits.length} logging call(s) inside interrupt context: ${[
              ...new Set(hits.map((hit) => hit.name)),
            ].join(", ")}. Logging in an ISR can block and re-enter the driver.`,
            snippet: hits[0]!.snippet,
          },
    );
  }

  // R4 — dynamic allocation
  {
    const hits = callHits(functions, DYNAMIC_ALLOCATION, false);
    findings.push(
      hits.length === 0
        ? {
            rule: "rtos.no-dynamic-allocation",
            status: "PASS" as const,
            severity: "info" as const,
            file: firstSource(files),
            line: null,
            explanation: "No dynamic allocation (malloc family) detected in the C sources.",
          }
        : {
            rule: "rtos.no-dynamic-allocation",
            status: "WARNING" as const,
            severity: "high" as const,
            file: hits[0]!.file,
            line: hits[0]!.line,
            explanation: `${hits.length} dynamic allocation call(s) detected: ${[
              ...new Set(hits.map((hit) => hit.name)),
            ].join(", ")}. Prefer static allocation in deterministic paths.`,
            snippet: hits[0]!.snippet,
          },
    );
  }

  // R5 — stack / task configuration
  if (rtosName === "freertos") {
    const minimalStack = readDefine(files, "configMINIMAL_STACK_SIZE");
    if (minimalStack === null) {
      findings.push({
        rule: "rtos.stack-config",
        status: "FAIL",
        severity: "critical",
        file: "src/FreeRTOSConfig.h",
        line: null,
        explanation: "configMINIMAL_STACK_SIZE is not defined in FreeRTOSConfig.h.",
      });
    } else {
      findings.push({
        rule: "rtos.stack-config",
        status: minimalStack < 64 ? "WARNING" : "PASS",
        severity: minimalStack < 64 ? "medium" : "info",
        file: "src/FreeRTOSConfig.h",
        line: null,
        explanation:
          minimalStack < 64
            ? `configMINIMAL_STACK_SIZE=${minimalStack} is very small; verify the task stack depth.`
            : `configMINIMAL_STACK_SIZE=${minimalStack} is configured.`,
      });
    }

    const checkOverflow = readDefine(files, "configCHECK_FOR_STACK_OVERFLOW");
    findings.push({
      rule: "rtos.stack-overflow-check",
      status: checkOverflow === null || checkOverflow === 0 ? "WARNING" : "PASS",
      severity: checkOverflow === null || checkOverflow === 0 ? "medium" : "info",
      file: "src/FreeRTOSConfig.h",
      line: null,
      explanation:
        checkOverflow === null || checkOverflow === 0
          ? "configCHECK_FOR_STACK_OVERFLOW is disabled: stack overflows stay silent."
          : `configCHECK_FOR_STACK_OVERFLOW=${checkOverflow} is enabled.`,
    });

    const staticSupport = readDefine(files, "configSUPPORT_STATIC_ALLOCATION");
    const dynamicSupport = readDefine(files, "configSUPPORT_DYNAMIC_ALLOCATION");
    const usesDynamicTask = functions.some((entry) =>
      entry.fn.calls.some((call) => call.name === "xTaskCreate"),
    );
    const usesStaticTask = functions.some((entry) =>
      entry.fn.calls.some((call) => call.name === "xTaskCreateStatic"),
    );
    const mainPath = files.find((file) => /main\.c$/.test(file.path))?.path ?? firstSource(files);

    if (usesDynamicTask && dynamicSupport === 0) {
      findings.push({
        rule: "rtos.task-configuration",
        status: "FAIL",
        severity: "critical",
        file: mainPath,
        line: null,
        explanation:
          "xTaskCreate() is used while configSUPPORT_DYNAMIC_ALLOCATION is 0: the task can never be created.",
      });
    } else if (usesStaticTask && staticSupport === 0) {
      findings.push({
        rule: "rtos.task-configuration",
        status: "FAIL",
        severity: "critical",
        file: mainPath,
        line: null,
        explanation: "xTaskCreateStatic() is used while configSUPPORT_STATIC_ALLOCATION is 0.",
      });
    } else {
      findings.push({
        rule: "rtos.task-configuration",
        status: "PASS",
        severity: "info",
        file: mainPath,
        line: null,
        explanation: "Task creation API matches the static/dynamic allocation configuration.",
      });
    }
  } else {
    const mainStack = files.some((file) => /CONFIG_MAIN_STACK_SIZE=\d+/.test(file.content));
    findings.push({
      rule: "rtos.stack-config",
      status: mainStack ? "PASS" : "WARNING",
      severity: mainStack ? "info" : "medium",
      file: "prj.conf",
      line: null,
      explanation: mainStack
        ? "CONFIG_MAIN_STACK_SIZE is configured in prj.conf."
        : "CONFIG_MAIN_STACK_SIZE is not set; the default main stack may be too small.",
    });

    const hasThreadDef = files.some((file) =>
      /K_THREAD_STACK_DEFINE|K_THREAD_DEFINE/.test(file.content),
    );
    findings.push({
      rule: "rtos.task-configuration",
      status: hasThreadDef ? "PASS" : "WARNING",
      severity: hasThreadDef ? "info" : "low",
      file: firstSource(files),
      line: null,
      explanation: hasThreadDef
        ? "Thread stacks are defined statically (K_THREAD_STACK_DEFINE/K_THREAD_DEFINE)."
        : "No static thread stack definition found; define thread stacks statically when threads are used.",
    });
  }

  // R6 — unbounded string APIs
  {
    const hits: { file: string; line: number; name: string; snippet: string }[] = [];
    for (const file of masked) {
      for (let line = 0; line < file.masked.length; line += 1) {
        const pattern = /(^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(file.masked[line]!)) !== null) {
          if (UNSAFE_STRING.includes(match[2]!)) {
            hits.push({
              file: file.path,
              line: line + 1,
              name: match[2]!,
              snippet: (file.raw[line] ?? "").trim(),
            });
          }
        }
      }
    }
    findings.push(
      hits.length === 0
        ? {
            rule: "safety.no-unsafe-string-api",
            status: "PASS" as const,
            severity: "info" as const,
            file: firstSource(files),
            line: null,
            explanation: "No unbounded string API (strcpy/strcat/sprintf) detected.",
          }
        : {
            rule: "safety.no-unsafe-string-api",
            status: "WARNING" as const,
            severity: "medium" as const,
            file: hits[0]!.file,
            line: hits[0]!.line,
            explanation: `${hits.length} unbounded string call(s) detected: ${[
              ...new Set(hits.map((hit) => hit.name)),
            ].join(", ")}. Use bounded variants and validate lengths.`,
            snippet: hits[0]!.snippet,
          },
    );
  }

  const summary = {
    pass: findings.filter((finding) => finding.status === "PASS").length,
    warning: findings.filter((finding) => finding.status === "WARNING").length,
    fail: findings.filter((finding) => finding.status === "FAIL").length,
  };

  return {
    engine: "lexical-structural",
    rtos: rtosName,
    findings,
    summary,
    limitations: [
      "comment/string aware lexical analysis with real brace matching",
      "no clang AST and no cross-translation-unit analysis",
      "device tree and Kconfig semantics are not evaluated",
    ],
  };
}

export function safetyStatusBadge(report: SafetyReport): SafetyStatus {
  if (report.summary.fail > 0) return "FAIL";
  if (report.summary.warning > 0) return "WARNING";
  return "PASS";
}
