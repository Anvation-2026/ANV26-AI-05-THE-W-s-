/**
 * Takes real video clips through the website, one after another, against a back end that is already running:
 * upload, import the drawn junction, analyse, Perception, Demand (apply), then the simulation comparison.
 * Saves screenshots and a summary next to the clips.
 *
 *   node scripts/e2e-clips.mjs N:/ANVATION/Videos [clip ...]
 *
 * Needs the front end on http://localhost:5173 built with VITE_API_URL=http://localhost:8000 (npm run dev with .env.local),
 * the back end on port 8000 with its real models, and a `junctions` folder with one JSON per clip
 * (written by signaltwin-api/scripts/analyse_folder.py).
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const folder = resolve(process.argv[2] ?? 'N:/ANVATION/Videos');
const only = process.argv.slice(3);
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const MODELS = { bangalore: 'yolo11m', delhi: 'yolo11m', timelapse: 'aerial/visdrone-yolo11s', topdown: 'aerial/visdrone-yolo11s' };
const MATCH = { bangalore: 'bangalore', delhi: 'delhi', timelapse: 'time-lapse', topdown: 'top-down' };
const out = join(folder, 'results', 'website');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome' });
const summary = [];
for (const key of Object.keys(MATCH)) {
  if (only.length && !only.includes(key)) continue;
  const file = readdirSync(folder).find((f) => f.toLowerCase().includes(MATCH[key]) && /\.(webm|mp4|mov)$/i.test(f));
  const junction = join(folder, 'junctions', `${key}.json`);
  if (!file || !existsSync(junction)) {
    summary.push({ clip: key, problem: 'video or junction file missing' });
    continue;
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const row = { clip: key, file, steps: {} };
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      row.steps[name] = `ok, ${((Date.now() - t0) / 1000).toFixed(0)} s`;
      return true;
    } catch (e) {
      row.steps[name] = `FAILED: ${String(e.message).split('\n')[0].slice(0, 220)}`;
      await page.screenshot({ path: join(out, `${key}.failed-${name.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
      return false;
    }
  };
  const toast = (re, t = 15000) => page.getByText(re).first().waitFor({ timeout: t });

  let ok = await step('upload and junction', async () => {
    await page.goto(`${WEB}/setup`, { waitUntil: 'networkidle' });
    await page.locator('input[type=file]').first().setInputFiles(join(folder, file));
    await toast(/Video loaded/);
    await page.getByRole('button', { name: 'Import JSON' }).click();
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles(junction);
    await toast(/Junction imported/);
    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForTimeout(250);
    }
    await page.getByRole('heading', { name: 'Analyse the video' }).waitFor();
  });
  ok = ok && (await step('analysis', async () => {
    await page.locator('#an-model').selectOption(MODELS[key]);
    await page.getByRole('button', { name: /Analyse (video|again)/ }).click();
    const consent = page.getByRole('button', { name: 'Upload and analyse' });
    if (await consent.isVisible({ timeout: 2000 }).catch(() => false)) await consent.click();
    await page.getByTestId('analyse-done').waitFor({ timeout: 600000 });
    row.analysis = (await page.getByTestId('analyse-done').innerText()).replace(/\s+/g, ' ').slice(0, 400);
    if (await page.getByTestId('analyse-poor').count()) row.analysis_alert = (await page.getByTestId('analyse-poor').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    await page.locator('#an-h').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `${key}.1-analysis.png`) });
  }));
  ok = ok && (await step('perception', async () => {
    await page.goto(`${WEB}/perception`, { waitUntil: 'networkidle' });
    await page.getByRole('radio', { name: 'Back end' }).click();
    await page.getByText('Quality of this analysis').waitFor({ timeout: 10000 });
    await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2; }, null, { timeout: 20000 });
    await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = Math.min(v.duration * 0.6, v.duration - 0.5); });
    await page.waitForFunction(() => document.querySelectorAll('.canvas-stage svg g rect').length > 0, null, { timeout: 10000 });
    row.boxes_on_screen = await page.locator('.canvas-stage svg g rect').count();
    const rows = await page.locator('table[aria-label="Vehicles counted per approach and class"] tbody tr').allInnerTexts();
    row.counts_table = rows.map((r) => r.replace(/\s+/g, ' '));
    await page.screenshot({ path: join(out, `${key}.2-perception.png`), fullPage: true });
  }));
  ok = ok && (await step('demand', async () => {
    await page.goto(`${WEB}/demand`, { waitUntil: 'networkidle' });
    await page.getByText('Your perception file').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, `${key}.3-demand.png`), fullPage: true });
    await page.getByRole('button', { name: 'Apply to junction' }).click();
    await toast(/Demand applied/);
  }));
  ok = ok && (await step('simulation comparison', async () => {
    await page.goto(`${WEB}/console`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Run 20 seeds/ }).click();
    const region = page.getByRole('region', { name: /Comparison of 20 seeds/ });
    await region.waitFor({ timeout: 180000 });
    row.state = await page.evaluate(() => { const st = JSON.parse(localStorage.getItem('signaltwin-state-v1') || '{}').state || {}; return { params: st.params, options: st.options, demand: st.demand, observed: st.junction && st.junction.observed, scenarioId: st.scenarioId }; });
    row.comparison = (await region.innerText()).replace(/\s+/g, ' ').slice(0, 900);
    await region.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `${key}.4-comparison.png`) });
  }));
  await step('twin', async () => {
    await page.goto(`${WEB}/twin`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Validation' }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    row.twin_verdict = await page.locator('.badge').filter({ hasText: /match/i }).first().innerText().catch(() => 'n/a');
    await page.screenshot({ path: join(out, `${key}.5-twin.png`), fullPage: true });
  });
  row.console_errors = errors.slice(0, 5);
  summary.push(row);
  console.log(key, JSON.stringify(row.steps));
  await ctx.close();
}
await browser.close();
writeFileSync(join(out, 'website-summary.json'), JSON.stringify(summary, null, 2));
const bad = summary.filter((r) => r.problem || Object.values(r.steps ?? {}).some((s) => s.startsWith('FAILED')) || r.console_errors?.length);
console.log(bad.length ? `${bad.length} clip(s) had a problem` : 'All clips went through every step with no console errors.');
process.exit(bad.length ? 1 : 0);
