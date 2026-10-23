/* Deterministic gameplay regression tests. No browser, Firebase, or network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function game() {
  const elements = new Map();
  const drawing = new Proxy({}, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) });
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const node = { hidden: false, style: {}, dataset: {}, textContent: '', classList: { add() {}, remove() {}, toggle() {} },
      getContext: () => drawing, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }),
      setAttribute() {}, querySelector: (selector) => element(id + selector), appendChild() {},
      setPointerCapture() {}, releasePointerCapture() {},
      addEventListener: (name, callback) => listeners.set(name, callback),
      dispatch: (name, event) => listeners.get(name)?.({ isPrimary: true, button: 0, pointerId: 1, ...event }) };
    elements.set(id, node);
    return node;
  }
  const window = { addEventListener() {}, localStorage: { getItem: () => null, setItem() {} } };
  window.parent = window;
  const sandbox = { window, document: { getElementById: element, createElement: (tag) => element(Symbol(tag)) }, navigator: {},
    performance: { now: () => 0 }, Date: class extends Date { static now() { return 12345678; } },
    requestAnimationFrame() {}, setTimeout, clearTimeout, console };
  vm.runInNewContext(fs.readFileSync(process.env.MERGE_PARTY_GAME || path.join(__dirname, '../activities/merge-party/game.js'), 'utf8'), sandbox);
  window.__mergeParty.debug.start();
  return { debug: window.__mergeParty.debug, canvas: element('gameCanvas') };
}

const radius = (debug, tier) => debug.TIERS[tier].diameter / 2;
const extentY = (debug, body) => debug.effectiveRadius(body, 0, 1);
const kinetic = (ball) => .5 * ball.mass * (ball.vx ** 2 + ball.vy ** 2) + .5 * ball.inertia * ball.omega ** 2;

test('reference proportions: narrow default cup, large high tiers, reset restores geometry', () => {
  const { debug } = game();
  const { cup } = debug.getState();
  assert.ok(cup.floorWidth / debug.TIERS[1].diameter > 2.95 && cup.floorWidth / debug.TIERS[1].diameter < 3.15,
    'The reference floor spans about 3.05 Green diameters');
  const slope = (cup.topWidth - cup.floorWidth) / (2 * cup.wallHeight);
  const outerWidth = cup.topWidth + 2 * debug.CONFIG.railRadius * (1 + 1 / Math.hypot(1, slope));
  assert.ok(outerWidth / 1080 > .64 && outerWidth / 1080 < .67,
    'The rounded outer rim spans the measured 65.4% of portrait width');
  assert.ok(cup.wallHeight / debug.TIERS[3].diameter < 2.3);
  assert.ok(debug.invariantTests().enlargedHighTiers);
  assert.ok(debug.TIERS.every((tier) => tier.diameter <= debug.TIERS[7].diameter), 'Rainbow remains largest');
  assert.ok(debug.TIERS[10].diameter < debug.TIERS[11].diameter && debug.TIERS[10].diameter > debug.TIERS[11].diameter * .9, 'Animal is slightly smaller than Aqua');
  for (const tier of debug.TIERS.slice(8)) {
    assert.ok(tier.diameter > debug.TIERS[3].diameter, 'High tiers remain larger than Red after rescaling');
    assert.ok(tier.diameter < debug.TIERS[7].diameter);
    assert.ok(tier.diameter < cup.floorWidth, 'A single high-tier body fits in the initial cup');
  }
  debug.useWalls(); debug.step(25); debug.reset();
  assert.equal(debug.getState().cup.topWidth, cup.topWidth);
  assert.equal(debug.getState().cup.wallsProgress, 0);
});

test('free fall accelerates each unsupported tier equally, independent of mass', () => {
  const { debug } = game();
  const blue = debug.spawn(0, 380, 400), red = debug.spawn(3, 700, 400);
  debug.step(12);
  assert.ok(Math.abs(blue.y - red.y) < 1e-8);
  assert.ok(Math.abs(blue.vy - red.vy) < 1e-8);
  assert.ok(Math.abs(blue.y - (400 + .5 * debug.CONFIG.gravity * .2 ** 2)) < 1);
});

test('compression reduces actual collider height while preserving mass and the solid floor', () => {
  const { debug } = game();
  const ball = debug.spawn(0, 540, debug.BASE_CUP.floorY - radius(debug, 0));
  ball.squeezeY = .14;
  const originalRadius = ball.radius;
  const originalMass = ball.mass;
  assert.ok(debug.effectiveRadius(ball, 0, -1) < originalRadius * .87,
    'Squash immediately changes the physical support height');
  debug.step(180);
  assert.equal(ball.radius, originalRadius);
  assert.equal(ball.mass, originalMass, 'Squashing changes shape without losing mass');
  assert.ok(Math.abs(ball.y + extentY(debug, ball) - debug.BASE_CUP.floorY) < .6);
  assert.ok(Math.hypot(ball.vx, ball.vy) < .1);
});

test('low-speed floor contacts settle, while a hard impact squashes with a small rebound', () => {
  const { debug } = game();
  const floor = debug.BASE_CUP.floorY;
  const ball = debug.spawn(0, 540, floor - radius(debug, 0) - 1, { vy: 60 });
  debug.step(1);
  assert.ok(ball.vy > -20, 'No restitution at a low-speed resting contact');
  debug.reset();
  const fast = debug.spawn(0, 540, floor - radius(debug, 0) - 1, { vy: 500 });
  debug.step(1);
  assert.ok(fast.vy < 0 && fast.vy >= -65, 'A substantial impact has a small, damped rebound');
  let maximumSquash = fast.squeezeY;
  for (let frame = 0; frame < 8; frame++) { debug.step(); maximumSquash = Math.max(maximumSquash, fast.squeezeY); }
  assert.ok(maximumSquash > .06, 'The impact visibly compresses the ball against the floor');
  debug.step(240);
  assert.ok(Math.abs(fast.vy) < .1);
});

test('soft floor friction converts sliding to rotation and dissipates its energy', () => {
  const { debug } = game();
  const ball = debug.spawn(0, 540, debug.BASE_CUP.floorY - radius(debug, 0), { vx: 100 });
  const energy = kinetic(ball);
  let peakRotation = 0;
  for (let frame = 0; frame < 30; frame++) { debug.step(); peakRotation = Math.max(peakRotation, Math.abs(ball.omega)); }
  assert.ok(peakRotation > .3, 'Sliding initially transfers into rotation');
  assert.ok(Math.abs(ball.vx) > 10 && Math.abs(ball.vx) < 55,
    'Floor friction slows the roll progressively instead of abruptly pinning the ball');
  assert.ok(Math.abs(ball.vx - extentY(debug, ball) * ball.omega) < 1,
    'Rolling matches the actual compressed radius at the floor contact');
  assert.ok(kinetic(ball) < energy);
  // Weight-dependent friction gives reference gravity a longer coast from the
  // same initial speed, bounded by v/a for time and v²/2a for distance.
  const rollingDeceleration = debug.CONFIG.rollingResistance * debug.CONFIG.gravity;
  const maximumDistance = ball.x - 540 + ball.vx ** 2 / (2 * rollingDeceleration);
  debug.step(Math.ceil(Math.abs(ball.vx) / rollingDeceleration / debug.CONFIG.fixedStep) + 1);
  assert.ok(Math.hypot(ball.vx, ball.vy) < .5, 'The roll settles within its friction stopping time');
  assert.ok(ball.x - 540 <= maximumDistance, 'The ball stops within its available rolling energy');
});

test('tapered wall absorbs an oblique impact and applies the correct inward reaction', () => {
  const { debug } = game();
  const cup = debug.BASE_CUP, slope = (cup.topWidth - cup.floorWidth) / (2 * cup.wallHeight);
  const nx = 1 / Math.hypot(1, slope), ny = -slope * nx;
  const r = radius(debug, 0), ax = 540 - (cup.topWidth + cup.floorWidth) / 4, ay = cup.floorY - cup.wallHeight / 2;
  const ball = debug.spawn(0, ax + nx * (r + .5), ay + ny * (r + .5), { vx: -300 * nx, vy: -300 * ny });
  debug.step(1);
  const normalSpeed = ball.vx * nx + ball.vy * ny;
  assert.ok(normalSpeed >= -10 && normalSpeed < 50,
    `The 300 px/s incoming impact becomes a nearly stopped or small inward rebound (${normalSpeed})`);
  assert.ok(ball.vx > -30 && ball.vy < -300 * ny,
    'The angled reaction arrests the leftward motion and reduces downward velocity');
  assert.ok(ball.squeezeX > .02, 'An oblique side impact visibly squashes the horizontal axis');
});

test('a precise crown placement remains interceptable longer than an off-centre one', () => {
  function escape(offset) {
    const { debug } = game();
    const red = debug.spawn(3, 540, debug.BASE_CUP.floorY - radius(debug, 3));
    const sum = radius(debug, 3) + radius(debug, 0);
    const blue = debug.spawn(0, red.x + offset, red.y - Math.sqrt(sum * sum - offset * offset));
    for (let frame = 1; frame <= 360; frame++) {
      debug.step();
      if (Math.abs(blue.x - red.x) > sum * .55) return frame / 60;
    }
    return Infinity;
  }
  const precise = escape(.5), loose = escape(35);
  assert.ok(Number.isFinite(loose), 'A clearly off-centre placement still rolls away');
  assert.ok(precise > loose + .4, `Precise ${precise}s must outlast loose ${loose}s`);
});

test('removing settled support resumes gravity on the next update', () => {
  const { debug } = game();
  const lower = debug.spawn(3, 540, debug.BASE_CUP.floorY - radius(debug, 3));
  const upper = debug.spawn(0, 540, lower.y - lower.radius - radius(debug, 0));
  debug.step(90);
  const before = upper.y;
  lower.dead = true;
  debug.step();
  assert.ok(upper.y > before + .5 * debug.CONFIG.gravity * debug.CONFIG.fixedStep ** 2 * .95 && upper.vy > debug.CONFIG.gravity * debug.CONFIG.fixedStep * .95);
  assert.equal(upper.sleeping, false);
});

test('touching balls merge atomically, inherit center velocity with size-based mass, and never freeze in midair', () => {
  const { debug } = game();
  const r = radius(debug, 0);
  const first = debug.spawn(0, 500 - r, 650, { vx: 50, vy: 90, omega: .5 });
  const second = debug.spawn(0, 500 + r, 650, { vx: 50, vy: 90, omega: .5 });
  debug.step();
  assert.equal(debug.getState().balls.length, 2, "Parents remain physical during the contact dwell");
  debug.step(12);
  const live = debug.getState().balls;
  assert.equal(live.length, 1);
  assert.equal(live[0].logicalTier, 1);
  assert.equal(live[0].mass, (radius(debug, 1) / radius(debug, 0)) ** 2);
  assert.equal(live[0].collisionEnabled, true);
  assert.ok(live[0].y > 650 && live[0].vy > 110);
  assert.ok(Math.abs(live[0].vx - 50) < .2);
  assert.equal(debug.getState().contacts.length, 0);
});

test('nearby matching outlines cannot attract or glue balls across a physical gap', () => {
  const { debug } = game();
  const r = radius(debug, 0);
  debug.spawn(0, 480, 650);
  debug.spawn(0, 480 + 2 * r + 4, 650);
  debug.step(1);
  assert.equal(debug.getState().balls.length, 2);
  assert.equal(debug.getState().contacts.length, 0, 'A real outline gap cannot start a glue reservation');
  assert.equal(debug.getState().mergeTransactions.length, 0);
});

test('mixed-size pile remains nonpenetrating and comes to rest', () => {
  const { debug } = game();
  const floor = debug.BASE_CUP.floorY;
  debug.spawn(1, 410, floor - radius(debug, 1));
  debug.spawn(2, 565, floor - radius(debug, 2));
  debug.spawn(3, 485, floor - 300);
  debug.step(480);
  const balls = debug.getState().balls;
  assert.equal(balls.length, 3);
  for (const ball of balls) {
    assert.ok(Number.isFinite(ball.x) && Number.isFinite(ball.y));
    assert.ok(ball.y + extentY(debug, ball) < floor + 1);
    assert.ok(Math.hypot(ball.vx, ball.vy) < 2, `Tier ${ball.logicalTier} speed ${Math.hypot(ball.vx, ball.vy)}`);
  }
  for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
    assert.ok(debug.pairGeometry(balls[i], balls[j]).separation > -1,
      'The actual deformed outlines remain nonpenetrating');
  }
});

test('high tiers fit, stay physical during merges, and terminal Aqua stays in the cup', () => {
  for (const tier of [8, 9, 10, 11]) {
    const { debug } = game();
    const ball = debug.spawn(tier, 540, 800);
    debug.step(180);
    assert.ok(Math.abs(ball.y + extentY(debug, ball) - debug.BASE_CUP.floorY) < 1);
    assert.ok(Math.hypot(ball.vx, ball.vy) < 1);
    assert.equal(debug.getState().runState, 'playing');
  }
  const { debug } = game();
  const r = radius(debug, 11);
  debug.spawn(11, 540 - r, 650); debug.spawn(11, 540 + r, 650);
  debug.step();
  assert.equal(debug.getState().balls.length, 2);
  assert.equal(debug.getState().contacts.length, 0);
});

test('hover follows the cursor before selection, during cooldown, and after promotion', () => {
  const { debug, canvas } = game();
  canvas.dispatch('pointermove', { clientX: 620, clientY: 500 });
  assert.equal(debug.getState().aimX, 620);
  assert.equal(debug.getState().balls.length, 0);
  canvas.dispatch('pointerdown', { clientX: 620, clientY: 500 });
  canvas.dispatch('pointerup', { clientX: 610, clientY: 500 });
  assert.equal(debug.getState().balls[0].x, 610);
  canvas.dispatch('pointermove', { clientX: 450, clientY: 500 });
  assert.equal(debug.getState().aimX, 450);
  for (let frame = 0; frame < 150 && !debug.getState().currentEntry; frame++) debug.step();
  assert.ok(debug.getState().currentEntry);
  assert.equal(debug.getState().aimX, 450);
  canvas.dispatch('pointerdown', { clientX: 470, clientY: 500 });
  canvas.dispatch('pointercancel', {});
  canvas.dispatch('pointermove', { clientX: 500, clientY: 500 });
  assert.equal(debug.getState().aimX, 500);
  assert.equal(debug.getState().pointerDown, false);
});

test('a tall last drop blocks its occupied lane but leaves a clear side lane playable', () => {
  const { debug, canvas } = game();
  // Let the soft pile settle before dropping into its remaining headroom.
  // A following larger ball then overlaps that genuinely occupied lane.
  const entries = debug.getState();
  entries.currentEntry.logicalTier = 0;
  entries.futureQueue[0].logicalTier = 3;
  // Eight settled alternating balls leave room for Blue but fill the next Red release lane.
  const column = [3, 1, 3, 1, 3, 1, 3, 1];
  let top = debug.BASE_CUP.floorY;
  for (const level of column) {
    const r = radius(debug, level);
    debug.spawn(level, 540, top - r);
    top -= 2 * r;
  }
  debug.step(360);
  assert.equal(debug.drop(), true);
  debug.step(120);
  let state = debug.getState();
  assert.ok(state.currentEntry && !state.queueRevealPending);
  assert.equal(state.runState, 'playing');
  const last = state.balls[state.balls.length - 1];
  assert.ok(last.y - extentY(debug, last) < 315 + radius(debug, state.currentEntry.logicalTier),
    'The last drop overlaps the next held ball in the occupied centre lane');
  assert.equal(debug.drop(), false, 'Cannot insert the next ball into the occupied centre');
  canvas.dispatch('pointermove', { clientX: 850, clientY: 500 });
  assert.equal(debug.drop(), true, 'A clear side lane remains available');
});

test('a smaller next ball follows a stationary cursor beyond the prior tier clamp', () => {
  const { debug, canvas } = game();
  const state = debug.getState();
  state.currentEntry.logicalTier = 3;
  state.futureQueue[0].logicalTier = 0;
  canvas.dispatch('pointermove', { clientX: 1080, clientY: 500 });
  const priorAim = debug.getState().aimX;
  const rimX = 540 + debug.BASE_CUP.topWidth / 2;
  assert.ok(priorAim >= rimX - 24 && priorAim < rimX + 44,
    'Red can reach the rounded wall while retaining an outside-edge margin');
  assert.equal(debug.getState().targetAimX, 1080);
  canvas.dispatch('pointerdown', { clientX: 1080, clientY: 500 });
  canvas.dispatch('pointerup', { clientX: 1080, clientY: 500 });
  assert.equal(debug.getState().targetAimX, 1080, 'Release retains the raw cursor coordinate');
  debug.step(120);
  const after = debug.getState();
  assert.equal(after.currentEntry.logicalTier, 0);
  assert.ok(after.aimX > priorAim + 1,
    'Blue follows the stationary cursor farther because it needs a smaller cap margin');
  assert.ok(after.aimX < rimX + 44, 'The promoted ball still excludes the outside edge');
});
