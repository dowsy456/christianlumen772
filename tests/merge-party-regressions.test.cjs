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
const extentY = (debug, body) => debug.effectiveRadius(body, 0, 1);
const serial = value => JSON.stringify(value);
const live = debug => debug.getState().balls.filter(ball => !ball.dead);
const speed = body => Math.hypot(body.vx, body.vy);

test('Aqua contacts remain physical and have no merge, score, combo, shiny, or cup side effects', () => {
  const { debug, effects } = game();
  const r = radius(debug, 11);
  debug.scheduleShiny('aqua-no-op-baseline');
  const a = debug.spawn(11, 540 - r, 500, { entry: { shiny: true } });
  const b = debug.spawn(11, 540 + r, 500, { entry: { shiny: true } });
  const before = debug.getState();
  const beforeEffects = serial(effects());
  const reservations = serial(before.shinyReservations);
  debug.step(20);
  const after = debug.getState();
  assert.equal(live(debug).length, 2);
  assert.equal(a.dead, false);
  assert.equal(b.dead, false);
  assert.equal(a.collisionEnabled, true);
  assert.equal(b.collisionEnabled, true);
  assert.equal(a.shinyConsumed, false);
  assert.equal(b.shinyConsumed, false);
  assert.ok(a.y > 500 && b.y > 500, 'Terminal balls still fall normally');
  assert.ok(debug.pairGeometry(a, b).separation >= -1, 'Terminal deformed outlines still collide');
  assert.equal(after.mergeTransactions.length, 0);
  assert.equal(after.contacts.length, 0);
  assert.equal(after.runScore, before.runScore);
  assert.equal(serial(after.activeCombo), serial(before.activeCombo));
  assert.equal(serial(after.shinyReservations), reservations);
  assert.equal(serial(effects()), beforeEffects);
  assert.equal(after.cup.growthCount, before.cup.growthCount);
  assert.equal(after.cup.topWidth, before.cup.topWidth);
});

test('matching balls stay live and moving during the contact hold, then merge once', () => {
  const { debug } = game();
  const r = radius(debug, 0);
  const a = debug.spawn(0, 500 - r, 600, { vx: 40, vy: 100, omega: .5 });
  const b = debug.spawn(0, 500 + r, 600, { vx: 40, vy: 100, omega: .5 });
  debug.step(6);
  assert.equal(live(debug).length, 2, '100 ms is shorter than the 180 ms merge hold');
  for (const body of [a, b]) {
    assert.equal(body.dead, false);
    assert.equal(body.collisionEnabled, true);
    assert.ok(body.y > 610 && body.vy > 150, 'Pending parents continue falling');
    assert.ok(body.x > body.px, 'Pending parents continue horizontal movement');
  }
  debug.step(12);
  const remaining = live(debug);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].logicalTier, 1);
  assert.equal(remaining[0].collisionEnabled, true);
  assert.ok(remaining[0].y > 630 && remaining[0].vy > 200);
  assert.ok(Math.abs(remaining[0].vx - 40) < .3, 'The merged center retains horizontal velocity');
  assert.equal(debug.getState().mergeTransactions.length, 1);
});

test('glue holds a matched pair together against separating velocity until its original merge deadline', () => {
  const { debug } = game();
  const r = radius(debug, 0);
  const a = debug.spawn(0, 480, 500);
  const b = debug.spawn(0, 480 + 2 * r, 500);
  debug.step(6);
  const started = debug.getState().contacts[0].started;
  a.vx = -300; b.vx = 300;
  debug.step(2);
  assert.equal(live(debug).length, 2);
  assert.equal(debug.getState().contacts.length, 1, 'First contact creates a persistent bond');
  assert.equal(debug.getState().contacts[0].started, started, 'Separating impulse does not restart the hold');
  assert.ok(Math.abs(debug.pairGeometry(a, b).separation) < 1, 'Glue maintains visible outline contact');
  debug.step(5);
  assert.equal(live(debug).length, 1);
  assert.equal(live(debug)[0].logicalTier, 1);
});

test('only a Rainbow pair grows the cup, with one growth per pair', () => {
  for (const tier of [7, 8, 9, 10, 11]) {
    const { debug } = game();
    const r = radius(debug, tier);
    const before = debug.getState().cup;
    debug.spawn(tier, 540 - r, 480);
    debug.spawn(tier, 540 + r, 480);
    debug.step(50);
    const after = debug.getState();
    assert.equal(after.cup.growthCount, tier === 7 ? 1 : 0, `Source tier ${tier}`);
    if (tier === 7) {
      assert.ok(after.cup.topWidth > before.topWidth);
      assert.ok(after.cup.floorWidth > before.floorWidth);
      assert.equal(live(debug)[0].logicalTier, 8);
    } else {
      assert.equal(after.cup.topWidth, before.topWidth, `Source tier ${tier} top width`);
      assert.equal(after.cup.floorWidth, before.floorWidth, `Source tier ${tier} floor width`);
      assert.equal(live(debug).length, tier === 11 ? 2 : 1);
      if (tier < 11) assert.equal(live(debug)[0].logicalTier, tier + 1);
    }
    debug.step(120);
    assert.equal(debug.getState().cup.growthCount, tier === 7 ? 1 : 0,
      `Source tier ${tier} cannot trigger delayed or repeated growth`);
  }
});

test('merge products use their collider area for mass without exponential density growth', () => {
  for (const tier of [0, 7, 8, 9, 10]) {
    const { debug } = game();
    const r = radius(debug, tier);
    debug.spawn(tier, 540 - r, 480, { mass: 1024, vx: 35, vy: 50 });
    debug.spawn(tier, 540 + r, 480, { mass: 1024, vx: 35, vy: 50 });
    debug.step(20);
    const result = live(debug)[0];
    assert.equal(live(debug).length, 1, `Source tier ${tier} completed its merge`);
    const expectedMass = (radius(debug, tier + 1) / radius(debug, 0)) ** 2;
    assert.ok(Math.abs(result.mass - expectedMass) < 1e-8, `Source tier ${tier} area mass`);
    assert.ok(Math.abs(result.vx - 35) < .3, 'Center velocity survives the mass recalibration');
    assert.ok(Number.isFinite(result.omega));
  }
});

test('a high mass ratio cannot push the supporting Blue through the floor', () => {
  for (const mass of [512, 1024]) {
    const { debug } = game();
    const floor = debug.BASE_CUP.floorY;
    const lower = debug.spawn(0, 540, floor - radius(debug, 0));
    const upper = debug.spawn(10, 540, lower.y - lower.radius - radius(debug, 10), { mass });
    for (let frame = 0; frame < 600; frame++) {
      debug.step();
      assert.ok(lower.y + extentY(debug, lower) <= debug.getState().cup.floorY + 1,
        `Mass ${mass}: support stays above the solid floor on frame ${frame}`);
      assert.ok(Number.isFinite(lower.y) && Number.isFinite(upper.y));
    }
    assert.equal(debug.getState().runState, 'playing');
  }
});

test('a crowded pile settles without sustained translation, spin, or compression-axis jitter', () => {
  const { debug } = game();
  const floor = debug.BASE_CUP.floorY;
  debug.spawn(1, 410, floor - radius(debug, 1));
  debug.spawn(2, 565, floor - radius(debug, 2));
  debug.spawn(3, 485, floor - 300);
  debug.step(480);
  const snapshots = new Map(live(debug).map(body => [body.rigidbodyId, body]));
  for (let frame = 0; frame < 180; frame++) {
    debug.step();
    for (const body of live(debug)) {
      const initial = snapshots.get(body.rigidbodyId);
      assert.ok(initial, 'No unexplained creation/destruction in a mixed pile');
      assert.ok(Math.hypot(body.x - initial.x, body.y - initial.y) < .75,
        `Tier ${body.logicalTier} remains still after settling`);
      assert.ok(speed(body) < 2, `Tier ${body.logicalTier} settled speed ${speed(body)}`);
      assert.ok(Math.abs(body.angle - initial.angle) < .025, 'Settled balls do not keep spinning');
      if (body.squeeze > .01 && initial.squeeze > .01) {
        assert.equal(body.squeezeAxis, initial.squeezeAxis, 'Resting compression axis stays stable');
      }
      assert.ok(body.y + extentY(debug, body) <= floor + 1);
    }
  }
});

test('removing support wakes its resting dependent body immediately', () => {
  const { debug } = game();
  const lower = debug.spawn(3, 540, debug.BASE_CUP.floorY - radius(debug, 3));
  const upper = debug.spawn(0, 540, lower.y - lower.radius - radius(debug, 0));
  debug.step(180);
  const before = upper.y;
  lower.dead = true;
  debug.step();
  assert.ok(upper.y > before + .5 * debug.CONFIG.gravity * debug.CONFIG.fixedStep ** 2 * .95 && upper.vy > debug.CONFIG.gravity * debug.CONFIG.fixedStep * .95,
    'A formerly supported ball starts falling on the next frame');
  assert.equal(upper.sleeping, false);
});

test('single off-centre crown support rolls away naturally instead of sleeping midair', () => {
  const { debug } = game();
  const red = debug.spawn(3, 540, debug.BASE_CUP.floorY - radius(debug, 3));
  const sum = red.radius + radius(debug, 0);
  const offset = 35;
  const blue = debug.spawn(0, red.x + offset, red.y - Math.sqrt(sum * sum - offset * offset));
  let escaped = false;
  for (let frame = 0; frame < 480; frame++) {
    debug.step();
    if (Math.abs(blue.x - red.x) > sum * .55) { escaped = true; break; }
  }
  assert.ok(escaped, 'An unstable crown contact must be able to roll off');
});

test('strong floor impacts compress visibly with little upward rebound and then return to rest', () => {
  const { debug } = game();
  const ball = debug.spawn(0, 540, debug.BASE_CUP.floorY - radius(debug, 0) - 1, { vy: 500 });
  debug.step();
  assert.ok(ball.vy < 0 && ball.vy >= -65, 'A hard impact has only a small upward rebound');
  let maximumSquash = ball.squeezeY;
  for (let frame = 0; frame < 8; frame++) { debug.step(); maximumSquash = Math.max(maximumSquash, ball.squeezeY); }
  assert.ok(maximumSquash > .06, 'Impact energy visibly deforms the floor-facing axis');
  debug.step(240);
  assert.ok(speed(ball) < .1, 'Restitution does not keep a resting ball bouncing');
  assert.ok(Math.abs(ball.y + extentY(debug, ball) - debug.BASE_CUP.floorY) < .6);
});

// Append to a Merge Party test file that already defines test, assert, game,
// and radius. These snippets deliberately do not modify the site checkout.

test('Snipe wakes a resting stack as soon as its supporting collider is removed', () => {
  const { debug, canvas } = game();
  const lower = debug.spawn(3, 540, debug.BASE_CUP.floorY - radius(debug, 3));
  const upper = debug.spawn(0, 540, lower.y - lower.radius - radius(debug, 0));
  debug.step(240);
  assert.equal(upper.sleeping, true, 'The regression requires a sleeping supported body');
  const before = upper.y;
  debug.toggleSnipe();
  canvas.dispatch('pointerdown', { clientX: lower.x, clientY: lower.y });
  assert.equal(lower.collisionEnabled, false, 'Snipe immediately removes its collider');
  assert.equal(lower.dead, false, 'The visible removal animation is still active');
  debug.step();
  assert.equal(upper.sleeping, false);
  assert.ok(upper.y > before + .5 * debug.CONFIG.gravity * debug.CONFIG.fixedStep ** 2 * .95 && upper.vy > debug.CONFIG.gravity * debug.CONFIG.fixedStep * .95,
    'The supported ball falls immediately, without waiting for the 120 ms fade');
});

test('removing a glued parent before the deadline cancels its reservation without a phantom merge', () => {
  const { debug, canvas } = game();
  const r = radius(debug, 0);
  debug.spawn(0, 480, 500);
  const second = debug.spawn(0, 480 + 2 * r, 500);
  debug.step(11);
  assert.equal(debug.getState().balls.length, 2, 'Parents still exist just before the merge deadline');
  debug.toggleSnipe();
  canvas.dispatch('pointerdown', { clientX: second.x, clientY: second.y });
  assert.equal(second.collisionEnabled, false, 'The removed parent stops participating immediately');
  debug.step();
  assert.equal(live(debug).filter(body => body.collisionEnabled).length, 1,
    'The unremoved parent survives instead of being consumed by an invalid bond');
  assert.equal(debug.getState().mergeTransactions.length, 0);
  assert.equal(debug.getState().contacts.length, 0);
  debug.step(20);
  assert.equal(live(debug).length, 1);
  assert.equal(live(debug)[0].logicalTier, 0);
});

test('a never-entered ball outside the rim cannot teleport through the side wall', () => {
  const { debug } = game();
  const rightRim = 540 + debug.BASE_CUP.topWidth / 2;
  const rimY = debug.BASE_CUP.floorY - debug.BASE_CUP.wallHeight;
  const body = debug.spawn(0, rightRim - 20, rimY - 110, { vx: 230 });
  assert.equal(body.enteredCup, false);
  let prior = { x: body.x, y: body.y };
  for (let frame = 0; frame < 40; frame++) {
    debug.step();
    assert.ok(Math.hypot(body.x - prior.x, body.y - prior.y) < 35,
      'Crossing the outside of a side segment cannot cause a 125 px inward correction');
    prior = { x: body.x, y: body.y };
  }
  assert.ok(body.x > rightRim + body.radius,
    'An outside trajectory remains outside the cup');
});

test('a dropped ball that touched a tall pile can spill before crossing below the rim', () => {
  const { debug } = game();
  const rightRim = 540 + debug.BASE_CUP.topWidth / 2;
  const rimY = debug.BASE_CUP.floorY - debug.BASE_CUP.wallHeight;
  // Preserve the ballistic path to the cap under reference gravity. Keeping
  // the old horizontal speed instead would miss the cap entirely.
  const body = debug.spawn(0, rightRim - 20, rimY - 110, { vx: 230 * Math.sqrt(debug.CONFIG.gravity / 1500) });
  body.firstContact = true; // The new ball has already landed on the tall pile.
  assert.equal(body.enteredCup, false);
  debug.step(35);
  assert.equal(body.onSurface, true, 'The fixture actually reaches physical rim support');
  assert.equal(body.outCandidate, false,
    'Rolling across the physical rounded cap is still supported, even outside the old zero-width rim');
  for (let frame = 0; frame < 180 && !body.outCandidate; frame++) debug.step();
  assert.equal(body.outCandidate, true,
    'Losing actual cap support makes the outward trajectory a real spill');
  assert.ok(body.x > rightRim + body.radius);
  assert.ok(body.y < rimY, 'The unsupported escape is detected before its center falls below the rim');
});

test('cup participation propagates through contact with a ball in a tall pile', () => {
  const { debug } = game();
  const rimY = debug.BASE_CUP.floorY - debug.BASE_CUP.wallHeight;
  const lower = debug.spawn(3, 540, rimY - 100);
  lower.enteredCup = true;
  const upper = debug.spawn(0, 540, lower.y - lower.radius - radius(debug, 0));
  debug.step();
  assert.ok(upper.y < rimY, 'The new ball has not crossed into the geometric cup yet');
  assert.ok(upper.enteredCup || upper.firstContact,
    'Contact with the existing pile must make a later spill eligible for detection');
});

test('Quake wakes the settled pile, makes contact-gated hops, and allows it to settle again', () => {
  const { debug } = game();
  const body = debug.spawn(0, 540, debug.BASE_CUP.floorY - radius(debug, 0));
  debug.step(180);
  assert.equal(body.sleeping, true);
  const before = { x: body.x, y: body.y };
  debug.useQuake();
  debug.step();
  assert.equal(body.sleeping, false, 'A moving cup immediately wakes its contacts');
  let maximumTravel = 0;
  for (let frame = 0; frame < 960; frame++) {
    debug.step();
    maximumTravel = Math.max(maximumTravel, Math.hypot(body.x - before.x, body.y - before.y));
      assert.ok(body.y + extentY(debug, body) <= debug.getState().cup.floorY + 5,
      'The moving floor contains the ball on every landing');
    assert.ok(Number.isFinite(body.x) && Number.isFinite(body.y));
  }
  assert.ok(maximumTravel > .5, 'The intentional Quake still visibly moves the ball');
  assert.ok(body.quakeJumpCount >= 6 && body.quakeLandingCount >= body.quakeJumpCount - 1,
    'Repeat takeoffs wait for supporting contact after the previous hop');
  assert.equal(debug.getState().cup.quake, null);
  debug.step(240);
  assert.ok(Math.hypot(body.vx, body.vy) < 2);
  assert.ok(Math.abs(body.y + extentY(debug, body) - debug.getState().cup.floorY) < .6);
});

test('raised walls expire safely while a settled floor ball stays supported', () => {
  const { debug } = game();
  const body = debug.spawn(0, 540, debug.BASE_CUP.floorY - radius(debug, 0));
  debug.step(180);
  debug.useWalls();
  debug.step(25);
  assert.equal(debug.getState().cup.wallsActive, true);
  assert.ok(debug.getState().cup.wallsProgress > .99);
  debug.step(Math.ceil(debug.CONFIG.wallsDurationMs / 1000 * 60) + 30);
  assert.equal(debug.getState().cup.wallsActive, false);
  assert.equal(debug.getState().cup.wallsProgress, 0);
  assert.ok(Math.abs(body.y + extentY(debug, body) - debug.getState().cup.floorY) < .6);
  assert.ok(Math.hypot(body.vx, body.vy) < 2);
  assert.equal(debug.getState().runState, 'playing');
});

test('checkout settles an already glued pair once, including immediate resume and repeat checkout', () => {
  const { debug } = game();
  const r = debug.TIERS[0].diameter / 2;
  debug.spawn(0, 540 - r, 500);
  debug.spawn(0, 540 + r, 500);
  debug.step();
  assert.equal(debug.getState().contacts.length, 1, 'The visible first-touch delay has committed a pair');
  assert.equal(live(debug).length, 2, 'The parents are still present before checkout');
  debug.openCheckout();
  assert.equal(debug.getState().contacts.length, 0, 'Checkout completes the committed glue');
  assert.equal(live(debug).length, 1, 'Checkout leaves one live merged result');
  assert.equal(live(debug)[0].logicalTier, 1);
  assert.equal(debug.getState().runScore, 10, 'The score shown for checkout includes that completed pair');
  debug.continueRun();
  debug.step();
  assert.equal(debug.getState().runScore, 10, 'Immediate resume does not score the pair a second time');
  debug.openCheckout();
  assert.equal(debug.getState().runScore, 10, 'Repeated checkout cannot replay its committed merge');
  debug.continueRun();
  debug.step(90);
  assert.equal(debug.getState().runScore, 10, 'Passing the original delay and combo window does not duplicate score');
  assert.equal(live(debug).length, 1);
  assert.equal(debug.getState().contacts.length, 0);
  assert.equal(debug.getState().mergeTransactions.length, 0);
});

test('checkout settles every independent glued pair and counts the combo only once', () => {
  const { debug } = game();
  const r = debug.TIERS[0].diameter / 2;
  for (const center of [350, 730]) {
    debug.spawn(0, center - r, 500);
    debug.spawn(0, center + r, 500);
  }
  debug.step();
  assert.equal(debug.getState().contacts.length, 2, 'Both independent pairs have committed');
  debug.openCheckout();
  assert.equal(debug.getState().runScore, 30, 'Two merges contribute 10 + 20 combo points');
  assert.equal(debug.getState().contacts.length, 0);
  assert.equal(live(debug).length, 2);
  assert.ok(live(debug).every(body => body.logicalTier === 1 && body.bondPartnerId == null));
  debug.continueRun();
  debug.step(30);
  assert.equal(debug.getState().runScore, 30, 'Resuming preserves the already banked combo exactly');
  debug.openCheckout();
  assert.equal(debug.getState().runScore, 30);
});

test('unbonded touching balls can move apart without CCD rewinding their motion', () => {
  for (const [tierA, tierB] of [[0, 1], [11, 11]]) {
    const { debug } = game();
    const sumRadius = (debug.TIERS[tierA].diameter + debug.TIERS[tierB].diameter) / 2;
    const startA = 360;
    const startB = startA + sumRadius;
    const a = debug.spawn(tierA, startA, 500, { vx: -120 });
    const b = debug.spawn(tierB, startB, 500, { vx: 120 });
    debug.step();
    assert.ok(a.x < startA - 1, 'The left ball actually follows its outward velocity');
    assert.ok(b.x > startB + 1, 'The right ball actually follows its outward velocity');
    assert.ok(b.x - a.x > sumRadius + 3, 'A prior touch does not trap a departing unbonded pair');
    assert.equal(debug.getState().contacts.length, 0);
    debug.step(12);
    assert.ok(b.x - a.x > sumRadius + 40, 'Separation continues across subsequent steps');
    assert.equal(live(debug).length, 2);
    assert.equal(debug.getState().mergeTransactions.length, 0);
    assert.equal(debug.getState().runScore, 0);
  }
});

test('a first matching touch still glues even when its initial velocities point apart', () => {
  const { debug } = game();
  const r = debug.TIERS[0].diameter / 2;
  debug.spawn(0, 540 - r, 500, { vx: -120 });
  debug.spawn(0, 540 + r, 500, { vx: 120 });
  debug.step();
  assert.equal(debug.getState().contacts.length, 1, 'Eligible starting contact commits immediately');
  assert.equal(live(debug).length, 2, 'Glue retains both parents during the delay');
  debug.step(14);
  assert.equal(live(debug).length, 1);
  assert.equal(live(debug)[0].logicalTier, 1);
});
