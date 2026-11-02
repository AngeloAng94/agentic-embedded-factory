import { describe, expect, test } from "bun:test";
import {
  failedRunHint,
  formatKnownIssues,
  mergeKnownIssues,
  parseKnownIssues,
} from "../core/knownIssues";

describe("known_issues.yaml", () => {
  test("parses an exact-text catalogue and round-trips it", () => {
    const parsed = parseKnownIssues(
      [
        "- error: \"undefined reference to `led_init'\"",
        "  hint: implement led_init in the LED block",
        "- error: \"region `FLASH' overflowed by 32 bytes\"",
        "  hint: reduce the image size",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues[0]).toEqual({
      error: "undefined reference to `led_init'",
      hint: "implement led_init in the LED block",
    });

    const again = parseKnownIssues(formatKnownIssues(parsed.issues));
    expect(again).toEqual(parsed);
  });

  test("accepts an empty file and the documented issues wrapper", () => {
    expect(parseKnownIssues("")).toEqual({ ok: true, issues: [] });
    expect(parseKnownIssues("issues:\n  - error: boom\n    hint: inspect boom\n")).toEqual({
      ok: true,
      issues: [{ error: "boom", hint: "inspect boom" }],
    });
  });

  test("rejects malformed entries and duplicate exact errors", () => {
    const malformed = parseKnownIssues("- error: boom\n  hint: 1\n  extra: no\n");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.errors.join(" | ")).toContain("known_issues[0].hint");
      expect(malformed.errors.join(" | ")).toContain("known_issues[0].extra");
    }

    const duplicate = parseKnownIssues(
      "- { error: boom, hint: first }\n- { error: boom, hint: second }\n",
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errors.join(" | ")).toContain("duplicate");
  });

  test("merges by exact error text and never invents a verified fix", () => {
    const merged = mergeKnownIssues(
      [{ error: "boom", hint: "curated hint" }],
      [
        { error: "boom", hint: "new hint must not replace the curated one" },
        { error: "bang", hint: failedRunHint("2026-01-01T00:00:00.000Z", "no repair") },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ error: "boom", hint: "curated hint" });
    expect(merged[1]?.hint).toContain("no verified repair");
  });
});
