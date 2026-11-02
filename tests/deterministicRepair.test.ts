import { describe, expect, test } from "bun:test";
import type { RuleFile } from "../core/blockPatch";
import {
  deterministicRepair,
  matchKnownIssues,
  parseCompilerDiagnostics,
} from "../agent/deterministicRepair";

const FILE = [
  "#include <stdint.h>",
  "",
  "// [AI_START_APP]",
  "int main(void) {",
  "    led_init();",
  "    return 0;",
  "}",
  "// [AI_END_APP]",
  "",
  "// [AI_START_LED]",
  "void led_init(void) {}",
  "// [AI_END_LED]",
  "",
].join("\n");

const files: RuleFile[] = [{ path: "src/main.c", content: FILE }];

describe("compiler diagnostics", () => {
  test("recognizes linker and compiler errors in a deterministic priority order", () => {
    const diagnostics = parseCompilerDiagnostics(
      [
        "src/main.c:(.text+0x4): undefined reference to `led_init'",
        "src/main.c:1:10: fatal error: board.h: No such file or directory",
        "region `FLASH' overflowed by 32 bytes",
        "src/main.c:9:5: error: incompatible type for argument 1 of 'foo'",
      ].join("\n"),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      "missing-include",
      "undefined-symbol",
      "region-overflow",
      "incompatible-type",
    ]);
    expect(diagnostics[0]?.name).toBe("board.h");
    expect(diagnostics[1]?.name).toBe("led_init");
    expect(diagnostics[2]?.detail).toContain("32 bytes");
  });

  test("recognizes implicit function declarations as an undefined symbol", () => {
    const diagnostics = parseCompilerDiagnostics(
      "src/main.c:3:5: warning: implicit declaration of function 'led_init'",
    );
    expect(diagnostics[0]).toMatchObject({ kind: "undefined-symbol", name: "led_init" });
  });

  test("known-issue matching is exact text, never fuzzy", () => {
    const issues = [
      { error: "undefined reference to `led_init'", hint: "implement led_init in LED" },
      { error: "undefined reference to `other'", hint: "unused" },
    ];
    expect(matchKnownIssues("src/main.c: undefined reference to `led_init'", issues)).toEqual([
      issues[0],
    ]);
    expect(matchKnownIssues("undefined reference to `led_init_extra'", issues)).toEqual([]);
  });
});

describe("deterministic repair ring", () => {
  test("stubs an undefined symbol inside the declared APP block only", () => {
    const before = FILE;
    const result = deterministicRepair({
      files,
      anchors: ["APP", "LED"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:(.text+0x4): undefined reference to `led_init'",
      ),
    });

    expect(result.applied).toBe(true);
    expect(result.kind).toBe("undefined-symbol");
    expect(result.appliedBlocks).toHaveLength(1);
    expect(result.appliedBlocks[0]?.block).toBe("APP");
    expect(result.files[0]?.content).toContain("void led_init(void) {}");

    const start = before.indexOf("// [AI_START_APP]");
    const end = before.indexOf("// [AI_END_APP]");
    const patched = result.files[0]!.content;
    expect(patched.slice(0, start)).toBe(before.slice(0, start));
    expect(patched.slice(patched.indexOf("// [AI_END_APP]"))).toBe(before.slice(end));
    expect(patched.match(/void led_init\(void\) \{\}/g)).toHaveLength(2);
  });

  test("does not apply an include fix outside the marked blocks", () => {
    const result = deterministicRepair({
      files,
      anchors: ["APP", "LED"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:1:10: fatal error: board.h: No such file or directory",
      ),
    });

    expect(result.applied).toBe(false);
    expect(result.kind).toBe("missing-include");
    expect(result.reason).toContain("outside the marked blocks");
    expect(result.files).toEqual(files);
    expect(result.appliedBlocks).toEqual([]);
  });

  test("refuses a region overflow and an incompatible type", () => {
    const overflow = deterministicRepair({
      files,
      anchors: ["APP"],
      diagnostics: parseCompilerDiagnostics("region `FLASH' overflowed by 32 bytes"),
    });
    expect(overflow.applied).toBe(false);
    expect(overflow.reason).toContain("linker/layout");

    const incompatible = deterministicRepair({
      files,
      anchors: ["APP"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:9:5: error: incompatible type for argument 1 of 'foo'",
      ),
    });
    expect(incompatible.applied).toBe(false);
    expect(incompatible.reason).toContain("cannot be fixed safely");
  });

  test("does not repeat a stub that already failed", () => {
    const result = deterministicRepair({
      files,
      anchors: ["APP"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:(.text+0x4): undefined reference to `led_init'",
      ),
      attemptedSymbols: ["led_init"],
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("already attempted");
  });

  test("refuses when no declared block exists", () => {
    const result = deterministicRepair({
      files: [{ path: "src/plain.c", content: "int main(void) { return 0; }\n" }],
      anchors: ["APP"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:(.text+0x4): undefined reference to `led_init'",
      ),
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("no declared editable block");
  });
});
