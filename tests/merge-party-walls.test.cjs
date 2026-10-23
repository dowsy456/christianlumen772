const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function game() {
  const elements = new Map();
  const drawing = new Proxy({}, { get: (target, key) => target[key] || (() => {}),
    set: (target, key, value) => (target[key] = value, true) });
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map(), attrs = new Map();
    const node = { hidden: false, style: {}, dataset: {}, textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getContext: () => drawing,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }),
      setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key),
      querySelector: selector => element(id + selector), querySelectorAll: () => [],
      appendChild() {}, focus() {}, setPointerCapture() {}, releasePointerCapture() {},
      addEventListener: (name, callback) => listeners.set(name, callback),
      dispatch: (name, event) => listeners.get(name)?.({ isPrimary: true, button: 0,
        pointerId: 1, preventDefault() {}, ...event }) };
    elements.set(id, node); return node;
  }
  const window = { addEventListener() {}, localStorage: { getItem: () => null, setItem() {} } };
  window.parent = window;
  const filename = path.join(__dirname, '../activities/merge-party/game.js');
  const source = fs.readFileSync(filename, 'utf8').replace('window.__mergeParty={',
    'window.__wallAudit={startMerge,frame:wallFrame,shoot:(id)=>{snipeTargetId=id;shootSnipe()}};\nwindow.__mergeParty={');
  vm.runInNewContext(source, { window, document: { getElementById: element,
    createElement: tag => element(Symbol(tag)), querySelectorAll: () => [] }, navigator: {},
    performance: { now: () => 0 }, Date: class extends Date { static now() { return 12345678; } },
    requestAnimationFrame() {}, setTimeout, clearTimeout, console }, { filename });
  const debug = window.__mergeParty.debug; debug.start();
  return { debug, audit: window.__wallAudit, element };
}
const live = debug => debug.getState().balls.filter(body => !body.dead);
const count = (debug, key) => debug.getState().abilityCounts[key];

test('every run gives two charges and Swap consumes one per completed use', () => {
  const { debug, element } = game();
  assert.deepEqual(JSON.parse(JSON.stringify(debug.getState().abilityCounts)),
    { swap: 2, quake: 2, walls: 2, snipe: 2 });
  debug.useSwap(); assert.equal(count(debug, 'swap'), 1);
  debug.useSwap(); assert.equal(count(debug, 'swap'), 1, 'Animation cannot spend the second charge');
  debug.step(40); debug.render(); debug.useSwap(); assert.equal(count(debug, 'swap'), 0);
  assert.match(element('swapBtn').getAttribute('aria-label'), /0 charges remaining/);
  debug.reset(); assert.equal(count(debug, 'swap'), 2);
});

test('timed abilities retain their second charge while active and can be used twice', () => {
  const { debug, element } = game();
  debug.useWalls(); assert.equal(count(debug, 'walls'), 1);
  debug.step(30); debug.useWalls(); assert.equal(count(debug, 'walls'), 1);
  debug.refreshControls(); assert.equal(element('wallsBtn').disabled, true);
  assert.match(element('wallsBtn').getAttribute('aria-label'), /1 charge remaining/);
  debug.step(1830); debug.useWalls(); assert.equal(count(debug, 'walls'), 0);
  debug.reset(); debug.useQuake(); assert.equal(count(debug, 'quake'), 1);
  debug.step(60); debug.useQuake(); assert.equal(count(debug, 'quake'), 1);
  debug.step(900); debug.useQuake(); assert.equal(count(debug, 'quake'), 0);
});

test('Snipe consumes a charge only on a valid shot, twice per run', () => {
  const { debug, audit } = game();
  debug.toggleSnipe(); audit.shoot(-1); assert.equal(count(debug, 'snipe'), 2);
  debug.toggleSnipe(); assert.equal(count(debug, 'snipe'), 2, 'Cancelling is free');
  for (const expected of [1, 0]) {
    const body = debug.spawn(0, 540, 1100);
    debug.toggleSnipe(); audit.shoot(body.rigidbodyId);
    assert.equal(count(debug, 'snipe'), expected);
    debug.step(10);
  }
});

test('a falling ball overlapping the new wall is pinned without lift or ejection', () => {
  const { debug } = game();
  const body = debug.spawn(3, 154, 900, { vx: -240, vy: 280 });
  body.outCandidate = true;
  const initial = { x: body.x, y: body.y };
  debug.useWalls();
  assert.ok(body.wallAttachment, 'Raising material catches the ball immediately');
  assert.equal(body.outCandidate, false);
  for (let frame = 0; frame < 120; frame++) {
    debug.step();
    assert.ok(Math.hypot(body.x - initial.x, body.y - initial.y) < .01,
      'Wall extension never pushes the embedded ball upward or sideways');
    assert.equal(body.vx, 0); assert.equal(body.vy, 0);
  }
  assert.ok(body.squeezeX > .03, 'The embedded ball visibly compresses sideways');
  debug.useQuake(); debug.step(120);
  assert.ok(body.wallAttachment, 'Quake does not shake a pierced ball free');
  assert.ok(Math.abs(body.y - initial.y) < 1, 'Attachment follows only the small cup motion');
});

test('old cup walls and balls outside the extension remain ordinary physics', () => {
  const { debug } = game();
  const existing = debug.spawn(0, 244, 1250);
  const outside = debug.spawn(1, -70, 920);
  const inside = debug.spawn(2, 540, 900);
  debug.useWalls();
  assert.equal(existing.wallAttachment, null);
  assert.equal(outside.wallAttachment, null);
  assert.equal(inside.wallAttachment, null);
  debug.step(15);
  assert.ok(inside.y > 920);
});

function mergeAtWall({ deep = false, blocked = false } = {}) {
  const gameState = game(), { debug, audit } = gameState;
  // Coordinates follow the wall normal, making shallow/deep embedding directly
  // comparable without depending on the game's incidental random queue.
  const frame = audit.frame('left');
  const normalOffset = deep ? -10 : 74;
  const along = 580;
  const x = frame.floor.x + frame.ux * along + frame.nx * normalOffset;
  const y = frame.floor.y + frame.uy * along + frame.ny * normalOffset;
  const a = debug.spawn(0, x, y);
  debug.useWalls(); debug.step(24);
  assert.ok(a.wallAttachment);
  const b = debug.spawn(0, a.x + frame.nx * 112, a.y + frame.ny * 112);
  if (blocked) debug.spawn(11, b.x + frame.nx * 70, b.y + frame.ny * 70);
  // Commit the contact transaction directly so this isolates rescue geometry
  // from the order in which an intentionally crowded setup resolves contacts.
  audit.startMerge(a, b);
  const result = live(debug).find(body => body.logicalTier === 1);
  assert.ok(result, 'The ordinary merge transaction creates its result');
  return { ...gameState, result };
}

test('an inward merge frees a shallow wall attachment when room is available', () => {
  const { debug, result } = mergeAtWall();
  assert.equal(result.wallAttachment, null);
  assert.equal(result.outCandidate, false);
  debug.step(60);
  assert.equal(debug.getState().runState, 'playing');
});

test('an ordinary contact with a pinned ball completes its merge and can rescue it', () => {
  const { debug, audit } = game();
  const frame = audit.frame('left');
  const a = debug.spawn(0, frame.floor.x + frame.ux * 580 + frame.nx * 74,
    frame.floor.y + frame.uy * 580 + frame.ny * 74);
  debug.useWalls(); debug.step(24);
  const separation = debug.effectiveRadius(a, frame.nx, frame.ny) + a.radius - .2;
  debug.spawn(0, a.x + frame.nx * separation, a.y + frame.ny * separation);
  debug.step(24);
  const result = live(debug).find(body => body.logicalTier === 1);
  assert.ok(result, 'Normal collision, contact hold and merge complete beside the wall');
  assert.equal(result.wallAttachment, null, 'A clear inward result leaves the rail');
  assert.equal(result.outCandidate, false);
});

test('deep embedding and surrounding balls can each prevent merge rescue', () => {
  const deep = mergeAtWall({ deep: true }).result;
  assert.ok(deep.wallAttachment, 'A deeply embedded merge remains stuck');
  const crowded = mergeAtWall({ blocked: true }).result;
  assert.ok(crowded.wallAttachment, 'The release never displaces a surrounding ball to invent room');
  assert.ok(deep.wallAttachment.inheritedDepth > 0);
});

test('retracting walls release pins without an upward impulse', () => {
  const { debug } = game();
  const body = debug.spawn(0, 130, 900);
  debug.useWalls(); assert.ok(body.wallAttachment);
  debug.step(1798);
  assert.ok(body.wallAttachment);
  let released = false;
  for (let frame = 0; frame < 45; frame++) {
    debug.step();
    if (!body.wallAttachment) {
      released = true;
      assert.ok(body.vy >= 0, `Retraction resumes downward gravity (${body.vy})`);
      assert.ok(Math.abs(body.vx) < 1, 'No sideways impulse is injected');
      break;
    }
  }
  assert.ok(released, 'The temporary wall cannot permanently pin a ball after expiration');
});
