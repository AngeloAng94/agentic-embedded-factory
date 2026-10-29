/**
 * Renders docs/workflow.html to:
 *
 *   docs/workflow.pdf   single A3 landscape page, vector text (view / print)
 *   docs/workflow.png   full-size preview (GitHub / chat)
 *
 *   bun docs/render-workflow.ts
 *
 * Playwright chromium is a dev dependency: `bunx playwright install chromium`.
 *
 * The sheet is a fixed 1587x1122 px canvas, i.e. A3 at 96 dpi, so the PDF page
 * is A3 with no scaling and the drawing keeps its proportions when printed.
 */
import { chromium } from "playwright";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = import.meta.dir;
const DESIGN = { width: 1587, height: 1122 };

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: DESIGN.width, height: DESIGN.height },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});

await page.goto(pathToFileURL(resolve(dir, "workflow.html")).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(250);

/** Cards are fixed-height boxes: report any content that no longer fits. */
const audit = await page.evaluate(() => {
  const sheet = document.querySelector<HTMLElement>(".sheet")!;
  const clipped: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(".st, .door, .out, .lane, .start, .rules")) {
    const dy = el.scrollHeight - el.clientHeight;
    const dx = el.scrollWidth - el.clientWidth;
    if (dx > 1 || dy > 1) {
      const label = (el.className || el.tagName).split(" ")[0];
      clipped.push(`${label}(${el.textContent?.trim().slice(0, 18)}): +${dx}x${dy}`);
    }
  }
  const outside: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(".sheet *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.left < -0.5 || r.top < -0.5 || r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5) {
      const label = (el.className || el.tagName).toString().split(" ")[0];
      outside.push(`${label} @ ${Math.round(r.left)},${Math.round(r.top)}→${Math.round(r.right)},${Math.round(r.bottom)}`);
    }
  }
  return {
    width: sheet.scrollWidth,
    height: sheet.scrollHeight,
    sheetBottom: Math.round(sheet.getBoundingClientRect().bottom),
    clipped,
    outside: outside.slice(0, 8),
  };
});

if (process.argv.includes("--audit")) {
  const geo = await page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const stations = [...document.querySelectorAll(".st")].map((el) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.left + r.width / 2);
    });
    return {
      bands: {
        header: box(".top"),
        sect1: box(".sect"),
        flow: box(".flow"),
        loop: box(".loop"),
        rules: box(".rules"),
        lanes: box(".lanes"),
        foot: box(".foot"),
      },
      stationCenters: stations,
      injected: [box(".lb.fail"), box(".lb.why")],
      gapAfterFlow: Math.round(
        document.querySelector(".loop")!.getBoundingClientRect().top -
          document.querySelector(".flow")!.getBoundingClientRect().bottom,
      ),
    };
  });
  console.log("--- audit ---");
  for (const [name, b] of Object.entries(geo.bands)) {
    if (b) console.log(`band ${name.padEnd(7)} y=${String(b.y).padStart(4)} h=${String(b.h).padStart(4)} w=${b.w}`);
  }
  console.log(`station centers: ${geo.stationCenters.join(", ")}`);
  console.log(`loop labels: ${JSON.stringify(geo.injected)}`);
  console.log(`gap flow→loop: ${geo.gapAfterFlow}px`);
}

await page.screenshot({ path: resolve(dir, "workflow.png"), fullPage: true });

const mm = (px: number) => Number(((px * 25.4) / 96).toFixed(2));
await page.pdf({
  path: resolve(dir, "workflow.pdf"),
  width: `${mm(audit.width)}mm`,
  height: `${mm(audit.height)}mm`,
  printBackground: true,
  margin: { top: "0", bottom: "0", left: "0", right: "0" },
});

await browser.close();

const pdf = readFileSync(resolve(dir, "workflow.pdf")).toString("latin1");
const pages = pdf.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
const vector = pdf.includes("/FontFile");
const pdfKb = Math.round(statSync(resolve(dir, "workflow.pdf")).size / 1024);
const pngKb = Math.round(statSync(resolve(dir, "workflow.png")).size / 1024);

console.log(`pdf  : docs/workflow.pdf  ${pages} page · ${pdfKb} KB · vector=${vector}`);
console.log(`png  : docs/workflow.png  ${pngKb} KB`);
console.log(
  `sheet: ${audit.width}x${audit.height}px (A3 = 1587x1122) · ${mm(audit.width)}x${mm(audit.height)}mm`,
);
console.log(
  audit.clipped.length === 0
    ? "audit: no clipped card"
    : `audit: ${audit.clipped.length} clipped — ${audit.clipped.join(" | ")}`,
);
console.log(
  audit.outside.length === 0
    ? "audit: everything inside the sheet"
    : `audit: ${audit.outside.length} box(es) outside — ${audit.outside.join(" | ")}`,
);
