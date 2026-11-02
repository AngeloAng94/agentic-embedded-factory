import type { Rtos } from "./types";

/**
 * Deterministic RTOS detection. Pure function so it can be unit tested and
 * reused by the web app, the desktop app and the runner.
 */
export function detectRtos(
  prompt: string,
  fallback: Rtos | null = null,
): Rtos | null {
  const lower = (prompt ?? "").toLowerCase();
  const zephyr = /\bzephyr\b|\bwest\b|\bzephyrproject\b/.test(lower);
  const freertos = /\bfreertos\b|\bfree-rtos\b|\bfree rtos\b/.test(lower);

  if (zephyr && !freertos) return "zephyr";
  if (freertos && !zephyr) return "freertos";
  if (zephyr && freertos) return fallback ?? null;
  return fallback;
}

export function detectBoard(prompt: string): string | null {
  // Zephyr board names are lower case: nucleo_l476rg, stm32f407g_disc1, ...
  const normalize = (value: string) => value.toLowerCase();
  const explicit = /board[\s:=]+([A-Za-z0-9_/-]+)/i.exec(prompt ?? "");
  if (explicit) return normalize(explicit[1]);
  const nucleo = /\b(nucleo[-_][a-z0-9]+)\b/i.exec(prompt ?? "");
  if (nucleo) return normalize(nucleo[1]);
  const discovery = /\b(stm32[a-z0-9]{2,}[a-z0-9]*)\b/i.exec(prompt ?? "");
  if (discovery) return normalize(discovery[1]);
  const nrf = /\b(nrf[0-9]{4}[a-z0-9]*)\b/i.exec(prompt ?? "");
  if (nrf) return normalize(nrf[1]);
  return null;
}

export function detectMcu(prompt: string): string | null {
  const match = /mcu[\s:=]+([A-Za-z0-9_/-]+)/i.exec(prompt ?? "");
  return match ? match[1] : null;
}

export function detectProjectName(prompt: string, rtos: Rtos): string {
  const quoted = /["“']([A-Za-z0-9_\- ]{3,32})["”']/.exec(prompt ?? "");
  if (quoted) {
    const candidate = quoted[1].trim().replace(/\s+/g, "_");
    if (/^[A-Za-z0-9_-]{3,32}$/.test(candidate)) return candidate;
  }
  const word = (prompt ?? "")
    .split(/\s+/)
    .find((token) => token.length > 3 && /^[A-Za-z][A-Za-z0-9_-]+$/.test(token));
  if (word) return word.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return `${rtos}_project`;
}
