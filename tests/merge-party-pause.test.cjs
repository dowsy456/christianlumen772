const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function game(storage = new Map()) {
  const elements = new Map(), listeners = new Map(), messages = [];
  const drawing = new Proxy({}, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) });
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const handlers = new Map(), attributes = new Map();
    const node = {
      hidden: false, style: {}, dataset: {}, textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getContext: () => drawing, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }),
      setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name),
      querySelector: selector => element(id + selector), querySelectorAll: () => [], appendChild() {}, focus() {},
      setPointerCapture() {}, releasePointerCapture() {},
      addEventListener: (name, fn) => handlers.set(name, fn),
      dispatch: (name, event = {}) => handlers.get(name)?.({ isPrimary: true, button: 0, pointerId: 1, clientX: 540, clientY: 315, ...event })
    };
    elements.set(id, node); return node;
  }
  const host = { postMessage: data => messages.push(data), localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } };
  const window = { parent: host, addEventListener: (name, fn) => listeners.set(name, fn) };
  let now = 0, frame;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../activities/merge-party/game.js'), 'utf8'), {
    window, document: { getElementById: element, createElement: tag => element(Symbol(tag)), querySelectorAll: () => [] },
    performance: { now: () => now }, requestAnimationFrame: fn => { frame = fn; },
    navigator: {}, setTimeout, clearTimeout, console
  });
  return { controller: window.__mergeParty, debug: window.__mergeParty.debug, element, messages, storage,
    tick: ms => { now += ms; frame(now); },
    message: (data, source = host) => listeners.get('message')?.({ data, source }),
    key: (key, options = {}) => listeners.get('keydown')?.({ key, repeat: false, preventDefault() {}, ...options }) };
}
const serialize = data => JSON.stringify(data);

test('number and numpad shortcuts activate each ability once and Snipe toggles without key repeat', () => {
  for (const [key, ability] of [['1','swap'],['2','quake'],['3','walls']]) {
    const g=game();g.debug.start();g.key(key);
    assert.equal(g.debug.getState().abilityCounts[ability],1);
  }
  const g=game();g.debug.start();g.key('4');
  assert.equal(g.debug.getState().snipeMode,true);
  g.key('4',{repeat:true});assert.equal(g.debug.getState().snipeMode,true);
  g.key('4');assert.equal(g.debug.getState().snipeMode,false);
  g.key('End',{code:'Numpad1'});assert.equal(g.debug.getState().abilityCounts.swap,1);
});

test('ability input stays inactive in text fields, with modifiers, or while paused', () => {
  const g=game();g.debug.start();
  g.key('1',{ctrlKey:true});g.key('2',{target:{closest:()=>true}});
  g.controller.pauseActivity();g.key('3');g.message({type:'htmlhub:merge-ability',key:'4'});
  assert.equal(serialize(g.debug.getState().abilityCounts),serialize({swap:2,quake:2,walls:2,snipe:2}));
  assert.equal(g.debug.getState().snipeMode,false);
});

test('Snipe can target and remove a ball while raised Walls remain active', () => {
  const g=game();g.debug.start();g.key('3');g.debug.step(120);g.debug.refreshControls();
  assert.equal(g.debug.getState().cup.wallsActive,true);
  assert.equal(g.element('snipeBtn').disabled,false);
  const ball=g.debug.spawn(0,540,900);
  g.message({type:'htmlhub:merge-ability',key:'4'});
  assert.equal(g.debug.getState().snipeMode,true);
  g.element('gameCanvas').dispatch('pointerdown',{clientX:540,clientY:900});
  assert.equal(g.debug.getState().abilityCounts.snipe,1);
  assert.equal(g.debug.getState().cup.wallsActive,true);
  g.debug.step(30);
  assert.equal(g.debug.getState().balls.some(item=>item.rigidbodyId===ball.rigidbodyId),false);
});

function startCombo(g) {
  g.debug.start();
  const radius = g.debug.TIERS[0].diameter / 2;
  g.debug.spawn(0, 540 - radius, g.debug.BASE_CUP.floorY - radius);
  g.debug.spawn(0, 540 + radius, g.debug.BASE_CUP.floorY - radius);
  for (let i = 0; i < 30 && !g.debug.getState().activeCombo; i++) g.debug.step();
  assert.equal(g.debug.getState().activeCombo?.ordinal, 1);
  const state = g.debug.getState();
  return 800 - (state.comboTime - state.activeCombo.lastMergeClock);
}

test('combo uses 800 ms of elapsed play time even during Snipe slow-motion or a stalled physics frame', () => {
  for (const slowMotion of [false, true]) {
    const g = game(), remaining = startCombo(g);
    if (slowMotion) g.debug.toggleSnipe();
    const before = g.debug.getState().simTime;
    g.tick(remaining - .001);
    assert.equal(g.debug.getState().activeCombo?.ordinal, 1);
    g.tick(.001);
    assert.equal(g.debug.getState().activeCombo, null);
    assert.equal(g.debug.getState().runScore, 10);
    const physicsElapsed = g.debug.getState().simTime - before;
    assert(physicsElapsed < 51, 'physics catch-up stays bounded while the real combo deadline expires');
    if (slowMotion) assert(physicsElapsed < 6, 'Snipe really slowed the physics without slowing the combo clock');
    else assert(physicsElapsed > 40, 'The comparison case runs at the normal physics rate');
  }
});

test('elapsed combo deadline excludes paused tab time and resumes with only its remaining duration', () => {
  const g = game(), remaining = startCombo(g);
  g.tick(300);
  g.controller.pauseActivity();
  g.tick(600000);
  assert.equal(g.debug.getState().activeCombo?.ordinal, 1);
  g.controller.resumeActivity();
  g.tick(remaining - 300 - .001);
  assert.equal(g.debug.getState().activeCombo?.ordinal, 1);
  g.tick(.001);
  assert.equal(g.debug.getState().activeCombo, null);
});

test('Pause freezes moving balls, timed abilities, and simulation even across a long close/reopen interval', () => {
  const g = game(); g.debug.start(); g.debug.spawn(4, 540, 800, { vy: 90 }); g.debug.useQuake();
  g.tick(20); assert.equal(g.controller.pauseActivity(), true);
  const before = serialize(g.debug.getState());
  g.tick(600000); g.debug.step(60);
  assert.equal(serialize(g.debug.getState()), before);
  assert.equal(g.controller.resumeView(), true);
  assert.equal(g.element('pauseModal').hidden, false);
  g.tick(600000);
  assert.equal(serialize(g.debug.getState()), before, 'Reopening still waits for explicit Resume');
  g.element('resumeBtn').dispatch('click'); g.tick(20);
  assert.equal(g.controller.isPaused(), false);
  assert.ok(g.debug.getState().simTime > JSON.parse(before).simTime);
  assert.ok(g.debug.getState().simTime - JSON.parse(before).simTime < 25, 'Closed time is never caught up');
  assert.ok(g.debug.getState().cup.quake, 'Quake duration did not expire while closed');
});

test('Pausing cancels a held drop and blocks abilities, aiming, checkout, and canvas input', () => {
  const g = game(); g.debug.start();
  g.element('gameCanvas').dispatch('pointerdown'); assert.equal(g.debug.getState().pointerDown, true);
  g.element('pauseBtn').dispatch('click');
  assert.equal(g.debug.getState().pointerDown, false);
  const before = serialize(g.debug.getState());
  g.element('gameCanvas').dispatch('pointerup', { clientY: 600 });
  g.element('gameCanvas').dispatch('pointerdown', { clientX: 400 });
  g.element('gameCanvas').dispatch('pointermove', { clientX: 700 });
  g.debug.drop(); g.debug.useSwap(); g.debug.useQuake(); g.debug.useWalls(); g.debug.toggleSnipe();
  g.debug.requestCheckout(); g.debug.openCheckout(); g.key('1'); g.key(' '); g.tick(20);
  assert.equal(serialize(g.debug.getState()), before);
  assert.equal(g.element('pauseBtn').getAttribute('aria-pressed'), 'true');
  assert.equal(g.element('swapBtn').disabled, true);
  g.key('p'); assert.equal(g.controller.isPaused(), false);
});

test('Host close request preserves a checkout decision until Resume and Continue', () => {
  const g = game(); g.debug.start(); g.debug.requestCheckout(); g.tick(20);
  assert.equal(g.element('confirmModal').hidden, false);
  g.message({ type: 'htmlhub:activity-pause-request' });
  assert.equal(g.controller.isPaused(), true);
  g.message({ type: 'htmlhub:activity-resume-view' });
  g.element('resumeBtn').dispatch('click');
  assert.equal(g.element('confirmModal').hidden, false);
  assert.equal(g.debug.getState().modalPaused, true);
  g.element('continueBtn').dispatch('click');
  assert.equal(g.debug.getState().modalPaused, false);
});

test('Run storage is isolated to the iframe/tab and menus or completed runs cannot be suspended', () => {
  const storage = new Map(), first = game(storage);
  assert.equal(first.controller.pauseActivity(), false);
  first.debug.start(); first.debug.spawn(6, 400, 500); first.controller.pauseActivity();
  const second = game(storage);
  assert.equal(second.debug.getState().runState, 'menu');
  assert.equal(second.debug.getState().balls.length, 0);
  assert.equal(second.controller.isPaused(), false);
  assert.equal(storage.size, 0, 'No run data was written to shared local storage');
  first.controller.resumeActivity(); first.debug.openCheckout(); first.debug.confirmCheckout();
  assert.equal(first.controller.pauseActivity(), false);
});

test('Native chat and exit bridge messages remain accessible during pause without destroying the run', () => {
  const g = game(); g.debug.start(); g.controller.pauseActivity();
  g.element('activityChatBtn').dispatch('click');
  assert.equal(g.messages.at(-1).type, 'htmlhub:activity-chat-toggle');
  g.element('pauseExitBtn').dispatch('click');
  assert.equal(g.messages.at(-1).type, 'htmlhub:activity-close');
  assert.equal(g.controller.isPaused(), true);
  assert.equal(g.controller.resumeActivity(), true);
  g.message({ type: 'htmlhub:activity-pause-request' }, {});
  assert.equal(g.controller.isPaused(), false, 'Unrelated frames cannot pause the activity');
  g.message({ type: 'htmlhub:activity-chat-state', open: true });
  assert.equal(g.element('activityChatBtn').getAttribute('aria-pressed'), 'true');
});
