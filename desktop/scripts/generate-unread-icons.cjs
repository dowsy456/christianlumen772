'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const output = label => path.join(__dirname, label === '99+' || Number(label) > 50 ? '../../unread-icons-extra' : '../../unread-icons');
  await Promise.all([fs.mkdir(output('1'), { recursive: true }), fs.mkdir(output('99+'), { recursive: true })]);
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    for (const label of [...Array.from({ length: 99 }, (_, i) => String(i + 1)), '99+']) {
      const data = await page.evaluate(label => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(16, 16, 16, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `700 ${label.length === 1 ? 25 : label.length === 2 ? 21 : 16}px "Segoe UI",sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, 16, 17);
        return canvas.toDataURL('image/png').split(',')[1];
      }, label);
      await fs.writeFile(path.join(output(label), `${label}.png`), Buffer.from(data, 'base64'));
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
