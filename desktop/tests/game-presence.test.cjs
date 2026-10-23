'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function harness() {
  const writes = [], updates = [], events = {}, timers = new Map(), refs = new Map(); let initializer;
  let now = 1000000;
  const App = { appPresenceNow: () => now, register(_id, init) { initializer = init; }, getUserHtmlActivity(user) { return user?.htmlActivity?.title ? user.htmlActivity : null; }, getUserActivityItems(user) { return user?.htmlActivity ? [{ kind: 'html', label: user.htmlActivity.title }] : []; }, startAppPresence() {}, stopAppPresence() {}, liveUserCache: new Map(), firebase: { database: { ServerValue: { TIMESTAMP: 'server-time' } } }, renderOnlineIndicator() {}, refreshOpenUserProfileCard() {} };
  const bridge = { enabled: [], setEnabled(value) { this.enabled.push(value); }, getSnapshot: async () => ({ games: [] }), onChange(callback) { this.changed = callback; } };
  App.db = { ref(key) {
    if (!refs.has(key)) refs.set(key, { key, set: async value => { writes.push({ key, value }); }, update: async value => { const write = { key, value }; writes.push(write); updates.push(write); }, remove: async () => { writes.push({ key, value: null }); }, onDisconnect: () => ({ remove: async () => {}, cancel: async () => {} }), on(_type, callback) { this.callback = callback; }, off() { this.callback = null; } });
    return refs.get(key);
  } };
  const schedule = (type, fn, delay) => { const id = {}; timers.set(id, {type,fn,delay});return id; };
  class Clock extends Date { static now() { return now; } }
  const context = { ChatApp: App, console, window: { chatDesktopGames: bridge, addEventListener: (name, callback) => { events[name] = callback; } }, setInterval: (fn,delay) => schedule('interval',fn,delay), clearInterval: id => timers.delete(id), setTimeout:(fn,delay)=>schedule('timeout',fn,delay), clearTimeout:id=>timers.delete(id), queueMicrotask, crypto: { randomUUID: () => 'device-session' }, Date:Clock, Map };
  context.URL = URL;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../js/chat/game-presence.js'), 'utf8'), context); initializer();
  return { App, now, writes, updates, refs, bridge, timers, events, advance:milliseconds=>{now+=milliseconds;} };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('game labels share all available mode, state, and privacy details without repeated labels', () => {
  const { App } = harness();
  const game = App.normalizeGameActivity({title:'Fortnite',experienceTitle:'Creator Island',creator:'Island Creator',mode:'Creative',state:'In Match',privacy:'Private'});
  assert.equal(App.getGameActivityLabel(game), 'Playing Creator Island on Fortnite · Creative · In Match · Private');
  assert.equal(App.getGameActivityLabel(game, {includeCreator:false}), 'Playing Creator Island on Fortnite · Creative · In Match · Private');
  assert.equal(App.getGameActivityLabel({...game, mode:'  Creative  ', state:'creative', privacy:'Private'}), 'Playing Creator Island on Fortnite · Creative · Private');
  assert.equal(App.getGameActivityLabel({...game, mode:'creator island', state:'Fortnite', privacy:''}), 'Playing Creator Island on Fortnite');
  assert.equal(App.getGameActivityLabel({title:'Roblox', experienceTitle:'Football Fusion 3 by XSTNS GAMES', creator:'XSTNS GAMES'}), 'Playing Football Fusion 3 on Roblox');
});
test('rich game metadata updates experience, creator, and image while excluding executable data', async () => {
  const h = harness(); h.App.currentUser = {code:'alice'};
  h.App.startGamePresence(); await flush(); h.refs.get('.info/connected').callback({val:()=>true}); await flush();
  const rich = {id:'roblox',title:'Roblox',experience:{name:'A community game',creator:{name:'The creators'},icon:'https://example.com/game.png'},path:'C:\\private\\game.exe',commandLine:'private'};
  h.bridge.changed({games:[rich]}); await flush();
  const game = h.writes.at(-1).value.games[0];
  assert.equal(game.experienceTitle, 'A community game'); assert.equal(game.creator, 'The creators');
  assert.equal(game.icon, 'https://example.com/game.png');
  assert.equal(h.App.getUserActivityItems(h.App.currentUser)[0].label, 'Playing A community game on Roblox');
  assert.equal(h.App.getGameActivityLabel(game, { includeCreator: true }), 'Playing A community game by The creators on Roblox');
  assert.doesNotMatch(JSON.stringify(game), /private|commandLine|path/);
  const before = h.App.getActivityPresenceRenderKey(h.App.currentUser);
  h.bridge.changed({games:[{...rich,experience:{name:'A new game',creator:{name:'Someone else'},icon:'javascript:alert(1)'}}]}); await flush();
  assert.notEqual(h.App.getActivityPresenceRenderKey(h.App.currentUser), before);
  assert.equal(h.writes.at(-1).value.games[0].icon, undefined);
  assert.equal(h.App.normalizeGameActivity({title:'Game',icon:'https://name:password@example.com/game.png'}).icon, undefined);
});
test('newer device activity wins and metadata expiration removes the complete rich entry', () => {
  const h = harness();
  const user = {gameActivitySessions:{latest:{updatedAt:h.now,games:[{title:'Roblox',experienceTitle:'Current',creator:'Group'}]},earlier:{updatedAt:h.now-1,games:[{title:'Roblox',experienceTitle:'Old'}]}}};
  assert.equal(h.App.getUserGameActivities(user)[0].experienceTitle, 'Current');
  h.advance(90000);
  assert.equal(h.App.getUserGameActivities(user).length, 0);
});
test('live multi-device games stack with multiple HTMLs and stale device records disappear', () => {
  const { App, now } = harness();
  const user = { htmlActivity: { title: 'Legacy' }, htmlActivities: { a: { updatedAt: now, items: [{ title: 'First', type: 'hub', hubId: 'a' }] }, b: { updatedAt: now, items: [{ title: 'Second', type: 'hub', hubId: 'b' }] }, stale: { updatedAt: now - 100000, items: [{ title: 'Stale' }] } }, gameActivitySessions: { desktop: { updatedAt: now, games: [{ id: 'one', title: 'Roblox' }, { id: 'two', title: 'Minecraft' }] }, duplicate: { updatedAt: now, games: [{ id: 'one', title: 'Roblox' }] }, old: { updatedAt: now - 100000, games: [{ title: 'Expired' }] } } };
  assert.deepEqual(Array.from(App.getUserActivityItems(user), item => item.label), ['Playing First', 'Playing Second', 'Playing Minecraft', 'Playing Roblox']);
  user.htmlActivities = null; assert.equal(App.getUserHtmlActivities(user)[0].title, 'Legacy');
  user.htmlActivitiesVersion = 1; assert.equal(App.getUserHtmlActivities(user).length, 0, 'closed migrated HTML sessions cannot revive legacy global presence');
});

test('unchanged game scans and lease heartbeats cause no repeated profile repaint or redundant scan writes', async () => {
  const h=harness();let renders=0;
  h.App.renderOnlineIndicator=()=>{renders++;};
  h.App.currentUser={code:'alice'};h.App.startGamePresence();await flush();
  h.refs.get('.info/connected').callback({val:()=>true});await flush();
  h.bridge.changed({games:[{id:'one',title:'Roblox'}]});await flush();
  const firstWrites=h.writes.length, firstRenders=renders;
  for(let i=0;i<60;i++){
    h.advance(1000);h.bridge.changed({games:[{id:'one',title:'Roblox'}]});
    await h.App.writeGamePresence();await flush();
  }
  assert.equal(h.writes.length-firstWrites,2,'only two 30-second lease renewals, not 60 scan writes');
  assert.deepEqual(JSON.parse(JSON.stringify(h.updates)), [
    { key: 'users/alice/gameActivitySessions/device-session', value: { updatedAt: 'server-time' } },
    { key: 'users/alice/gameActivitySessions/device-session', value: { updatedAt: 'server-time' } }
  ], 'lease renewals update only the device timestamp, without rewriting game metadata');
  assert.equal(renders,firstRenders,'timestamps do not repaint the profile/roster');
  h.bridge.changed({games:[]});await flush();
  const stopped=h.writes.length;
  h.advance(100000);await h.App.writeGamePresence();await flush();
  assert.equal(h.writes.length,stopped,'an idle account does not repeatedly write null');
  h.App.stopGamePresence();
});

test('remote activity expiration uses one deadline and does not poll/repaint an idle profile', async()=>{
  const h=harness();let renders=0;
  h.App.renderOnlineIndicator=()=>renders++;
  assert.equal(h.timers.size,0,'feature initialization starts no timer');
  const user={code:'bob',gameActivitySessions:{device:{updatedAt:h.now,games:[{id:'one',title:'Game'}]}}};
  h.App.liveUserCache.set('bob',user);h.App.observeActivityPresenceUser(user);await flush();
  assert.equal(renders,0);assert.equal(h.timers.size,1);
  const [id,expiry]=[...h.timers][0];assert.equal(expiry.type,'timeout');
  h.advance(90001);h.timers.delete(id);expiry.fn();await flush();
  assert.equal(renders,1);assert.equal(h.timers.size,0,'expired user leaves no polling timer');
  assert.equal(h.App.getUserGameActivities(user).length,0);
});
test('game presence waits for connection cleanup, heartbeats only this device, and logout stops detection', async () => {
  const h = harness(); h.App.startGamePresence(); assert.equal(h.App.gamePresenceSession, undefined);
  h.App.currentUser = { code: 'alice', gameActivitySessions: { otherPC: { updatedAt: h.now, games: [{ title: 'Other Game' }] } } };
  h.App.startGamePresence(); await flush(); assert.equal(h.bridge.enabled.at(-1), true); assert.equal(h.writes.length, 0);
  h.refs.get('.info/connected').callback({ val: () => true }); await flush();
  h.bridge.changed({ games: [{ id: 'roblox', title: 'Roblox', path: 'private' }] }); await flush();
  const write = h.writes.at(-1); assert.equal(write.key, 'users/alice/gameActivitySessions/device-session');
  assert.match(write.value.games[0].icon, /^data:image\/png;base64,/);
  const record = JSON.parse(JSON.stringify(write.value)); delete record.games[0].icon;
  assert.deepEqual(record, { games: [{ id: 'roblox', title: 'Roblox', startedAt: h.now }], updatedAt: 'server-time' });
  assert.ok(h.App.currentUser.gameActivitySessions.otherPC); assert.doesNotMatch(JSON.stringify(write), /private/);
  h.App.stopAppPresence(); await flush(); assert.equal(h.bridge.enabled.at(-1), false); assert.equal(h.App.gamePresenceSession, null); assert.equal(h.refs.get('.info/connected').callback, null); assert.ok(h.writes.every(write => write.key.endsWith('/device-session')));
  const count = h.writes.length; h.bridge.changed({ games: [{ title: 'After Logout' }] }); await flush(); assert.equal(h.writes.length, count);
});

test('platform elapsed time survives experience switches, reaches other users and resets after exit', async () => {
  const h = harness(); h.App.currentUser = { code: 'alice' }; h.App.startGamePresence(); await flush();
  h.refs.get('.info/connected').callback({ val: () => true }); await flush();
  h.bridge.changed({ games: [{ id: 'roblox', title: 'Roblox', experienceTitle: 'First' }] }); await flush();
  h.advance(65000);
  h.bridge.changed({ games: [{ id: 'roblox', title: 'Roblox', experienceTitle: 'Second' }] }); await flush();
  const game = h.writes.at(-1).value.games[0];
  assert.equal(game.startedAt, h.now); assert.equal(h.App.getActivityElapsedLabel(game.startedAt), '1:05 Elapsed');
  assert.equal(game.experienceStartedAt, h.now + 65000);
  const remote = { gameActivitySessions: { pc: { updatedAt: h.now + 65000, games: [game] } } };
  assert.equal(h.App.getUserGameActivities(remote)[0].startedAt, h.now);
  assert.equal(h.App.getUserGameActivities(remote)[0].experienceStartedAt, h.now + 65000);
  h.advance(10000);
  h.bridge.changed({ games: [{ id: 'roblox', title: 'Roblox' }] }); await flush();
  const home = h.writes.at(-1).value.games[0];
  assert.equal(home.startedAt, h.now); assert.equal(home.experienceStartedAt, undefined);
  h.bridge.changed({ games: [{ id: 'roblox', title: 'Roblox', experienceTitle: 'Second' }] }); await flush();
  assert.equal(h.writes.at(-1).value.games[0].experienceStartedAt, h.now + 75000, 'rejoining starts a fresh subgame timer');
  h.bridge.changed({ games: [] }); await flush(); h.advance(1000);
  h.bridge.changed({ games: [{ id: 'roblox', title: 'Roblox' }] }); await flush();
  assert.equal(h.writes.at(-1).value.games[0].startedAt, h.now + 76000);
  assert.equal(h.App.normalizeGameActivity({ title: 'Bad', startedAt: Infinity }).startedAt, undefined);
});
