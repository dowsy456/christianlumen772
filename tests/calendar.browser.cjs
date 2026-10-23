/* Chrome integration checks against an isolated shared Firebase fixture. No production requests. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { createSharedFirebaseBackend } = require('./shared-firebase-backend.cjs');
const root = path.resolve(__dirname, '..');
const reportDir = path.resolve(process.argv[2] || path.join(root, '../calendar-v3-browser-results'));
const entry = pathToFileURL(path.join(root, 'index.html')).href;
const today = '2026-09-14';
const fresh = '.calendar-editor[data-kind="note"][data-id="__new__"]';
const editor = id => `.calendar-editor[data-kind="note"][data-id="${id}"]`;
const photo = color => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="${color}"/><circle cx="100" cy="75" r="55" fill="#54cfc9"/></svg>`).toString('base64');
async function loggedIn(page, code) {
  await page.goto(entry); await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  if (await page.evaluate(() => !ChatApp.currentUser)) { await page.click('#btn-go-login'); await page.fill('#login-code', code); await page.click('#btn-login'); }
  await page.waitForFunction(code => ChatApp.currentUser?.code === code && ChatApp.calendarState?.ready && ChatApp.calendarState?.remindersReady && ChatApp.calendarState?.connected, code);
}
async function calendar(page, date) { await page.evaluate(date => ChatApp.showCalendarPage(date), date); await page.locator('.calendar-month-page').waitFor({ state: 'visible' }); }
async function dayPage(page, date) { await page.evaluate(date => ChatApp.showCalendarDay(date), date); await page.locator('.calendar-day-page').waitFor({ state: 'visible' }); }
async function dismissToasts(page) {
  for (let i = 0; i < 8; i++) {
    if (!await page.locator('#toast.is-showing').isVisible()) { await page.waitForTimeout(210); if (!await page.locator('#toast.is-showing').isVisible()) break; }
    await page.locator('#btn-toast-close').click(); await page.waitForTimeout(210);
  }
}
async function selectMonth(page, index) {
  await page.locator('.calendar-controls .custom-select-btn').click();
  await page.locator(`.custom-select-pop:not([hidden]) .custom-select-opt[data-custom-select-index="${index}"]`).click();
  assert.equal(await page.locator('#calendar-month-select').inputValue(), String(index));
}
async function selectNoteDate(page, date) {
  const trigger = page.locator('#calendar-note-date');
  const previous = await trigger.getAttribute('data-value');
  await trigger.click();
  const popup = page.locator('.calendar-date-picker-pop'); await popup.waitFor({ state: 'visible' });
  const months = (Number(date.slice(0, 4)) - Number(previous.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(previous.slice(5, 7));
  for (let i = 0; i < Math.abs(months); i++) await popup.locator(`[data-action="${months < 0 ? 'prev' : 'next'}"]`).click();
  await popup.locator(`[data-date="${date}"]`).click();
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await trigger.getAttribute('data-value'), date);
}
async function exerciseDatePicker(page) {
  const trigger = page.locator('#calendar-note-date');
  await trigger.click();
  const popup = page.locator('.calendar-date-picker-pop'); await popup.waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(reportDir, 'calendar-custom-date-picker.png') });
  for (const [month, boundary] of [[0, 'prev'], [11, 'next']]) {
    await popup.locator('[data-action="months"]').click();
    await popup.locator(`[data-action="month"][data-month="${month}"]`).click();
    assert.equal(await popup.locator(`[data-action="${boundary}"]`).isDisabled(), true, 'custom date picker stays in the current year');
  }
  await popup.locator('[data-action="months"]').click(); await popup.locator('[data-action="month"][data-month="8"]').click();
  await popup.locator(`[data-date="${today}"]`).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2026-09-15');
  await page.evaluate(() => ChatApp.renderCalendar());
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2026-09-15', 'live render preserves picker keyboard focus');
  await page.keyboard.press('Enter'); await popup.waitFor({ state: 'hidden' });
  assert.equal(await trigger.getAttribute('data-value'), '2026-09-15');
  await trigger.click(); await popup.waitFor({ state: 'visible' }); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate(el => document.activeElement === el), true, 'Escape returns focus to the date trigger');
  assert.equal(await trigger.getAttribute('data-value'), '2026-09-15', 'Escape does not commit an unchosen day');
}
async function addNote(page, text, date = today, remind = false) {
  await selectNoteDate(page, date);
  const form = page.locator(fresh);
  await form.locator('textarea.calendar-editor-input').fill(text);
  if (remind) await form.locator('.calendar-remind-checkbox').check();
  await form.locator('.calendar-editor-save').click();
  await page.waitForFunction(({ date, text }) => Object.values(ChatApp.calendarState.notes[date] || {}).some(record => record.text === text), { date, text });
  const id = await page.evaluate(({ date, text }) => Object.entries(ChatApp.calendarState.notes[date]).find(([, record]) => record.text === text)[0], { date, text });
  if (remind) await page.waitForFunction(({ date, id }) => ChatApp.isCalendarNoteReminder(date, id), { date, id });
  return id;
}
async function editNote(page, id, text, save = true) {
  const form = page.locator(editor(id));
  if (await form.locator('.calendar-editor-edit').isVisible()) await form.locator('.calendar-editor-edit').click();
  await form.locator('textarea.calendar-editor-input').fill(text);
  assert.equal(await form.locator('textarea.calendar-editor-input').evaluate(el => getComputedStyle(el).resize), 'none', 'saved note editing is non-resizable');
  if (save) await form.locator('.calendar-editor-save').click();
}
async function monthGeometry(page, name) {
  await dismissToasts(page); await page.evaluate(() => { ChatApp.closeMobileDrawers?.(); ChatApp.messagesEl.scrollTop = 0; }); await page.waitForTimeout(180);
  const bounds = await page.evaluate(() => {
    const rect = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
    const toolbar = document.querySelector('.calendar-toolbar');
    return { viewport: rect(ChatApp.messagesEl), card: rect(document.querySelector('.calendar-month-card')), grid: rect(document.querySelector('.calendar-grid')), gridCard: rect(document.querySelector('.calendar-month-grid-card')), toolbar: rect(toolbar), toolbarBackground: getComputedStyle(toolbar).backgroundColor, toolbarImage: getComputedStyle(toolbar).backgroundImage, toolbarInGridCard: !!toolbar.closest('.calendar-month-grid-card'), add: rect(document.querySelector('#calendar-note-date')), docWidth: document.documentElement.scrollWidth, width: innerWidth, height: innerHeight };
  });
  assert.ok(bounds.grid.bottom <= Math.min(bounds.viewport.bottom, bounds.height) + 2, `${name}: every calendar row fits ${JSON.stringify(bounds)}`);
  assert.ok(bounds.card.height >= bounds.viewport.height * .78, `${name}: month fills workspace`);
  assert.ok(bounds.add.top >= Math.min(bounds.viewport.bottom, bounds.height) - 12, `${name}: unified form starts below viewport`);
  assert.ok(bounds.docWidth <= bounds.width + 1 && bounds.card.left >= -1 && bounds.card.right <= bounds.width + 1, `${name}: fits horizontally`);
  assert.equal(bounds.toolbarInGridCard, false, `${name}: title is outside grid box`);
  assert.equal(bounds.toolbarBackground, 'rgba(0, 0, 0, 0)', `${name}: title toolbar is transparent`);
  assert.equal(bounds.toolbarImage, 'none', `${name}: title toolbar has no background image`);
  assert.ok(bounds.toolbar.bottom <= bounds.gridCard.top + 2, `${name}: title is above grid box`);
  await page.screenshot({ path: path.join(reportDir, `${name}.png`) });
  await page.locator('#calendar-note-date').scrollIntoViewIfNeeded(); assert.ok(await page.evaluate(() => ChatApp.messagesEl.scrollTop > 0), `${name}: scrolling reveals unified form`);
  return bounds;
}
async function waitReminder(page) {
  for (let i = 0; i < 6; i++) {
    await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('is-showing'));
    if ((await page.locator('#toast-title').textContent()) === 'Reminder for today') return await page.locator('#toast-body').textContent();
    await page.locator('#btn-toast-close').click(); await page.waitForTimeout(210);
  }
  throw new Error('Expected queued calendar reminder in the existing app toast');
}
(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  const backend = createSharedFirebaseBackend(2), errors = [], contexts = [];
  for (const [code, username, displayName] of [['P1', 'alicehandle', 'Alice Visible'], ['P2', 'bobhandle', 'Bob Visible']]) {
    Object.assign(backend.values.users[code], { username, usernameLower: username, displayName, displayNameLower: displayName.toLowerCase(), photoDataURL: photo(code === 'P1' ? '#ff6748' : '#8e84df'), photoTransform: { unit: 'rel', scale: 1.6, x: .13, y: -.08 } });
    (backend.values.usernames ||= {})[createHash('sha256').update(username).digest('hex')] = { u: username, code };
  }
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  async function makePage(code, viewport) {
    const context = await browser.newContext({ viewport, timezoneId: 'Pacific/Honolulu' }); contexts.push(context); await backend.bind(context);
    await context.addInitScript(() => { const NativeDate = Date, fixed = NativeDate.parse('2026-09-15T07:30:00Z'); class LocalTestDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } } window.Date = LocalTestDate; });
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(`${code}: ${error.message}`)); await loggedIn(page, code); return page;
  }
  try {
    const one = await makePage('P1', { width: 1440, height: 900 }), two = await makePage('P2', { width: 1440, height: 900 });
    await one.click('#btn-side-calendar'); await one.locator('.calendar-month-page').waitFor(); await calendar(two); await dismissToasts(one); await dismissToasts(two);
    assert.equal(await one.locator('#modal').isVisible(), false); assert.equal(await one.evaluate(() => ChatApp.calendarState.today), today);
    assert.equal(await one.locator('.calendar-hero, .calendar-legend, .calendar-reminders-section, #calendar-reminder-date, .calendar-reminder-list, .calendar-reminder-toasts').count(), 0, 'no old standalone reminder UI');
    assert.equal(await one.locator('#calendar-month-select option').count(), 12); assert.ok((await one.locator('#calendar-month-select').getAttribute('class')).includes('custom-select-native'), 'month uses app custom dropdown');
    assert.equal(await one.locator('#calendar-note-date').evaluate(el => el.tagName), 'BUTTON', 'note date uses custom picker');
    assert.equal(await one.locator('.calendar-page input[type="date"]').count(), 0, 'no native date inputs');
    assert.equal(await one.locator(`${fresh} .calendar-editor-delete:visible`).count(), 0);
    await selectMonth(one, 0); assert.equal(await one.locator('[data-calendar-action="prev"]').isDisabled(), true);
    await selectMonth(one, 11); assert.equal(await one.locator('[data-calendar-action="next"]').isDisabled(), true);
    await selectMonth(one, 7); assert.equal(await one.locator('.calendar-grid > *').count(), 42);
    const geometry = { desktopSixWeeks: await monthGeometry(one, 'calendar-desktop-six-weeks') };
    assert.equal(await one.locator('#calendar-note-date').getAttribute('data-value'), today, 'past month browse leaves new-note date today');
    await exerciseDatePicker(one);
    const tagged = await addNote(one, 'Remember this note from today.', today, true); assert.equal(backend.get(`calendarReminders/P1/${today}/${tagged}`).noteId, tagged);
    await dismissToasts(one); const oldId = await addNote(one, 'An old-month note remains editable.', '2026-08-05');
    await one.locator('.calendar-day[data-date="2026-08-05"]').click(); await one.locator('.calendar-day-page').waitFor();
    assert.equal((await one.locator('[data-calendar-action="back"]').textContent()).trim(), 'Back');
    assert.equal(await one.locator('.calendar-grid').count(), 0); assert.equal(await one.locator(fresh).count(), 0);
    await dayPage(two, '2026-08-05'); await editNote(two, oldId, 'Bob edited this old note.');
    await one.waitForFunction(id => ChatApp.calendarState.notes['2026-08-05']?.[id]?.text === 'Bob edited this old note.', oldId);
    await one.locator('[data-calendar-action="back"]').click(); await one.locator('.calendar-month-page').waitFor(); assert.equal(await one.locator('#calendar-month-select').inputValue(), '7');
    await one.locator('[data-calendar-action="today"]').click();
    const text = '<img src=x onerror="window.__calendarInjection=true"> Literal text.\nA second line.';
    const first = await addNote(one, text); await one.locator(`.calendar-day[data-date="${today}"]`).click(); await one.locator('.calendar-day-page').waitFor();
    assert.equal(await one.locator(`${editor(first)} .calendar-note-bubble`).textContent(), text); assert.equal(await one.evaluate(() => !!window.__calendarInjection), false);
    assert.equal(await one.locator(`${editor(first)} textarea`).isVisible(), false, 'saved notes initially display as bubbles');
    const bubbleStyle = await one.locator(`${editor(first)} .calendar-note-bubble`).evaluate(el => ({ resize: getComputedStyle(el).resize, height: el.clientHeight, scrollHeight: el.scrollHeight, width: el.clientWidth, parentWidth: el.parentElement.clientWidth }));
    assert.equal(bubbleStyle.resize, 'none'); assert.ok(bubbleStyle.height <= 100 && bubbleStyle.scrollHeight <= bubbleStyle.height + 1, 'short saved bubble fits its text');
    assert.ok(bubbleStyle.width < bubbleStyle.parentWidth - 20, 'short saved bubble does not stretch to full list width');
    assert.equal(await one.locator('.calendar-day-page').getByText(/^Note \d+$/).count(), 0);
    assert.equal(await one.locator('.calendar-day-page').getByText(/^(Saved|Up to date)$/).count(), 0);
    await editNote(one, first, 'My unsaved draft survives a live addition.', false);
    await calendar(two, today); const second = await addNote(two, 'Another user adds this while Alice reads the day.'); await one.locator(editor(second)).waitFor();
    assert.equal(await one.locator(`${editor(first)} textarea`).inputValue(), 'My unsaved draft survives a live addition.');
    await one.locator(`${editor(first)} .calendar-editor-save`).click(); await dayPage(two, today);
    await editNote(one, first, 'Chosen version after conflict review.', false); await editNote(two, first, 'Bob changed this simultaneously.');
    const conflict = one.locator(editor(first)); await conflict.locator('.calendar-editor-conflict').waitFor({ state: 'visible' });
    assert.equal(await conflict.locator('.calendar-editor-save').isDisabled(), true); await conflict.getByRole('button', { name: 'Keep my draft', exact: true }).click(); await conflict.locator('.calendar-editor-save').click();
    await two.waitForFunction(id => ChatApp.calendarState.notes[ChatApp.calendarState.today]?.[id]?.text === 'Chosen version after conflict review.', first);
    const author = one.locator(`${editor(first)} .calendar-author-button`), avatar = author.locator('img'); await author.getByText('alicehandle', { exact: true }).waitFor();
    assert.equal((await author.textContent()).includes('Alice Visible'), false); assert.equal(await avatar.evaluate(img => img.style.transform), 'translate(-37%, -58%) scale(1.6)'); assert.equal(await avatar.evaluate(img => getComputedStyle(img).objectFit), 'contain');
    const updatedPhoto = photo('#3489c6'); await two.evaluate(async src => ChatApp.db.ref('users/P1').update({ username: 'AliceHandle', usernameLower: 'alicehandle', photoDataURL: src, photoTransform: { unit: 'rel', scale: 1.25, x: -.1, y: .06 } }), updatedPhoto);
    await one.waitForFunction(({ id, src }) => document.querySelector(`.calendar-editor[data-id="${id}"] .calendar-author-avatar img`)?.getAttribute('src') === src, { id: first, src: updatedPhoto });
    assert.equal(await avatar.evaluate(img => img.style.transform), 'translate(-60%, -44%) scale(1.25)');
    await author.getByText('AliceHandle', { exact: true }).waitFor();
    await author.click(); await one.waitForFunction(() => ChatApp.userProfileOpen && ChatApp.userProfilePinnedCode === 'P1'); await author.evaluate(el => el.click()); await one.waitForFunction(() => !ChatApp.userProfileOpen);
    await author.focus(); await one.keyboard.press('Enter'); await one.waitForFunction(() => ChatApp.userProfileOpen); await one.keyboard.press('Enter'); await one.waitForFunction(() => !ChatApp.userProfileOpen);
    await one.locator(`${editor(first)} .calendar-remind-checkbox`).check(); await one.waitForFunction(id => ChatApp.isCalendarNoteReminder(ChatApp.calendarState.today, id), first);
    assert.equal(await two.locator(`${editor(first)} .calendar-remind-checkbox`).isChecked(), false, 'reminder tag is personal'); assert.equal(await two.evaluate(() => Object.keys(ChatApp.calendarState.reminders[ChatApp.calendarState.today] || {}).length), 0);
    await dismissToasts(one); await one.screenshot({ path: path.join(reportDir, 'calendar-day-notes.png') });
    await two.locator(`${editor(second)} .calendar-editor-delete`).click(); await one.locator(editor(second)).waitFor({ state: 'detached' }); assert.equal(backend.get(`calendar/years/2026/${today}/${second}`), null);
    await one.reload(); await one.waitForFunction(() => ChatApp.calendarState?.ready && ChatApp.getStoredPlace() === 'calendar:2026-09-14'); await one.locator('.calendar-day-page').waitFor();
    const reminderText = await waitReminder(one); const activeId = reminderText === 'Remember this note from today.' ? tagged : first;
    assert.ok(['Remember this note from today.', 'Chosen version after conflict review.'].includes(reminderText));
    await editNote(two, activeId, 'The active reminder follows the latest note text.');
    await one.waitForFunction(() => document.querySelector('#toast-body')?.textContent === 'The active reminder follows the latest note text.');
    assert.equal(await one.locator('.calendar-reminder-toasts, .calendar-reminder-toast').count(), 0);
    await one.screenshot({ path: path.join(reportDir, 'calendar-standard-reminder-toast.png') });
    await one.locator('#btn-toast-close').click(); await one.waitForTimeout(210);
    const nextText = await waitReminder(one); assert.equal(nextText, activeId === tagged ? 'Chosen version after conflict review.' : 'Remember this note from today.', 'second reminder uses standard toast queue');
    await dismissToasts(one);
    await one.locator('[data-calendar-action="back"]').click(); await one.locator('.calendar-month-page').waitFor(); geometry.desktop = await monthGeometry(one, 'calendar-desktop');
    await one.evaluate(() => { sessionStorage.removeItem(ChatApp.LS.USER_BOOTSTRAP); localStorage.removeItem(ChatApp.LS.USER_BOOTSTRAP); });
    await one.reload(); await one.waitForFunction(() => ChatApp.currentUser?.code === 'P1' && ChatApp.calendarState?.ready && document.body.dataset.calendarPage === '1'); await one.locator('.calendar-month-page').waitFor();
    assert.equal(await one.locator('#composer').isVisible(), false); await waitReminder(one); await dismissToasts(one);
    for (const [name, viewport] of [['mobile', { width: 390, height: 844 }], ['landscape', { width: 720, height: 420 }]]) {
      const page = await makePage('P1', viewport); await calendar(page); await dismissToasts(page); await selectMonth(page, 7); assert.equal(await page.locator('.calendar-grid > *').count(), 42);
      geometry[name] = await monthGeometry(page, `calendar-${name}-six-weeks`);
      await page.locator('#calendar-note-date').click(); await page.locator('.calendar-date-picker-pop').waitFor({ state: 'visible' });
      const picker = await page.locator('.calendar-date-picker-pop').boundingBox(); assert.ok(picker.x >= 0 && picker.y >= 0 && picker.x + picker.width <= viewport.width + 1 && picker.y + picker.height <= viewport.height + 1, `${name}: custom date picker fits viewport`);
      await page.screenshot({ path: path.join(reportDir, `calendar-${name}-date-picker.png`) }); await page.locator('.calendar-date-picker-pop [data-action="close"]').click();
      await page.locator('.calendar-day[data-date="2026-08-05"]').click(); await page.locator('.calendar-day-page').waitFor(); assert.equal(await page.locator('.calendar-grid').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); await page.screenshot({ path: path.join(reportDir, `calendar-${name}-day.png`) });
    }
    fs.writeFileSync(path.join(reportDir, 'calendar-layout.json'), JSON.stringify(geometry, null, 2));
    await one.evaluate(() => { ChatApp.getAccurateNow = () => new Date('2026-09-15T10:00:00.025Z'); ChatApp.refreshCalendarDate(); });
    await one.waitForFunction(() => ChatApp.calendarState.today === '2026-09-15' && !ChatApp.calendarState.reminders['2026-09-14']); assert.equal(backend.get('calendarReminders/P1/2026-09-14'), null);
    assert.equal(await one.evaluate(() => ChatApp.isCalendarNoteReminder('2026-09-14', Object.keys(ChatApp.calendarState.notes['2026-09-14'])[0])), false);
    await one.evaluate(() => ChatApp.logoutToLanding()); await one.waitForFunction(() => !ChatApp.currentUser);
    assert.deepEqual(errors, []); assert.deepEqual(backend.deliveryErrors, []);
    console.log('Calendar v3 browser checks passed: custom pickers, full month layouts, fitted saved bubbles, live edit/delete/profile/avatar, personal note tags, standard reminder toast queue, reload and midnight expiry.');
  } finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
