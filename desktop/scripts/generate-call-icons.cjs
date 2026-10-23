'use strict';
// Build-time asset helper. The shipped EXE uses these tiny PNGs directly and
// does not create a renderer or rasterize icons during startup.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const index = await fs.readFile(path.join(__dirname, '../../index.html'), 'utf8');
  const sidebar = await fs.readFile(path.join(__dirname, '../../js/ui/sidebar.js'), 'utf8');
  const extra = {};
  const output = path.join(__dirname, '../assets/call-controls');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 32, height: 32 }, deviceScaleFactor: 1 });
    for (const [name, button, color] of [
      ['mute', 'mute', '#d7e1ed'], ['mute-active', 'mute', '#f06b75'],
      ['deafen', 'deafen', '#d7e1ed'], ['deafen-active', 'deafen', '#f06b75'],
      ['overlay', 'overlay', '#d7e1ed'], ['overlay-active', 'overlay', '#55b98a'],
      ['share', 'share', '#d7e1ed'], ['share-active', 'share', '#55b98a'],
      ['camera', 'camera', '#d7e1ed'], ['camera-active', 'camera', '#55b98a'],
      ['leave', 'leave', '#f06b75'],
    ]) {
      const markup = index.match(new RegExp(`<button[^>]+id="btn-call-${button}"[^>]*>[\\s\\S]*?<svg[\\s\\S]*?</svg>`))?.[0];
      let svg = markup?.slice(markup.indexOf('<svg'));
      if (!svg) throw Error(`Missing call icon ${button}`);
      if (button === 'leave') svg = sidebar.match(/leaveIcon\.innerHTML = '([^']+)'/)?.[1] || svg;
      if (['mute-active', 'deafen-active'].includes(name)) svg = svg.replace('</svg>', '<path d="M4 4 20 20" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>');
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:32px;height:32px;color:${color}}</style>${svg}`);
      if (button === 'share' || button === 'camera') extra[name] = 'data:image/png;base64,' + (await page.screenshot({ omitBackground: true })).toString('base64');
      else await page.screenshot({ path: path.join(output, `${name}.png`), omitBackground: true });
    }
    const taskbarPath = path.join(__dirname, '../taskbar.cjs');
    const taskbar = await fs.readFile(taskbarPath, 'utf8');
    await fs.writeFile(taskbarPath, taskbar.replace(/^const EXTRA_ICON_DATA = .*;$/m, `const EXTRA_ICON_DATA = ${JSON.stringify(extra)};`));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
