/* Shared Calendar ordering uses isolated fixtures only; external HTTP is blocked. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { createSharedFirebaseBackend } = require('./shared-firebase-backend.cjs');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, '../calendar-order-checks'));
const date = '2026-09-14';
const note = (page, id) => page.locator(`.calendar-note-item[data-id="${id}"]`);
const ids = page => page.locator('.calendar-note-item').evaluateAll(nodes => nodes.map(node => node.dataset.id));
async function expectOrder(page, expected) {
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.calendar-note-item')].map(node => node.dataset.id)) === JSON.stringify(expected), expected);
  assert.deepEqual(await ids(page), expected);
}
async function day(page) { await page.evaluate(date => ChatApp.showCalendarDay(date), date); await page.locator('.calendar-day-page').waitFor(); }
async function month(page) { await page.evaluate(date => ChatApp.showCalendarPage(date), date); await page.locator('.calendar-month-page').waitFor(); }
async function previews(page, expected) {
  await page.waitForFunction(({ date, expected }) => JSON.stringify([...document.querySelectorAll(`.calendar-day[data-date="${date}"] .calendar-note-preview`)].map(node => node.textContent)) === JSON.stringify(expected), { date, expected });
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const backend = createSharedFirebaseBackend(2);
  backend.values.calendar = { activeYear: 2026, years: { 2026: { [date]: {
    a: { text: 'First note', createdAt: 1, updatedAt: 1, authorUsername: 'P1', authorName: 'P1' },
    b: { text: 'Second note', createdAt: 2, updatedAt: 2, authorUsername: 'P1', authorName: 'P1' },
    c: { text: 'Spotlight this note', createdAt: 3, updatedAt: 3, authorUsername: 'P2', authorName: 'P2' }
  } } } };
  backend.values.usernames = {};
  for (const code of ['P1', 'P2']) backend.values.usernames[createHash('sha256').update(code.toLowerCase()).digest('hex')] = { code };
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [];
  async function makePage(code, mobile) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, isMobile: mobile, timezoneId: 'UTC' });
    await backend.bind(context);
    await context.addInitScript(() => {
      const NativeDate = Date, fixed = NativeDate.parse('2026-09-14T12:00:00Z');
      window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };
    });
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${code}: ${error.message}`));
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.click('#btn-go-login'); await page.fill('#login-code', code); await page.click('#btn-login');
    await page.waitForFunction(code => ChatApp.currentUser?.code === code && ChatApp.calendarState?.ready && ChatApp.calendarState?.connected, code);
    return page;
  }
  try {
    const one = await makePage('P1', false), two = await makePage('P2', true);
    await day(one); await month(two);
    await expectOrder(one, ['a', 'b', 'c']);
    assert.equal(await note(one, 'a').getByRole('button', { name: 'Move note up', exact: true }).isDisabled(), true);
    assert.equal(await note(one, 'c').getByRole('button', { name: 'Move note down', exact: true }).isDisabled(), true);
    await previews(two, ['First note', 'Second note']);
    const up = note(one, 'c').getByRole('button', { name: 'Move note up', exact: true });
    await up.focus(); await one.keyboard.press('Enter');
    await expectOrder(one, ['a', 'c', 'b']);
    await one.waitForFunction(() => document.activeElement?.closest('.calendar-note-item')?.dataset.id === 'c' && !document.activeElement.disabled);
    await previews(two, ['First note', 'Spotlight this note']);
    await up.focus(); await one.keyboard.press('Enter');
    await expectOrder(one, ['c', 'a', 'b']);
    await one.waitForFunction(() => document.activeElement?.classList.contains('calendar-note-move-down') && document.activeElement.closest('.calendar-note-item')?.dataset.id === 'c');
    await previews(two, ['Spotlight this note', 'First note']);
    assert.equal(backend.get(`calendar/years/2026/${date}/c`).order, 0);
    assert.equal(backend.get(`calendar/years/2026/${date}/c`).authorUsername, 'P2');
    assert.equal(backend.get(`calendar/years/2026/${date}/c`).updatedAt, 3, 'reordering does not pretend the note text changed');
    await one.screenshot({ path: path.join(output, 'calendar-order-desktop.png') });

    // A live move by another user must preserve a local unsaved draft and selection.
    await note(one, 'b').getByRole('button', { name: 'Edit', exact: true }).click();
    const input = note(one, 'b').locator('textarea');
    await input.fill('Unsaved text survives the move');
    await input.evaluate(node => { node.focus(); node.setSelectionRange(2, 8); });
    await day(two);
    await note(two, 'a').getByRole('button', { name: 'Move note up', exact: true }).tap();
    await expectOrder(one, ['a', 'c', 'b']);
    assert.equal(await input.inputValue(), 'Unsaved text survives the move');
    assert.deepEqual(await input.evaluate(node => [document.activeElement === node, node.selectionStart, node.selectionEnd]), [true, 2, 8]);
    await note(one, 'b').getByRole('button', { name: 'Save', exact: true }).click();
    await two.waitForFunction(() => document.querySelector('.calendar-note-item[data-id="b"] .calendar-note-bubble')?.textContent === 'Unsaved text survives the move');
    assert.equal(backend.get(`calendar/years/2026/${date}/b`).order, 2, 'saving after a move keeps the position');
    await note(two, 'c').locator('.calendar-remind-checkbox').check();
    await two.waitForFunction(date => ChatApp.isCalendarNoteReminder(date, 'c'), date);
    await note(two, 'c').getByRole('button', { name: 'Move note up', exact: true }).tap();
    await expectOrder(two, ['c', 'a', 'b']);
    assert.equal(await note(two, 'c').locator('.calendar-remind-checkbox').isChecked(), true, 'personal reminder follows the unchanged note ID');
    assert.equal(backend.get(`calendarReminders/P1/${date}`), null, 'other users do not inherit reminder tags');
    const bounds = await two.locator('.calendar-note-order').evaluateAll(groups => groups.map(group => {
      const rect = group.getBoundingClientRect(), card = group.closest('.calendar-note-item').getBoundingClientRect();
      return { left: rect.left, right: rect.right, cardRight: card.right, viewport: innerWidth };
    }));
    assert.ok(bounds.every(item => item.left >= 0 && item.right <= item.cardRight + 1 && item.right <= item.viewport + 1), 'all reorder controls fit narrow screens');
    await two.screenshot({ path: path.join(output, 'calendar-order-mobile.png') });

    await one.reload();
    await one.waitForFunction(() => ChatApp.currentUser?.code === 'P1' && ChatApp.calendarState?.ready);
    await expectOrder(one, ['c', 'a', 'b']);
    await month(one); await previews(one, ['Spotlight this note', 'First note']);
    const added = await one.evaluate(date => ChatApp.saveCalendarNote(date, null, 'New notes go at the end'), date);
    await day(one); await expectOrder(one, ['c', 'a', 'b', added]);
    await month(two); await previews(two, ['Spotlight this note', 'First note']);
    await day(one);
    await one.evaluate(() => { ChatApp.calendarState.connected = false; ChatApp.renderCalendar(); });
    assert.equal(await note(one, 'a').getByRole('button', { name: 'Move note up', exact: true }).isDisabled(), true);
    assert.equal(await note(one, 'a').getByRole('button', { name: 'Move note down', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []); assert.deepEqual(backend.deliveryErrors, []);
    console.log('Calendar order: two-client live sync, month spotlight, keyboard/touch, mobile fit, drafts, author/reminder retention, reload and append PASS');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
