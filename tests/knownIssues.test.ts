import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveKnownIssueProposals,
  failedRunHint,
  formatKnownIssueProposals,
  formatKnownIssues,
  mergeKnownIssues,
  parseKnownIssueProposals,
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

  test("pending proposals round-trip and are separate from the catalogue", () => {
    const proposals = [
      {
        error: "undefined reference to `missing_function'",
        context: "attempt 3; build: fake build; stop: repair limit",
        runId: "run-6d-failure",
      },
      { error: "boom", context: "attempt 1; flash failed", runId: "run-2" },
    ];
    const parsed = parseKnownIssueProposals(formatKnownIssueProposals(proposals));
    expect(parsed).toEqual({ ok: true, proposals });
    expect(parseKnownIssueProposals("")).toEqual({ ok: true, proposals: [] });

    const bad = parseKnownIssueProposals("- error: boom\n  context: x\n");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" | ")).toContain("run_id");
  });

  test("approval moves only the selected proposals into the catalogue", () => {
    const pending = [
      { error: "boom", context: "attempt 1", runId: "run-1" },
      { error: "bang", context: "attempt 2", runId: "run-2" },
    ];
    const approved = approveKnownIssueProposals({
      catalog: [{ error: "curated", hint: "keep me" }],
      pending,
      selector: { index: 1 },
      hint: "inspect the first failure",
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.catalog).toEqual([
      { error: "curated", hint: "keep me" },
      { error: "boom", hint: "inspect the first failure" },
    ]);
    expect(approved.remaining).toEqual([pending[1]!]);
    expect(approved.approved).toEqual([pending[0]!]);

    const byRun = approveKnownIssueProposals({
      catalog: [],
      pending,
      selector: { runId: "run-2" },
    });
    expect(byRun.ok).toBe(true);
    if (byRun.ok) expect(byRun.catalog[0]?.hint).toBe("attempt 2");
  });

  test("the human approval CLI updates the catalogue and leaves no approved proposal", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "py-bench-approve-"));
    try {
      mkdirSync(path.join(dir, ".pokayoke"));
      const pendingPath = path.join(dir, ".pokayoke", "known_issues.pending.yaml");
      writeFileSync(
        pendingPath,
        formatKnownIssueProposals([
          { error: "boom", context: "attempt 1", runId: "run-1" },
        ]),
      );
      const cli = path.resolve(import.meta.dir, "../tools/knownIssues/index.ts");
      const result = Bun.spawnSync(
        [process.execPath, cli, "--dir", dir, "--all", "--json"],
        { cwd: path.resolve(import.meta.dir, "..") },
      );
      expect(result.exitCode).toBe(0);
      const catalog = readFileSync(path.join(dir, "known_issues.yaml"), "utf8");
      expect(catalog).toContain('error: "boom"');
      const pending = readFileSync(pendingPath, "utf8");
      expect(pending).toContain("[]");
      expect(pending).not.toContain('error: "boom"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
