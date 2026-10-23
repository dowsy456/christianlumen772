/* User-facing movement and rendering regressions for the September 11 update. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function game() {
  const elements = new Map(), scales = [];
  const drawing = new Proxy({
    scale: (x, y) => scales.push([x, y]),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} })
  }, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => (target[key] = value, true) });
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const node = {
      hidden: false, style: { setProperty() {} }, dataset: {}, textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getContext: () => drawing, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }),
      setAttribute() {}, querySelector: selector => element(String(id) + selector), querySelectorAll: () => [],
      appendChild() {}, focus() {}, setPointerCapture() {}, releasePointerCapture() {},
      addEventListener: (name, fn) => listeners.set(name, fn),
      dispatch: (name, event = {}) => listeners.get(name)?.({ isPrimary: true, button: 0, pointerId: 1, clientX: 540, clientY: 315, ...event })
    };
    elements.set(id, node); return node;
  }
  const window = { setTimeout() {}, clearTimeout() {}, addEventListener() {}, localStorage: { getItem: () => null, setItem() {} } }; window.parent = window;
  const filename = process.env.MERGE_PARTY_GAME || path.join(__dirname, '../activities/merge-party/game.js');
  const source = fs.readFileSync(filename, 'utf8').replace('window.__mergeParty={',
    'window.__updateAudit={draw:body=>drawBall(ctx,body)};\nwindow.__mergeParty={');
  vm.runInNewContext(source, {
    window, document: { getElementById: element, createElement: tag => element(Symbol(tag)), querySelectorAll: () => [] },
    navigator: {}, performance: { now: () => 0 }, Date: class extends Date { static now() { return 12345678; } },
    requestAnimationFrame() {}, setTimeout, clearTimeout, console
  }, { filename });
  const debug = window.__mergeParty.debug; debug.start();
  return { debug, canvas: element('gameCanvas'), draw: body => { scales.length = 0; window.__updateAudit.draw(body); return scales.map(scale => [...scale]); } };
}
const radius = (debug, tier) => debug.TIERS[tier].diameter / 2;
const extent = (debug, body) => debug.effectiveRadius(body, 0, 1);

// The supplied 30 fps videos imply roughly 650 px/s² at the 1080 px world width.
test('a normal placement accelerates promptly and reaches contact without a launch spike', () => {
  const { debug } = game(); debug.getState().currentEntry.logicalTier = 3;
  assert.equal(debug.drop(), true);
  const bodyId = debug.getState().balls[0].rigidbodyId;
  let firstContactAt = null, maximumSpeed = 0, maximumCompression = 0;
  for (let frame = 0; frame < 240; frame++) {
    debug.step();
    const body = debug.getState().balls.find(item => item.rigidbodyId === bodyId);
    assert.ok(body && !body.dead);
    maximumSpeed = Math.max(maximumSpeed, Math.hypot(body.vx, body.vy));
    maximumCompression = Math.max(maximumCompression, body.squeezeY || 0);
    if (body.firstContact && firstContactAt === null) firstContactAt = (frame + 1) / 60;
    assert.ok(body.y + extent(debug, body) <= debug.BASE_CUP.floorY + 1, 'The deformed collider remains above the floor');
  }
  assert.ok(firstContactAt >= 1.7 && firstContactAt <= 1.95, `Release-to-floor time follows the measured reference fall (${firstContactAt}s)`);
  assert.ok(maximumSpeed > 1000 && maximumSpeed <= 1250, `Drop accelerates naturally to the reference landing speed (${maximumSpeed})`);
  assert.ok(maximumCompression > .07, `The landing visibly squashes a Red (${maximumCompression})`);
});

test('a Red cannot remain balanced on either skinny wall cap without supporting balls', () => {
  for (const side of [-1, 1]) {
    const { debug } = game(), cup = debug.BASE_CUP;
    const slope = (cup.topWidth - cup.floorWidth) / (2 * cup.wallHeight);
    const capX = 540 + side * (cup.topWidth / 2 + debug.CONFIG.railRadius / Math.hypot(1, slope));
    const capY = cup.floorY - cup.wallHeight - debug.CONFIG.railRadius * slope / Math.hypot(1, slope);
    const body = debug.spawn(3, capX - side * 2, capY - debug.CONFIG.railRadius - radius(debug, 3) - 30);
    let firstContact = false, contactFrames = 0, maximumFirstReaction = 0, previousVx = body.vx;
    for (let frame = 0; frame < 240; frame++) {
      debug.step();
      if (body.firstContact) firstContact = true;
      if (firstContact) {
        contactFrames++;
        if (contactFrames < 8) maximumFirstReaction = Math.max(maximumFirstReaction, Math.abs(body.vx - previousVx));
      }
      previousVx = body.vx;
      assert.equal(body.wallAttachment, null, 'An ordinary wall cap cannot pin the Red');
    }
    assert.ok(contactFrames > 100, 'The placement actually reaches the cap');
    assert.ok(Math.abs(body.x - capX) > radius(debug, 3) * .65 || body.y > capY + radius(debug, 3),
      `Side ${side}: the unsupported Red rolls away from the thin cap`);
    assert.ok(maximumFirstReaction < 100, `Side ${side}: rolling starts without a horizontal catapult (${maximumFirstReaction})`);
  }
});

test('resting balls retain a circular outline without displacing their support', () => {
  const { debug, draw } = game();
  const body = debug.spawn(0, 540, debug.BASE_CUP.floorY - radius(debug, 0)); debug.step(300);
  const before = { x: body.x, y: body.y }, widths = [], heights = [];
  for (let sample = 0; sample < 24; sample++) {
    debug.step(5);
    const shape = draw(body)[0]; assert.ok(shape, 'Ball drawing applies its visible proportions');
    widths.push(shape[0]); heights.push(shape[1]);
    assert.ok(Math.hypot(body.x - before.x, body.y - before.y) < 1, 'Breathing keeps floor support stable');
    assert.ok(body.y + extent(debug, body) <= debug.BASE_CUP.floorY + .7);
  }
  for (let i = 0; i < widths.length; i++) {
    assert.ok(Math.abs(widths[i] - heights[i]) < .04, 'Idle facial animation leaves the outline circular');
    assert.ok(Math.abs(widths[i] - 1) < .04 && Math.abs(heights[i] - 1) < .04, 'A ball is not permanently squashed by its own weight');
  }
});

function quakeMotion(tier) {
  const { debug } = game(); const body = debug.spawn(tier, 540, debug.BASE_CUP.floorY - radius(debug, tier)); debug.step(240);
  const rest = { x: body.x, y: body.y }; debug.useQuake();
  let floorFrames = 0, rise = 0, peakSpeed = 0, maxHorizontalChange = 0, distance = 0, vx = body.vx, x = body.x;
  for (let frame = 0; frame < 900; frame++) {
    debug.step();
    if (Math.abs(body.y + extent(debug, body) - debug.BASE_CUP.floorY) < 5) floorFrames++;
    rise = Math.max(rise, rest.y - body.y); peakSpeed = Math.max(peakSpeed, Math.hypot(body.vx, body.vy));
    maxHorizontalChange = Math.max(maxHorizontalChange, Math.abs(body.vx - vx)); distance += Math.abs(body.x - x); vx = body.vx; x = body.x;
    assert.equal(debug.getState().runState, 'playing');
    assert.ok(Number.isFinite(body.x + body.y + body.vx + body.vy));
  }
  debug.step(2); assert.equal(debug.getState().cup.quake, null, 'Quake ends after fifteen seconds');
  debug.step(300); assert.ok(Math.hypot(body.vx, body.vy) < 2, 'The ball settles again after Quake');
  return { floorFrames, rise, peakSpeed, maxHorizontalChange, distance };
}

test('Quake makes bounded hops with recovery between landings and respects ball mass', () => {
  const small = quakeMotion(0), large = quakeMotion(7);
  for (const motion of [small, large]) {
    assert.ok(motion.floorFrames >= 360, `At least 40% of Quake allows floor contact and recovery (${motion.floorFrames}/900)`);
    assert.ok(motion.rise > 5 && motion.rise < 130, `Quake creates useful bounded hops (${motion.rise}px rise)`);
    assert.ok(motion.peakSpeed < 560, `Hop speed stays bounded (${motion.peakSpeed})`);
    assert.ok(motion.maxHorizontalChange < 250, `Randomized takeoffs cannot fling the ball sideways (${motion.maxHorizontalChange})`);
    assert.ok(motion.distance > 25, `Quake creates useful actual motion (${motion.distance}px)`);
  }
  assert.ok(large.rise < small.rise * .65, `A large ball jumps less (${large.rise}px vs ${small.rise}px)`);
  assert.ok(large.distance < small.distance * .8, `A large ball resists the same shake (${large.distance}px vs ${small.distance}px)`);
});

test('a crowded mixed pile remains finite and contained through sustained physics and Quake', () => {
  const { debug } = game();
  const tiers = [0, 1, 2, 3, 4, 5];
  for (let i = 0; i < 24; i++) debug.spawn(tiers[i % tiers.length], 320 + (i % 3) * 205, 1200 - Math.floor(i / 3) * 180);
  debug.step(300); debug.useQuake();
  for (let frame = 0; frame < 960; frame++) {
    debug.step();
    for (const body of debug.getState().balls.filter(body => !body.dead)) {
      assert.ok(Number.isFinite(body.x + body.y + body.vx + body.vy + body.squeezeX + body.squeezeY));
      assert.ok(Math.hypot(body.vx, body.vy) <= debug.CONFIG.maxSpeed + 5, 'Crowding cannot exceed the velocity budget');
      if (body.x > 290 && body.x < 790 && !body.outCandidate) assert.ok(body.y + extent(debug, body) <= debug.BASE_CUP.floorY + 6, 'A crowded supported body cannot pass through the floor');
    }
  }
});

test('strong sideways bulges collide and merge when their deformed outlines touch', () => {
  const { debug } = game();
  const r = radius(debug, 0);
  const left = debug.spawn(0, 460, 700), right = debug.spawn(0, 460 + r * 2 * 1.14, 700);
  left.squeezeY = right.squeezeY = debug.TIERS[0].squish;
  assert.ok(debug.pairGeometry(left, right).separation < 0, 'The squashed outlines physically overlap');
  debug.step();
  assert.ok(debug.getState().contacts.length > 0, 'Conservative collision bounds keep strongly deformed contact');
  debug.step(18);
  const live = debug.getState().balls.filter(body => !body.dead);
  assert.equal(live.length, 1); assert.equal(live[0].logicalTier, 1, 'The touching soft outlines complete an ordinary merge');
});

test('full-height Red drops at far pointer positions roll into the cup instead of sticking on its caps', () => {
  for (const clientX of [-2400, 3500]) {
    const { debug, canvas } = game(); debug.getState().currentEntry.logicalTier = 3;
    canvas.dispatch('pointerdown', { clientX, clientY: 400 });
    canvas.dispatch('pointerup', { clientX, clientY: 400 });
    const state = debug.getState(); assert.equal(state.balls.length, 1, 'The normal pointer gesture commits one drop');
    const id = state.balls[0].rigidbodyId;
    assert.equal(state.balls[0].y, 315, 'The test uses the actual held release height');
    let firstContactFrame = null, firstContactX = null, body;
    for (let frame = 0; frame < 360; frame++) {
      debug.step(); body = debug.getState().balls.find(item => item.rigidbodyId === id);
      assert.ok(body && !body.dead); assert.equal(body.outCandidate, false, 'The clamped inside lane directs a release into the cup');
      assert.equal(debug.getState().runState, 'playing');
      if (body.firstContact && firstContactFrame === null) { firstContactFrame = frame; firstContactX = body.x; }
      if (firstContactFrame !== null && frame - firstContactFrame >= 180) break;
    }
    assert.ok(firstContactFrame !== null, 'The full descent makes actual contact');
    assert.ok(Math.abs(body.x - firstContactX) > body.radius * .65, 'The ball moves away from the unsupported cap after landing');
    assert.ok(body.y > debug.BASE_CUP.floorY - debug.BASE_CUP.wallHeight + body.radius, 'The Red actually descends inside the cup');
    assert.ok(body.onSurface || body.sleeping, 'The final position has real supporting contact');
  }
});

test('two touching pinned balls merge with finite motion despite zero inverse mass', () => {
  const { debug } = game();
  const a = debug.spawn(0, 140, 880), b = debug.spawn(0, 170, 950); debug.useWalls();
  assert.ok(a.wallAttachment && b.wallAttachment, 'Both bodies are embedded in the newly raised material');
  debug.step(30);
  const live = debug.getState().balls.filter(body => !body.dead);
  assert.equal(live.length, 1); assert.equal(live[0].logicalTier, 1);
  assert.ok(live[0].wallAttachment, 'A merge along the wall remains embedded');
  for (let frame = 0; frame < 90; frame++) {
    debug.step();
    const body = debug.getState().balls.find(body => !body.dead);
    assert.ok(Number.isFinite(body.x + body.y + body.vx + body.vy + body.omega + body.squeezeX + body.squeezeY));
  }
});

test('a pin near the original cap returns to ordinary supported cup physics after expiry', () => {
  const { debug } = game(); const body = debug.spawn(0, 220, 970); debug.useWalls();
  assert.ok(body.wallAttachment); debug.step(1822);
  assert.equal(body.wallAttachment, null, 'Retraction releases material near the original cap');
  for (let frame = 0; frame < 360; frame++) {
    debug.step();
    assert.ok(Number.isFinite(body.x + body.y + body.vx + body.vy));
    assert.equal(body.outCandidate, false, 'An inward release stays in the cup');
    assert.ok(body.y + extent(debug, body) <= debug.BASE_CUP.floorY + 1);
  }
  assert.equal(debug.getState().runState, 'playing');
  assert.ok(body.onSurface || body.sleeping, 'The original cup provides normal support again');
  assert.ok(Math.abs(body.y + extent(debug, body) - debug.BASE_CUP.floorY) < 1);
});
