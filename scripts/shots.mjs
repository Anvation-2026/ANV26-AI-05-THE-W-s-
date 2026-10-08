import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const routes = (process.argv[2] ?? '/,/setup,/perception,/demand,/twin,/controller,/console,/experiments,/report,/parameters,/method,/terms,/privacy,/nope').split(',');
const widths = (process.argv[3] ?? '1440').split(',').map(Number);
const themes = (process.argv[4] ?? 'light').split(',');
const wait = Number(process.argv[5] ?? 2500);
const outDir = process.argv[6] ?? 'shots';
mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
for (const theme of themes) {
  for (const w of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 800 ? 844 : 900 }, colorScheme: theme });
    await ctx.addInitScript((t) => { try { localStorage.setItem('signaltwin-theme', t); } catch {} }, theme);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${theme} ${w}] console: ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => problems.push(`[${theme} ${w}] pageerror: ${String(e).slice(0, 300)}`));
    for (const r of routes) {
      await page.goto('http://localhost:4173' + r, { waitUntil: 'networkidle' });
      await page.waitForTimeout(wait);
      const name = (r === '/' ? 'home' : r.replace(/[^a-z]/gi, '')) + `-${w}-${theme}`;
      await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`[${theme} ${w}] ${r}: horizontal overflow ${overflow}px`);
    }
    await ctx.close();
  }
}
await browser.close();
server.kill();
console.log(problems.length ? problems.join('\n') : 'No console errors or horizontal overflow.');
