import { describe, expect, test } from "bun:test";
import type { RuleFile } from "../core/blockPatch";
import {
  deterministicRepair,
  isSingleEditApart,
  matchKnownIssues,
  parseCompilerDiagnostics,
} from "../agent/deterministicRepair";

const FILE = [
  "#include <stdint.h>",
  "",
  "// [AI_START_APP]",
  "int main(void) {",
  "    led_ini();",
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
        "src/main.c:(.text+0x4): undefined reference to `led_ini'",
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
    expect(diagnostics[1]?.name).toBe("led_ini");
    expect(diagnostics[2]?.detail).toContain("32 bytes");
  });

  test("marks an implicit declaration as such, without calling it a linker symbol", () => {
    const diagnostics = parseCompilerDiagnostics(
      "src/main.c:3:5: warning: implicit declaration of function 'strlen'",
    );
    expect(diagnostics[0]).toMatchObject({
      kind: "undefined-symbol",
      name: "strlen",
      implicit: true,
    });
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
  test("corrects a misspelling to the only declared project symbol, without inventing a body", () => {
    const before = FILE;
    const result = deterministicRepair({
      files,
      anchors: ["APP", "LED"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:(.text+0x4): undefined reference to `led_ini'",
      ),
    });

    expect(result.applied).toBe(true);
    expect(result.kind).toBe("undefined-symbol");
    expect(result.appliedBlocks).toHaveLength(1);
    expect(result.appliedBlocks[0]?.block).toBe("APP");
    expect(result.files[0]?.content).toContain("led_init();");
    expect(result.files[0]?.content).not.toContain("led_ini();");
    expect(result.files[0]?.content.match(/void led_init\(void\) \{\}/g)).toHaveLength(1);

    const start = before.indexOf("// [AI_START_APP]");
    const end = before.indexOf("// [AI_END_APP]");
    const patched = result.files[0]!.content;
    expect(patched.slice(0, start)).toBe(before.slice(0, start));
    expect(patched.slice(patched.indexOf("// [AI_END_APP]"))).toBe(before.slice(end));
  });

  test("adds a standard header for a known implicit declaration, inside a block", () => {
    const source = [
      "// [AI_START_APP]",
      "int main(void) {",
      "    printf(\"hello\");",
      "    return 0;",
      "}",
      "// [AI_END_APP]",
      "",
    ].join("\n");
    const result = deterministicRepair({
      files: [{ path: "src/main.c", content: source }],
      anchors: ["APP"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:3:5: warning: implicit declaration of function 'printf'",
      ),
    });

    expect(result.applied).toBe(true);
    expect(result.kind).toBe("undefined-symbol");
    expect(result.files[0]?.content).toContain("#include <stdio.h>");
    expect(result.appliedBlocks[0]?.block).toBe("APP");
    const start = source.indexOf("// [AI_START_APP]");
    expect(result.files[0]?.content.slice(0, start)).toBe(source.slice(0, start));
  });

  test("does not add an arbitrary or already-present include", () => {
    const missing = deterministicRepair({
      files,
      anchors: ["APP", "LED"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:1:10: fatal error: board.h: No such file or directory",
      ),
    });
    expect(missing.applied).toBe(false);
    expect(missing.kind).toBe("missing-include");
    expect(missing.reason).toContain("would not fix a standard function");
    expect(missing.files).toEqual(files);

    const unknown = deterministicRepair({
      files,
      anchors: ["APP", "LED"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:3:5: warning: implicit declaration of function 'led_ini'",
      ),
    });
    expect(unknown.applied).toBe(false);
    expect(unknown.reason).toContain("not in the fixed standard-header table");

    const already = deterministicRepair({
      files: [
        {
          path: "src/main.c",
          content: "#include <stdio.h>\n// [AI_START_APP]\nint main(void) { printf(\"x\"); }\n// [AI_END_APP]\n",
        },
      ],
      anchors: ["APP"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:3:5: warning: implicit declaration of function 'printf'",
      ),
    });
    expect(already.applied).toBe(false);
    expect(already.reason).toContain("already included");
  });

  test("an undefined symbol with no near declaration is handed to the model unchanged", () => {
    const result = deterministicRepair({
      files,
      anchors: ["APP", "LED"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:(.text+0x4): undefined reference to `missing_function'",
      ),
    });

    expect(result.applied).toBe(false);
    expect(result.kind).toBe("undefined-symbol");
    expect(result.reason).toContain("no existing declared function is one edit away");
    expect(result.files).toEqual(files);
    expect(result.appliedBlocks).toEqual([]);
  });

  test("refuses an ambiguous near match instead of choosing one", () => {
    const ambiguous = FILE.replace(
      "void led_init(void) {}",
      "void led_init(void) {}\nvoid led_ino(void) {}",
    );
    const result = deterministicRepair({
      files: [{ path: "src/main.c", content: ambiguous }],
      anchors: ["APP", "LED"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:(.text+0x4): undefined reference to `led_ini'",
      ),
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("ambiguous");
    expect(result.files[0]?.content).toBe(ambiguous);
  });

  test("corrects a near macro name declared in the project", () => {
    const source = [
      "#define LED_PIN 1",
      "// [AI_START_APP]",
      "int main(void) {",
      "    return LED_PNI;",
      "}",
      "// [AI_END_APP]",
      "",
    ].join("\n");
    const result = deterministicRepair({
      files: [{ path: "src/main.c", content: source }],
      anchors: ["APP"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:(.text+0x4): undefined reference to `LED_PNI'",
      ),
    });
    expect(result.applied).toBe(true);
    expect(result.files[0]?.content).toContain("return LED_PIN;");
  });

  test("refuses a region overflow, an incompatible type and a repeated correction", () => {
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

    const repeated = deterministicRepair({
      files,
      anchors: ["APP", "LED"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:(.text+0x4): undefined reference to `led_ini'",
      ),
      attemptedSymbols: ["led_ini"],
    });
    expect(repeated.applied).toBe(false);
    expect(repeated.reason).toContain("already attempted");
  });

  test("refuses when the symbol is not inside a declared block", () => {
    const result = deterministicRepair({
      files: [{ path: "src/plain.c", content: "void led_init(void) {}\nint main(void) { led_ini(); }\n" }],
      anchors: ["APP"],
      diagnostics: parseCompilerDiagnostics(
        "src/main.c:(.text+0x4): undefined reference to `led_ini'",
      ),
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("does not occur inside a declared editable block");
  });

  test("single-edit distance accepts one insertion, deletion, substitution or swap only", () => {
    expect(isSingleEditApart("led_ini", "led_init")).toBe(true);
    expect(isSingleEditApart("led_init", "led_ini")).toBe(true);
    expect(isSingleEditApart("led_imit", "led_init")).toBe(true);
    expect(isSingleEditApart("led_inti", "led_init")).toBe(true);
    expect(isSingleEditApart("led", "led_init")).toBe(false);
    expect(isSingleEditApart("led_xyz", "led_init")).toBe(false);
  });
});
