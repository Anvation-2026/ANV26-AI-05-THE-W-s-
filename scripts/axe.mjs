import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';

const routes = ['/', '/setup', '/perception', '/demand', '/twin', '/controller', '/console', '/experiments', '/report', '/parameters', '/method', '/terms', '/privacy', '/nope'];
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4175', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ channel: 'chrome' });
const summary = {};
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('signaltwin-theme', t); } catch {} }, theme);
  const page = await ctx.newPage();
  for (const r of routes) {
    await page.goto('http://localhost:4175' + r, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
    for (const v of res.violations) {
      const key = `${v.id} (${v.impact})`;
      summary[key] ??= { help: v.help, where: new Set(), sample: [] };
      summary[key].where.add(`${theme}:${r}`);
      if (summary[key].sample.length < 2) summary[key].sample.push(v.nodes[0]?.target?.join(' ') + ' | ' + (v.nodes[0]?.any?.[0]?.message ?? v.nodes[0]?.failureSummary ?? '').slice(0, 160));
    }
  }
  await ctx.close();
}
await browser.close();
server.kill();
const keys = Object.keys(summary);
if (!keys.length) console.log('No axe violations on 14 routes in light and dark.');
for (const k of keys) console.log(`${k}: ${summary[k].help}\n   pages: ${[...summary[k].where].slice(0, 8).join(', ')}${summary[k].where.size > 8 ? ` +${summary[k].where.size - 8}` : ''}\n   e.g. ${summary[k].sample.join('\n        ')}`);
