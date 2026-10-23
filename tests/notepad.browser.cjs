/* Tab-local draft checks with an isolated Firebase fixture and no remote access. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const mock = require('./firebase-mock.js');
const appURL = pathToFileURL(path.resolve(__dirname, '../index.html')).href;
const note = 'Draft only in this tab\n<script>ordinary note text</script>\nSecond line';

async function ready(page) {
  await page.goto(appURL);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  if (!await page.evaluate(() => !!ChatApp.currentUser)) {
    await page.click('#btn-go-login');
    await page.fill('#login-code', 'TEST-USER');
    await page.click('#btn-login');
  }
  await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
}
async function open(page) {
  await page.evaluate(() => ChatApp.openNotepadModal());
  await page.waitForSelector('#notepad-editor');
}
async function beginDelayedImport(page) {
  await page.evaluate(() => {
    const file = new File(['Delayed import'], 'slow.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'text', { value: () => new Promise(resolve => { window.__completeNotepadImport = resolve; }) });
    const input = document.querySelector('#notepad-file-input');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    delete input.files;
  });
}
async function finishDelayedImport(page) {
  await page.evaluate(async () => {
    window.__completeNotepadImport('Delayed import');
    await Promise.resolve();
  });
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    for (const blockedStorage of [false, true]) {
      const context = await browser.newContext();
      await context.addInitScript(mock);
      if (blockedStorage) await context.addInitScript(() => {
        Object.defineProperty(window, 'sessionStorage', { value: {
          getItem() { throw new Error('Storage unavailable'); },
          setItem() { throw new Error('Storage unavailable'); }
        } });
      });
      await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await ready(page);
      await open(page);
      await page.fill('#notepad-filename', 'strategy.txt');
      await page.fill('#notepad-editor', note);
      await page.click('#btn-modal-close');
      await page.waitForFunction(() => ChatApp.modalEl.hidden);
      await open(page);
      assert.equal(await page.inputValue('#notepad-editor'), note, 'closing preserves typed text');
      assert.equal(await page.inputValue('#notepad-filename'), 'strategy.txt');
      await page.evaluate(() => ChatApp.openModal({ title: 'Another tool', bodyHTML: '<p>Replacement</p>' }));
      await open(page);
      assert.equal(await page.inputValue('#notepad-editor'), note, 'replacement preserves the draft');
      if (!blockedStorage) {
        await ready(page);
        await open(page);
        assert.equal(await page.inputValue('#notepad-editor'), note, 'reload preserves the same tab session');
        const otherTab = await context.newPage();
        await ready(otherTab);
        await open(otherTab);
        assert.equal(await otherTab.inputValue('#notepad-editor'), '', 'a fresh tab has its own draft');
        await otherTab.close();
      }
      await page.click('#btn-notepad-new');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => ChatApp.modalEl.hidden);
      await open(page);
      assert.equal(await page.inputValue('#notepad-editor'), '', 'New deliberately clears the stored draft');
      assert.equal(await page.inputValue('#notepad-filename'), '');
      await page.setInputFiles('#notepad-file-input', { name: 'imported.md', mimeType: 'text/markdown', buffer: Buffer.from('# Imported draft') });
      await page.waitForFunction(() => document.querySelector('#notepad-editor').value === '# Imported draft');
      await page.click('#btn-modal-close');
      await page.waitForFunction(() => ChatApp.modalEl.hidden);
      await open(page);
      assert.equal(await page.inputValue('#notepad-editor'), '# Imported draft', 'imported files also survive closing');
      assert.equal(await page.inputValue('#notepad-filename'), 'imported.md');

      await page.evaluate(() => {
        window.__notepadOriginalUser = ChatApp.currentUser;
        ChatApp.currentUser = { code: 'ANOTHER-USER', username: 'Another' };
      });
      await open(page);
      assert.equal(await page.inputValue('#notepad-editor'), '', 'switching accounts starts with its own empty draft');
      await page.fill('#notepad-editor', 'Other account private text');
      await page.evaluate(() => { ChatApp.currentUser = window.__notepadOriginalUser; });
      await open(page);
      assert.equal(await page.inputValue('#notepad-editor'), '# Imported draft', 'switching back restores the original account draft');
      assert.equal(await page.inputValue('#notepad-filename'), 'imported.md');

      await beginDelayedImport(page);
      await page.click('#btn-notepad-new');
      await finishDelayedImport(page);
      assert.equal(await page.inputValue('#notepad-editor'), '', 'New cancels a pending file read');
      assert.equal(await page.inputValue('#notepad-filename'), '');
      await beginDelayedImport(page);
      await page.fill('#notepad-editor', 'Newer typed draft');
      await finishDelayedImport(page);
      assert.equal(await page.inputValue('#notepad-editor'), 'Newer typed draft', 'typing cancels an older file read');
      await beginDelayedImport(page);
      await page.fill('#notepad-filename', 'new-name.txt');
      await finishDelayedImport(page);
      assert.equal(await page.inputValue('#notepad-filename'), 'new-name.txt', 'renaming cancels an older file read');
      assert.equal(await page.inputValue('#notepad-editor'), 'Newer typed draft');
      await beginDelayedImport(page);
      await page.click('#btn-modal-close');
      await page.waitForFunction(() => ChatApp.modalEl.hidden);
      await open(page);
      await page.fill('#notepad-editor', 'Reopened current draft');
      await finishDelayedImport(page);
      await page.click('#btn-modal-close');
      await page.waitForFunction(() => ChatApp.modalEl.hidden);
      await open(page);
      assert.equal(await page.inputValue('#notepad-editor'), 'Reopened current draft', 'an import from a closed modal cannot replace the reopened draft');
      assert.equal(await page.inputValue('#notepad-filename'), 'new-name.txt');
      const writes = await page.evaluate(() => JSON.stringify(window.__testDatabase.writes));
      assert.ok(!['Imported draft', 'Draft only in this tab', 'Other account private text', 'Reopened current draft'].some(text => writes.includes(text)), 'drafts never enter Firebase writes');
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ blockedStorage, reopen: true, import: true, importCancellation: true, accountIsolation: true, new: true, firebaseDraftWrites: 0, errors: 0 }));
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
