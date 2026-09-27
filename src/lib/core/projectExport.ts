import type { ProjectLike } from "./types";
import { createZip, type ZipEntry } from "./zip";

/**
 * Project export: turns the stored project into a real, buildable tree
 * (files + configs + generated README + manifest) and into ZIP bytes.
 */

export interface ExportManifest {
  tool: "EmbedFactory";
  manifestVersion: 1;
  name: string;
  rtos: string;
  board: string | null;
  mcu: string | null;
  exportedAt: string;
  fileCount: number;
  files: { path: string; bytes: number; hash: string }[];
  hashAlgorithm: "fnv1a-32";
  verification: string;
  buildCommand: string;
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
    return `west build${boardArg} -p always`;
  }
  return "cmake -S . -B build && cmake --build build";
}

export function buildProjectManifest(
  project: ProjectLike,
  files: { path: string; content: string }[],
  exportedAt: Date = new Date(),
  verification = "NOT_VERIFIED",
): ExportManifest {
  return {
    tool: "EmbedFactory",
    manifestVersion: 1,
    name: project.name,
    rtos: project.rtos,
    board: project.board ?? null,
    mcu: project.mcu ?? null,
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
    buildCommand: buildCommandFor(project.rtos, project.board ?? null),
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
Check \`embedfactory.manifest.json\` (\`verification\` field) before trusting a build result.
`;
}

export function generatedBuildDoc(project: ProjectLike): string {
  const command = buildCommandFor(project.rtos, project.board ?? null);
  const prerequisites =
    project.rtos === "zephyr"
      ? `- Zephyr SDK + \`west\` in PATH\n- \`ZEPHYR_BASE\` pointing to the Zephyr checkout (or run \`west init -l .\`)`
      : `- cmake + a C toolchain (arm-none-eabi-gcc or host gcc)\n- FreeRTOS-Kernel checkout in \`third_party/FreeRTOS-Kernel\``;

  return `# Build instructions

## Prerequisites

${prerequisites}

## Real build

\`\`\`bash
${command}
\`\`\`

## Build through the local runner (captures real stdout/stderr/exit code)

\`\`\`bash
bun runner/index.ts build --dir . --json
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
  options: { exportedAt?: Date; verification?: string } = {},
): { entries: ZipEntry[]; manifest: ExportManifest } {
  const exportedAt = options.exportedAt ?? new Date();
  const manifest = buildProjectManifest(
    project,
    files,
    exportedAt,
    options.verification ?? "NOT_VERIFIED",
  );

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
  options: { exportedAt?: Date; verification?: string } = {},
): { bytes: Uint8Array; manifest: ExportManifest; entries: ZipEntry[] } {
  const { entries, manifest } = buildExportEntries(project, files, options);
  const bytes = createZip(entries, options.exportedAt ?? new Date());
  return { bytes, manifest, entries };
}

export function safeArchiveName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "embedded-project" : cleaned;
}
