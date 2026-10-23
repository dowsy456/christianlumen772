/* Calibration from the supplied 30 fps gameplay recordings.
 * Bounds allow capture jitter and viewport differences; tests measure behavior,
 * not a copy of the engine constants. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function game() {
  const elements = new Map();
  const drawing = new Proxy({}, {
    get: (target, key) => target[key] || (() => {}),
    set: (target, key, value) => (target[key] = value, true)
  });
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const node = {
      hidden: false, style: { setProperty() {} }, dataset: {}, textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getContext: () => drawing,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }),
      setAttribute() {}, querySelector: selector => element(String(id) + selector),
      querySelectorAll: () => [], appendChild() {}, focus() {},
      setPointerCapture() {}, releasePointerCapture() {},
      addEventListener: (name, callback) => listeners.set(name, callback),
      dispatch: (name, event) => listeners.get(name)?.({
        isPrimary: true, button: 0, pointerId: 1, ...event
      })
    };
    elements.set(id, node);
    return node;
  }
  const window = {
    addEventListener() {}, localStorage: { getItem: () => null, setItem() {} }
  };
  window.parent = window;
  const filename = process.env.MERGE_PARTY_GAME ||
    path.join(__dirname, '../activities/merge-party/game.js');
  // Advance exact fractions of simulation time without exposing extra game APIs.
  const source = fs.readFileSync(filename, 'utf8').replace('window.__mergeParty={',
    'window.__calibrationAudit={step:physicsStep,effects:()=>effects};\nwindow.__mergeParty={');
  vm.runInNewContext(source, {
    window,
    document: { getElementById: element, createElement: tag => element(Symbol(tag)), querySelectorAll: () => [] },
    navigator: {}, performance: { now: () => 0 },
    Date: class extends Date { static now() { return 12345678; } },
    requestAnimationFrame() {}, setTimeout, clearTimeout, console
  }, { filename });
  const debug = window.__mergeParty.debug;
  debug.start();
  return { debug, stepMs: ms => window.__calibrationAudit.step(ms / 1000) };
}

const radius = (debug, tier) => debug.TIERS[tier].diameter / 2;
const live = debug => debug.getState().balls.filter(body => !body.dead);

test('free falls match the measured 613–684 world-unit gravity across direct tiers', () => {
  for (const tier of [0, 1, 2, 3]) {
    const { debug } = game();
    const body = debug.spawn(tier, 540, 300, { vx: 0, vy: 0 });
    const startY = body.y;
    debug.step(30);
    const halfY = body.y;
    debug.step(30);
    const endY = body.y;
    // The second finite difference cancels starting position and velocity.
    const acceleration = (endY - 2 * halfY + startY) / (.5 ** 2);
    assert.ok(acceleration >= 600 && acceleration <= 700,
      `Tier ${tier}: fitted acceleration ${acceleration.toFixed(1)} matches the recordings`);
    assert.ok(endY - startY >= 305 && endY - startY <= 350,
      'One second of free fall has the deliberate distance visible in the reference');
    assert.ok(Math.abs(body.x - 540) < .01, 'A vertical release acquires no sideways launch');
    assert.equal(body.firstContact, false, 'The measurements precede every collision');
  }
});

test('a blue landing on red spreads, recovers slowly, and stays on its support', () => {
  const { debug } = game();
  const red = debug.spawn(3, 540, debug.BASE_CUP.floorY - radius(debug, 3));
  debug.step(120);
  const blue = debug.spawn(0, 540, red.y - radius(debug, 3) - radius(debug, 0) - 500);
  const started = debug.getState().simTime;
  let contactAt = null, recoveredAt = null;
  let peak = { x: 1, y: 1, at: 0 };
  const samples = [];
  for (let frame = 0; frame < 210; frame++) {
    debug.step();
    const time = debug.getState().simTime;
    const shape = debug.bodyShape(blue);
    if (blue.touched && contactAt === null) contactAt = time;
    if (shape.y < peak.y) peak = { ...shape, at: time };
    if (contactAt === null) continue;
    samples.push({ elapsed: time - contactAt, ...shape, gap: debug.pairGeometry(red, blue).separation });
    if (peak.y < .8 && recoveredAt === null && time > peak.at && shape.y >= .98) recoveredAt = time;
    assert.ok(Math.abs(shape.x * shape.y - 1) < .03,
      'Impact deformation preserves the ball area rather than shrinking it');
  }
  assert.ok(contactAt !== null, 'The falling blue really lands on red');
  assert.ok(contactAt - started >= 1150 && contactAt - started <= 1350,
    'The 500-unit fall has the recorded slow arrival timing');
  assert.ok(peak.x >= 1.32 && peak.x <= 1.56 && peak.y >= .64 && peak.y <= .76,
    `Peak ${peak.x.toFixed(3)} × ${peak.y.toFixed(3)} matches the observed 1.45 × .70 squash`);
  assert.ok(peak.at - contactAt >= 100 && peak.at - contactAt <= 300,
    'Compression builds over several frames rather than snapping instantly');
  assert.ok(recoveredAt !== null && recoveredAt - contactAt >= 500 && recoveredAt - contactAt <= 900,
    'The body returns toward round over the recorded half-second-plus recovery');
  assert.ok(samples.every(sample => sample.gap <= 2),
    'The contracting outline follows its support without a gap and a second landing');
  assert.ok(samples.filter(sample => sample.elapsed >= 850).every(sample => sample.y >= .98),
    'A settled blue does not start another compression/bounce cycle');
  assert.ok(Math.abs(blue.x - red.x) < 2, 'An accurately centered placement remains on the crown');
  assert.equal(debug.getState().runState, 'playing');
});

test('equal balls keep their joined offset before one live replacement appears', () => {
  const g = game(), { debug } = g;
  const r = radius(debug, 0);
  const a = debug.spawn(0, 540 - r, 500, { vx: 80 });
  const b = debug.spawn(0, 540 + r, 500, { vx: -80 });
  g.stepMs(1000 / 120);
  const contact = debug.getState().contacts[0];
  assert.ok(contact, 'First physical contact creates a joined pair');
  const dx = b.x - a.x, dy = b.y - a.y;
  const firstTouch = contact.started;
  while (debug.getState().simTime - firstTouch < 150) {
    g.stepMs(1000 / 120);
    assert.equal(live(debug).length, 2, 'Both characters remain visible during the contact hold');
    assert.ok(Math.abs((b.x - a.x) - dx) < .1 && Math.abs((b.y - a.y) - dy) < .1,
      'Joined balls cannot slide around or rebound apart while waiting to merge');
  }
  let replacementAt = null;
  while (debug.getState().simTime - firstTouch < 260) {
    g.stepMs(1000 / 120);
    const bodies = live(debug);
    assert.ok(bodies.some(body => body.collisionEnabled),
      'The merge transition never removes every live collider');
    if (bodies.length === 1) { replacementAt = debug.getState().simTime; break; }
  }
  assert.ok(replacementAt !== null, 'The contact hold finishes with one replacement');
  assert.ok(replacementAt - firstTouch >= 160 && replacementAt - firstTouch <= 220,
    'The merge has a visible short hold without a long artificial pause');
  const result = live(debug)[0];
  assert.equal(result.logicalTier, 1);
  assert.ok(Math.abs(result.x - 540) < 1, 'The replacement uses the parent pair midpoint');
  assert.ok(Math.abs(result.vx) < 3 && result.vy >= 0 && result.vy < 180,
    'A merge preserves gentle shared falling motion without an explosive kick');
});

test('a fresh merge remains visible for about 300 ms before the next chain step', () => {
  const g = game(), { debug } = g;
  const r = radius(debug, 0);
  debug.spawn(0, 540 - r, 500);
  debug.spawn(0, 540 + r, 500);
  for (let frame = 0; frame < 40 && live(debug).length !== 1; frame++) g.stepMs(1000 / 120);
  const result = live(debug)[0];
  assert.equal(live(debug).length, 1, 'The first physical merge has completed');
  assert.equal(result.logicalTier, 1);
  const createdAt = debug.getState().simTime;
  // Meet the freshly created result immediately, before its reveal has ended.
  debug.spawn(1, result.x, result.y - debug.effectiveRadius(result, 0, -1) - radius(debug, 1),
    { vy: result.vy });
  g.stepMs(1000 / 120);
  assert.ok(debug.getState().contacts.some(contact => contact.aId === result.rigidbodyId || contact.bId === result.rigidbodyId),
    'Fresh matching results still join immediately instead of bouncing apart during protection');
  let nextMergeAt = null;
  while (debug.getState().simTime - createdAt < 380) {
    const elapsed = debug.getState().simTime - createdAt;
    const bodies = live(debug);
    if (elapsed < 270) assert.equal(bodies.length, 2,
      'The new green stays identifiable through its reveal and joined contact hold');
    if (bodies.length === 1) { nextMergeAt = debug.getState().simTime; break; }
    g.stepMs(1000 / 120);
  }
  assert.ok(nextMergeAt !== null, 'Protection expires and allows the physical chain to continue');
  assert.ok(nextMergeAt - createdAt >= 280 && nextMergeAt - createdAt <= 340,
    `The next chain step occurs after a distinct ${(nextMergeAt - createdAt).toFixed(1)} ms character beat`);
  assert.equal(live(debug)[0].logicalTier, 2);
});
