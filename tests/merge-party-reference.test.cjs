/* Behavioral regressions for the supplied Merge Party reference and bug reports. */
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
    'window.__comboAudit={step:physicsStep,effects:()=>effects};\nwindow.__mergeParty={');
  vm.runInNewContext(source, {
    window,
    document: { getElementById: element, createElement: tag => element(Symbol(tag)), querySelectorAll: () => [] },
    navigator: {}, performance: { now: () => 0 },
    Date: class extends Date { static now() { return 12345678; } },
    requestAnimationFrame() {}, setTimeout, clearTimeout, console
  }, { filename });
  const debug = window.__mergeParty.debug;
  debug.start();
  return { debug, controller: window.__mergeParty, canvas: element('gameCanvas'),
    stepMs: ms => window.__comboAudit.step(ms / 1000), effects: window.__comboAudit.effects };
}

const radius = (debug, tier) => debug.TIERS[tier].diameter / 2;
const live = debug => debug.getState().balls.filter(body => !body.dead);
const extentY = (debug, body) => debug.effectiveRadius(body, 0, 1);

function advanceTo(g, time) {
  while (time - g.debug.getState().simTime > 1e-8) {
    g.stepMs(Math.min(1000 / 60, time - g.debug.getState().simTime));
  }
}

function beginCombo(g) {
  const r = radius(g.debug, 0);
  g.debug.spawn(0, 540 - r, g.debug.BASE_CUP.floorY - r);
  g.debug.spawn(0, 540 + r, g.debug.BASE_CUP.floorY - r);
  for (let frame = 0; frame < 30 && !g.debug.getState().activeCombo; frame++) g.debug.step();
  assert.equal(g.debug.getState().activeCombo?.ordinal, 1, 'A physical merge opens the combo');
  return g.debug.getState().activeCombo.lastMergeAt;
}

test('the rounded wall top supports a ball before it penetrates the painted rim', () => {
  for (const side of [-1, 1]) {
    const { debug } = game();
    const cup = debug.getState().cup;
    const rimX = 540 + side * cup.topWidth / 2;
    const rimY = cup.floorY - cup.wallHeight;
    const ball = debug.spawn(0, rimX, rimY - radius(debug, 0) - 40);
    debug.step(12);
    assert.ok(ball.y + extentY(debug, ball) < rimY - 8,
      `Side ${side}: the visible cap arrests the fall above the old zero-width endpoint`);
    assert.equal(ball.outCandidate, false, 'Touching the rim is not itself a spill');
    assert.equal(debug.getState().runState, 'playing');
  }
});

test('placement reaches the wall for every direct tier and preserves an edge margin', () => {
  for (const tier of [0, 1, 2, 3]) {
    const { debug, canvas } = game();
    debug.getState().currentEntry.logicalTier = tier;
    const cup = debug.getState().cup;
    const rimX = 540 + cup.topWidth / 2;
    canvas.dispatch('pointermove', { clientX: 1080, clientY: 500 });
    const aim = debug.getState().aimX;
    assert.ok(aim >= rimX - 24,
      `Tier ${tier}: ball center can overlap the inner portion of the wall (${aim})`);
    assert.ok(aim < rimX + 44, 'The clamp preserves a margin before the outside tip of the painted rim');
    canvas.dispatch('pointermove', { clientX: 0, clientY: 500 });
    assert.ok(Math.abs(debug.getState().aimX - (1080 - aim)) < .01,
      'Left and right wall access are symmetric');
  }
});

test('dropping in either inner wall lane rolls into the cup without sticking to its cap', () => {
  for (const side of [-1, 1]) for (const tier of [0, 3]) {
    const { debug, canvas } = game();
    debug.getState().currentEntry.logicalTier = tier;
    canvas.dispatch('pointermove', { clientX: side < 0 ? 0 : 1080, clientY: 500 });
    const aim = debug.getState().aimX;
    assert.equal(debug.drop(), true, `Tier ${tier}: the wall lane accepts a real drop`);
    const bodyId = live(debug)[0].rigidbodyId;
    let touchedRim = false;
    for (let frame = 0; frame < 360; frame++) {
      debug.step();
      const body = live(debug).find(item => item.rigidbodyId === bodyId);
      assert.ok(body, 'The dropped ball remains live');
      assert.equal(body.outCandidate, false,
        `Side ${side}, tier ${tier}, frame ${frame}: aiming above the rim is not a spill`);
      assert.equal(debug.getState().runState, 'playing');
      touchedRim ||= body.firstContact;
    }
    const body = live(debug).find(item => item.rigidbodyId === bodyId);
    assert.ok(touchedRim, 'The drop actually reaches the physical wall');
    assert.ok(side * (body.x - aim) < -radius(debug, tier) * .65,
      'The inner lane rolls away from the narrow cap into the cup');
    assert.ok(body.y > debug.BASE_CUP.floorY - debug.BASE_CUP.wallHeight + radius(debug, tier),
      'Ordinary rim contact never permanently suspends the ball');
    assert.ok(body.onSurface || body.sleeping, 'The placement remains physically supported');
  }
});

test('a fast outside strike below the rounded cap cannot teleport through the rail', () => {
  for (const side of [-1, 1]) {
    const { debug } = game();
    const cup = debug.getState().cup;
    const slope = (cup.topWidth - cup.floorWidth) / (2 * cup.wallHeight);
    const length = Math.hypot(1, slope);
    const railRadius = debug.CONFIG.railRadius || 29;
    const capX = 540 + side * (cup.topWidth / 2 + railRadius / length);
    const capY = cup.floorY - cup.wallHeight + railRadius * slope / length;
    const body = debug.spawn(0, capX + side * (radius(debug, 0) + railRadius + 12), capY + 20,
      { vx: -side * 1400, vy: 320 });
    for (let frame = 0; frame < 15; frame++) {
      const before = { x: body.x, y: body.y };
      debug.step();
      const innerWallX = 540 + side * (cup.topWidth / 2 -
        slope * (body.y - (cup.floorY - cup.wallHeight)));
      assert.ok(side * (body.x - innerWallX) > radius(debug, 0) * .5,
        'An outside underside strike stays on the outside face');
      assert.ok(Math.hypot(body.x - before.x, body.y - before.y) < debug.CONFIG.maxSpeed / 60 + 5,
        'Cap contact resolves locally without snapping across the full wall');
      assert.ok(Number.isFinite(body.x) && Number.isFinite(body.y));
    }
  }
});

test('wall placement expands after a Double Rainbow without another pointer movement', () => {
  const { debug, canvas } = game();
  debug.getState().currentEntry.logicalTier = 0;
  canvas.dispatch('pointermove', { clientX: 1080, clientY: 500 });
  const before = debug.getState();
  const r = radius(debug, 7);
  debug.spawn(7, 540 - r, 480);
  debug.spawn(7, 540 + r, 480);
  debug.step(60);
  const after = debug.getState();
  assert.equal(after.cup.growthCount, 1);
  assert.ok(after.cup.topWidth > before.cup.topWidth);
  assert.ok(after.aimX > before.aimX + 10,
    'A stationary pointer follows the outward movement of the cup rim');
  assert.ok(after.aimX >= 540 + after.cup.topWidth / 2 - 24,
    'The newly grown wall remains reachable');
});

test('first airborne contact fixes relative motion while the bonded pair keeps falling', () => {
  const { debug } = game();
  const r = radius(debug, 0);
  const a = debug.spawn(0, 480, 400, { vx: 100, vy: 300 });
  const b = debug.spawn(0, 480 + r * 2, 400, { vx: -100, vy: -120 });
  debug.step();
  assert.equal(live(debug).length, 2, 'The short merge animation retains both parents');
  assert.equal(debug.getState().contacts.length, 1, 'The first contact commits one pair');
  const bonded = { dx: b.x - a.x, dy: b.y - a.y, centerY: (a.y + b.y) / 2 };
  assert.ok(Math.hypot(a.vx - b.vx, a.vy - b.vy) < 2,
    'Touching matches immediately share translation, including tangent velocity');
  debug.step(3);
  assert.ok(Math.hypot(b.x - a.x - bonded.dx, b.y - a.y - bonded.dy) < 1,
    'The pair cannot orbit or slide around its contact during the hold');
  assert.ok((a.y + b.y) / 2 > bonded.centerY + 4,
    'Bonding fixes the parents to one another while gravity moves their center');
  debug.step(24);
  assert.equal(live(debug).length, 1);
  assert.equal(live(debug)[0].logicalTier, 1);
  assert.equal(live(debug)[0].collisionEnabled, true);
});

test('a falling continuation beyond 800 ms starts a fresh combo even with the same action ID', () => {
  const { debug } = game();
  const floor = debug.BASE_CUP.floorY;
  const r = radius(debug, 0);
  debug.spawn(0, 420, floor - r, { comboActionId: 42 });
  debug.spawn(0, 420 + 2 * r, floor - r, { comboActionId: 42 });
  debug.spawn(1, 700, floor - radius(debug, 1), { comboActionId: 42 });
  debug.spawn(1, 700, 200, { comboActionId: 42 });
  let ordinal = 0;
  let firstMergeAt = null;
  let secondMergeAt = null;
  for (let frame = 0; frame < 240; frame++) {
    debug.step();
    const state = debug.getState();
    if (state.activeCombo?.ordinal >= 1 && firstMergeAt === null) firstMergeAt = state.simTime;
    if (live(debug).some(body => body.logicalTier === 2) && secondMergeAt === null) secondMergeAt = state.simTime;
    ordinal = Math.max(ordinal, state.activeCombo?.ordinal || 0);
  }
  assert.ok(firstMergeAt !== null && secondMergeAt !== null, 'Both physical merges completed');
  assert.ok(secondMergeAt - firstMergeAt > 800, 'The continuation exercises a real delayed cascade');
  assert.equal(ordinal, 1, 'An old action ID or falling ball cannot keep the expired chain alive');
  assert.equal(debug.getState().runScore, 30, 'The two independent combos bank 10 + 20 points');
});

test('combo expires at exactly 800 ms of deterministic play time and banks its score once', () => {
  const g = game();
  const mergedAt = beginCombo(g);
  advanceTo(g, mergedAt + 799.999);
  assert.equal(g.debug.getState().activeCombo?.ordinal, 1, 'The combo remains live just before its deadline');
  assert.equal(g.debug.getState().runScore, 0);
  advanceTo(g, mergedAt + 800);
  assert.equal(g.debug.getState().activeCombo, null, 'The combo closes on its 800 ms boundary');
  assert.equal(g.debug.getState().runScore, 10);
  assert.ok(!g.effects().some(effect => effect.type === 'combo-label'), 'An expired multiplier is no longer drawn');
  g.debug.step(120);
  assert.equal(g.debug.getState().runScore, 10, 'Subsequent simulation cannot bank it twice');
});

test('dropping a nonmatching ball near expiry does not refresh the combo', () => {
  const g = game();
  const mergedAt = beginCombo(g);
  advanceTo(g, mergedAt + 650);
  g.debug.getState().currentEntry.logicalTier = 3;
  assert.equal(g.debug.drop(), true, 'The test performs a real player drop');
  const dropped = live(g.debug).find(body => body.logicalTier === 3);
  assert.equal(g.debug.getState().activeCombo.lastMergeAt, mergedAt, 'Drop does not change the successful-merge timestamp');
  advanceTo(g, mergedAt + 800);
  assert.equal(g.debug.getState().activeCombo, null);
  assert.equal(g.debug.getState().runScore, 10);
  assert.ok(live(g.debug).find(body => body.rigidbodyId === dropped.rigidbodyId).vy > g.debug.CONFIG.gravity * .15 * .95,
    'The dropped ball is still falling when the previous combo expires');
});

test('a successful merge before expiry extends the combo for 800 ms from that merge', () => {
  const g = game();
  const firstMergeAt = beginCombo(g);
  advanceTo(g, firstMergeAt + 400);
  const r = radius(g.debug, 2);
  g.debug.spawn(2, 540 - r, 500);
  g.debug.spawn(2, 540 + r, 500);
  for (let frame = 0; frame < 30 && g.debug.getState().activeCombo?.ordinal !== 2; frame++) g.debug.step();
  assert.equal(g.debug.getState().activeCombo?.ordinal, 2);
  const secondMergeAt = g.debug.getState().activeCombo.lastMergeAt;
  assert.ok(secondMergeAt > firstMergeAt && secondMergeAt < firstMergeAt + 800);
  advanceTo(g, firstMergeAt + 800);
  assert.equal(g.debug.getState().activeCombo?.ordinal, 2, 'The first merge deadline has been replaced');
  advanceTo(g, secondMergeAt + 799.999);
  assert.equal(g.debug.getState().activeCombo?.ordinal, 2);
  advanceTo(g, secondMergeAt + 800);
  assert.equal(g.debug.getState().activeCombo, null);
  assert.equal(g.debug.getState().runScore, 90, 'The successful second merge earns its x2 multiplier');
});

test('ongoing Quake and a pending matching contact do not postpone combo expiry', () => {
  for (const obstruction of ['quake', 'contact']) {
    const g = game();
    const mergedAt = beginCombo(g);
    advanceTo(g, mergedAt + 700);
    if (obstruction === 'quake') g.debug.useQuake();
    else {
      const r = radius(g.debug, 2);
      g.debug.spawn(2, 540 - r, 500);
      g.debug.spawn(2, 540 + r, 500);
    }
    advanceTo(g, mergedAt + 800);
    const expired = g.debug.getState();
    assert.ok(obstruction === 'quake' ? expired.cup.quake : expired.contacts.length,
      `${obstruction} remains in progress at the deadline`);
    assert.equal(expired.activeCombo, null, `${obstruction} cannot extend a combo without a successful merge`);
    assert.equal(expired.runScore, 10);
    if (obstruction === 'contact') {
      g.debug.step(10);
      assert.equal(g.debug.getState().activeCombo?.ordinal, 1, 'The pending pair starts a new combo when it succeeds');
    }
  }
});

test('pausing preserves the remaining combo window until the run resumes', () => {
  const g = game();
  const mergedAt = beginCombo(g);
  advanceTo(g, mergedAt + 799);
  const before = g.debug.getState().simTime;
  assert.equal(g.controller.pauseActivity(), true);
  g.stepMs(600000);
  assert.equal(g.debug.getState().simTime, before);
  assert.equal(g.debug.getState().activeCombo?.ordinal, 1);
  g.controller.resumeView();
  g.debug.step(60);
  assert.equal(g.debug.getState().simTime, before, 'Reopening a paused run does not resume its clock');
  g.controller.resumeActivity();
  advanceTo(g, mergedAt + 799.999);
  assert.equal(g.debug.getState().activeCombo?.ordinal, 1);
  advanceTo(g, mergedAt + 800);
  assert.equal(g.debug.getState().activeCombo, null);
  assert.equal(g.debug.getState().runScore, 10);
});

test('Quake keeps useful bounded hopping throughout its fifteen seconds', () => {
  const { debug } = game();
  const ball = debug.spawn(1, 540, debug.BASE_CUP.floorY - radius(debug, 1));
  debug.step(180); const restY = ball.y; debug.useQuake();
  assert.equal(debug.getState().abilityCounts.quake, 1);
  let maximumRise = 0, earlyMotion = 0, lateMotion = 0, lastX = ball.x;
  for (let frame = 0; frame < 899; frame++) {
    debug.step();
    maximumRise = Math.max(maximumRise, restY - ball.y);
    if (frame < 120) earlyMotion += Math.abs(ball.x - lastX);
    if (frame > 720) lateMotion += Math.abs(ball.x - lastX);
    lastX = ball.x;
  }
  assert.ok(debug.getState().cup.quake, 'Quake stays active just before fifteen seconds');
  assert.ok(maximumRise > 20 && maximumRise < 130, `The ball makes useful bounded hops (${maximumRise}px)`);
  assert.ok(ball.quakeJumpCount >= 6, 'The ball can hop again after making supporting contact');
  assert.ok(earlyMotion > 1 && lateMotion > 1, 'Useful agitation continues through the ability');
  assert.equal(debug.getState().runState, 'playing');
  debug.step(2); assert.equal(debug.getState().cup.quake, null);
});

test('Quake closes nearby gaps and produces useful physical merges', () => {
  for (const gap of [8, 12]) {
    const { debug } = game(); const r = radius(debug, 0), floor = debug.BASE_CUP.floorY;
    debug.spawn(0, 480 - r - gap / 2, floor - r);
    debug.spawn(0, 480 + r + gap / 2, floor - r);
    debug.step(240);
    assert.equal(live(debug).length, 2, 'The settled matching pair starts with a real gap');
    assert.ok(debug.pairGeometry(...live(debug)).separation > .5, 'No contact exists before Quake');
    debug.useQuake(); debug.step(1000);
    assert.equal(debug.getState().runState, 'playing');
    assert.equal(live(debug).length, 1, 'Agitation reunites the nearby pair');
    assert.equal(live(debug)[0].logicalTier, 1, 'Physical contact creates the normal merged tier');
  }
});

test('a precise crown placement moves gently while a loose placement can still roll away', () => {
  function escape(offset) {
    const { debug } = game();
    const red = debug.spawn(3, 540, debug.BASE_CUP.floorY - radius(debug, 3));
    const sum = red.radius + radius(debug, 0);
    const blue = debug.spawn(0, red.x + offset, red.y - Math.sqrt(sum * sum - offset * offset));
    let firstSecondMotion = 0;
    for (let frame = 1; frame <= 720; frame++) {
      debug.step();
      if (frame === 60) firstSecondMotion = Math.abs(blue.x - red.x - offset);
      if (Math.abs(blue.x - red.x) > sum * .55) return { seconds: frame / 60, firstSecondMotion };
    }
    return { seconds: Infinity, firstSecondMotion };
  }
  const precise = escape(5);
  const loose = escape(35);
  assert.ok(precise.seconds >= 2, `A precise crown lasts long enough to react (${precise.seconds}s)`);
  assert.ok(precise.firstSecondMotion > .01, 'Support damping does not artificially freeze the placement');
  assert.ok(Number.isFinite(loose.seconds) && loose.seconds < precise.seconds,
    'Off-centre placement retains a real chance of falling');
});

test('merging a Red obstruction releases both Pinks into the next merge', () => {
  const { debug } = game();
  const lower = debug.spawn(2, 500, debug.BASE_CUP.floorY - radius(debug, 2));
  const middle = debug.spawn(3, 500, lower.y - lower.radius - radius(debug, 3));
  const upper = debug.spawn(2, 500, middle.y - middle.radius - radius(debug, 2));
  debug.step(180);
  const upperStart = upper.y;
  const offset = 190;
  debug.spawn(3, middle.x + offset,
    middle.y - Math.sqrt(4 * middle.radius * middle.radius - offset * offset));
  debug.step(360);
  const remaining = live(debug);
  assert.equal(remaining.filter(body => body.logicalTier === 2).length, 0,
    'The separated Pink pair becomes free to touch and merge');
  assert.equal(remaining.filter(body => body.logicalTier === 3).length, 1);
  assert.equal(remaining.filter(body => body.logicalTier === 4).length, 1);
  assert.ok(upper.dead || upper.y > upperStart + upper.radius,
    'The upper Pink responds to the changed support');
  assert.equal(debug.getState().runState, 'playing');
});
