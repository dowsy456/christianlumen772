/* Pointer input must never resize, move, or apply pressure to placed balls.
 * Compare against an identical idle simulation so natural impact/load squash
 * remains allowed and remains tested by the physics suites.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function game() {
  const elements = new Map();
  const drawing = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }) }, {
    get: (target, key) => target[key] || (() => {}),
    set: (target, key, value) => (target[key] = value, true)
  });
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const handlers = new Map();
    const node = {
      hidden: false, style: { setProperty() {} }, dataset: {}, textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getContext: () => drawing,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }),
      setAttribute() {}, querySelector: selector => element(String(id) + selector),
      querySelectorAll: () => [], appendChild() {}, focus() {},
      setPointerCapture() {}, releasePointerCapture() {},
      addEventListener: (type, handler) => handlers.set(type, handler),
      dispatch: (type, event = {}) => handlers.get(type)?.({ isPrimary: true, button: 0,
        pointerId: 1, clientX: 540, clientY: 315, ...event })
    };
    elements.set(id, node); return node;
  }
  const window = { addEventListener() {}, setTimeout() {}, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {} } }; window.parent = window;
  const filename = process.env.MERGE_PARTY_GAME || path.join(__dirname, '../activities/merge-party/game.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    window, document: { getElementById: element, createElement: tag => element(Symbol(tag)), querySelectorAll: () => [] },
    navigator: {}, performance: { now: () => 0 }, Date: class extends Date { static now() { return 12345678; } },
    requestAnimationFrame() {}, setTimeout, clearTimeout, console
  }, { filename });
  const debug = window.__mergeParty.debug; debug.start();
  return { debug, canvas: element('gameCanvas'), pause: () => window.__mergeParty.pauseActivity(), resume: () => window.__mergeParty.resumeActivity() };
}
const radius = (debug, tier) => debug.TIERS[tier].diameter / 2;
const height = (debug, body) => debug.effectiveRadius(body, 0, 1);
const width = (debug, body) => debug.effectiveRadius(body, 1, 0);
const live = debug => debug.getState().balls.filter(body => !body.dead);
function physicalState(debug) {
  return JSON.stringify(live(debug).map(body => ({
    id: body.rigidbodyId, tier: body.logicalTier, x: body.x, y: body.y,
    vx: body.vx, vy: body.vy, angle: body.angle, omega: body.omega,
    mass: body.mass, radius: body.radius, shape: debug.bodyShape(body),
    width: width(debug, body), height: height(debug, body),
    sleeping: body.sleeping, merge: body.mergeTransactionId
  })));
}
function compareSteps(control, interacted, frames, message) {
  for (let frame = 0; frame < frames; frame++) {
    control.debug.step(); interacted.debug.step();
    assert.equal(physicalState(interacted.debug), physicalState(control.debug), `${message}, frame ${frame}`);
  }
}
function scene(stacked = false, falling = false) {
  const g = game(), d = g.debug;
  const lower = d.spawn(3, 540, d.BASE_CUP.floorY - radius(d, 3)); d.step(180);
  const upper = stacked ? d.spawn(0, 540, lower.y - height(d, lower) - radius(d, 0) - (falling ? 180 : 0)) : null;
  if (upper && !falling) d.step(240);
  return { ...g, lower, target: upper || lower };
}

test('unloaded balls recover to circles on the floor while their faces remain alive', () => {
  for (const tier of [0, 3, 7]) {
    const { debug } = game();
    const body = debug.spawn(tier, 540, debug.BASE_CUP.floorY - radius(debug, tier) - 220);
    debug.step(360);
    const settled = { x: body.x, y: body.y }; let blinkFrames = 0;
    for (let frame = 0; frame < 600; frame++) {
      debug.step();
      assert.ok(Math.abs(height(debug, body) / body.radius - 1) < .035,
        `Tier ${tier}: its own weight does not leave a permanently flattened ball`);
      assert.ok(Math.abs(width(debug, body) / body.radius - 1) < .035);
      assert.ok(Math.hypot(body.x - settled.x, body.y - settled.y) < 2, 'Facial life does not make a supported body drift');
      if (body.blinkStarted >= 0) blinkFrames++;
    }
    assert.ok(blinkFrames > 0, 'A settled ball still animates its face');
  }
});

test('holding a placed ball leaves its dimensions and motion identical to an untouched ball', () => {
  for (const stacked of [false, true]) {
    const control = scene(stacked), held = scene(stacked);
    held.canvas.dispatch('pointerdown', { clientX: held.target.x, clientY: held.target.y });
    assert.equal(held.debug.getState().pointerDown, true, 'The input really started a held placement');
    compareSteps(control, held, 240, 'Holding cannot alter the existing body or its support');
    assert.equal(live(held.debug).length, stacked ? 2 : 1, 'Holding does not release the queued ball');
  }
});

test('downward, upward, and sideways drags only aim the queued ball while existing colliders evolve naturally', () => {
  for (const delta of [{ x: 0, y: 210 }, { x: 170, y: 0 }, { x: -130, y: -170 }, { x: 130, y: 160 }]) {
    for (const falling of [false, true]) {
      const control = scene(true, falling), dragged = scene(true, falling);
      const start = { clientX: dragged.target.x, clientY: dragged.target.y };
      dragged.canvas.dispatch('pointerdown', start);
      for (let move = 1; move <= 12; move++) {
        dragged.canvas.dispatch('pointermove', { clientX: start.clientX + delta.x * move / 12, clientY: start.clientY + delta.y * move / 12 });
        compareSteps(control, dragged, 6, 'A held drag cannot squeeze, widen, or push any placed ball');
      }
      compareSteps(control, dragged, 120, 'Remaining held cannot change the physical stack');
      assert.equal(dragged.debug.getState().targetAimX, start.clientX + delta.x, 'Dragging updates the drop aim');
    }
  }
});

test('a downward drag cannot widen separated matching balls into a merge', () => {
  function separated() {
    const g = game(), r = radius(g.debug, 0), floor = g.debug.BASE_CUP.floorY;
    const body = g.debug.spawn(0, 470, floor - r);
    g.debug.spawn(0, 470 + 2 * r + 3, floor - r); g.debug.step(180);
    return { ...g, body };
  }
  const control = separated(), dragged = separated();
  assert.equal(live(dragged.debug).length, 2);
  dragged.canvas.dispatch('pointerdown', { clientX: dragged.body.x, clientY: dragged.body.y });
  dragged.canvas.dispatch('pointermove', { clientX: dragged.body.x, clientY: dragged.body.y + 180 });
  compareSteps(control, dragged, 180, 'Pointer pressure cannot create an artificial merging contact');
  assert.equal(live(dragged.debug).length, 2, 'Both separated matches remain live');
  assert.equal(dragged.debug.getState().runScore, 0);
});

test('releasing a drag from a placed ball drops exactly one queued ball without resizing the original', () => {
  for (const delta of [{ x: 0, y: 0 }, { x: 0, y: 170 }, { x: 130, y: 0 }]) {
    const control = scene(), dragged = scene();
    const before = physicalState(dragged.debug);
    const from = { clientX: dragged.target.x, clientY: dragged.target.y };
    const to = { clientX: from.clientX + delta.x, clientY: from.clientY + delta.y };
    dragged.canvas.dispatch('pointerdown', from); dragged.canvas.dispatch('pointermove', to);
    assert.equal(physicalState(dragged.debug), before);
    compareSteps(control, dragged, 90, 'Aim input has no physical force');
    const original = { x: dragged.lower.x, y: dragged.lower.y, width: width(dragged.debug, dragged.lower), height: height(dragged.debug, dragged.lower), mass: dragged.lower.mass };
    dragged.canvas.dispatch('pointerup', to);
    assert.equal(live(dragged.debug).length, 2, 'One release places one ball');
    assert.equal(live(dragged.debug).at(-1).vx, 0, 'Dragging never charges horizontal launch velocity');
    assert.equal(live(dragged.debug).at(-1).vy, 0, 'Every release begins at rest regardless of held drag distance');
    assert.equal(dragged.debug.getState().pointerDown, false);
    assert.deepEqual({ x: dragged.lower.x, y: dragged.lower.y, width: width(dragged.debug, dragged.lower), height: height(dragged.debug, dragged.lower), mass: dragged.lower.mass }, original,
      'Releasing never rescales or moves the selected existing ball');
    dragged.canvas.dispatch('pointerup', to);
    assert.equal(live(dragged.debug).length, 2, 'Duplicate releases do not place another ball');
  }
});

test('cancellation, lost capture, and pause clear held placement without leaving force or dropping a ball', () => {
  for (const end of ['pointercancel', 'lostpointercapture', 'pause']) {
    const control = scene(true), dragged = scene(true);
    const point = { clientX: dragged.target.x, clientY: dragged.target.y };
    dragged.canvas.dispatch('pointerdown', point);
    dragged.canvas.dispatch('pointermove', { ...point, clientY: point.clientY + 200 });
    compareSteps(control, dragged, 90, 'Drag remains nonphysical before cancellation');
    if (end === 'pause') { dragged.pause(); control.pause(); dragged.debug.step(60); control.debug.step(60); dragged.resume(); control.resume(); }
    else dragged.canvas.dispatch(end);
    assert.equal(dragged.debug.getState().pointerDown, false, `${end} clears held input`);
    dragged.canvas.dispatch('pointerup', { ...point, clientY: point.clientY + 200 });
    compareSteps(control, dragged, 180, 'Cancelled input leaves the unchanged natural simulation');
    assert.equal(live(dragged.debug).length, 2, `${end} prevents a pending release from dropping a ball`);
  }
});
test('a Red placed in a real two-ball pocket stays supported instead of racing off', () => {
  const { debug } = game();
  const left = debug.spawn(4, 540 - debug.BASE_CUP.floorWidth * .23, debug.BASE_CUP.floorY - radius(debug, 4));
  const right = debug.spawn(5, 540 + debug.BASE_CUP.floorWidth * .23, debug.BASE_CUP.floorY - radius(debug, 5)); debug.step(180);
  const red = debug.spawn(3, (left.x + right.x) / 2, Math.min(left.y, right.y) - 225);
  let touchedLeft = false, touchedRight = false;
  for (let frame = 0; frame < 360; frame++) {
    debug.step();
    touchedLeft ||= red.y < left.y && debug.pairGeometry(red, left).separation < 1;
    touchedRight ||= red.y < right.y && debug.pairGeometry(red, right).separation < 1;
  }
  assert.ok(touchedLeft && touchedRight, 'Both sides of the cup-relative pocket physically support the Red');
  assert.equal(debug.getState().runState, 'playing');
  assert.equal(red.outCandidate, false);
  assert.equal(red.wallAttachment, null);
  assert.ok(red.x > left.x && red.x < right.x, 'The pocket between supporting balls retains the precise placement');
  assert.ok(red.y < left.y && red.y < right.y, 'The Red rests on the balls rather than sliding through the pocket');
  const before = { x: red.x, y: red.y }; debug.step(180);
  assert.ok(Math.hypot(red.x - before.x, red.y - before.y) < 5, 'A legitimately supported placement settles');
});

