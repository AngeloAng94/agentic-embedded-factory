import { describe, expect, test } from "bun:test";
import { applyBlockEdit, applyBlockEdits, type RuleFile } from "../core/blockPatch";

const FILE = [
  "#include <stdint.h>",
  "",
  "// [AI_START_APP]",
  "int main(void) {",
  "    return 0;",
  "}",
  "// [AI_END_APP]",
  "",
  "// [AI_START_LED]",
  "void led_init(void) {}",
  "// [AI_END_LED]",
  "",
].join("\n");

const files: RuleFile[] = [
  { path: "src/main.c", content: FILE },
  { path: "src/other.c", content: "// [AI_START_APP]\nvoid other(void) {}\n// [AI_END_APP]\n" },
];

const BODY = ["int main(void) {", "    led_init();", "    return 0;", "}"].join("\n");

describe("block patch — inside the markers", () => {
  test("replaces only the block body and keeps everything else byte for byte", () => {
    const result = applyBlockEdit(FILE, "APP", BODY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toContain("led_init();");
    expect(result.content.startsWith("#include <stdint.h>\n\n// [AI_START_APP]\n")).toBe(true);
    expect(result.content.endsWith("// [AI_END_APP]\n\n// [AI_START_LED]\nvoid led_init(void) {}\n// [AI_END_LED]\n")).toBe(true);

    // The untouched prefix and suffix are exactly the original slices.
    const start = FILE.indexOf("// [AI_START_APP]");
    const end = FILE.indexOf("// [AI_END_APP]");
    expect(result.content.slice(0, start)).toBe(FILE.slice(0, start));
    const endInResult = result.content.indexOf("// [AI_END_APP]");
    expect(result.content.slice(endInResult)).toBe(FILE.slice(end));
  });

  test("preserves CRLF line endings", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const result = applyBlockEdit(crlf, "APP", BODY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("\r\n// [AI_END_APP]");
      expect(result.content.replace(/\r\n/g, "")).not.toContain("\n");
    }
  });

  test("rejects a missing anchor", () => {
    const result = applyBlockEdit("int main(void) { return 0; }\n", "APP", BODY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ANCHOR_MISSING");
  });

  test("rejects duplicate markers", () => {
    const doubled = `${FILE}\n// [AI_START_APP]\n// [AI_END_APP]\n`;
    const result = applyBlockEdit(doubled, "APP", BODY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ANCHOR_MISSING");
  });

  test("rejects content that tries to inject markers", () => {
    const result = applyBlockEdit(FILE, "APP", `${BODY}\n// [AI_END_APP]\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MARKER_IN_CONTENT");
  });

  test("rejects touching a nested block", () => {
    const nested = "// [AI_START_APP]\n// [AI_START_LED]\nvoid x(void) {}\n// [AI_END_LED]\n// [AI_END_APP]\n";
    const result = applyBlockEdit(nested, "APP", BODY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("BLOCK_NESTED");
  });

  test("writes into an existing empty block (markers back to back)", () => {
    const empty = "// [AI_START_APP]\n// [AI_END_APP]\n";
    const result = applyBlockEdit(empty, "APP", "int main(void) { return 0; }");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("// [AI_START_APP]\nint main(void) { return 0; }\n// [AI_END_APP]\n");
    }
  });

  test("rejects an empty new body even when the block is empty", () => {
    const empty = "// [AI_START_APP]\n// [AI_END_APP]\n";
    const result = applyBlockEdit(empty, "APP", "  \n \n");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EMPTY_BLOCK");
  });

  test("rejects an empty body for a non-empty block too", () => {
    const result = applyBlockEdit(FILE, "APP", "  \n ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EMPTY_BLOCK");
  });
});

describe("block patch — whole plan", () => {
  test("applies every edit when all of them are valid", () => {
    const result = applyBlockEdits(
      files,
      [
        { path: "src/main.c", block: "APP", content: BODY },
        { path: "src/other.c", block: "APP", content: "void other(void) { led_init(); }" },
      ],
      ["APP", "LED"],
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toHaveLength(2);
      expect(result.files.find((file) => file.path === "src/other.c")?.content).toContain("led_init()");
    }
  });

  test("is all-or-nothing: one bad edit applies nothing", () => {
    const result = applyBlockEdits(
      files,
      [
        { path: "src/main.c", block: "APP", content: BODY },
        { path: "src/main.c", block: "NOPE", content: "x" },
      ],
      ["APP", "LED"],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.code).toBe("BLOCK_NOT_DECLARED");
    }
  });

  test("rejects an undeclared block even when the markers exist", () => {
    const result = applyBlockEdits(files, [{ path: "src/main.c", block: "LED", content: "void led(void) {}" }], ["APP"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed[0]?.code).toBe("BLOCK_NOT_DECLARED");
  });

  test("rejects an edit to a file that does not exist", () => {
    const result = applyBlockEdits(files, [{ path: "src/missing.c", block: "APP", content: BODY }], ["APP"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed[0]?.code).toBe("FILE_NOT_FOUND");
  });

  test("rejects the same block edited twice", () => {
    const result = applyBlockEdits(
      files,
      [
        { path: "src/main.c", block: "APP", content: BODY },
        { path: "src/main.c", block: "APP", content: "int main(void) { return 1; }" },
      ],
      ["APP"],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed.some((failure) => failure.code === "DUPLICATE_EDIT")).toBe(true);
  });
});
