/**
 * Repository path sandboxing.
 *
 * Any path coming from an LLM or from a client is untrusted. These helpers are
 * the single gate used by the Convex backend, the runner and the desktop app.
 */

export const ALLOWED_ROOT_FILES = [
  "CMakeLists.txt",
  "README.md",
  "prj.conf",
  "Kconfig",
  "west.yml",
  ".gitignore",
] as const;

export const ALLOWED_DIRECTORIES = [
  "src",
  "include",
  "boards",
  "tests",
  "drivers",
  "app",
  "scripts",
] as const;

export const ALLOWED_EXTENSIONS = [
  ".c",
  ".h",
  ".cpp",
  ".cmake",
  ".conf",
  ".overlay",
  ".yaml",
  ".yml",
  ".json",
  ".md",
  ".txt",
  ".ld",
  ".s",
  ".sh",
] as const;

/** Maximum size of a single generated file (256 KiB). */
export const MAX_FILE_BYTES = 256 * 1024;
/** Maximum number of files in a single agent plan. */
export const MAX_PLAN_FILES = 24;

export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.length > 180) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("..") || path.includes("~")) return false;
  if (path.includes("//") || path.includes("\\\\")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false; // windows drive letters
  // Control characters are rejected on purpose: they can hide path traversal.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return false;
  return true;
}

export function isPathAllowed(path: string): boolean {
  if (!isSafeRelativePath(path)) return false;

  const parts = path.split("/");
  const fileName = parts[parts.length - 1];
  if (!fileName || fileName === "." || fileName === "..") return false;

  if (parts.length === 1) {
    return (ALLOWED_ROOT_FILES as readonly string[]).includes(fileName);
  }

  const first = parts[0];
  if (!(ALLOWED_DIRECTORIES as readonly string[]).includes(first)) return false;

  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = fileName.slice(dot).toLowerCase();
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

export function describeRejection(path: string): string {
  if (!path) return "empty path";
  if (!isSafeRelativePath(path)) return "unsafe path (absolute, traversal or control chars)";
  const parts = path.split("/");
  if (parts.length > 1 && !(ALLOWED_DIRECTORIES as readonly string[]).includes(parts[0])) {
    return `directory "${parts[0]}" is outside the sandbox`;
  }
  return `path "${path}" is not in the allow-list`;
}

/** Normalises a repo-relative path or returns null when it is unusable. */
export function normalizeRepoPath(path: string): string | null {
  if (typeof path !== "string") return null;
  const cleaned = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!isSafeRelativePath(cleaned)) return null;
  return cleaned;
}
