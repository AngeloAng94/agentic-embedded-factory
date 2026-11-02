/**
 * Presentation helpers for the control plane.
 *
 * Kept out of `StatusIndicator.tsx` so that file only exports components
 * (react-refresh) and so a timestamp is formatted the same way everywhere.
 */

/** Absolute local timestamp; "never" when the probe was never run. */
export function formatCheckedAt(value: number | null | undefined): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}
