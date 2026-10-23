/* Deterministic refresh-rate pacing, independent of a physical display. */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../activities/bopl-royale/game.js'), 'utf8');
function scheduler(frameRate = '30') {
  const state = { settings: { frameRate }, canvasSizeDirty: false };
  const start = source.indexOf('    let scheduledFrameRate=');
  const end = source.indexOf('    function gameLoop(ts)', start);
  assert(start >= 0 && end > start);
  const sandbox = { state };
  vm.runInNewContext(source.slice(start, end) + '\nthis.tick=shouldRenderFrame;', sandbox);
  return { state, tick: sandbox.tick };
}
for (const refresh of [60, 90, 120, 144, 165, 240]) {
  test(`30 FPS remains 30 on a ${refresh} Hz display without accumulating refresh rounding`, () => {
    const { tick } = scheduler();
    const frames = [];
    for (let i = 0; i < refresh * 10; i++) {
      const ts = i * 1000 / refresh;
      if (tick(ts)) frames.push(ts);
    }
    assert.equal(frames.length, 300);
    for (let i = 1; i < frames.length; i++) assert(frames[i] - frames[i - 1] <= 1000 / 30 + 1000 / refresh + .01);
  });
}
test('display-sync renders each refresh and changing caps does not cause a catch-up burst', () => {
  const { state, tick } = scheduler('unlimited');
  for (let i = 0; i < 144; i++) assert.equal(tick(i * 1000 / 144), true);
  state.settings.frameRate = '30';
  assert.equal(tick(1000), true);
  assert.equal(tick(1007), false);
  assert.equal(tick(15000), true);
  assert.equal(tick(15007), false);
});
test('a resize repaints on the next refresh without resetting the normal frame cadence', () => {
  const { state, tick } = scheduler();
  assert.equal(tick(0), true);
  state.canvasSizeDirty = true;
  assert.equal(tick(7), true);
  state.canvasSizeDirty = false;
  assert.equal(tick(14), false);
  assert.equal(tick(34), true);
});

function networkHarness() {
  const writes=[], pending=[];
  const ref={set:payload=>{writes.push({type:'set',payload});return new Promise(resolve=>pending.push(resolve));},update:payload=>{writes.push({type:'update',payload});return new Promise(resolve=>pending.push(resolve));}};
  const state={mode:'online',connected:true,phase:'battle',round:1,coordinatorId:'me',playersRef:{child:()=>ref},worldRef:ref,netWritesInFlight:0,worldWritesInFlight:0};
  const sandbox={state,me:{code:'me'}};
  const patchStart=source.indexOf('    function realtimeStatePatch('),patchEnd=source.indexOf('    function writeWorldState()',patchStart);
  const motionStart=source.indexOf('    function sendNetPayload('),motionEnd=source.indexOf('    function writeLocalState()',motionStart);
  vm.runInNewContext(source.slice(patchStart,patchEnd)+source.slice(motionStart,motionEnd)+'\nthis.sendMotion=sendNetPayload;this.sendWorld=sendWorldPayload;this.patch=realtimeStatePatch;',sandbox);
  const flush=async()=>{pending.shift()?.();await new Promise(resolve=>setImmediate(resolve));};
  return {state,writes,pending,flush,...sandbox};
}

test('game state patches preserve changed values and explicitly remove disappeared objects', () => {
  const f=networkHarness();
  const old={round:1,platforms:{a:{x:10,y:20,destroyed:false}},projectiles:{old:{x:10}}};
  const next={round:1,platforms:{a:{x:11,y:20,destroyed:false}},projectiles:{new:{x:30}}};
  const patch=JSON.parse(JSON.stringify(f.patch(old,next)));
  assert.deepEqual(patch,{'platforms/a/x':11,'projectiles/old':null,'projectiles/new':{x:30}});
  assert.ok(JSON.stringify(patch).length<JSON.stringify(next).length);
});

test('motion publishing coalesces slow writes to the latest frame and safely publishes reversals', async () => {
  const f=networkHarness();
  f.sendMotion({x:10,y:20,alive:true,netSeq:1});
  f.sendMotion({x:15,y:20,alive:true,netSeq:2});
  f.sendMotion({x:10,y:25,alive:true,netSeq:3});
  assert.equal(f.writes.length,1,'at most one state write is pending');
  await f.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes[1].payload)),{y:25,netSeq:3},'newest frame is compared with the acknowledged state');
  await f.flush();
  f.state.connected=false;f.sendMotion({x:100,y:100,netSeq:4});
  assert.equal(f.writes.length,2,'offline movement creates no queued Firebase writes');
});

test('world publishing sends only changing leaves after the initial snapshot and resets for a new round', async () => {
  const f=networkHarness();
  f.sendWorld({round:1,worldSeq:1,platforms:{a:{x:10,y:20}},projectiles:{a:{x:2}}}); await f.flush();
  f.sendWorld({round:1,worldSeq:2,platforms:{a:{x:11,y:20}},projectiles:{}});
  assert.equal(f.writes[1].type,'update');
  assert.deepEqual(JSON.parse(JSON.stringify(f.writes[1].payload)),{worldSeq:2,'platforms/a/x':11,'projectiles/a':null}); await f.flush();
  f.state.round=2;f.sendWorld({round:2,worldSeq:1,platforms:{}});
  assert.equal(f.writes[2].type,'set','new rounds replace obsolete world state'); await f.flush();
});
