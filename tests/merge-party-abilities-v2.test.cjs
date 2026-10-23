/* Contact-gated Quake and immediate wall rescue regressions. */
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
    const attrs = new Map();
    const node = { hidden: false, style: { setProperty() {} }, dataset: {}, textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getContext: () => drawing,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }),
      setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key),
      querySelector: selector => element(id + selector), querySelectorAll: () => [],
      appendChild() {}, focus() {}, setPointerCapture() {}, releasePointerCapture() {}, addEventListener() {} };
    elements.set(id, node); return node;
  }
  const window = { addEventListener() {}, localStorage: { getItem: () => null, setItem() {} } }; window.parent = window;
  const filename = path.join(__dirname, '../activities/merge-party/game.js');
  const source = fs.readFileSync(filename, 'utf8').replace('window.__mergeParty={', `
    window.__abilityAudit={takeoffs:[],walls:()=>cup.wallsAnimation};
    const originalQuakeForces=applyQuakeForces;
    applyQuakeForces=(dt)=>{
      const before=new Map(balls.map(body=>[body.rigidbodyId,{...body}]));
      originalQuakeForces(dt);
      for(const body of balls)if(body.quakeJumpCount>(before.get(body.rigidbodyId)?.quakeJumpCount||0)){
        window.__abilityAudit.takeoffs.push({at:simTime,before:before.get(body.rigidbodyId),after:{...body}});
      }
    };
    window.__mergeParty={`);
  vm.runInNewContext(source, { window, document: { getElementById: element,
    createElement: tag => element(Symbol(tag)), querySelectorAll: () => [] }, navigator: {},
    performance: { now: () => 0 }, Date: class extends Date { static now() { return 12345678; } },
    requestAnimationFrame() {}, setTimeout, clearTimeout, console }, { filename });
  const debug = window.__mergeParty.debug; debug.start();
  return { debug, audit: window.__abilityAudit, element };
}

test('Quake hops repeatedly only from settled supporting contact and waits for each landing', () => {
  const { debug, audit } = game();
  const body = debug.spawn(0, 540, debug.BASE_CUP.floorY - debug.TIERS[0].diameter / 2);
  debug.step(240); debug.useQuake(); debug.step(900);
  const jumps = audit.takeoffs.filter(jump => jump.before.rigidbodyId === body.rigidbodyId);
  assert.ok(jumps.length >= 6 && jumps.length <= 16, `Useful, paced jumps: ${jumps.length}`);
  const directions = new Set();
  for (let index = 0; index < jumps.length; index++) {
    const jump = jumps[index];
    assert.equal(jump.before.quakeSupported, true, 'Every kick begins at a supporting collision');
    assert.equal(jump.before.quakeAwaitingLanding, false, 'An unfinished airborne hop cannot get another boost');
    assert.ok(jump.before.quakeGroundedTime >= .065, 'The ball gets actual contact time between hops');
    const gravityScale = Math.sqrt(debug.CONFIG.gravity / 1500);
    assert.ok(jump.after.vy < jump.before.vy - 250 * gravityScale, 'The ability produces useful upward energy at the reference gravity');
    assert.ok(jump.after.vy > -550 * gravityScale, 'The launch energy stays bounded');
    directions.add(Math.sign(jump.after.vx));
    if (index) {
      assert.ok(jump.at - jumps[index - 1].at >= 950, 'Jump energy cannot accumulate every physics tick');
      assert.ok(jump.before.quakeLandingCount >= index, 'Every subsequent launch follows a landing');
    }
  }
  assert.equal(directions.size, 2, 'Randomized hops move both left and right');
});

test('a falling ball receives no Quake boost before landing and larger balls jump less', () => {
  const heights = [];
  for (const tier of [0, 7]) {
    const { debug, audit } = game();
    const body = debug.spawn(tier, 540, 600);
    debug.useQuake();
    let maximumRise = 0, landedY = null;
    for (let frame = 0; frame < 900; frame++) {
      debug.step();
      if (!body.firstContact) assert.equal(body.quakeJumpCount || 0, 0, 'Falling through the air cannot launch the ball');
      if (body.quakeSupported && landedY === null) landedY = body.y;
      if (landedY !== null) maximumRise = Math.max(maximumRise, landedY - body.y);
    }
    assert.ok(audit.takeoffs.length >= 5, 'Landing enables later hops');
    heights.push(maximumRise);
  }
  assert.ok(heights[0] > 35 && heights[0] < 130, `Small ball hop: ${heights[0]}px`);
  assert.ok(heights[1] > 5 && heights[1] < heights[0] * .65, `Large balls resist Quake: ${heights}`);
});

test('contact with another ball beneath can enable Quake without touching the floor', () => {
  const { debug, audit } = game();
  const base = debug.spawn(7, 540, debug.BASE_CUP.floorY - debug.TIERS[7].diameter / 2);
  debug.step(300);
  const upper = debug.spawn(0, 540, base.y - debug.effectiveRadius(base, 0, 1) - debug.TIERS[0].diameter / 2);
  debug.step(120); debug.useQuake(); debug.step(300);
  const jump = audit.takeoffs.find(jump => jump.before.rigidbodyId === upper.rigidbodyId);
  assert.ok(jump, 'A ball resting in the pile participates');
  assert.ok(jump.before.y + debug.effectiveRadius(jump.before, 0, 1) < debug.BASE_CUP.floorY - 100,
    'The upper ball was supported by the pile, not the floor');
});

test('brushing a sloping side rail cannot count as a Quake landing', () => {
  const { debug, audit } = game();
  debug.useQuake(); debug.step(75);
  const body = debug.spawn(0, 812, 1180, { vx: 80 });
  let railContact = false, observations = 0;
  for (let frame = 0; frame < 80; frame++) {
    debug.step();
    if (body.y + debug.effectiveRadius(body, 0, 1) >= debug.BASE_CUP.floorY - 10) break;
    railContact ||= body.firstContact;
    observations++;
    assert.equal(body.quakeJumpCount || 0, 0, 'Rail contact must not kick an unsupported ball upward');
  }
  assert.ok(railContact && observations > 10, 'The falling body actually brushes the side wall');
  assert.equal(audit.takeoffs.length, 0);
});

test('Walls can be used on the first expired frame while the old walls are still retracting', () => {
  const { debug, audit, element } = game();
  debug.useWalls();
  while (debug.getState().simTime < debug.getState().cup.wallsEndsAt) debug.step();
  const before = debug.getState();
  assert.ok(audit.walls()?.to === 0 && before.cup.wallsProgress > .95, 'The previous walls just started retracting');
  assert.equal(element('wallsBtn').disabled, false, 'The remaining charge is clickable in the exact expiry step, without a later UI repaint');
  debug.useWalls();
  const after = debug.getState();
  assert.equal(after.abilityCounts.walls, 0); assert.equal(after.cup.wallsActive, true);
  assert.equal(after.cup.wallsEndsAt, after.simTime + debug.CONFIG.wallsDurationMs);
  assert.equal(audit.walls().from, before.cup.wallsProgress, 'The animation reverses continuously');
  assert.equal(audit.walls().to, 1);
  debug.useWalls(); assert.equal(debug.getState().abilityCounts.walls, 0, 'A duplicate click cannot spend another charge');
});

test('Walls stay available during a spill warning, including Snipe aim mode, and catch the falling ball', () => {
  for (const aimMode of [false, true]) {
    const { debug, element } = game();
    if (aimMode) debug.toggleSnipe();
    const body = debug.spawn(3, 154, 900, { vx: -240, vy: 280 }); body.outCandidate = true;
    debug.refreshControls(); assert.equal(element('wallsBtn').disabled, false);
    const before = { x: body.x, y: body.y };
    debug.useWalls();
    assert.equal(debug.getState().abilityCounts.walls, 1);
    assert.equal(debug.getState().snipeMode, false);
    assert.ok(body.wallAttachment, 'The warning does not prevent a pierced wall rescue');
    assert.equal(body.outCandidate, false);
    debug.step(40);
    assert.ok(Math.hypot(body.x - before.x, body.y - before.y) < .1, 'The saved ball is caught without upward ejection');
  }
});
