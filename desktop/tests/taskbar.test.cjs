'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { createCallTaskbar, COMMAND_CHANNEL } = require('../taskbar.cjs');

function harness(platform = 'win32') {
  const calls = [], messages = [], images = [];
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setThumbarButtons(buttons) { calls.push(buttons); return true; },
  });
  const contents = { isDestroyed: () => false, send: (channel, command) => messages.push({ channel, ...command }) };
  const nativeImage = { createFromPath(file) { images.push(file); assert.equal(fs.readFileSync(file).subarray(1, 4).toString(), 'PNG'); return file; }, createFromDataURL(data) { assert.equal(Buffer.from(data.split(',')[1], 'base64').subarray(1, 4).toString(), 'PNG'); return data; } };
  const controller = createCallTaskbar({ mainWindow: win, nativeImage, getContents: () => contents, platform });
  const state = { active: true, enabled: true, roomId: 'room', sessionId: 'session', controls: { muted: false, deafened: false } };
  return { win, calls, messages, images, contents, controller, state };
}

test('Windows thumbnails expose six matching icons and dispatch session-scoped commands', () => {
  const h = harness();
  h.controller.update(h.state);
  const buttons = h.calls.at(-1);
  assert.deepEqual(buttons.map(button => button.tooltip), ['Mute', 'Deafen', 'Screen Share', 'Camera', 'Turn Off Call Overlay', 'Leave Call']);
  for (const button of buttons) button.click();
  assert.deepEqual(h.messages.map(message => message.action), ['mute', 'deafen', 'share', 'camera', 'overlay', 'leave']);
  for (const message of h.messages) assert.deepEqual([message.channel, message.roomId, message.sessionId], [COMMAND_CHANNEL, 'room', 'session']);
  h.controller.destroy();
});

test('live muted/deafened/overlay state refreshes thumbnails without roster/speaking churn', () => {
  const h = harness();
  h.controller.update(h.state);
  h.controller.update({ ...h.state, members: [{ speaking: true }] });
  assert.equal(h.calls.length, 1);
  h.controller.update({ ...h.state, enabled: false, controls: { muted: true, deafened: true, listenOnly: true } });
  const buttons = h.calls.at(-1);
  assert.deepEqual(buttons.map(button => button.tooltip), ['Microphone unavailable', 'Undeafen', 'Screen Share', 'Camera', 'Turn On Call Overlay', 'Leave Call']);
  assert.deepEqual(buttons[0].flags, ['disabled']);
  buttons[0].click();
  assert.equal(h.messages.length, 0);
  h.win.emit('restore');
  assert.equal(h.calls.length, 3);
  h.controller.destroy();
});

test('stale thumbnail callbacks cannot affect a later call or a destroyed renderer', () => {
  const h = harness();
  h.controller.update(h.state);
  const old = h.calls.at(-1);
  h.controller.update({ ...h.state, sessionId: 'replacement' });
  old[3].click();
  assert.equal(h.messages.length, 0);
  h.contents.isDestroyed = () => true;
  h.calls.at(-1)[3].click();
  assert.equal(h.messages.length, 0);
  h.controller.update({ active: false });
  assert.deepEqual(h.calls.at(-1), []);
  old[0].click();
  assert.equal(h.messages.length, 0);
  h.win.emit('closed');
  assert.equal(h.win.listenerCount('focus'), 0);
});

test('failed toolbar creation retries and other platforms do not access Windows APIs', () => {
  const h = harness();
  h.win.setThumbarButtons = buttons => { h.calls.push(buttons); return false; };
  h.controller.update(h.state);
  h.controller.update(h.state);
  assert.equal(h.calls.length, 2);
  h.controller.destroy();
  const other = harness('darwin');
  other.controller.update(other.state);
  assert.equal(other.calls.length, 0);
  assert.equal(other.images.length, 0);
  other.controller.destroy();
});
