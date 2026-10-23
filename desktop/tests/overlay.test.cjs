'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCallOverlay, normalizeSnapshot, rosterLayout, isAppURL, PUBLISH_CHANNEL, STATE_CHANNEL, PAINTED_CHANNEL } = require('../overlay.cjs');

const roster = overrides => ({
  active: true, enabled: true, roomId: 'room-1',
  members: [
    { code: 'u-z', displayName: 'Zoe', photoDataURL: 'data:image/png;base64,AA==', photoTransform: { unit: 'rel', x: .15, y: -.25, scale: 2.4 }, speaking: true },
    { code: 'u-a', displayName: 'alice', photoTransform: { unit: 'rel', x: 0, y: 0, scale: 1 } },
  ],
  ...overrides,
});

function harness() {
  const windows = [];
  class Contents extends EventEmitter {
    constructor(url = 'chatapp://app/index.html') { super(); this.url = url; this.mainFrame = { url }; this.sent = []; this.destroyed = false; }
    getURL() { return this.url; }
    isDestroyed() { return this.destroyed; }
    send(channel, state) { this.sent.push({ channel, state }); }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
  }
  class Window extends EventEmitter {
    static getFocusedWindow() { return windows.find(window => window.focused && !window.destroyed) || null; }
    constructor(options = {}) {
      super(); this.options = options; this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width || 900, height: options.height || 700 };
      this.minimized = false; this.focused = false; this.visible = false; this.destroyed = false; this.webContents = new Contents(); this.calls = []; windows.push(this);
    }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.calls.push(['setBounds', { ...bounds }, this.visible]); this.bounds = { ...bounds }; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    focus() { for (const window of windows) if (window.focused) window.blur(); this.focused = true; this.emit('focus'); }
    blur() { this.focused = false; this.emit('blur'); }
    setMenu() {}
    setIgnoreMouseEvents(...args) { this.calls.push(['ignoreMouse', ...args]); }
    setFocusable(...args) { this.calls.push(['focusable', ...args]); }
    isAlwaysOnTop() { return !!this.topmost; }
    setAlwaysOnTop(...args) { this.topmost = args[0]; this.calls.push(['top', ...args]); }
    moveTop() { this.calls.push(['moveTop']); }
    showInactive() { this.visible = true; this.calls.push(['showInactive']); }
    hide() { this.visible = false; this.calls.push(['hide']); }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    minimize() { this.minimized = true; this.focused = false; this.emit('minimize'); }
    restore() { this.minimized = false; this.emit('restore'); }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, bounds: { x: -1600, y: 120, width: 1600, height: 900 }, workArea: { x: -1600, y: 120, width: 1600, height: 860 } },
  ];
  const screen = Object.assign(new EventEmitter(), {
    displays,
    getAllDisplays() { return this.displays; },
    getDisplayMatching(bounds) { return this.displays.find(display => bounds.x >= display.bounds.x && bounds.x < display.bounds.x + display.bounds.width) || this.displays[0]; },
  });
  const ipcMain = new EventEmitter();
  const main = new Window({ x: -1400, y: 180 });
  const contents = new Contents();
  const powerMonitor = new EventEmitter(), intervals = new Map();
  const timers = { setInterval(callback) { const id = {}; intervals.set(id, callback); return id; }, clearInterval(id) { intervals.delete(id); } };
  const tick = () => { for (const callback of intervals.values()) callback(); };
  const controller = createCallOverlay({ BrowserWindow: Window, screen, ipcMain, mainWindow: main, uiDir: '/ui', powerMonitor, timers });
  controller.bindContents(contents);
  const publish = (snapshot, sender = contents, senderFrame = sender.mainFrame) => ipcMain.emit(PUBLISH_CHANNEL, { sender, senderFrame }, snapshot);
  const nativeWindow = () => windows.at(-1);
  const loaded = () => nativeWindow().webContents.emit('did-finish-load');
  const nativeReady = () => nativeWindow().emit('ready-to-show');
  const last = () => nativeWindow().webContents.sent.at(-1).state;
  const paint = (generation = last().presentation.generation, sender = nativeWindow().webContents, senderFrame = sender.mainFrame) => ipcMain.emit(PAINTED_CHANNEL, { sender, senderFrame }, generation);
  const ready = () => { loaded(); nativeReady(); paint(); };
  return { windows, Window, Contents, screen, ipcMain, main, contents, controller, publish, nativeWindow, loaded, nativeReady, paint, ready, last, tick, intervals, powerMonitor };
}

test('normalization preserves live crop and speaking state, sorts names, and only permits image data', () => {
  const snapshot = roster();
  snapshot.members.push({ code: 'u-b', displayName: 'Bob', photoDataURL: 'https://example.test/avatar.png' });
  snapshot.members.push({ code: 'u-b', displayName: 'duplicate' });
  const actual = normalizeSnapshot(snapshot);
  assert.deepEqual(actual.members.map(user => user.displayName), ['alice', 'Bob', 'Zoe']);
  assert.equal(actual.members[1].photoDataURL, '');
  assert.deepEqual(actual.members[2].photoTransform, { unit: 'rel', x: .15, y: -.25, scale: 2.4 });
  assert.equal(actual.members[2].speaking, true);
  assert.equal(actual.members[2].photoDataURL, 'data:image/png;base64,AA==');
  snapshot.members[0].muted = true;
  assert.equal(normalizeSnapshot(snapshot).members[2].speaking, false);
});

test('SVG fallback is allowed; invalid snapshots, nonfinite transforms, and remote origins are rejected', () => {
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const actual = normalizeSnapshot(roster({ members: [{ code: 'u', displayName: '<script>\nName', photoDataURL: svg, photoTransform: { x: NaN, y: Infinity, scale: -3 } }] }));
  assert.equal(actual.members[0].photoDataURL, svg);
  assert.equal(actual.members[0].displayName, '<script> Name');
  assert.deepEqual(actual.members[0].photoTransform, { unit: 'rel', x: 0, y: 0, scale: .2 });
  for (const invalid of [null, {}, roster({ active: false }), roster({ roomId: '' }), roster({ members: [] })]) assert.equal(normalizeSnapshot(invalid).active, false);
  assert.equal(isAppURL('chatapp://app/index.html'), true);
  for (const url of ['https://app/', 'chatapp://evil/', 'chatapp://user@app/', 'chatapp://app.evil/', 'about:blank']) assert.equal(isAppURL(url), false);
});

test('larger saved GIF profiles are preserved across a six-person call', () => {
  const photoDataURL = 'data:image/gif;base64,' + 'A'.repeat(9 * 1024 * 1024);
  const members = Array.from({ length: 6 }, (_, i) => ({ code: String(i), displayName: String(i), photoDataURL }));
  const actual = normalizeSnapshot(roster({ members }));
  assert.equal(actual.members.length, 6);
  for (const member of actual.members) assert.equal(member.photoDataURL, photoDataURL);
});

test('enabled native overlay uses a compact shadowless surface without taking focus or clicks', () => {
  const h = harness();
  h.publish(roster());
  assert.equal(h.windows.length, 2, 'surface is prewarmed before minimizing');
  assert.equal(h.nativeWindow().isVisible(), false);
  const win = h.nativeWindow();
  assert.equal(win.isVisible(), false, 'wait for renderer readiness');
  h.loaded();
  assert.equal(win.isVisible(), false, 'loaded HTML is not a painted roster');
  h.paint();
  assert.equal(win.isVisible(), false, 'also wait for Electron compositor readiness');
  h.nativeReady();
  assert.equal(win.isVisible(), true);
  assert.deepEqual(win.getBounds(), rosterLayout(h.screen.displays[1], 2).bounds);
  assert.ok(win.getBounds().width <= 294);
  assert.ok(win.getBounds().height < 100);
  assert.equal(win.options.hasShadow, false);
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.options.focusable, false);
  assert.equal(win.options.paintWhenInitiallyHidden, true);
  assert.equal(win.options.webPreferences.backgroundThrottling, false);
  assert.ok(win.calls.some(call => call[0] === 'ignoreMouse' && call[1] === true && call[2].forward === true));
  assert.ok(win.calls.some(call => call[0] === 'focusable' && call[1] === false));
  assert.ok(win.calls.some(call => call[0] === 'top' && call[1] === true && call[2] === 'screen-saver'));
  assert.ok(win.calls.some(call => call[0] === 'showInactive'));
  assert.equal(win.webContents.sent.at(-1).channel, STATE_CHANNEL);
  assert.deepEqual(h.last().members.map(user => user.displayName), ['alice', 'Zoe']);
  h.main.minimize();
  assert.equal(win.isVisible(), true);
  h.main.restore();
  assert.equal(win.isVisible(), true);
  h.main.emit('blur');
  assert.equal(win.isVisible(), true);
  h.controller.destroy();
});

test('foreground Chat App hides overlay and external focus restores it without needing call changes', () => {
  const h = harness();
  h.main.focus();
  h.publish(roster());
  h.ready();
  assert.equal(h.nativeWindow().isVisible(), false, 'never covers the foreground call menu');
  assert.equal(h.intervals.size, 1, 'watchdog remains available for foreground transitions');
  h.main.blur();
  h.paint();
  assert.equal(h.nativeWindow().isVisible(), true, 'other applications show the enabled overlay');
  h.main.focus();
  assert.equal(h.nativeWindow().isVisible(), false, 'focus hides immediately');
  h.tick();
  assert.equal(h.nativeWindow().isVisible(), false, 'topmost repair cannot reveal it over Chat App');
  h.main.minimize();
  h.paint();
  assert.equal(h.nativeWindow().isVisible(), true);
  h.main.restore();
  h.main.focus();
  assert.equal(h.nativeWindow().isVisible(), false);
  h.controller.destroy();
});

test('screen-share popouts do not suppress the desktop overlay', () => {
  const h = harness();
  h.publish(roster());
  h.ready();
  const overlay = h.nativeWindow();
  const popout = new h.Window();
  popout.focus();
  h.tick();
  assert.equal(overlay.isVisible(), true);
  popout.blur();
  h.tick();
  assert.equal(overlay.isVisible(), true);
  h.controller.destroy();
  popout.destroy();
});

test('roster layouts never reach any taskbar edge and scale long calls to the safe area', () => {
  for (const workArea of [
    { x: 0, y: 0, width: 1920, height: 1032 },
    { x: 0, y: 48, width: 1920, height: 1032 },
    { x: 48, y: 0, width: 1872, height: 1080 },
    { x: 0, y: 0, width: 1872, height: 1080 },
    { x: -1366, y: 0, width: 1366, height: 720 },
  ]) for (const count of [1, 6, 32, 512]) {
    const layout = rosterLayout({ workArea }, count), b = layout.bounds;
    assert.ok(b.x >= workArea.x && b.y >= workArea.y);
    assert.ok(b.x + b.width <= workArea.x + workArea.width);
    assert.ok(b.y + b.height <= workArea.y + workArea.height);
    assert.ok(b.width <= 294 && b.height <= workArea.height - 31);
    assert.ok(layout.scale > 0 && layout.scale <= .7);
  }
});

test('live updates and toggle propagate while minimized; leave clears the displayed roster', () => {
  const h = harness();
  h.main.minimize();
  h.publish(roster());
  h.ready();
  const changed = roster();
  changed.members[0].displayName = 'Aaron';
  changed.members[0].speaking = false;
  changed.members[0].photoTransform.scale = 1.5;
  h.publish(changed);
  assert.equal(h.last().members[0].displayName, 'Aaron');
  assert.equal(h.last().members[0].speaking, false);
  assert.equal(h.last().members[0].photoTransform.scale, 1.5);
  h.publish(roster({ enabled: false }));
  assert.equal(h.nativeWindow().isVisible(), false);
  h.publish(roster());
  h.paint();
  assert.equal(h.nativeWindow().isVisible(), true);
  h.publish({ active: false });
  assert.equal(h.nativeWindow().isVisible(), false);
  assert.deepEqual(h.last().members, []);
  h.controller.destroy();
});

test('wrong window, child frame, and untrusted origin cannot publish a roster', () => {
  const h = harness();
  h.main.minimize();
  h.publish(roster(), h.main.webContents);
  h.publish(roster(), h.contents, { url: 'chatapp://app/index.html' });
  h.contents.mainFrame.url = 'https://example.test/';
  h.publish(roster());
  h.contents.mainFrame.url = 'chatapp://app/index.html';
  h.contents.url = 'https://example.test/';
  h.publish(roster());
  assert.equal(h.windows.length, 2);
  h.ready();
  assert.equal(h.nativeWindow().isVisible(), false);
  assert.equal(h.last().active, false);
  h.controller.destroy();
});

test('navigation and renderer crashes hide immediately and clear stale identities', () => {
  const h = harness();
  h.main.minimize();
  h.publish(roster());
  h.ready();
  h.contents.emit('did-start-navigation', {}, 'chatapp://app/index.html', false, true);
  assert.equal(h.nativeWindow().isVisible(), false);
  assert.deepEqual(h.last().members, []);
  h.publish(roster());
  assert.equal(h.nativeWindow().isVisible(), false, 'old navigating document cannot restore stale state');
  h.contents.emit('did-navigate');
  h.publish(roster());
  h.paint();
  assert.equal(h.nativeWindow().isVisible(), true);
  h.contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(h.nativeWindow().isVisible(), false);
  assert.deepEqual(h.last().members, []);
  h.controller.destroy();
});

test('replacing the application contents removes old subscriptions and rejects late messages', () => {
  const h = harness();
  h.main.minimize();
  h.publish(roster());
  h.ready();
  const replacement = new h.Contents();
  h.controller.bindContents(replacement);
  assert.equal(h.nativeWindow().isVisible(), false);
  assert.equal(h.contents.listenerCount('destroyed'), 0);
  h.publish(roster());
  assert.equal(h.nativeWindow().isVisible(), false);
  h.publish(roster(), replacement);
  h.paint();
  assert.equal(h.nativeWindow().isVisible(), true);
  h.contents.emit('destroyed');
  assert.equal(h.nativeWindow().isVisible(), true, 'late old-window events cannot clear the new roster');
  replacement.destroyed = true;
  replacement.emit('destroyed');
  assert.deepEqual(h.last().members, []);
  h.controller.destroy();
});

test('monitor changes use the safe work area and monitor removal falls back to an existing display', () => {
  const h = harness();
  h.main.minimize();
  h.publish(roster());
  h.ready();
  h.screen.displays[1].bounds = { x: -1440, y: -120, width: 1440, height: 2560 };
  h.screen.displays[1].workArea = { x: -1440, y: -120, width: 1440, height: 2520 };
  h.screen.emit('display-metrics-changed');
  assert.deepEqual(h.nativeWindow().getBounds(), rosterLayout(h.screen.displays[1], 2).bounds);
  assert.equal(h.nativeWindow().isVisible(), true, 'display changes retain the visible roster');
  h.paint();
  h.screen.displays.pop();
  h.screen.emit('display-removed');
  assert.deepEqual(h.nativeWindow().getBounds(), rosterLayout(h.screen.displays[0], 2).bounds);
  h.main.restore();
  h.main.bounds = { x: 30, y: 40, width: 1000, height: 720 };
  h.main.emit('move');
  h.main.minimize();
  assert.deepEqual(h.nativeWindow().getBounds(), rosterLayout(h.screen.displays[0], 2).bounds);
  h.controller.destroy();
});

test('closing the main window destroys overlay and unregisters all native listeners', () => {
  const h = harness();
  h.main.minimize();
  h.publish(roster());
  h.ready();
  h.main.destroy();
  assert.equal(h.nativeWindow().isDestroyed(), true);
  assert.equal(h.ipcMain.listenerCount(PUBLISH_CHANNEL), 0);
  assert.equal(h.ipcMain.listenerCount(PAINTED_CHANNEL), 0);
  assert.equal(h.contents.listenerCount('did-start-navigation'), 0);
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(h.screen.listenerCount(event), 0);
  h.controller.destroy();
});

test('minimizing a painted roster keeps it visible without waiting for another paint', () => {
  const h = harness();
  h.publish(roster());
  h.ready();
  const visibleGeneration = h.last().presentation.generation;
  assert.equal(h.nativeWindow().isVisible(), true);
  h.main.minimize();
  assert.equal(h.last().presentation.generation, visibleGeneration);
  h.paint();
  assert.equal(h.nativeWindow().isVisible(), true);
  h.controller.destroy();
});

test('disabling and re-enabling the overlay invalidate in-flight paint acknowledgements', () => {
  const h = harness();
  h.publish(roster());
  h.loaded();
  h.nativeReady();
  h.main.minimize();
  const first = h.last().presentation.generation;
  h.publish(roster({ enabled: false }));
  const restored = h.last().presentation.generation;
  h.paint(first);
  assert.equal(h.nativeWindow().isVisible(), false);
  h.publish(roster());
  const second = h.last().presentation.generation;
  h.paint(first);
  h.paint(restored);
  assert.equal(h.nativeWindow().isVisible(), false);
  h.publish(roster({ enabled: false }));
  h.paint(second);
  assert.equal(h.nativeWindow().isVisible(), false);
  h.publish(roster());
  h.paint();
  assert.equal(h.nativeWindow().isVisible(), true);
  assert.equal(h.nativeWindow().calls.filter(call => call[0] === 'showInactive').length, 1);
  h.controller.destroy();
});

test('watchdog recovers hidden/reordered windows and stops on toggle, leave, and shutdown', () => {
  const h = harness();
  h.publish(roster());
  h.ready();
  assert.equal(h.intervals.size, 1);
  const win = h.nativeWindow();
  win.hide();
  const before = win.calls.filter(call => call[0] === 'moveTop').length;
  h.tick();
  assert.equal(win.isVisible(), true, 'recovers Show Desktop hiding the overlay');
  assert.ok(win.calls.filter(call => call[0] === 'moveTop').length > before);
  win.hide();
  h.powerMonitor.emit('unlock-screen');
  assert.equal(win.isVisible(), true);
  h.publish(roster({ enabled: false }));
  assert.equal(h.intervals.size, 0);
  h.tick();
  assert.equal(win.isVisible(), false);
  h.publish(roster());
  h.paint();
  assert.equal(h.intervals.size, 1);
  h.publish({ active: false });
  assert.equal(h.intervals.size, 0);
  h.publish(roster());
  h.controller.destroy();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.powerMonitor.listenerCount('unlock-screen'), 0);
});

test('live speaking updates do not reset a pending presentation or hide a visible overlay', () => {
  const h = harness();
  h.publish(roster());
  h.ready();
  h.main.minimize();
  const generation = h.last().presentation.generation;
  const changed = roster();
  changed.members[0].speaking = false;
  h.publish(changed);
  assert.equal(h.last().presentation.generation, generation);
  h.paint(generation);
  assert.equal(h.nativeWindow().isVisible(), true);
  const hideCount = h.nativeWindow().calls.filter(call => call[0] === 'hide').length;
  h.publish(roster());
  assert.equal(h.last().presentation.generation, generation);
  assert.equal(h.nativeWindow().isVisible(), true);
  assert.equal(h.nativeWindow().calls.filter(call => call[0] === 'hide').length, hideCount);
  h.controller.destroy();
});

test('one-DIP Windows scaling roundoff does not hide or resize speaking updates', () => {
  const h = harness();
  h.publish(roster());
  h.ready();
  const win = h.nativeWindow(), generation = h.last().presentation.generation;
  // Native bounds at 125% scale may be one logical pixel wider/taller than
  // requested, while its renderer retains the intended CSS viewport size.
  win.bounds.width += 1;
  win.bounds.height += 1;
  win.bounds.x -= 1;
  const resizeCount = win.calls.filter(call => call[0] === 'setBounds').length;
  const hideCount = win.calls.filter(call => call[0] === 'hide').length;
  for (const speaking of [false, true, false]) {
    const next = roster(); next.members[0].speaking = speaking;
    h.publish(next);
  }
  assert.equal(h.last().presentation.generation, generation);
  assert.equal(win.isVisible(), true);
  assert.equal(win.calls.filter(call => call[0] === 'setBounds').length, resizeCount);
  assert.equal(win.calls.filter(call => call[0] === 'hide').length, hideCount);
  h.controller.destroy();
});

test('paint acknowledgements are restricted to the current native overlay main frame', () => {
  const h = harness();
  h.publish(roster());
  h.loaded();
  h.nativeReady();
  h.main.minimize();
  const generation = h.last().presentation.generation;
  h.paint(generation, h.contents);
  h.paint(generation, h.nativeWindow().webContents, { url: 'file:///ui/overlay.html' });
  h.paint(String(generation));
  h.paint(generation + 1);
  assert.equal(h.nativeWindow().isVisible(), false);
  h.paint(generation);
  assert.equal(h.nativeWindow().isVisible(), true);
  h.controller.destroy();
});

test('monitor resize preserves the visible surface during its next paint', () => {
  const h = harness();
  h.main.minimize();
  h.publish(roster());
  h.ready();
  const oldGeneration = h.last().presentation.generation;
  h.screen.displays[1].bounds = { x: -1920, y: 0, width: 1920, height: 1080 };
  h.screen.displays[1].workArea = { x: -1920, y: 0, width: 1920, height: 1040 };
  h.screen.emit('display-metrics-changed', {}, h.screen.displays[1]);
  assert.equal(h.nativeWindow().isVisible(), true);
  const boundChange = h.nativeWindow().calls.filter(call => call[0] === 'setBounds').at(-1);
  assert.equal(boundChange[2], true, 'display changes do not tear down a visible compositor surface');
  assert.equal(h.last().presentation.width, 286);
  assert.equal(h.last().presentation.height, 77);
  h.paint(oldGeneration);
  assert.equal(h.nativeWindow().isVisible(), true);
  h.paint();
  assert.equal(h.nativeWindow().isVisible(), true);
  h.controller.destroy();
});

test('steady desktop visibility does not repeatedly change native styles or z-order', () => {
  const h = harness();
  h.publish(roster());
  h.ready();
  const win = h.nativeWindow(), calls = win.calls.length;
  for (let i = 0; i < 40; i++) h.tick();
  assert.equal(win.isVisible(), true);
  assert.equal(win.calls.length, calls, 'idle polling must not force compositor updates');
  win.topmost = false;
  h.tick();
  assert.equal(win.isAlwaysOnTop(), true, 'repair a genuinely lost topmost flag');
  assert.equal(win.calls.filter(call => call[0] === 'top').length, 2);
  h.controller.destroy();
});

test('returning from Chat App shows the existing painted roster immediately', () => {
  const h = harness();
  h.main.focus();
  h.publish(roster());
  h.ready();
  const win = h.nativeWindow(), generation = h.last().presentation.generation;
  assert.equal(win.isVisible(), false);
  for (let i = 0; i < 6; i++) {
    h.main.blur();
    assert.equal(win.isVisible(), true, 'focus change needs no new paint IPC or avatar decode');
    assert.equal(h.last().presentation.generation, generation);
    h.main.focus();
    assert.equal(win.isVisible(), false);
  }
  h.main.minimize();
  assert.equal(win.isVisible(), true);
  h.controller.destroy();
});

test('native size clamping and live participant changes never hide the roster', () => {
  const h = harness();
  h.publish(roster());
  h.ready();
  const win = h.nativeWindow();
  win.bounds.width += 20;
  win.bounds.height += 20;
  const resizeCount = win.calls.filter(call => call[0] === 'setBounds').length;
  const hideCount = win.calls.filter(call => call[0] === 'hide').length;
  for (let i = 0; i < 20; i++) {
    const next = roster(); next.members[0].speaking = i % 2 === 0;
    h.publish(next);
  }
  assert.equal(win.calls.filter(call => call[0] === 'setBounds').length, resizeCount);
  const next = roster(); next.members.push({ code: 'third', displayName: 'Third' });
  h.publish(next);
  assert.equal(win.isVisible(), true);
  assert.equal(win.calls.filter(call => call[0] === 'hide').length, hideCount);
  h.controller.destroy();
});

test('the rendered avatar sits within seven DIPs of the usable screen edge', () => {
  for (const display of [
    { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { workArea: { x: -1600, y: 120, width: 1600, height: 860 } },
    { workArea: { x: 48, y: 0, width: 1872, height: 1080 } },
  ]) {
    const layout = rosterLayout(display, 6);
    assert.equal(layout.bounds.x, display.workArea.x);
    assert.ok(layout.bounds.x - display.workArea.x + 4 + 4 * layout.scale <= 7);
  }
});

test('speaking updates reuse photo bytes only inside the same call session', () => {
  const original = normalizeSnapshot({ ...roster(), sessionId: 'one' });
  const delta = { ...original, members: original.members.map(({ photoDataURL, ...member }) => ({ ...member, reusePhoto: true, speaking: true })) };
  assert.deepEqual(normalizeSnapshot(delta, original).members.map(member => member.photoDataURL), original.members.map(member => member.photoDataURL));
  assert.ok(normalizeSnapshot({ ...delta, sessionId: 'two' }, original).members.every(member => member.photoDataURL === ''));
});

test('native speaking payloads omit unchanged photos and toggling back on restores full images', () => {
  const h = harness();
  h.publish(roster()); h.ready();
  const next = roster(); next.members[0].speaking = true;
  h.publish(next);
  assert.ok(h.last().members.every(member => member.reusePhoto === true && member.photoDataURL === undefined));
  h.publish({ ...next, enabled: false });
  h.publish({ ...next, enabled: true });
  assert.ok(h.last().members.every(member => typeof member.photoDataURL === 'string' && !member.reusePhoto));
  h.controller.destroy();
});

test('Windows transitional minimized bounds cannot move the overlay to the wrong monitor', () => {
  const h = harness();
  h.publish(roster());
  h.ready();
  h.main.bounds = { x: -32000, y: -32000, width: 160, height: 28 };
  h.main.emit('move');
  h.main.minimize();
  h.paint();
  assert.deepEqual(h.nativeWindow().getBounds(), rosterLayout(h.screen.displays[1], 2).bounds);
  h.controller.destroy();
});

test('overlay renderer recovers once from a crash using the latest unchanged call snapshot', () => {
  const h = harness();
  h.main.minimize();
  h.publish(roster());
  h.ready();
  const original = h.nativeWindow();
  const oldGeneration = h.last().presentation.generation;
  original.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(original.isDestroyed(), true);
  assert.notEqual(h.nativeWindow(), original);
  h.loaded();
  h.nativeReady();
  h.paint(oldGeneration, original.webContents);
  assert.equal(h.nativeWindow().isVisible(), false);
  h.paint();
  assert.equal(h.nativeWindow().isVisible(), true);
  assert.deepEqual(h.last().members.map(member => member.displayName), ['alice', 'Zoe']);
  const recovery = h.nativeWindow();
  recovery.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(h.windows.length, 3, 'repeated renderer failures do not create an unbounded restart loop');
  h.controller.destroy();
});

test('native capture choices survive permission prompts, refresh stale ids and cancel only their own ticket', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../main.cjs'), 'utf8');
  const handlers = new Map(), listeners = new Map();
  const frame = {}, wc = { mainFrame:frame, isDestroyed:() => false, getURL:() => 'chatapp://app/index.html' };
  const choices = new WeakMap();
  let now = 100000, refreshes = 0, removed = false, displayHandler;
  const context = vm.createContext({
    ipcMain: { handle:(name, handler) => handlers.set(name,handler), on:(name, handler) => listeners.set(name,handler) },
    ses: { setDisplayMediaRequestHandler:handler => { displayHandler = handler; } },
    appView:{webContents:wc}, mainWindow:{isFocused:() => true},
    captureCaller:event => event.sender === wc && event.senderFrame === frame ? wc : null,
    captureSelections:choices, captureSources:[{id:'screen:selected',name:'Selected display',thumbnail:{toDataURL:() => ''}}], captureSourcesAt:now,
    isAppURL:url => url.startsWith('chatapp://app'), Date:{now:() => now},
    refreshCaptureSources:async () => { refreshes++; context.captureSourcesAt = now; return context.captureSources = removed ? [] : context.captureSources; }
  });
  vm.runInContext(source.slice(source.indexOf("    ipcMain.handle('chat-capture:sources'"),source.indexOf("    ipcMain.handle('chat-clipboard:files'")),context);
  vm.runInContext(source.slice(source.indexOf('  ses.setDisplayMediaRequestHandler('),source.indexOf("  ses.on('will-download'")),context);
  const event = {sender:wc,senderFrame:frame};
  assert.equal(await handlers.get('chat-capture:select')(event,'screen:selected',{requestId:'first'}),true);
  now += 15000;
  let captured;
  await displayHandler({frame,securityOrigin:'chatapp://app',audioRequested:true},value => { captured = value; });
  assert.equal(captured.video.id,'screen:selected','Allowing a permission prompt after ten seconds still shares the selected screen');
  assert.equal(choices.has(wc),false,'Selection is consumed exactly once');
  now += 31000;
  assert.equal(await handlers.get('chat-capture:select')(event,'screen:selected',{requestId:'newer'}),true);
  assert.equal(refreshes,1,'A retry after a long prompt refreshes source availability');
  listeners.get('chat-capture:cancel')(event,'first');
  assert.equal(choices.get(wc).requestId,'newer','Late cancellation cannot erase a newer selection');
  listeners.get('chat-capture:cancel')(event,'newer');
  assert.equal(choices.has(wc),false);
  removed = true; now += 31000;
  assert.equal(await handlers.get('chat-capture:select')(event,'screen:selected',{requestId:'removed'}),false,'A disappeared source is rejected, never substituted');
});
