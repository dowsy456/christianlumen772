/* Regression coverage for floor containment, resting stacks and merge rules. */
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
      hidden: false, style: {}, dataset: {}, textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getContext: () => drawing,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }),
      setAttribute() {}, querySelector: selector => element(id + selector),
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
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} }
  };
  window.parent = window;
  const sandbox = {
    window,
    document: {
      getElementById: element,
      createElement: tag => element(Symbol(tag)),
      querySelectorAll: () => []
    },
    navigator: {}, performance: { now: () => 0 },
    Date: class extends Date { static now() { return 12345678; } },
    requestAnimationFrame() {}, setTimeout, clearTimeout, console
  };
  const filename = process.env.MERGE_PARTY_GAME ||
    path.join(__dirname, '../activities/merge-party/game.js');
  let source = fs.readFileSync(filename, 'utf8');
  // Inspect effects inside this isolated test VM without expanding production API.
  assert.ok(source.includes('window.__mergeParty={'), 'Gameplay debug entry point is available');
  source = source.replace('window.__mergeParty={',
    'window.__physicsAuditEffects=()=>effects.map(effect=>({...effect}));\nwindow.__mergeParty={');
  vm.runInNewContext(source, sandbox, { filename });
  const debug = window.__mergeParty.debug;
  if (debug.getState().runState !== 'playing') {
    if (debug.start) debug.start();
    else if (debug.startRun) debug.startRun();
    else {
      for (const id of ['playBtn', 'startBtn', 'startGameBtn', 'menuPlayBtn']) {
        if (elements.has(id)) elements.get(id).dispatch('click', {});
      }
    }
  }
  assert.equal(debug.getState().runState, 'playing', 'Harness starts gameplay before physics assertions');
  return { debug, canvas: element('gameCanvas'), effects: window.__physicsAuditEffects };
}

const radius = (debug, tier) => debug.TIERS[tier].diameter / 2;
const serial = value => JSON.stringify(value);
const live = debug => debug.getState().balls.filter(ball => !ball.dead);
const speed = body => Math.hypot(body.vx, body.vy);

// Behavioral checks for the revised soft body model. These intentionally read
// geometry and rebound distance in addition to cosmetic squeeze properties.
function squeezeY(body) {
  return Number.isFinite(body.squeezeY) ? body.squeezeY :
    body.squeezeAxis === 'y' ? (body.squeeze || 0) : 0;
}
const extentY = (debug, body) => debug.effectiveRadius(body, 0, 1);
function contactsFor(debug, id) {
  return debug.getState().contacts.filter(c => c.aId === id || c.bId === id);
}

test('normal Blue drop absorbs the impact with squash and only a small rebound', () => {
  const { debug } = game();
  const floor = debug.BASE_CUP.floorY;
  const body = debug.spawn(0, 540, floor - radius(debug, 0) - 420);
  let impacted = false, maxSquash = 0, reboundHeight = 0, peakUpward = 0;
  for (let frame = 0; frame < 240; frame++) {
    debug.step();
    if (body.y + body.radius > floor - 2 || squeezeY(body) > .01) impacted = true;
    if (impacted) {
      maxSquash = Math.max(maxSquash, squeezeY(body));
      reboundHeight = Math.max(reboundHeight, floor - radius(debug, 0) - body.y);
      peakUpward = Math.max(peakUpward, -body.vy);
    }
    assert.ok(body.y + extentY(debug, body) <= floor + 1, 'Deformed shape cannot leak below the floor');
  }
  assert.ok(impacted, 'The normal drop reached the cup floor');
  assert.ok(maxSquash >= .07, `Impact makes the Blue visibly compress (${maxSquash})`);
  assert.ok(reboundHeight <= 9, `A 420 px drop rebounds no more than 9 px (${reboundHeight})`);
  assert.ok(peakUpward <= 140, `Upward launch stays small (${peakUpward})`);
  assert.ok(speed(body) < 2, 'The impact settles instead of bouncing indefinitely');
});

function loadedSupport(tier) {
  const { debug } = game();
  const floor = debug.BASE_CUP.floorY;
  const lower = debug.spawn(tier, 540, floor - radius(debug, tier));
  debug.step(120);
  const unloadedY = lower.y;
  // A centered, mixed-tier load avoids merges and tests physical space saving.
  const upperTier = tier === 0 ? 3 : 0;
  const upper = debug.spawn(upperTier, 540,
    lower.y - extentY(debug, lower) - radius(debug, upperTier), { mass: lower.mass * 4 });
  debug.step(180);
  return { debug, lower, upper, floor, unloadedY,
    gained: (lower.y - unloadedY) / lower.radius };
}

test('weight compresses a small supporting ball and creates actual stack space', () => {
  const { debug, lower, upper, floor, gained } = loadedSupport(0);
  assert.ok(gained > .055, `Loaded Blue's center moves toward the floor (${gained})`);
  assert.ok(squeezeY(lower) > .08, 'Blue retains visible squash while loaded');
  assert.ok(lower.y + extentY(debug, lower) <= floor + 1, 'Reduced height stays contained');
  assert.ok(upper.y - extentY(debug, upper) > floor - 2 * lower.radius - 2 * upper.radius + 5,
    'The occupied top of the stack is below its rigid-circle position');
});

test('a large ball compresses less than Blue under proportional load but still yields', () => {
  const small = loadedSupport(0);
  const large = loadedSupport(7);
  assert.ok(large.gained > .003, `Rainbow collider is still deformable (${large.gained})`);
  assert.ok(large.gained < small.gained * .75,
    `Rainbow compresses proportionally less (${large.gained} versus ${small.gained})`);
});

test('Yellow is just below Orange, White and Rainbow are reduced, and Rainbow remains largest', () => {
  const { debug } = game();
  const sizes = debug.TIERS.map(tier => tier.diameter);
  assert.ok(sizes[5] < sizes[4] && sizes[5] >= sizes[4] * .88,
    `Yellow is slightly smaller than Orange (${sizes[5]}, ${sizes[4]})`);
  assert.ok(sizes[6] < 380.8 * .91, 'White was reduced materially from the oversized version');
  assert.ok(sizes[7] < 465.6 * .95, 'Rainbow was reduced from the oversized version');
  assert.ok(sizes[7] === Math.max(...sizes), 'Rainbow is the biggest ball');
  assert.ok(sizes[10] < sizes[11] && sizes[10] > sizes[11] * .87,
    'Animal remains slightly smaller than Aqua');
});

test('matching contact bonds instantly, survives outward velocity, and merges after the short hold', () => {
  const { debug } = game();
  const r = radius(debug, 0);
  const a = debug.spawn(0, 540 - r + .2, 550);
  const b = debug.spawn(0, 540 + r - .2, 550);
  debug.step();
  assert.equal(debug.getState().contacts.length, 1, 'First-touch frame creates one bond');
  assert.equal(live(debug).length, 2, 'First touch does not consume the visible parents');
  a.vx = -500; b.vx = 500;
  for (let frame = 0; frame < 5; frame++) {
    debug.step();
    assert.equal(debug.getState().contacts.length, 1, 'Outward motion cannot discard the bond');
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= a.radius + b.radius + 2,
      'Glue constrains the parents before the merge');
  }
  assert.equal(live(debug).length, 2, '100 ms of glue remains visibly delayed');
  debug.step(8);
  assert.equal(live(debug).length, 1, 'The bonded pair has merged by 233 ms');
  assert.equal(live(debug)[0].logicalTier, 1);
  assert.equal(debug.getState().mergeTransactions.length, 1);
});

test('first visual outline contact can bond without a hidden collider gap', () => {
  const { debug } = game();
  const visibleR = debug.TIERS[0].diameter / 2;
  debug.spawn(0, 540 - visibleR, 550);
  debug.spawn(0, 540 + visibleR, 550);
  debug.step();
  assert.equal(debug.getState().contacts.length, 1,
    'Two touching visible outlines create their bond immediately');
  debug.step(14);
  assert.equal(live(debug).length, 1);
});

test('fast glancing matching contact cannot bounce apart before its merge', () => {
  const { debug } = game();
  const r = radius(debug, 0);
  const a = debug.spawn(0, 540 - r - 6, 530, { vx: 1400, vy: -300 });
  const b = debug.spawn(0, 540 + r + 6, 550, { vx: -1400, vy: 300 });
  debug.step();
  assert.equal(debug.getState().contacts.length, 1, 'Fast glancing contact is captured');
  assert.equal(live(debug).length, 2);
  debug.step(14);
  assert.equal(live(debug).length, 1);
  assert.equal(debug.getState().mergeTransactions.length, 1);
  assert.ok(a.dead && b.dead, 'Both original parents belong to the same completed merge');
});

test('three touching matches reserve exclusive pairs and cannot consume a parent twice', () => {
  const { debug } = game();
  const r = radius(debug, 0);
  const bodies = [-1, 0, 1].map(offset => debug.spawn(0, 540 + offset * (2 * r - 1), 550));
  debug.step();
  assert.equal(debug.getState().contacts.length, 1, 'Only one exclusive pair is reserved');
  for (const body of bodies) assert.ok(contactsFor(debug, body.rigidbodyId).length <= 1);
  debug.step(20);
  assert.equal(live(debug).length, 2);
  assert.equal(live(debug).filter(body => body.logicalTier === 1).length, 1);
  assert.equal(live(debug).filter(body => body.logicalTier === 0).length, 1);
  assert.equal(debug.getState().mergeTransactions.length, 1);
});

test('different tiers do not glue, and touching Aquas remain complete merge no-ops', () => {
  for (const [tierA, tierB] of [[0, 1], [11, 11]]) {
    const { debug, effects } = game();
    const a = debug.spawn(tierA, 540 - radius(debug, tierA), 500);
    const b = debug.spawn(tierB, 540 + radius(debug, tierB), 500);
    const before = debug.getState();
    const effectsBefore = serial(effects());
    debug.step(25);
    const after = debug.getState();
    assert.equal(live(debug).length, 2);
    assert.equal(after.contacts.length, 0);
    assert.equal(after.mergeTransactions.length, 0);
    assert.equal(after.runScore, before.runScore);
    assert.equal(after.cup.growthCount, before.cup.growthCount);
    assert.ok(!a.dead && !b.dead && a.collisionEnabled && b.collisionEnabled);
    if (tierA === 11) {
      assert.equal(serial(after.activeCombo), serial(before.activeCombo));
      assert.equal(serial(effects()), effectsBefore, 'Aqua contact creates no merge flourish');
    }
  }
});


