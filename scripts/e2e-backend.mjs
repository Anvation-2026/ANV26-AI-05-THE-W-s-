/**
 * End-to-end test of the front end together with the real back end.
 *
 * It starts the API (synthetic detector, so no model download is needed), builds the front end pointing at it,
 * uploads a generated junction video through the Setup page, and follows it through Perception, Demand, Twin and
 * the privacy controls in a real browser. Usage:  npm run e2e:backend
 *
 * Needs: the Python environment in signaltwin-api/.venv (see its README) and Chrome.
 */
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const apiDir = join(root, 'signaltwin-api');
const py = process.env.API_PYTHON ?? (process.platform === 'win32' ? join(apiDir, '.venv', 'Scripts', 'python.exe') : join(apiDir, '.venv', 'bin', 'python'));
if (!existsSync(py)) {
  console.error(`The Python environment was not found at ${py}. Create it first: see signaltwin-api/README.md.`);
  process.exit(2);
}
const API_PORT = 8010;
const WEB_PORT = 4175;
const api = `http://localhost:${API_PORT}`;
const web = `http://localhost:${WEB_PORT}`;
const work = mkdtempSync(join(tmpdir(), 'signaltwin-e2e-'));
const dataDir = join(work, 'data');
mkdirSync(dataDir, { recursive: true });
const procs = [];
const cleanup = () => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* a locked file on Windows is not worth failing for */
  }
};
process.on('exit', cleanup);

// 1. test media: a generated junction video and the matching junction drawing
const video = join(work, 'junction.mp4');
const junctionFile = join(work, 'junction.json');
const truthFile = join(work, 'truth.json');
let made = spawnSync(py, ['-m', 'signaltwin_api.testing.synth', video, '--seconds', '150', '--junction', junctionFile, '--truth', truthFile], { cwd: apiDir, encoding: 'utf8' });
if (made.status !== 0) {
  console.error(made.stderr || made.stdout);
  process.exit(2);
}
const truth = JSON.parse(readFileSync(truthFile, 'utf8'));

// 2. the API
const apiProc = spawn(py, ['-m', 'uvicorn', 'signaltwin_api.main:app', '--port', String(API_PORT), '--log-level', 'warning'], {
  cwd: apiDir,
  env: { ...process.env, DETECTOR: 'synthetic', DATA_DIR: dataDir, ALLOWED_ORIGINS: web, LOG_LEVEL: 'WARNING', RETENTION_HOURS: '24' },
  stdio: 'ignore',
});
procs.push(apiProc);
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${api}/v1/health`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
  if (i === 59) {
    console.error('The API did not start.');
    process.exit(2);
  }
}

// 3. the front end, built for this API
const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', join(work, 'dist')], { cwd: root, env: { ...process.env, VITE_API_URL: api }, encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  process.exit(2);
}
procs.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', join(work, 'dist'), '--port', String(WEB_PORT), '--strictPort'], { cwd: root, stdio: 'ignore' }));
await new Promise((r) => setTimeout(r, 2500));

if (process.env.E2E_HOLD) {
  console.log(`servers ready: ${api} and ${web}. Files in ${work}. Press Ctrl+C to stop.`);
  await new Promise(() => undefined);
}
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
let apiDown = false; // failed requests are expected once the test stops the API on purpose
page.on('console', (m) => { if (m.type() === 'error' && !(apiDown && /ERR_CONNECTION_REFUSED|Failed to fetch/.test(m.text()))) errors.push(`console: ${m.text().slice(0, 240)}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 240)}`));
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', `${name}: ${String(e.message).split('\n')[0].slice(0, 300)}`]);
  }
}
const go = async (p) => { await page.goto(web + p, { waitUntil: 'networkidle' }); await page.waitForTimeout(500); };
const toastHas = async (re, t = 10000) => { await page.getByText(re).first().waitFor({ timeout: t }); };
let videoId = null;

await step('Back end badge says connected', async () => {
  await go('/');
  await page.getByTestId('backend-badge').filter({ hasText: 'Back end connected' }).waitFor({ timeout: 8000 });
  await page.getByTestId('backend-badge').click();
  await page.getByText('The back end is running').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
});

await step('Setup: load the video and import the drawing', async () => {
  await go('/setup');
  await page.locator('input[type=file]').first().setInputFiles(video);
  await toastHas(/Video loaded/);
  await page.getByRole('button', { name: 'Import JSON' }).click();
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(junctionFile);
  await toastHas(/Junction imported/);
});

await step('Setup: walk to the review step', async () => {
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(250);
  }
  await page.getByRole('heading', { name: 'Analyse the video' }).waitFor();
});

await step('Analyse: consent notice, then cancel a running analysis', async () => {
  await page.getByRole('button', { name: 'Analyse video' }).click();
  await page.getByRole('dialog', { name: /Before your video is uploaded/ }).waitFor();
  await page.getByRole('button', { name: 'Upload and analyse' }).click();
  await page.getByTestId('analyse-progress').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => /Finding and tracking/.test(document.body.innerText), null, { timeout: 40000 });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await toastHas(/Analysis cancelled/);
  await page.getByRole('button', { name: 'Analyse video' }).waitFor();
});

await step('Analyse: progress and finished', async () => {
  await page.getByRole('button', { name: 'Analyse video' }).click();
  await page.getByTestId('analyse-progress').waitFor({ timeout: 10000 });
  await page.getByTestId('analyse-done').waitFor({ timeout: 240000 });
  const text = await page.getByTestId('analyse-done').innerText();
  const m = text.match(/Vehicles counted on the upstream lines\s+([\d,]+)/);
  if (!m) throw new Error(`no count in: ${text.slice(0, 200)}`);
  const counted = Number(m[1].replace(/,/g, ''));
  const expected = Object.values(truth.counts.upstream).reduce((s, byClass) => s + Object.values(byClass).reduce((a, b) => a + b, 0), 0);
  if (Math.abs(counted - expected) > Math.max(3, 0.1 * expected)) throw new Error(`counted ${counted}, the video contains ${expected}`);
  videoId = await page.evaluate(() => JSON.parse(localStorage.getItem('signaltwin-state-v1') ?? '{}')?.state?.serverVideo?.videoId ?? null);
  if (!videoId) throw new Error('the uploaded video id was not remembered');
});

await step('Analyse: the same video again is answered from the cache', async () => {
  await page.getByRole('button', { name: 'Analyse again' }).click();
  await page.getByText(/reused from an earlier run/).waitFor({ timeout: 30000 });
});

await step('Perception: back end source draws boxes in step with the video', async () => {
  await go('/perception');
  const opt = page.getByRole('radio', { name: 'Back end' });
  if (await opt.isDisabled()) throw new Error('the Back end option is disabled');
  await opt.click();
  await page.getByText('Quality of this analysis').waitFor({ timeout: 8000 });
  const video = page.locator('video[aria-label="Your video with detections"]');
  await video.waitFor();
  // the file in this browser is gone after navigation to a fresh page load, so the server copy plays
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2; }, null, { timeout: 15000 });
  await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 40; });
  await page.waitForFunction(() => document.querySelectorAll('.canvas-stage svg g rect').length > 0, null, { timeout: 8000 });
  const boxes = await page.locator('.canvas-stage svg g rect').count();
  if (boxes < 1) throw new Error('no boxes drawn');
  const rows = await page.locator('table[aria-label="Vehicles counted per approach and class"] tbody tr').allInnerTexts();
  if (!rows.some((r) => /[1-9]/.test(r))) throw new Error('the counts table is empty');
});

await step('Demand: computed by the back end, no errors', async () => {
  const wait = page.waitForResponse((r) => r.url().includes('/v1/demand/estimate') && r.status() === 200, { timeout: 15000 });
  await go('/demand');
  await wait;
  await page.getByText(/Peak demand|Demand profile|Arrivals|PCU/i).first().waitFor();
});

await step('Demand from your video drives the simulation comparison', async () => {
  await go('/demand');
  await page.getByText('Your perception file').first().waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Apply to junction' }).click();
  await toastHas(/Demand applied/);
  await go('/console');
  await page.getByRole('button', { name: /Run 20 seeds/ }).click();
  const region = page.getByRole('region', { name: /Comparison of 20 seeds/ });
  await region.waitFor({ timeout: 120000 });
  const text = (await region.innerText()).replace(/\s+/g, ' ');
  for (const name of ['Webster', 'VAC', 'SignalTwin']) if (!new RegExp(name, 'i').test(text)) throw new Error(`the comparison has no ${name} row`);
  if (!/delay/i.test(text)) throw new Error('the comparison shows no delay numbers');
});

await step('Twin: validates against your own video', async () => {
  await go('/twin');
  await page.getByRole('heading', { name: 'Validation' }).waitFor();
  if (await page.getByText('Your video has not been analysed yet').count()) throw new Error('the twin is still using the sample clip');
  await page.getByText(/The clip is your video/).first().waitFor();
});

await step('Accessibility: pages and dialogs while connected', async () => {
  const scan = async (label) => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    if (r.violations.length) throw new Error(`${label}: ${r.violations.map((v) => `${v.id} (${v.nodes[0]?.target?.join(' ')})`).join('; ')}`);
  };
  for (const path of ['/perception', '/demand', '/twin', '/privacy']) {
    await go(path);
    if (path === '/perception') await page.getByRole('radio', { name: 'Back end' }).click();
    await page.waitForTimeout(600);
    await scan(path);
  }
  await page.getByTestId('backend-badge').click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(700); // let the dialog finish fading in, or the contrast is measured mid-animation
  await scan('back end dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  await go('/setup');
  await page.locator('input[type=file]').first().setInputFiles(video);
  await toastHas(/Video loaded/);
  await page.getByRole('button', { name: 'Import JSON' }).click();
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(junctionFile);
  await toastHas(/Junction imported/);
  for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: 'Continue' }).click(); await page.waitForTimeout(200); }
  await page.getByRole('heading', { name: 'Analyse the video' }).waitFor();
  await scan('setup review step with the analyse panel');
});

await step('Simulations on the back end give the same table as the browser', async () => {
  const table = async () => (await page.getByRole('region', { name: /Comparison of 20 seeds/ }).innerText()).replace(/\s+/g, ' ');
  await go('/console');
  await page.getByRole('button', { name: /Run 20 seeds/ }).click();
  await page.getByRole('region', { name: /Comparison of 20 seeds/ }).waitFor({ timeout: 90000 });
  const browserTable = await table();
  // switch the simulations to the back end
  await page.getByTestId('backend-badge').click();
  await page.getByRole('radio', { name: 'On the back end' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
  await go('/console');
  const sent = page.waitForRequest((r) => r.url().endsWith('/v1/experiments') && r.method() === 'POST', { timeout: 15000 });
  await page.getByRole('button', { name: /Run 20 seeds/ }).click();
  await sent;
  await page.getByRole('region', { name: /Comparison of 20 seeds/ }).waitFor({ timeout: 120000 });
  const serverTable = await table();
  if (serverTable !== browserTable) throw new Error(`the tables differ:\n${browserTable.slice(0, 300)}\n${serverTable.slice(0, 300)}`);
  // and put the default back
  await page.getByTestId('backend-badge').click();
  await page.getByRole('radio', { name: 'In this browser' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();
});

await step('Errors say what to do: the back end goes away', async () => {
  await go('/setup');
  await page.locator('input[type=file]').first().setInputFiles(video);
  await toastHas(/Video loaded/);
  await page.getByRole('button', { name: 'Import JSON' }).click();
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(junctionFile);
  await toastHas(/Junction imported/);
  for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: 'Continue' }).click(); await page.waitForTimeout(200); }
  apiDown = true;
  apiProc.kill();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Analyse (video|again)/ }).click();
  const box = page.getByTestId('analyse-error');
  await box.waitFor({ timeout: 15000 });
  const t = await box.innerText();
  if (!/What to do/.test(t) || !/back end|server/i.test(t)) throw new Error(`unhelpful error: ${t.slice(0, 200)}`);
});

// restart the API on the same data so the privacy controls can be tried against a real server
const api2 = spawn(py, ['-m', 'uvicorn', 'signaltwin_api.main:app', '--port', String(API_PORT), '--log-level', 'warning'], {
  cwd: apiDir,
  env: { ...process.env, DETECTOR: 'synthetic', DATA_DIR: dataDir, ALLOWED_ORIGINS: web, LOG_LEVEL: 'WARNING' },
  stdio: 'ignore',
});
procs.push(api2);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${api}/v1/health`)).ok) break; } catch { /* wait */ }
  await new Promise((r) => setTimeout(r, 500));
}

await step('Privacy: Delete my video and results removes it from the server', async () => {
  if (videoId) {
    const before = await fetch(`${api}/v1/videos/${videoId}`);
    if (before.status !== 200) throw new Error(`the video should exist before deleting, got ${before.status}`);
  }
  await go('/privacy');
  await page.getByRole('button', { name: 'Delete my video and results' }).click();
  await page.getByRole('button', { name: 'Delete video and results' }).click();
  await toastHas(/were deleted from the server/);
  const after = await fetch(`${api}/v1/videos/${videoId}`);
  if (after.status !== 404) throw new Error(`the server still has the video: ${after.status}`);
  const body = await after.json();
  if (!body.fix) throw new Error('the 404 has no fix text');
});

await browser.close();
for (const [s, n] of results) console.log(s, n);
const failed = results.some(([s]) => s === 'FAIL');
if (errors.length) {
  console.log('Console errors:');
  for (const e of errors.slice(0, 20)) console.log(' ', e);
} else console.log('No console errors.');
cleanup();
process.exit(failed || errors.length ? 1 : 0);
