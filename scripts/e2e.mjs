import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4174', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
await ctx.addInitScript(() => {
  window.print = () => { window.__printed = true; };
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 240)}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 240)}`));

const results = [];
const base = 'http://localhost:4174';
async function step(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', `${name}: ${String(e.message).split('\n')[0].slice(0, 200)}`]);
  }
}
const go = async (p) => { await page.goto(base + p, { waitUntil: 'networkidle' }); await page.waitForTimeout(600); };
const toastHas = async (re) => { await page.getByText(re).first().waitFor({ timeout: 8000 }); };

await step('Home loads, plays and scoreboard fills', async () => {
  await go('/');
  await page.getByRole('button', { name: 'Pause' }).waitFor({ timeout: 6000 });
  await page.waitForTimeout(1500);
  await page.getByRole('radio', { name: 'B surge' }).click();
  await page.getByRole('button', { name: 'Restart' }).click();
  await page.getByRole('radio', { name: '4x' }).click();
});
await step('Home pipeline steps all open', async () => {
  for (const s of ['Count', 'Demand', 'Twin', 'Decide', 'Prove', 'See']) {
    await page.getByRole('tab', { name: new RegExp(s) }).click();
    await page.waitForTimeout(150);
  }
});
await step('Home honest comparison toggle and seed', async () => {
  await page.getByRole('radio', { name: 'Video only' }).click();
  await page.getByRole('radio', { name: 'Video plus twin' }).click();
  await page.getByRole('button', { name: 'New traffic' }).click();
});
await step('Home fairness slider', async () => {
  const sl = page.getByRole('slider', { name: 'North surge' });
  await sl.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
});
await step('Home CTA links', async () => {
  await page.getByRole('link', { name: 'Open the console' }).click();
  await page.waitForURL('**/console');
});

await step('Console: play, speed, emergency, restart', async () => {
  await go('/console');
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByRole('radio', { name: '4x' }).click();
  await page.getByRole('button', { name: 'Send' }).click();
  await toastHas(/Emergency vehicle sent/);
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Restart' }).click();
});
await step('Console: scenario B, baseline, objective, noise, seed, look-ahead', async () => {
  await page.getByRole('radio', { name: /B surge/ }).click();
  await page.getByRole('radio', { name: 'Webster plan' }).click();
  await page.getByRole('radio', { name: 'VAC' }).click();
  await page.getByText('Clear standing queue first').first().click();
  await page.getByText('Clear standing queue first').first().click();
  await page.getByRole('radio', { name: 'People' }).click();
  await page.getByRole('slider', { name: 'Detection noise' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('#seed-in').fill('7');
  await page.getByText('Platoon look-ahead').first().click();
  await page.getByRole('button', { name: 'Load by approach' }).click();
  await page.getByRole('slider', { name: 'North load' }).focus();
  await page.keyboard.press('ArrowRight');
});
await step('Console: run 20 seeds and download', async () => {
  await page.getByRole('button', { name: /Run 20 seeds/ }).click();
  await page.getByRole('region', { name: /Comparison of 20 seeds/ }).waitFor({ timeout: 90000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download this run' }).click()]);
  if (!dl.suggestedFilename().endsWith('.csv')) throw new Error('not a csv');
});
await step('Console: splitter keyboard', async () => {
  const sp = page.getByRole('separator');
  await sp.focus();
  const before = await sp.getAttribute('aria-valuenow');
  await page.keyboard.press('ArrowRight');
  const after = await sp.getAttribute('aria-valuenow');
  if (before === after) throw new Error('splitter did not move');
});

await step('Setup: sample path through all five steps and save', async () => {
  await go('/setup');
  await page.getByRole('button', { name: 'Use the sample junction' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Save junction' }).first().click();
  await toastHas(/Junction saved/);
});
await step('Setup: draw a stop line and undo', async () => {
  await go('/setup');
  await page.getByRole('button', { name: 'Use the sample junction' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Clear North' }).click();
  await page.waitForTimeout(500);
  const s0 = await page.getByText(/Stop lines/).locator('..').innerText();
  await page.getByRole('button', { name: 'Draw a stop line' }).click();
  const box = await page.getByRole('application').boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.3, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const s1 = await page.getByText(/Stop lines/).locator('..').innerText();
  if (s0 === s1) throw new Error(`stop line count unchanged: ${s0}`);
  await page.getByRole('button', { name: 'Undo' }).click();
});
await step('Setup: counts CSV error and valid file', async () => {
  await go('/setup');
  await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
  await page.getByText(/Missing columns/).waitFor({ timeout: 5000 });
  await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'ok.csv', mimeType: 'text/csv', buffer: Buffer.from('time,approach,class,count\n0,N,car,4\n15,S,bus,1\n30,E,two-wheeler,6\n45,W,car,3\n') });
  await page.getByText(/4 rows/).waitFor({ timeout: 5000 });
});
await step('Setup: JSON export, import error', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export JSON' }).click()]);
  if (!dl.suggestedFilename().endsWith('.json')) throw new Error('not json');
  await page.getByRole('button', { name: 'Import JSON' }).click();
  await page.locator('[role=dialog] input[type=file]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
  await page.getByText(/Export a junction from this page/).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
});

await step('Perception: layers, play, import dialog', async () => {
  await go('/perception');
  await page.getByRole('radio', { name: /Fixed plan as recorded/ }).click();
  await page.getByRole('radio', { name: /SignalTwin/ }).click();
  await page.getByRole('radio', { name: /VAC, clears the queue zone/ }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByText('Boxes').click();
  await page.getByText('Speeds').click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Import perception file' }).first().click();
  await page.locator('[role=dialog] input[type=file]').setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from('{"fps":10}') });
  await page.getByText(/perception format/).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Imported perception file' }).click();
  await page.getByText(/No detections for this video yet|No video is loaded/).first().waitFor({ timeout: 4000 });
});

await step('Demand: change bin, smoothing, apply, export', async () => {
  await go('/demand');
  await page.getByText('Arrival profile').first().waitFor({ timeout: 8000 });
  await page.getByLabel('Bin size').selectOption('30');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Recompute' }).click();
  await page.getByRole('button', { name: 'Apply to junction' }).click();
  await page.getByRole('button', { name: 'Apply demand' }).click();
  await toastHas(/Demand applied/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export demand CSV' }).click()]);
  if (!dl.suggestedFilename().endsWith('.csv')) throw new Error('not csv');
});

await step('Twin: calibrate to Close match and accept', async () => {
  await go('/twin');
  await page.getByText('Validation').first().waitFor();
  const field = page.getByLabel('Saturation flow');
  await field.fill('1950');
  await page.waitForTimeout(800);
  await page.getByText('Close match').first().waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Accept calibration' }).click();
  await toastHas(/Calibration accepted/);
});

await step('Controller: scrub, grid search, apply best, log filter', async () => {
  await go('/controller');
  await page.getByRole('button', { name: 'Play' }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Pause' }).first().click();
  await page.getByRole('radio', { name: 'VAC' }).click();
  await page.getByText('How VAC decides').waitFor({ timeout: 5000 });
  await page.getByRole('radio', { name: 'SignalTwin' }).click();
  await page.getByRole('button', { name: 'Run grid search' }).click();
  await page.getByText(/Best: beta/).waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: 'Apply the best weights' }).click();
  await page.getByLabel('Search the reasons').fill('green');
  await page.getByLabel('Rule').selectOption('stay');
  await page.getByRole('button', { name: 'Reset to tuned defaults' }).click();
});

await step('Experiments: scenarios, ablation, noise, fairness, restore', async () => {
  await go('/experiments');
  await page.getByLabel('Seeds per run').fill('6');
  await page.getByRole('button', { name: 'Run both scenarios' }).click();
  await page.getByRole('region', { name: /Comparison of 6 seeds/ }).waitFor({ timeout: 90000 });
  await page.getByRole('tab', { name: 'Ablation' }).click();
  await page.getByRole('button', { name: 'Run ablation' }).click();
  await page.getByRole('region', { name: /Ablation results/ }).waitFor({ timeout: 90000 });
  await page.getByRole('tab', { name: 'Noise' }).click();
  await page.getByRole('button', { name: 'Run noise test' }).click();
  await page.getByText(/At 20 percent missed detections/).waitFor({ timeout: 90000 });
  await page.getByRole('tab', { name: 'Fairness' }).click();
  await page.getByRole('table', { name: 'Fairness summary' }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Restore' }).first().click();
});
await step('Experiments: cancel mid-run', async () => {
  await page.getByRole('tab', { name: 'Scenarios' }).click();
  await page.getByLabel('Seeds per run').fill('40');
  await page.getByRole('button', { name: 'Run A only' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  await toastHas(/cancelled/);
});

await step('Report: sections, csv, pdf, copy, raw', async () => {
  await go('/report');
  await page.getByText('Demand summary').first().waitFor();
  await page.getByText('Charts').first().click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
  if (!dl.suggestedFilename().endsWith('.csv')) throw new Error('not csv');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  await page.waitForTimeout(500);
  if (!(await page.evaluate(() => window.__printed))) throw new Error('print not called');
  await page.getByRole('button', { name: 'Copy summary as text' }).click();
  await toastHas(/Summary copied/);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download all raw data' }).click()]);
  if (!dl2.suggestedFilename().endsWith('.json')) throw new Error('not json');
});

await step('Parameters: edit, search, reset group, reset all', async () => {
  await go('/parameters');
  await page.getByLabel('Yellow value').fill('4');
  await page.getByText(/values? changed from the default/).waitFor({ timeout: 4000 });
  await page.getByLabel('Search parameters').fill('flow');
  await page.getByText('Saturation flow').first().waitFor();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: /Reset junction timing/ }).click();
  await page.getByRole('button', { name: 'Reset all' }).click();
  await page.getByRole('button', { name: 'Reset all' }).last().click();
  await toastHas(/All parameters reset/);
});

await step('Method: TOC and copy link', async () => {
  await go('/method');
  await page.getByRole('link', { name: 'The fairness guarantee' }).click();
  await page.getByRole('button', { name: /Copy link to The fairness guarantee/ }).focus();
  await page.getByRole('button', { name: /Copy link to The fairness guarantee/ }).click();
  await toastHas(/Link copied/);
});

await step('Shortcuts dialog and go-to keys', async () => {
  await go('/');
  await page.keyboard.press('?');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await page.waitForURL('**/console');
});
await step('Theme toggle persists', async () => {
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.getByRole('button', { name: /Switch to/ }).click();
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (before === after) throw new Error('theme did not change');
  await page.reload();
  const kept = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (kept !== after) throw new Error('theme not persisted');
});
await step('Example videos: each loads with its video, analysis and comparison', async () => {
  const demos = [
    ['Example: overhead four-way junction', 'topdown'],
    ['Example: Bangalore flyover road', 'bangalore'],
    ['Example: Delhi highway', 'delhi'],
    ['Example: time-lapse junction (not usable)', 'timelapse'],
  ];
  for (const [label, key] of demos) {
    await go('/perception');
    await page.locator('#junction-select').selectOption({ label });
    await toastHas(/loaded, with its video/);
    await page.getByRole('radio', { name: 'Back end' }).waitFor();
    await page.getByRole('radio', { name: 'Back end' }).click();
    await page.getByText('Quality of this analysis').waitFor({ timeout: 8000 });
    const rows = await page.locator('table[aria-label="Vehicles counted per approach and class"] tbody tr').allInnerTexts();
    if (!rows.some((r) => /[1-9]/.test(r))) throw new Error(`${key}: the counts table is empty`);
    const hasVideo = await page.evaluate(async (k) => { const r = await fetch(`/demos/${k}.webm`, { method: 'HEAD' }); return r.ok && (r.headers.get('content-type') || '').startsWith('video'); }, key);
    if (hasVideo) {
      await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2; }, null, { timeout: 15000 });
      await page.evaluate(() => { const v = document.querySelector('video'); v.currentTime = Math.max(0.5, v.duration * 0.5); });
      await page.waitForFunction(() => document.querySelectorAll('.canvas-stage svg g rect').length > 0, null, { timeout: 10000 });
    }
    await go('/console');
    await page.getByRole('button', { name: /Run 20 seeds/ }).click();
    await page.getByRole('region', { name: /Comparison of 20 seeds/ }).waitFor({ timeout: 90000 });
  }
  await go('/perception');
  await page.locator('#junction-select').selectOption({ label: 'Sample junction, four-way' });
  await toastHas(/Switched to the sample junction/);
});
await step('Privacy: delete all data', async () => {
  await go('/privacy');
  await page.getByRole('button', { name: 'Delete all data' }).click();
  await page.getByRole('button', { name: 'Delete everything' }).click();
  await toastHas(/All data deleted/);
});
await step('Terms and 404', async () => {
  await go('/terms');
  await page.getByRole('heading', { name: 'Terms of service' }).waitFor();
  await go('/does-not-exist');
  await page.getByRole('heading', { name: /does not exist/ }).waitFor();
  await page.getByRole('link', { name: 'Console' }).first().click();
});

await browser.close();
server.kill();
for (const [s, n] of results) console.log(s, n);
console.log(errors.length ? '\nConsole errors:\n' + errors.join('\n') : '\nNo console errors.');
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);


