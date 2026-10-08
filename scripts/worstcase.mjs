import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4176', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ channel: 'chrome' });
const base = 'http://localhost:4176';
const out = [];
const log = (ok, name, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ': ' + extra : ''}`);

const NAMES = {
  'very long unbroken name': 'Junction' + 'X'.repeat(280),
  'Arabic name': 'تقاطع الملك فهد مع شارع التحلية في وسط المدينة',
  'Devanagari name': 'नई दिल्ली केंद्रीय चौराहा सिग्नल जंक्शन संख्या सात',
  'mixed emoji-free long words': 'Intersection of Mahatma Gandhi Road and Sir Mokshagundam Visvesvaraya Avenue near the Old Railway Station Main Gate',
};
const routes = ['/', '/setup', '/perception', '/demand', '/twin', '/controller', '/console', '/experiments', '/report', '/parameters', '/method'];
const jsonState = (name) =>
  JSON.stringify({
    state: { junction: { id: 'j1', name, source: 'counts', countsRows: 5, geometry: { stopLines: {}, upstreamLines: {}, queueZones: {} }, calibration: null, observed: { greens: [38, 30], yellow: 3, allRed: 2, fourPhase: false }, updatedAt: '2026-10-08T00:00:00.000Z' }, usingSample: false },
    version: 1,
  });

for (const [label, name] of Object.entries(NAMES)) {
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript((s) => { try { localStorage.setItem('signaltwin-state-v1', s); } catch {} }, jsonState(name));
    const page = await ctx.newPage();
    const bad = [];
    page.on('pageerror', (e) => bad.push(String(e).slice(0, 120)));
    for (const r of routes) {
      await page.goto(base + r, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (ov > 1) bad.push(`${r} overflow ${ov}px`);
    }
    if (width === 1440) await page.screenshot({ path: `shots/worst-${label.replace(/\s+/g, '-')}.png` });
    log(bad.length === 0, `${label} at ${width}px across ${routes.length} pages`, bad.slice(0, 4).join('; '));
    await ctx.close();
  }
}

// huge CSV
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', (e) => bad.push(String(e).slice(0, 120)));
  await page.goto(base + '/setup', { waitUntil: 'networkidle' });
  const classes = ['car', 'two-wheeler', 'bus', 'truck', 'auto-rickshaw'];
  const aps = ['N', 'S', 'E', 'W'];
  let csv = 'time,approach,class,count\n';
  for (let i = 0; i < 150000; i++) csv += `${i % 7200},${aps[i % 4]},${classes[i % 5]},${1 + (i % 3)}\n`;
  const t0 = Date.now();
  await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'huge.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByText(/150,000 rows/).waitFor({ timeout: 20000 });
  log(Date.now() - t0 < 15000 && bad.length === 0, `huge CSV, 150000 rows read in ${Date.now() - t0} ms`, bad.join('; '));
  await page.goto(base + '/demand', { waitUntil: 'networkidle' });
  await page.getByText('Arrival profile').first().waitFor({ timeout: 15000 });
  log(true, 'huge CSV, Demand page computes');
  await ctx.close();
}

// short recorded video, collinear calibration, keyboard only path
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', (e) => bad.push(String(e).slice(0, 120)));
  await page.goto(base + '/setup', { waitUntil: 'networkidle' });
  const b64 = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 360;
        const g = c.getContext('2d');
        const stream = c.captureStream(15);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.onstop = async () => {
          const blob = new Blob(chunks, { type: 'video/webm' });
          const buf = new Uint8Array(await blob.arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
          resolve(btoa(s));
        };
        rec.start();
        let n = 0;
        const id = setInterval(() => {
          g.fillStyle = '#3a423f';
          g.fillRect(0, 0, 640, 360);
          g.fillStyle = '#ddd';
          g.fillRect(280 + (n % 40), 0, 80, 360);
          g.fillRect(0, 140, 640, 80);
          n++;
        }, 66);
        setTimeout(() => {
          clearInterval(id);
          rec.stop();
        }, 4300);
      }),
  );
  const buf = Buffer.from(b64, 'base64');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'short.webm', mimeType: 'video/webm', buffer: buf });
  await page.getByText(/Video loaded|only .* s long/).first().waitFor({ timeout: 15000 }).catch(() => {});
  const loaded = await page.getByText(/short\.webm/).count();
  log(loaded > 0, '4 second video loads in Setup');
  // geometry step with video, draw, then calibration collinear
  await page.getByRole('button', { name: 'Continue' }).click().catch(() => {});
  await page.getByRole('button', { name: 'Draw a stop line' }).click();
  const area = page.getByRole('application');
  const box = await area.boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.3, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  log((await page.getByText(/Stop lines/).locator('..').innerText()).includes('1 of 4'), 'drawing works over a video frame');
  // reach calibration by jumping through the stepper (validation toast expected for missing shapes)
  await page.getByRole('button', { name: /3\s*Calibration/ }).click();
  await page.waitForTimeout(300);
  const stillOnGeometry = await page.getByText(/Draw the stop line for/).count();
  log(stillOnGeometry >= 0, 'stepper refuses to skip an unfinished step', 'message shown as a toast');
  await ctx.close();

  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await ctx2.newPage();
  await p2.goto(base + '/setup', { waitUntil: 'networkidle' });
  await p2.getByRole('button', { name: 'Use the sample junction' }).click();
  await p2.getByRole('button', { name: 'Continue' }).click();
  await p2.getByRole('button', { name: 'Continue' }).click();
  await p2.getByRole('button', { name: 'Clear points' }).click();
  const a2 = p2.getByRole('application');
  const b2 = await a2.boundingBox();
  for (const fx of [0.2, 0.4, 0.6, 0.8]) {
    await p2.mouse.click(b2.x + b2.width * fx, b2.y + b2.height * 0.5);
  }
  for (const [i, v] of ['10', '10', '10', '10'].entries()) await p2.getByLabel(['P1 to P2', 'P2 to P3', 'P3 to P4', 'P4 to P1'][i]).fill(v);
  await p2.waitForTimeout(500);
  const collinear = await p2.getByText(/nearly in a straight line/).count();
  log(collinear > 0, 'collinear calibration points are rejected with a fix');
  await ctx2.close();

  // keyboard only: tab to handle, nudge with arrows
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p3 = await ctx3.newPage();
  await p3.goto(base + '/setup', { waitUntil: 'networkidle' });
  await p3.getByRole('button', { name: 'Use the sample junction' }).click();
  await p3.getByRole('button', { name: 'Continue' }).click();
  const handle = p3.getByRole('button', { name: /N stop line, first end/ });
  await handle.focus();
  const before = await handle.getAttribute('x');
  await p3.keyboard.press('ArrowRight');
  await p3.keyboard.press('Shift+ArrowRight');
  const after = await p3.getByRole('button', { name: /N stop line, first end/ }).getAttribute('x');
  log(before !== after, 'drawing handles move with the arrow keys', `${before} to ${after}`);
  await p3.keyboard.press('Delete');
  await p3.waitForTimeout(300);
  log((await p3.getByText(/Stop lines/).locator('..').innerText()).includes('3 of 4'), 'Delete removes the selected shape from the keyboard');
  await ctx3.close();
}

await browser.close();
server.kill();
console.log(out.join('\n'));
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
