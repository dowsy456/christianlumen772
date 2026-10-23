'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { normalizeSnapshot, rosterLayout } = require('../overlay.cjs');

(async () => {
  const source = await fs.readFile(path.join(__dirname, '../../call-modules/panel.js'), 'utf8');
  const badgeMarkup = Object.fromEntries(['muted', 'deafened', 'sharing'].map(kind => {
    const match = source.match(new RegExp(`addState\\("${kind}",[^\\n]+?'(<svg[\\s\\S]*?<\\/svg>)'\\);`));
    assert.ok(match, `reference avatar badge ${kind}`);
    return [kind, match[1]];
  }));
  badgeMarkup.watchingYourScreen = source.match(/App\.CALL_VIEWERS_EYE_SVG = '([^']+)'/)[1];
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.chatOverlayDisplay = { onState(callback) { window.__overlayState = callback; }, painted(generation) { window.__painted = generation; } }; });
    await page.goto(pathToFileURL(path.join(__dirname, '../ui/overlay.html')).href);
    for (const count of [6, 32]) {
      const display = { workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
      const layout = rosterLayout(display, count);
      await page.setViewportSize({ width: layout.bounds.width, height: layout.bounds.height });
      const state = normalizeSnapshot({ active: true, enabled: true, roomId: 'test', members: Array.from({ length: count }, (_, i) => ({ code: String(i), displayName: i === 0 ? 'Long display name '.repeat(15) : `User ${i + 1}`, muted: i % 4 === 0, deafened: i % 4 === 1, sharing: true, cameraSharing: true, watchingYourScreen: true })) });
      state.presentation = { generation: count, width: layout.bounds.width, height: layout.bounds.height, scale: layout.scale };
      await page.evaluate(state => window.__overlayState(state), state);
      await page.waitForFunction(generation => window.__painted === generation, count);
      const rendered = await page.evaluate(reference => {
        const shape = svg => Array.from(svg.querySelectorAll('path,rect,circle')).map(node => ({ tag: node.tagName, attrs: Object.fromEntries(['d', 'x', 'y', 'width', 'height', 'rx', 'cx', 'cy', 'r'].filter(attr => node.hasAttribute(attr)).map(attr => [attr, node.getAttribute(attr)])) }));
        return {
          clipping: Array.from(document.querySelectorAll('.overlay-member')).map(row => { const r = row.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }),
          iconsMatch: Object.entries(reference).map(([kind, markup]) => { const expected = new DOMParser().parseFromString(markup, 'text/html').querySelector('svg'); return [kind, JSON.stringify(shape(document.querySelector(`.state-${kind} svg`))) === JSON.stringify(shape(expected))]; }),
          colors: ['muted', 'deafened', 'sharing'].map(kind => getComputedStyle(document.querySelector(`.state-${kind}`)).color),
          eyeText: document.querySelector('.state-watchingYourScreen').textContent,
          shadows: Array.from(document.querySelectorAll('.avatar,.name-pill')).every(node => getComputedStyle(node).boxShadow === 'none'),
          pageTransparent: getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)',
        };
      }, badgeMarkup);
      assert.equal(await page.locator('.name-pill .state-cameraSharing').count(), count, 'camera appears in name-pill indicators');
      assert.equal(await page.locator('.avatar .state-cameraSharing').count(), 0, 'no camera indicator covers the profile photo');
      assert.equal(await page.locator('.state-cameraSharing').first().evaluate(e => getComputedStyle(e).color), 'rgb(105, 200, 152)');
      assert.equal(rendered.clipping.length, count);
      assert.ok(rendered.clipping[0].left <= 7, 'roster sits next to the desktop edge');
      for (const box of rendered.clipping) assert.ok(box.left >= 0 && box.top >= 0 && box.right <= layout.bounds.width + .1 && box.bottom <= layout.bounds.height + .1, `roster clips: ${JSON.stringify(box)}`);
      for (const [kind, match] of rendered.iconsMatch) assert.equal(match, true, `${kind} matches call menu avatar/viewer icon`);
      assert.deepEqual(rendered.colors, ['rgb(239, 140, 145)', 'rgb(239, 140, 145)', 'rgb(105, 200, 152)']);
      assert.equal(rendered.eyeText, '', 'viewer icon is a monochrome SVG, not emoji text');
      assert.equal(rendered.shadows, true);
      assert.equal(rendered.pageTransparent, true);
      if (count === 6) {
        const output = path.resolve(__dirname, '../../../qa/corrected-overlay.png');
        await fs.mkdir(path.dirname(output), { recursive: true });
        await page.screenshot({ path: output, omitBackground: true });
      }
    }
    // A profile can take arbitrarily long to decode. The native roster must
    // acknowledge its fallback paint anyway, even when Windows clamps the
    // CSS viewport differently from a requested native window rectangle.
    await page.evaluate(() => {
      window.__originalImage = window.Image;
      window.Image = class extends window.__originalImage {
        decode() { return new Promise(() => {}); }
      };
      window.__overlayState({ active: true, enabled: true, members: [{
        code: 'slow-avatar', displayName: 'Visible immediately', photoDataURL: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        photoTransform: { x: 0, y: 0, scale: 1 },
      }], presentation: { generation: 100, width: 10, height: 10, scale: .7 } });
    });
    await page.waitForFunction(() => window.__painted === 100, { timeout: 1500 });
    assert.equal(await page.locator('.display-name').textContent(), 'Visible immediately');
    assert.match(await page.locator('.avatar img').getAttribute('src'), /^data:image\/svg\+xml,/);
    assert.deepEqual(errors, []);
    console.log('Overlay renderer: 6/32 member layouts, edge placement, clipping, SVG parity, and immediate fallback paint with stalled avatar decode/native size mismatch PASS');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
