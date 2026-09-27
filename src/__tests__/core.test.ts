import { describe, expect, test } from "bun:test";
import { applyUnifiedDiff, formatUnifiedDiff, parseUnifiedDiff } from "../lib/core/diff";
import { describeRejection, isPathAllowed } from "../lib/core/pathSafety";
import {
  buildHeadline,
  isVerifiedSuccess,
  projectStatusFor,
  statusBadge,
  formatBuildReport,
  notAvailable,
  realResult,
  simulated,
} from "../lib/core/buildStatus";
import { normalizeRunnerResult, resolveRunnerConfig } from "../lib/core/buildDispatch";
import { detectBoard, detectProjectName, detectRtos } from "../lib/core/rtos";
import { formatKnowledgeBlock, retrieveKnowledge, type KbDocument } from "../lib/core/knowledge";
import { analyzeProject, safetyStatusBadge } from "../lib/core/safety";
import { parseAgentResponse, buildTurnPrompt, describePlan } from "../lib/core/agentProtocol";

describe("unified diff", () => {
  const original = ["int main(void) {", "    return 0;", "}", ""].join("\n");

  test("applies a valid patch", () => {
    const diff = [
      "--- a/src/main.c",
      "+++ b/src/main.c",
      "@@ -1,3 +1,4 @@",
      " int main(void) {",
      "+    init();",
      "     return 0;",
      " }",
    ].join("\n");

    const outcome = applyUnifiedDiff(original, diff);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.content).toContain("init();");
  });

  test("rejects a patch whose context does not match, with the line number", () => {
    const diff = [
      "--- a/src/main.c",
      "+++ b/src/main.c",
      "@@ -1,3 +1,4 @@",
      " int other_function(void) {",
      "+    init();",
      " }",
    ].join("\n");

    const outcome = applyUnifiedDiff(original, diff);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("PATCH_FAILED");
      expect(outcome.reason).toMatch(/line 1/);
    }
    // The file is not returned at all, so a caller can never write a corrupt file.
    expect(Object.keys(outcome)).not.toContain("content");
  });

  test("rejects empty diffs, diffs without hunks and overlapping hunks", () => {
    expect(applyUnifiedDiff(original, "").ok).toBe(false);
    expect(applyUnifiedDiff(original, "--- a/x\n+++ b/x\n").ok).toBe(false);
    const overlapping = [
      "--- a/src/main.c",
      "+++ b/src/main.c",
      "@@ -2,2 +2,2 @@",
      "-    return 0;",
      "+    return 1;",
      "@@ -1,1 +1,2 @@",
      "+// comment",
    ].join("\n");
    const outcome = applyUnifiedDiff(original, overlapping);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/overlaps/);
  });

  test("parseUnifiedDiff reports the path declared in the header", () => {
    const parsed = parseUnifiedDiff(
      ["--- a/src/other.c", "+++ b/src/other.c", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.parsed.filePath).toBe("src/other.c");
  });

  test("formatUnifiedDiff produces a patch that round-trips", () => {
    const after = ["int main(void) {", "    init();", "    return 0;", "}", ""].join("\n");
    const diff = formatUnifiedDiff("src/main.c", original, after);
    const outcome = applyUnifiedDiff(original, diff);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.content).toBe(after);
  });
});

describe("path sandbox", () => {
  test("allows the documented project paths", () => {
    for (const path of [
      "src/main.c",
      "src/drivers/led.c",
      "include/config.h",
      "tests/test_main.c",
      "CMakeLists.txt",
      "prj.conf",
      "README.md",
      ".gitignore",
      "boards/nucleo.overlay",
    ]) {
      expect(isPathAllowed(path), path).toBe(true);
    }
  });

  test("rejects traversal, absolute paths and foreign directories", () => {
    for (const path of [
      "../etc/passwd",
      "/etc/passwd",
      "src/../../etc/passwd",
      "~/secrets.c",
      "C:/windows/system32/x.c",
      "docs/readme.md",
      "src/main",
      "src/payload.exe",
      ".git/config",
      "src\\..\\evil.c",
    ]) {
      expect(isPathAllowed(path), path).toBe(false);
      expect(describeRejection(path).length, path).toBeGreaterThan(0);
    }
  });
});

describe("build status honesty model", () => {
  test("only a real, zero-exit process is verified", () => {
    const success = realResult({
      command: "west build -b x",
      exitCode: 0,
      durationMs: 18400,
      stdout: "building",
      stderr: "",
      artifacts: ["build/zephyr/zephyr.elf"],
    });

    expect(isVerifiedSuccess(success)).toBe(true);
    expect(statusBadge(success)).toBe("REAL · SUCCESS");
    expect(projectStatusFor(success)).toBe("verified");
    expect(formatBuildReport(success)).toContain("build/zephyr/zephyr.elf");
  });

  test("a real failure is not a success and fails the project", () => {
    const failure = realResult({
      command: "west build",
      exitCode: 1,
      durationMs: 900,
      stdout: "",
      stderr: "src/main.c:3:5: error: 'foo' undeclared",
    });
    expect(isVerifiedSuccess(failure)).toBe(false);
    expect(projectStatusFor(failure)).toBe("failed");
    expect(buildHeadline(failure)).toContain("verdict=FAILURE");
  });

  test("missing toolchain and simulations never verify anything", () => {
    const missing = notAvailable("toolchain unavailable: west not found", "west build");
    expect(missing.verification).toBe("NOT_AVAILABLE");
    expect(missing.verdict).toBe("UNKNOWN");
    expect(isVerifiedSuccess(missing)).toBe(false);
    expect(projectStatusFor(missing)).toBe("unverified");

    const fake = simulated("no compiler invoked");
    expect(isVerifiedSuccess(fake)).toBe(false);
    expect(formatBuildReport(fake)).toContain("SIMULATED — no compiler invoked");
  });

  test("a runner claiming SUCCESS without real evidence is downgraded", () => {
    const downgraded = normalizeRunnerResult({
      verification: "SIMULATED",
      verdict: "SUCCESS",
      exitCode: 0,
      stdout: "all good",
    });
    expect(downgraded?.verdict).toBe("UNKNOWN");
    expect(downgraded?.reason).toMatch(/claimed SUCCESS without a real successful process/);

    const bogus = normalizeRunnerResult({ verification: "TOTALLY_REAL", verdict: "SUCCESS" });
    expect(bogus).toBeNull();

    const real = normalizeRunnerResult({
      verification: "REAL",
      verdict: "SUCCESS",
      exitCode: 0,
      command: "west build",
    });
    expect(real?.verdict).toBe("SUCCESS");
  });

  test("runner configuration comes from the environment", () => {
    expect(resolveRunnerConfig({}).url).toBeNull();
    expect(resolveRunnerConfig({ BUILD_RUNNER_URL: "http://host:8790/" }).url).toBe(
      "http://host:8790",
    );
  });
});

describe("RTOS detection", () => {
  test("detects zephyr, freertos and ambiguity", () => {
    expect(detectRtos("build a Zephyr project for a Nucleo board")).toBe("zephyr");
    expect(detectRtos("use FreeRTOS with a static task")).toBe("freertos");
    expect(detectRtos("compare Zephyr and FreeRTOS")).toBeNull();
    expect(detectRtos("compare Zephyr and FreeRTOS", "zephyr")).toBe("zephyr");
    expect(detectRtos("hello")).toBeNull();
  });

  test("detects board, mcu and project name", () => {
    expect(detectBoard("board: nucleo_l476rg")).toBe("nucleo_l476rg");
    expect(detectBoard("target the STM32F407 discovery")).toBe("stm32f407");
    expect(detectBoard("use the NUCLEO-L476RG")).toBe("nucleo-l476rg");
    expect(detectProjectName('Build "sensor_hub" firmware for Zephyr', "zephyr")).toBe("sensor_hub");
    expect(detectProjectName("x", "zephyr")).toBe("zephyr_project");
  });
});

describe("knowledge retrieval", () => {
  const docs: KbDocument[] = [
    {
      _id: "kb:1",
      rtos: "zephyr",
      category: "pattern",
      title: "Zephyr GPIO interrupt pattern",
      content: "k_work_submit from the ISR and defer blocking work to a workqueue.",
      tags: ["zephyr", "gpio", "isr", "workqueue"],
    },
    {
      _id: "kb:2",
      rtos: "zephyr",
      category: "checklist",
      title: "Zephyr RTOS Checklist",
      content: "Define thread stacks statically and verify CONFIG_MAIN_STACK_SIZE.",
      tags: ["zephyr", "stack"],
    },
    {
      _id: "kb:3",
      rtos: "freertos",
      category: "pattern",
      title: "FreeRTOS static task pattern",
      content: "xTaskCreateStatic with a StaticTask_t buffer.",
      tags: ["freertos", "task"],
    },
    {
      _id: "kb:4",
      rtos: "general",
      category: "best_practice",
      title: "Embedded Safety Rules",
      content: "Avoid malloc in real-time paths; keep ISRs short.",
      tags: ["safety"],
    },
  ];

  test("filters by RTOS, scores by tags and respects the budget", () => {
    const result = retrieveKnowledge(docs, {
      rtos: "zephyr",
      userRequest: "add an ISR that uses the workqueue for the gpio button",
      budgetTokens: 800,
    });

    expect(result.docs.length).toBeGreaterThan(0);
    expect(result.docs[0]!.id).toBe("kb:1");
    expect(result.skippedOtherRtos).toBe(1);
    expect(result.docs.some((doc) => doc.id === "kb:3")).toBe(false);
    expect(result.log).toContain("considered=");
    expect(result.log).toContain("kb:1");
    expect(formatKnowledgeBlock(result.docs)).toContain("Zephyr GPIO interrupt pattern");
  });

  test("a tiny budget injects fewer fragments", () => {
    const wide = retrieveKnowledge(docs, { rtos: "zephyr", userRequest: "stack isr", budgetTokens: 800 });
    const narrow = retrieveKnowledge(docs, { rtos: "zephyr", userRequest: "stack isr", budgetTokens: 10 });
    expect(narrow.usedTokens).toBeLessThanOrEqual(10);
    expect(narrow.docs.length).toBeLessThanOrEqual(wide.docs.length);
  });
});

describe("safety analysis", () => {
  const zephyrFiles = [
    { path: "CMakeLists.txt", content: "cmake_minimum_required(VERSION 3.20)\n" },
    { path: "prj.conf", content: "CONFIG_MAIN_STACK_SIZE=2048\n" },
    {
      path: "src/main.c",
      content: [
        "#include <zephyr/kernel.h>",
        "static void button_isr(const void *arg) {",
        "    k_sleep(K_MSEC(10));",
        "}",
        "int main(void) { return 0; }",
        "",
      ].join("\n"),
    },
  ];

  test("flags a blocking call inside an ISR with rule, line and severity", () => {
    const report = analyzeProject(zephyrFiles, "zephyr");
    const finding = report.findings.find((item) => item.rule === "rtos.no-blocking-in-isr");
    expect(finding?.status).toBe("FAIL");
    expect(finding?.file).toBe("src/main.c");
    expect(finding?.line).toBe(3);
    expect(finding?.severity).toBe("critical");
    expect(safetyStatusBadge(report)).toBe("FAIL");
    expect(report.engine).toBe("lexical-structural");
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  test("comments and string literals never trigger a rule", () => {
    const files = zephyrFiles.map((file) =>
      file.path === "src/main.c"
        ? {
            path: file.path,
            content: [
              "#include <zephyr/kernel.h>",
              "static void button_isr(const void *arg) {",
              "    /* k_sleep(K_MSEC(10)); */",
              '    const char *msg = "k_msleep(1000)";',
              "    (void)msg; (void)arg;",
              "}",
              "int main(void) { return 0; }",
              "",
            ].join("\n"),
          }
        : file,
    );

    const report = analyzeProject(files, "zephyr");
    const finding = report.findings.find((item) => item.rule === "rtos.no-blocking-in-isr");
    expect(finding?.status).toBe("PASS");
  });

  test("dynamic allocation is reported as a warning", () => {
    const report = analyzeProject(
      [
        { path: "prj.conf", content: "CONFIG_MAIN_STACK_SIZE=2048\n" },
        { path: "CMakeLists.txt", content: "project(x)\n" },
        {
          path: "src/main.c",
          content: "#include <stdlib.h>\nint main(void) { char *p = malloc(16); free(p); return 0; }\n",
        },
      ],
      "zephyr",
    );
    const finding = report.findings.find((item) => item.rule === "rtos.no-dynamic-allocation");
    expect(finding?.status).toBe("WARNING");
    expect(finding?.line).toBe(2);
  });

  test("missing required files and unsafe string APIs are reported", () => {
    const report = analyzeProject(
      [{ path: "src/main.c", content: "int main(void){ char b[4]; strcpy(b, \"abcdef\"); return 0; }\n" }],
      "zephyr",
    );
    const required = report.findings.find((item) => item.rule === "project.required-files");
    expect(required?.status).toBe("FAIL");
    const unsafe = report.findings.find((item) => item.rule === "safety.no-unsafe-string-api");
    expect(unsafe?.status).toBe("WARNING");
    expect(unsafe?.file).toBe("src/main.c");
  });

  test("FreeRTOS configuration mismatches and ISR APIs are detected", () => {
    const report = analyzeProject(
      [
        { path: "CMakeLists.txt", content: "project(x)\n" },
        {
          path: "src/FreeRTOSConfig.h",
          content: [
            "#define configMINIMAL_STACK_SIZE ((uint16_t)128)",
            "#define configSUPPORT_STATIC_ALLOCATION 1",
            "#define configSUPPORT_DYNAMIC_ALLOCATION 0",
            "#define configCHECK_FOR_STACK_OVERFLOW 2",
            "",
          ].join("\n"),
        },
        {
          path: "src/main.c",
          content: [
            '#include "FreeRTOS.h"',
            '#include "task.h"',
            "void EXTI0_IRQHandler(void) {",
            "    xQueueSend(queue, &event, 0);",
            "}",
            "int main(void) { xTaskCreate(task, \"t\", 128, NULL, 1, &h); }",
            "",
          ].join("\n"),
        },
      ],
      "freertos",
    );

    const isr = report.findings.find((item) => item.rule === "rtos.no-blocking-in-isr");
    expect(isr?.status).toBe("FAIL");
    expect(isr?.line).toBe(4);

    const taskConfig = report.findings.find((item) => item.rule === "rtos.task-configuration");
    expect(taskConfig?.status).toBe("FAIL");

    const stack = report.findings.find((item) => item.rule === "rtos.stack-config");
    expect(stack?.status).toBe("PASS");
  });
});

describe("agent wire protocol", () => {
  test("parses a fenced JSON answer with prose around it", () => {
    const answer = [
      "Sure! Here is the plan:",
      "```json",
      JSON.stringify({
        summary: "add an LED driver",
        creates: [{ path: "src/led.c", content: "void led_init(void){}\n" }],
        patches: [{ path: "src/main.c", diff: "@@ -1,1 +1,1 @@\n-a\n+b" }],
        requestBuild: true,
      }),
      "```",
    ].join("\n");

    const parsed = parseAgentResponse(answer);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.plan.creates).toHaveLength(1);
      expect(parsed.plan.patches).toHaveLength(1);
      expect(parsed.plan.requestBuild).toBe(true);
      expect(describePlan(parsed.plan)).toContain("src/led.c");
    }
  });

  test("rejects answers without a usable JSON object", () => {
    const noJson = parseAgentResponse("I cannot help with that.");
    expect(noJson.ok).toBe(false);
    if (!noJson.ok) expect(noJson.code).toBe("LLM_BAD_RESPONSE");

    const brokenJson = parseAgentResponse("Here: {summary: 'x',}");
    expect(brokenJson.ok).toBe(false);

    const emptyPlan = parseAgentResponse(JSON.stringify({ summary: "", creates: [], patches: [] }));
    expect(emptyPlan.ok).toBe(false);
    if (!emptyPlan.ok) expect(emptyPlan.code).toBe("PLAN_EMPTY");
  });

  test("answers with no operations are marked answerOnly", () => {
    const parsed = parseAgentResponse(JSON.stringify({ message: "just a question", requestBuild: false }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.plan.answerOnly).toBe(true);
      expect(parsed.plan.summary).toBe("just a question");
    }
  });

  test("the turn prompt carries knowledge and compiler errors", () => {
    const prompt = buildTurnPrompt({
      project: { name: "demo", rtos: "zephyr", board: "nucleo", mcu: null },
      files: [{ path: "src/main.c", content: "int main(void){return 0;}" }],
      knowledge: "### Zephyr checklist\nuse k_work_submit",
      userRequest: "add an ISR",
      buildResult: realResult({
        command: "west build",
        exitCode: 1,
        durationMs: 12,
        stdout: "",
        stderr: "src/main.c:3:5: error: 'foo' undeclared",
      }),
      attempt: 2,
    });

    expect(prompt).toContain("k_work_submit");
    expect(prompt).toContain("'foo' undeclared");
    expect(prompt).toContain("REPAIR ATTEMPT: 2 of 3");
    expect(prompt).toContain("BEGIN src/main.c");
  });
});
