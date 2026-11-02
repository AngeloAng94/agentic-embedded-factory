import type { ProjectLike } from "./types";
import { createZip, type ZipEntry } from "./zip";

/**
 * Project export: turns the stored project into a real, buildable tree
 * (files + configs + generated README + manifest) and into ZIP bytes.
 *
 * The manifest records which board and toolchain the project is meant for, and
 * — honestly — whether the last build was REAL/SUCCESS or not. A manifest that
 * says `verification: "NOT_VERIFIED"` means no compiler was ever executed.
 */

export interface BoardProfile {
  rtos: string;
  board: string | null;
  toolchain: string | null;
  verification: string;
  verdict: string;
}

export interface ExportManifest {
  tool: "EmbedFactory";
  manifestVersion: 1;
  name: string;
  rtos: string;
  board: string | null;
  mcu: string | null;
  toolchain: string | null;
  exportedAt: string;
  fileCount: number;
  files: { path: string; bytes: number; hash: string }[];
  hashAlgorithm: "fnv1a-32";
  verification: string;
  verdict: string;
  buildCommand: string;
  /** Board profile of the build this export belongs to. */
  boardProfile: BoardProfile;
}

export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildCommandFor(rtos: string, board: string | null): string {
  if (rtos === "zephyr") {
    const boardArg = board ? ` -b ${board}` : " -b <board>";
    return `west build${boardArg} -d build -p auto`;
  }
  return "cmake -S . -B build && cmake --build build";
}

export interface ExportOptions {
  exportedAt?: Date;
  /** "REAL · SUCCESS", "NOT_VERIFIED", ... */
  verification?: string;
  verdict?: string;
  toolchain?: string | null;
}

export function buildProjectManifest(
  project: ProjectLike,
  files: { path: string; content: string }[],
  options: ExportOptions = {},
): ExportManifest {
  const exportedAt = options.exportedAt ?? new Date();
  const verification = options.verification ?? "NOT_VERIFIED";
  const verdict = options.verdict ?? "UNKNOWN";
  const toolchain = options.toolchain ?? null;
  const board = project.board ?? null;

  return {
    tool: "EmbedFactory",
    manifestVersion: 1,
    name: project.name,
    rtos: project.rtos,
    board,
    mcu: project.mcu ?? null,
    toolchain,
    exportedAt: exportedAt.toISOString(),
    fileCount: files.length,
    files: files
      .map((file) => ({
        path: file.path,
        bytes: new TextEncoder().encode(file.content).length,
        hash: fnv1a(file.content),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    hashAlgorithm: "fnv1a-32",
    verification,
    verdict,
    buildCommand: buildCommandFor(project.rtos, board),
    boardProfile: {
      rtos: project.rtos,
      board,
      toolchain,
      verification,
      verdict,
    },
  };
}

export function generatedReadme(project: ProjectLike): string {
  const command = buildCommandFor(project.rtos, project.board ?? null);
  return `# ${project.name}

Firmware project exported from EmbedFactory.

- RTOS: ${project.rtos}
- Board: ${project.board ?? "unspecified"}
- MCU: ${project.mcu ?? "unspecified"}
${project.description ? `- Requirement: ${project.description}\n` : ""}
## Build

\`\`\`bash
${command}
\`\`\`

## Verification status

A build only counts as verified when a real toolchain was executed.
Check \`embedfactory.manifest.json\` (\`verification\`, \`verdict\` and \`boardProfile\`)
before trusting a build result.
`;
}

export function generatedBuildDoc(project: ProjectLike): string {
  const command = buildCommandFor(project.rtos, project.board ?? null);
  const prerequisites =
    project.rtos === "zephyr"
      ? `- Zephyr SDK + \`west\` in PATH
- \`cmake\`, \`ninja\`, \`python3\`, \`dtc\`
- \`ZEPHYR_BASE\` pointing to the Zephyr checkout (or run \`west init -l .\`)
- ARM toolchain from the SDK: \`arm-zephyr-eabi-gcc\`

Check your machine before building:

\`\`\`bash
bun runner/index.ts doctor
\`\`\`

The doctor prints \`Environment READY\` or \`NOT_READY\` with a \`Missing:\` list.
It never falls back to a simulated build.`
      : `- cmake + a C toolchain (arm-none-eabi-gcc or host gcc)
- FreeRTOS-Kernel checkout in \`third_party/FreeRTOS-Kernel\``;

  return `# Build instructions

## Prerequisites

${prerequisites}

## Real build

\`\`\`bash
${command}
\`\`\`

## Build through the local runner (captures real stdout/stderr/exit code)

\`\`\`bash
bun runner/index.ts build --dir . --rtos ${project.rtos}${
    project.board ? ` --board ${project.board}` : ""
  } --json
\`\`\`

The runner reports \`verification=NOT_AVAILABLE\` when the toolchain is missing.
It never reports success without executing a real process.
`;
}

export const DEFAULT_GITIGNORE = `build/
build-*/
*.o
*.elf
*.bin
*.hex
*.map
*.obj
*.a
*.d
.west/
zephyr/.cache/
node_modules/
.DS_Store
`;

export function buildExportEntries(
  project: ProjectLike,
  files: { path: string; content: string }[],
  options: ExportOptions = {},
): { entries: ZipEntry[]; manifest: ExportManifest } {
  const exportedAt = options.exportedAt ?? new Date();
  const manifest = buildProjectManifest(project, files, { ...options, exportedAt });

  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const entries: ZipEntry[] = files.map((file) => ({
    path: file.path,
    content: file.content,
  }));

  if (!byPath.has("README.md")) {
    entries.push({ path: "README.md", content: generatedReadme(project) });
  }
  if (!byPath.has(".gitignore")) {
    entries.push({ path: ".gitignore", content: DEFAULT_GITIGNORE });
  }
  entries.push({ path: "BUILD.md", content: generatedBuildDoc(project) });
  entries.push({
    path: "embedfactory.manifest.json",
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, manifest };
}

export function buildProjectArchive(
  project: ProjectLike,
  files: { path: string; content: string }[],
  options: ExportOptions = {},
): { bytes: Uint8Array; manifest: ExportManifest; entries: ZipEntry[] } {
  const exportedAt = options.exportedAt ?? new Date();
  const { entries, manifest } = buildExportEntries(project, files, { ...options, exportedAt });
  const bytes = createZip(entries, exportedAt);
  return { bytes, manifest, entries };
}

export function safeArchiveName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "embedded-project" : cleaned;
}
