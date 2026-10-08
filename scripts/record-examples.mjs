/**
 * Records a screen video of each example video's live simulation (Console page) and a still of its plan comparison.
 *   node scripts/record-examples.mjs [outputFolder]
 * Needs the app running on http://localhost:5173 (npm run dev). Videos are .webm files.
 */
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const out = resolve(process.argv[2] ?? 'N:/ANVATION/Videos/results/simulation-videos');
mkdirSync(out, { recursive: true });
const EXAMPLES = [
  ['Example: overhead four-way junction', 'overhead-four-way'],
  ['Example: Bangalore flyover road', 'bangalore'],
  ['Example: Delhi highway', 'delhi'],
  ['Example: large multi-lane junction (time-lapse)', 'time-lapse-junction'],
];
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome' });
for (const [label, name] of EXAMPLES) {
  const tmp = join(out, `_tmp_${name}`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: tmp, size: { width: 1440, height: 900 } } });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/perception`, { waitUntil: 'networkidle' });
  await page.locator('#junction-select').selectOption({ label });
  await page.getByText(/loaded, with its video/).first().waitFor();
  await page.goto(`${WEB}/console`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.getByRole('radio', { name: '4x' }).click();
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByRole('button', { name: 'Play' }).click().catch(() => undefined);
  await page.waitForTimeout(50000); // about 200 simulated seconds at 4x
  await page.getByRole('button', { name: /Run 20 seeds/ }).click();
  await page.getByRole('region', { name: /Comparison of 20 seeds/ }).waitFor({ timeout: 120000 });
  await page.getByRole('region', { name: /Comparison of 20 seeds/ }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(out, `${name}.comparison.png`) });
  await ctx.close(); // writes the video
  const f = readdirSync(tmp).find((x) => x.endsWith('.webm'));
  if (f) renameSync(join(tmp, f), join(out, `${name}.simulation.webm`));
  console.log('recorded', name);
}
await browser.close();
