/**
 * Renders docs/infographic.html to three artifacts:
 *
 *   docs/infographic.pdf     single-page poster at design size (view / zoom)
 *   docs/infographic-a4.pdf  A4 landscape, 6 pages (print)
 *   docs/infographic.png     full poster preview (GitHub / chat)
 *
 *   bun docs/render-infographic.ts
 *
 * Playwright chromium is a dev dependency: `bunx playwright install chromium`.
 *
 * Page sizes are given in millimetres on purpose: Chromium paginates at the
 * paper size, so the sheet must be at least as wide as the design (1232px) or
 * the responsive breakpoints collapse the poster into a single column. A4
 * landscape keeps 1077px of content width, above the 980px breakpoint.
 */
import { chromium } from "playwright";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = import.meta.dir;
const htmlPath = resolve(dir, "infographic.html");
const mm = (px: number) => Number(((px * 25.4) / 96).toFixed(2));

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1232, height: 1200 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});

await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(250);

await page.emulateMedia({ media: "screen" });
await page.screenshot({
  path: resolve(dir, "infographic.png"),
  fullPage: true,
});

await page.emulateMedia({ media: "print" });
const layout = await page.evaluate(() => {
  const overflows: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(
    ".card, .panel, .cp, .srow, .step, .masthead, .rules, .node",
  )) {
    const dx = el.scrollWidth - el.clientWidth;
    const dy = el.scrollHeight - el.clientHeight;
    if (dx > 1 || dy > 1) overflows.push(`${el.className.split(" ")[0]}: +${dx}x${dy}`);
  }
  return {
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    overflows,
  };
});

// Poster: one page, exactly the design. No page breaks, vector text.
await page.pdf({
  path: resolve(dir, "infographic.pdf"),
  width: `${mm(layout.width)}mm`,
  height: `${mm(layout.height + 4)}mm`,
  printBackground: true,
  margin: { top: "0", bottom: "0", left: "0", right: "0" },
});

// Print version: A4 landscape, cards never cut in half.
await page.pdf({
  path: resolve(dir, "infographic-a4.pdf"),
  format: "A4",
  landscape: true,
  scale: 0.92,
  printBackground: true,
  margin: { top: "6mm", bottom: "6mm", left: "6mm", right: "6mm" },
});

await browser.close();

const { readFileSync, statSync } = await import("node:fs");
const count = (file: string) => {
  const text = readFileSync(file).toString("latin1");
  return {
    pages: text.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0,
    vector: text.includes("/FontFile"),
    kb: Math.round(statSync(file).size / 1024),
  };
};
const poster = count(resolve(dir, "infographic.pdf"));
const print = count(resolve(dir, "infographic-a4.pdf"));
const pngKb = Math.round(statSync(resolve(dir, "infographic.png")).size / 1024);

console.log(
  `poster: docs/infographic.pdf  ${poster.pages} page · ${poster.kb} KB · vector=${poster.vector}`,
);
console.log(`print : docs/infographic-a4.pdf  ${print.pages} pages · ${print.kb} KB`);
console.log(`png   : docs/infographic.png  ${pngKb} KB`);
console.log(`layout: ${layout.width}x${layout.height}px`);
console.log(
  layout.overflows.length === 0
    ? "layout: no container overflow"
    : `layout: ${layout.overflows.length} overflow(s) — ${layout.overflows.join(", ")}`,
);
