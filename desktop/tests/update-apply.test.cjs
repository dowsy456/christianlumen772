'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const applySource = source.slice(source.indexOf('async function applyPendingUpdate()'), source.indexOf('async function boot()'));
function fixture(state = {}, draft = '') {
  const loaded = [], notices = [];
  const renderer = vm.createContext({ ChatApp:state, document:{querySelector:() => ({value:draft})} }); renderer.window = renderer;
  const context = vm.createContext({ pendingCandidate:{dir:'new'}, currentCandidate:{dir:'old'}, booting:false, mainWindow:{},
    appView:{webContents:{isDestroyed:() => false, executeJavaScript: async text => vm.runInContext(text,renderer)}},
    loadCandidate:async candidate => loaded.push(candidate.dir), dialog:{showMessageBox:async (_win, value) => notices.push(value)}, writeLog:() => {} });
  vm.runInContext(applySource,context);
  return {context,loaded,notices};
}
test('update protects active and paused recordings, unsent preview audio, calls, drafts and queued sends', async () => {
  for (const state of [{voiceRecorder:{state:'recording'}},{voiceRecorder:{state:'paused'}},{voicePreviewBlob:{}},{voiceRecorderStream:{}},{currentCallRoomId:'room'},{pendingSendCount:1},{pendingPoll:{question:'Unsent poll'}},{activeFirebaseUploads:new Map([['one',{}]])},{pendingFiles:[{}]}]) {
    const h = fixture(state); await h.context.applyPendingUpdate(); assert.equal(h.loaded.length,0); assert.equal(h.notices.length,1); assert.equal(h.context.booting,false);
  }
  const draft = fixture({},'unsent text'); await draft.context.applyPendingUpdate(); assert.equal(draft.loaded.length,0);
  const ready = fixture(); await ready.context.applyPendingUpdate(); assert.deepEqual(ready.loaded,['new']);
});
test('rapid update clicks perform only one renderer replacement while its busy check is pending', async () => {
  const h = fixture(); let release;
  h.context.appView.webContents.executeJavaScript = () => new Promise(resolve => {release=resolve;});
  const first = h.context.applyPendingUpdate(), second = h.context.applyPendingUpdate();
  assert.equal(h.context.booting,true); release(false); await Promise.all([first,second]);
  assert.deepEqual(h.loaded,['new']); assert.equal(h.context.booting,false);
});
test('portable production packaging closes native debug entry points while retaining shared web updates', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).build;
  assert.equal(config.asar, true);
  assert.deepEqual(config.win.target, [{ target: 'dir', arch: ['x64'] }]);
  assert.equal(config.portable.artifactName, 'Chat App.exe');
  const launcher = require('../scripts/benchmark-games.cjs').PORTABLE_SOURCE;
  assert.match(launcher, /Environment\.Is64BitProcess/);
  assert.match(launcher, /ZipArchive\(payload, ZipArchiveMode.Read\)/);
  assert.match(launcher, /UseShellExecute = false/);
  assert.doesNotMatch(launcher, /powershell|cmd\.exe|Process\.Start\([^s]|VirtualAlloc|CreateRemoteThread|ReadProcessMemory/i);
  assert.deepEqual(config.electronFuses, {
    runAsNode:false, enableNodeOptionsEnvironmentVariable:false, enableNodeCliInspectArguments:false,
    enableEmbeddedAsarIntegrityValidation:true, onlyLoadAppFromAsar:true
  });
  assert.ok(config.asarUnpack.includes('helpers/*.exe'), 'fixed native helpers remain executable without extracting JavaScript');
  assert.ok(config.extraResources.some(resource => resource.to === 'bundled-app'), 'shared web source keeps its normal external bundle and GitHub update path');
  assert.match(source, /createContentHandler\(\(\) => activeRoot, net\)/);
  const games = fs.readFileSync(path.join(__dirname, '../games.cjs'), 'utf8');
  assert.match(games, /node:worker_threads/);
  for (const entry of fs.readdirSync(path.join(__dirname, '..'))) {
    if (!entry.endsWith('.cjs')) continue;
    const runtime = fs.readFileSync(path.join(__dirname, '..', entry), 'utf8');
    assert.doesNotMatch(runtime, /(?:child_process\.fork|\bfork\s*\(|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|--inspect(?:-brk)?)/, entry + ' must not depend on disabled production debug entry points');
    assert.doesNotMatch(runtime, /nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/, entry + ' must retain sandboxed renderers');
  }
});
test('inspector-based native QA refuses shipping executables before loading Playwright', () => {
  const integration = fs.readFileSync(path.join(__dirname, 'release-native.electron.cjs'), 'utf8');
  for (const option of ['CHAT_APP_TEST_EXECUTABLE', 'CHAT_APP_TEST_EXE']) {
    assert.throws(() => vm.runInNewContext(integration, { process:{env:{[option]:'Chat App.exe'}} }), /Packaged Chat App must use an ordinary launch smoke check/);
  }
});
test('required native download opens HTTPS then exits without tray or unload prevention', async () => {
  const events = [], context = vm.createContext({ captureCaller: event => event.trusted, quittingForUpdate: false, quitting: false, backgroundRunning: true, URL,
    shell: { openExternal: async url => events.push(['open', url]) }, tray: { destroy: () => events.push(['tray']) },
    spotifyConnection: null, gameActivity: null, ringPopups: null, callOverlay: null, app: { exit: code => events.push(['exit', code]) } });
  vm.runInContext(source.slice(source.indexOf('async function openUpdateAndQuit('), source.indexOf('function fitContent()')), context);
  assert.equal(await context.openUpdateAndQuit({}, 'https://example.test/update'), false);
  assert.equal(await context.openUpdateAndQuit({ trusted: true }, 'file:///app.exe'), false);
  assert.deepEqual(events, []);
  await context.openUpdateAndQuit({ trusted: true }, 'https://example.test/update');
  assert.deepEqual(events, [['open', 'https://example.test/update'], ['tray'], ['exit', 0]]);
  assert.equal(context.backgroundRunning, false); assert.equal(context.quittingForUpdate, true);
});
