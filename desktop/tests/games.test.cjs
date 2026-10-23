'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { detectGames, publicGameMetadata, parseSteamManifest, readInstalledGames, parseRobloxActivity, createRobloxActivityReader, createGameEnricher, createGameActivity, createProcessScanner, createThreadedProcessScanner } = require('../games.cjs');
test('installed Steam games match actual running executables, not launchers or adjacent paths', () => {
  const game = parseSteamManifest('"AppState" { "appid" "105600" "name" "Terraria" "installdir" "Terraria" }', 'D:\\Steam');
  assert.deepEqual(game, { id: 'steam:105600', title: 'Terraria', dir: 'D:\\Steam\\steamapps\\common\\Terraria' });
  assert.equal(parseSteamManifest('"appid" "1" "name" "Bad" "installdir" "..\\outside"', 'D:\\Steam'), null);
  const processes = [
    { name: 'steam.exe', path: 'D:\\Steam\\steam.exe', visible: true },
    { name: 'launcher.exe', path: game.dir + '\\launcher.exe', visible: true },
    { name: 'crashhelper.exe', path: game.dir + '\\crashhelper.exe', visible: true },
    { name: 'other.exe', path: game.dir + '-fake\\game.exe', visible: true },
    { name: 'unlisted.exe', path: game.dir + '\\unlisted.exe', visible: false },
  ];
  assert.deepEqual(detectGames(processes, [game]), []);
  processes.push({ name: 'actual-game.exe', path: game.dir + '\\bin\\actual-game.exe', visible: true });
  assert.deepEqual(detectGames(processes, [game]), [{ id: 'steam:105600', title: 'Terraria' }]);
});
test('known games and Java Minecraft coexist, deduplicate and never expose paths or command lines', () => {
  const result = detectGames([
    { name: 'RobloxPlayerBeta.exe', path: 'C:\\private\\Roblox.exe' }, { name: 'RobloxPlayerBeta.exe' },
    { name: 'javaw.exe', commandLine: 'javaw.exe -cp client.jar net.minecraft.client.main.Main --accessToken PRIVATE' },
    { name: 'javaw.exe', commandLine: 'javaw.exe -jar unrelated.jar' }, { name: 'RiotClientServices.exe' },
  ], []);
  assert.deepEqual(result.map(game => game.title), ['Minecraft', 'Roblox']);
  assert.ok(result.every(game => Object.keys(game).every(key => ['id', 'title', 'icon'].includes(key))));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private|commandLine/);
});
test('native game scanning accepts only its trusted main frame and drops async results after logout/navigation', async () => {
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const mainWindow = new EventEmitter(), timers = { setInterval: () => 1, clearInterval() {} };
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'chatapp://app/index.html' }, getURL: () => 'chatapp://app/index.html', isDestroyed: () => false, sent: [], send(channel, state) { this.sent.push({ channel, state }); } });
  let resolveProcesses, requests = 0;
  const controller = createGameActivity({ ipcMain, mainWindow, timers, platform: 'win32', getInstalls: async () => [], getProcesses: () => { ++requests; return new Promise(resolve => { resolveProcesses = resolve; }); } });
  controller.bindContents(contents);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  ipcMain.emit('chat-games:enabled', { ...event, senderFrame: { url: event.senderFrame.url } }, true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 0);
  ipcMain.emit('chat-games:enabled', event, true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 1);
  ipcMain.emit('chat-games:enabled', event, false);
  resolveProcesses([{ name: 'robloxplayerbeta.exe' }]);
  await new Promise(resolve => setImmediate(resolve)); assert.ok(contents.sent.every(message => message.state.games.length === 0), 'late game snapshots never restore a signed-out user');
  contents.emit('did-start-navigation', {}, 'chatapp://app/index.html', false, true);
  ipcMain.emit('chat-games:enabled', event, true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 1);
  controller.destroy(); assert.equal(ipcMain.listenerCount('chat-games:enabled'), 0);
});

test('one hidden helper serves repeated process snapshots and stops immediately on logout', async () => {
  const children = [];
  function spawnProcess(command, args, options) {
    assert.match(command, /helpers[\\/]game-process-helper\.exe$/); assert.equal(options.windowsHide, true);
    assert.deepEqual(args, [], 'Only a fixed packaged executable is launched');
    assert.notEqual(options.shell, true);
    const child = new EventEmitter(); children.push(child);
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} }); child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { destroy() { this.destroyed = true; }, write(line) {
      const request = JSON.parse(line);
      if (!request.id) { assert.ok(request.names.includes('robloxplayerbeta.exe')); return; }
      const value = JSON.stringify({ id: request.id, processes: [{ name: 'robloxplayerbeta.exe', path: 'C:\\private\\game.exe' }], scanMs: 3 }) + '\n';
      // Stream framing must survive a JSON response split across reads.
      queueMicrotask(() => { child.stdout.emit('data', value.slice(0, 15)); child.stdout.emit('data', value.slice(15)); });
    } });
    child.kill = () => { child.killed = true; child.emit('exit'); };
    return child;
  }
  const scanner = createProcessScanner({ spawnProcess, access: async () => {} });
  for (let i = 0; i < 12; i++) assert.equal((await scanner.read())[0].name, 'robloxplayerbeta.exe');
  assert.equal(children.length, 1, 'twelve scans share one fixed native helper');
  assert.equal(scanner.getDiagnostics().scanMs, 3);
  scanner.stop(); assert.equal(children[0].killed, true); assert.equal(children[0].stdin.destroyed, true);
  await scanner.read(); assert.equal(children.length, 2, 'only a later session restarts the helper'); scanner.stop();
});

test('cancelling scanner startup cannot leak a helper after logout', async () => {
  let finishRead, spawns = 0;
  const scanner = createProcessScanner({ access: () => new Promise(resolve => { finishRead = resolve; }), spawnProcess: () => { ++spawns; } });
  const pending = scanner.read(); scanner.stop(); finishRead();
  await assert.rejects(pending, /stopped/); assert.equal(spawns, 0);
});

test('packaged helper uses only visible-process limited information without memory access or runtime compilation', () => {
  const source = require('../scripts/benchmark-games.cjs').HELPER_SOURCE;
  assert.doesNotMatch(source, /Add-Type|Invoke-Expression|FromBase64String|ExecutionPolicy|ReadProcessMemory|WriteProcessMemory|VirtualAlloc|CreateRemoteThread|PROCESS_VM_|PROCESS_ALL_ACCESS|SeDebugPrivilege|AdjustTokenPrivileges|DebugActiveProcess/i);
  assert.match(source, /process\.MainWindowHandle/);
  assert.doesNotMatch(source, /process\.(?:MainModule|StartTime)/);
  assert.match(source, /PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;/);
  assert.equal((source.match(/OpenProcess\(PROCESS_QUERY_LIMITED_INFORMATION, false, process\.Id\)/g) || []).length, 1);
  assert.deepEqual([...source.matchAll(/private static extern \w+ (\w+)\(/g)].map(match => match[1]).sort(), ['CloseHandle', 'GetClassLongPtr', 'GetProcessTimes', 'OpenProcess', 'QueryFullProcessImageName', 'SendMessageTimeout']);
  assert.match(source, /SendMessageTimeout\(window, 0x7F, new IntPtr\(1\), IntPtr.Zero, 2, 40, out icon\)/, 'icon requests use WM_GETICON and a 40ms timeout');
  assert.match(source, /finally \{ if \(handle != IntPtr.Zero\) CloseHandle\(handle\); \}/);
  const visibilityGuard = source.indexOf('if (!visible) continue;');
  assert.ok(visibilityGuard > 0 && visibilityGuard < source.indexOf('OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION'));
  assert.ok(visibilityGuard < source.indexOf('java && IsMinecraft(process.Id)'));
  assert.match(source, /\{ "commandLine", "" \}/, 'JVM arguments never leave the classification function');
  assert.match(source, /Convert.ToDouble\(entry\["startedAt"\]\) != startedAt/, 'cached metadata is invalidated when a PID is reused');
  const runtime = require('node:fs').readFileSync(require('node:path').join(__dirname, '../games.cjs'), 'utf8');
  assert.doesNotMatch(runtime, /spawnProcess\(['"](?:powershell|pwsh|cmd)|csc\.exe|-Command|-EncodedCommand|\.ps1['"]/i);
});

test('concurrent scans share one request; a blocked helper cannot automatically respawn', async () => {
  let spawns = 0, child, requests = 0;
  const scanner = createProcessScanner({ access: async () => {}, spawnProcess() {
    ++spawns; child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} }); child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { destroy() {}, write(line) { if (JSON.parse(line).id) ++requests; } });
    child.kill = () => { child.killed = true; child.emit('exit'); };
    return child;
  } });
  const first = scanner.read(), second = scanner.read();
  assert.equal(first, second);
  const rejected = assert.rejects(first, /blocked/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1); child.emit('error', new Error('blocked'));
  await rejected; assert.equal(child.killed, true); assert.equal(scanner.getDiagnostics().failed, true);
  for (let i = 0; i < 12; i++) await assert.rejects(scanner.read(), /blocked/);
  assert.equal(spawns, 1);
  scanner.stop();
  const next = scanner.read(); const stopped = assert.rejects(next, /stopped/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(spawns, 2);
  scanner.stop(); await stopped;
});

test('unresponsive helpers time out once without a timer-driven restart', async () => {
  let timeout, child, spawns = 0, timeoutMs;
  const scanner = createProcessScanner({ access: async () => {}, timers: { setTimeout(fn, ms) { timeout = fn; timeoutMs = ms; return 1; }, clearTimeout() {} }, spawnProcess() {
    ++spawns; child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} }); child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { destroy() {}, write() {} });
    child.kill = () => { child.killed = true; child.emit('exit'); };
    return child;
  } });
  const pending = scanner.read(); const rejected = assert.rejects(pending, /timed out/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(timeoutMs, 60000, 'A first native launch allows bounded OS inspection time');
  timeout(); await rejected;
  assert.equal(child.killed, true); await assert.rejects(scanner.read(), /timed out/); assert.equal(spawns, 1);
  scanner.stop();
});

test('failed game activity pauses polling for its session and can recover after explicit re-enable', async () => {
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const mainWindow = new EventEmitter(); let tick, scans = 0, failed = false, cleared = 0;
  const timers = { setInterval(fn) { tick = fn; return 1; }, clearInterval() { ++cleared; } };
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'chatapp://app/index.html' }, getURL: () => 'chatapp://app/index.html', isDestroyed: () => false, sent: [], send(channel, state) { this.sent.push({ channel, state }); } });
  const controller = createGameActivity({ ipcMain, mainWindow, timers, platform: 'win32', getInstalls: async () => [], getProcesses: async () => { ++scans; if (failed) throw new Error('blocked'); return [{ name: 'robloxplayerbeta.exe' }]; } });
  controller.bindContents(contents); const event = { sender: contents, senderFrame: contents.mainFrame };
  ipcMain.emit('chat-games:enabled', event, true); await new Promise(resolve => setImmediate(resolve));
  failed = true; await tick(); const clearCount = cleared;
  assert.deepEqual(contents.sent.at(-1).state.games, []);
  for (let i = 0; i < 12; i++) await tick();
  ipcMain.emit('chat-games:enabled', event, true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 2); assert.equal(cleared, clearCount);
  ipcMain.emit('chat-games:enabled', event, false); failed = false;
  ipcMain.emit('chat-games:enabled', event, true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scans, 3); assert.equal(contents.sent.at(-1).state.games[0].title, 'Roblox');
  controller.destroy();
});

test('steady game snapshots cause no repeat renderer IPC and leaving a game publishes once', async () => {
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const mainWindow = new EventEmitter(); let tick, processes = [{ name: 'robloxplayerbeta.exe' }], installationReads = 0;
  const timers = { setInterval(fn) { tick = fn; return 1; }, clearInterval() {} };
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'chatapp://app/index.html' }, getURL: () => 'chatapp://app/index.html', isDestroyed: () => false, sent: [], send(channel, state) { this.sent.push({ channel, state }); } });
  const controller = createGameActivity({ ipcMain, mainWindow, timers, platform: 'win32', getInstalls: async () => { ++installationReads; return []; }, getProcesses: async () => processes });
  controller.bindContents(contents); ipcMain.emit('chat-games:enabled', { sender: contents, senderFrame: contents.mainFrame }, true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(contents.sent.length, 1);
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(contents.sent.length, 1); assert.equal(installationReads, 1);
  processes = []; await tick(); assert.equal(contents.sent.length, 2); assert.deepEqual(contents.sent.at(-1).state.games, []);
  await tick(); assert.equal(contents.sent.length, 2); controller.destroy();
});

test('native scanner worker isolates cold startup, coalesces reads and restores the shorter warm timeout', async () => {
  let worker, spawns = 0; const delays = [], requests = [];
  const scanner = createThreadedProcessScanner({
    timers: { setTimeout(fn, delay) { delays.push(delay); return { unref() {} }; }, clearTimeout() {} },
    makeWorker() { spawns++; worker = Object.assign(new EventEmitter(), { postMessage: value => requests.push(value), terminate: async () => {} }); return worker; }
  });
  const first = scanner.read(); assert.equal(scanner.read(), first);
  assert.equal(delays[0], 60000); assert.equal(spawns, 1);
  worker.emit('message', { id: requests[0].id, processes: [{ name: 'robloxplayerbeta.exe' }], scanMs: 7 });
  assert.equal((await first)[0].name, 'robloxplayerbeta.exe');
  const second = scanner.read(); assert.equal(delays[1], 12000); assert.equal(spawns, 1);
  const stopped = assert.rejects(second, /stopped/); scanner.stop(); await stopped;
  assert.equal(requests.at(-1).stop, true); assert.equal(scanner.getDiagnostics().running, false);
});

test('Roblox log parsing requires a real confirmed join and clears disconnects without exposing private log fields', () => {
  const joining = "2026-10-05T12:00:00Z [FLog::Output] ! Joining game 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' place 123 at 10.0.0.1\n";
  const load = '2026-10-05T12:00:01Z [FLog::GameJoinLoadTime] Report game_join_loadtime: placeid:123, universeid:456, userid:PRIVATE\n';
  const joined = '2026-10-05T12:00:02Z [FLog::Network] Replicator created: 10.0.0.1\n';
  assert.deepEqual(parseRobloxActivity(joining + load), { placeId: '123', confirmed: false, universeId: '456' });
  const actual = parseRobloxActivity(joining + load + joined);
  assert.deepEqual(actual, { placeId: '123', confirmed: true, universeId: '456' });
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE|10\.0\.0|aaaaaaaa/);
  assert.equal(parseRobloxActivity('[FLog::CreatorOutput] fake [FLog::Output] ! Joining game \'abc\' place 999 at x\n'), null);
  assert.equal(parseRobloxActivity('[FLog::Network] Time to disconnect replication data: 1\n', actual), null);
  assert.equal(parseRobloxActivity('[FLog::SingleSurfaceApp] leaveUGCGameInternal\n', actual), null);
});

test('Roblox reader binds logs to one live process, streams bounded chunks and tracks leave events incrementally', async () => {
  let log = 'x'.repeat(300000) + "\n[FLog::Output] ! Joining game 'aaa-bbb' place 123 at 10.0.0.1\n[FLog::Network] Replicator created: x\n";
  let birthtimeMs = 1000; const reads = [];
  const reader = createRobloxActivityReader({ environment: { LOCALAPPDATA: 'C:\\Private' },
    readdir: async () => [{ name: 'v_20261005T120000_Player_aaa.log', isFile: () => true }],
    stat: async () => ({ birthtimeMs, mtimeMs: 2000, size: Buffer.byteLength(log) }),
    open: async (_path, flags) => { assert.equal(flags, 'r'); return { read: async (buffer, at, length, position) => {
      reads.push({ length, position }); const bytes = Buffer.from(log).subarray(position, position + length); bytes.copy(buffer, at); return { bytesRead: bytes.length };
    }, close: async () => {} }; }
  });
  const processes = [{ name: 'RobloxPlayerBeta.exe', pid: 42, startedAt: 1000 }];
  assert.equal((await reader(processes)).placeId, '123');
  assert.ok(reads.every(read => read.length <= 262144)); assert.equal(reads[0].position, 0);
  const initialReads = reads.length;
  await reader(processes); assert.equal(reads.length, initialReads, 'An unchanged file is not reread');
  log += '[FLog::Network] Time to disconnect replication data: 1\n';
  assert.equal(await reader(processes), null);
  assert.ok(reads.at(-1).length < 100);
  birthtimeMs = 0; processes[0].startedAt = 100000;
  assert.equal(await reader(processes), null, 'A previous launch cannot masquerade as the current game');
  assert.equal(await reader([...processes, { ...processes[0], pid: 43 }]), null, 'Ambiguous simultaneous players do not guess an experience');
});

test('Roblox enrichment resolves official metadata, caches it and publishes only public title creator and icon', async () => {
  const urls = []; let place = '123';
  const enrich = createGameEnricher({ readRobloxActivity: async () => place ? { placeId: place } : null, fetchJSON: async url => {
    urls.push(url);
    if (url.includes('/places/')) return { universeId: 456 };
    if (url.includes('thumbnails.')) return { data: [{ targetId: 456, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/public-icon.png' }] };
    return { data: [{ id: 456, name: 'A Roblox Experience', creator: { type: 'Group', name: 'A Creator Group' }, privateField: 'PRIVATE' }] };
  } });
  const base = [{ id: 'game:roblox', title: 'Roblox' }];
  const first = await enrich(base, [{ name: 'RobloxPlayerBeta.exe', commandLine: 'PRIVATE' }]);
  assert.equal(first[0].experienceTitle, 'A Roblox Experience'); assert.equal(first[0].creator, 'A Creator Group');
  assert.equal(first[0].icon, 'https://tr.rbxcdn.com/public-icon.png'); assert.match(first[0].platformIcon, /^data:image\/png;base64,/);
  assert.equal(urls.length, 3); await enrich(base, []); assert.equal(urls.length, 3);
  assert.ok(urls.every(url => /^https:\/\/(?:apis|games|thumbnails)\.roblox\.com\//.test(url)));
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|commandLine/);
  place = null; const home = await enrich(base, []); assert.equal(home[0].experienceTitle, undefined, 'Returning to the Roblox home app clears experience data'); assert.match(home[0].icon, /^data:image\/png;base64,/);
});

test('generic provider metadata uses the same public fields without accepting unsafe image URLs', () => {
  const result = detectGames([{ name: 'minecraft.windows.exe', gameActivity: { experience: { name: 'A community server', creator: 'Its creator', icon: 'https://example.com/server.png' }, commandLine: 'PRIVATE' } }], []);
  assert.equal(result[0].experienceTitle, 'A community server'); assert.equal(result[0].creator, 'Its creator');
  assert.equal(result[0].icon, 'https://example.com/server.png'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(publicGameMetadata({ title: 'Game', icon: 'javascript:alert(1)' }).icon, undefined);
});

test('late Roblox HTTP metadata cannot resurrect a game after the process exits', async () => {
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const mainWindow = new EventEmitter(); let tick, finish, processes = [{ name: 'robloxplayerbeta.exe' }];
  const timers = { setInterval(fn, delay) { tick = fn; assert.equal(delay, 3000); return 1; }, clearInterval() {} };
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'chatapp://app/index.html' }, getURL: () => 'chatapp://app/index.html', isDestroyed: () => false, sent: [], send(channel, state) { this.sent.push({ channel, state }); } });
  const controller = createGameActivity({ ipcMain, mainWindow, timers, platform: 'win32', getInstalls: async () => [], getProcesses: async () => processes,
    enrichGames: games => games.length ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([]) });
  controller.bindContents(contents); ipcMain.emit('chat-games:enabled', { sender: contents, senderFrame: contents.mainFrame }, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contents.sent.at(-1).state.games[0].title, 'Roblox', 'Base game appears before HTTP finishes');
  processes = []; await tick();
  finish([{ title: 'Roblox', experienceTitle: 'Old experience' }]); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(contents.sent.at(-1).state.games, []); controller.destroy();
});

test('known games and Minecraft running only in a tray/background process are absent', () => {
  const processes = [{ name: 'RobloxPlayerBeta.exe', visible: false }, { name: 'minecraft.windows.exe', visible: false }, { name: 'javaw.exe', visible: false, commandLine: 'net.minecraft.client.main.Main' }];
  assert.deepEqual(detectGames(processes, []), []);
  processes[0].visible = true;
  assert.deepEqual(detectGames(processes, []).map(game => game.title), ['Roblox']);
});

test('Roblox reader ignores newer crash logs and hidden duplicate players, including long current sessions', async () => {
  const log = "[FLog::Output] ! Joining game 'aaa-bbb' place 123 at address\n[FLog::Network] Replicator created: x\n" + '[FLog::Output] ordinary output\n'.repeat(20000);
  const opened = [];
  const reader = createRobloxActivityReader({ environment: { LOCALAPPDATA: 'C:\\Private' },
    readdir: async () => ['v_Player_game.log', 'v_Player_game_CrashHandler_last.log'].map(name => ({ name, isFile: () => true })),
    stat: async file => ({ birthtimeMs: file.includes('CrashHandler') ? 1100 : 1000, mtimeMs: 2000, size: Buffer.byteLength(log) }),
    open: async file => { opened.push(file); return { read: async (buffer, at, length, position) => { const bytes = Buffer.from(log).subarray(position, position + length); bytes.copy(buffer, at); return { bytesRead: bytes.length }; }, close: async () => {} }; }
  });
  const result = await reader([{ name: 'RobloxPlayerBeta.exe', pid: 42, startedAt: 1000, visible: true }, { name: 'RobloxPlayerBeta.exe', pid: 43, startedAt: 900, visible: false }]);
  assert.equal(result.placeId, '123'); assert.equal(opened.length, 1); assert.doesNotMatch(opened[0], /CrashHandler/);
  assert.equal(await reader([{ name: 'RobloxPlayerBeta.exe', pid: 42, startedAt: 1000, visible: false }]), null);
});

test('Minecraft uses its grass block artwork and never a JVM or launcher executable icon', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=', files = [];
  const enrich = createGameEnricher({ readRobloxActivity: async () => null, getFileIcon: async file => { files.push(file); return { toDataURL: () => png }; } });
  const processes = [{ name: 'minecraft.windows.exe', path: 'C:\\private\\Minecraft.exe', visible: true }];
  const base = detectGames(processes, []);
  const first = await enrich(base, processes); assert.match(first[0].icon, /^data:image\/png;base64,/); assert.notEqual(first[0].icon, png);
  const rich = await enrich([{ ...base[0], experienceTitle: 'Server', creator: 'Creator', icon: 'https://example.com/server.png' }], processes);
  assert.equal(rich[0].icon, 'https://example.com/server.png'); assert.equal(rich[0].platformIcon, first[0].icon); assert.equal(files.length, 0);
  assert.doesNotMatch(JSON.stringify(rich), /private|path|commandLine/);
  assert.equal(publicGameMetadata({ title: 'Bad', icon: 'data:image/svg+xml,<svg onload="bad"/>' }).icon, undefined);
});

test('Minecraft uses the helpers private classification without returning JVM arguments', () => {
  const result = detectGames([{ name: 'javaw.exe', visible: true, isMinecraft: true, commandLine: '' }, { name: 'java.exe', visible: true, isMinecraft: false, commandLine: '' }], []);
  assert.deepEqual(result.map(game => game.title), ['Minecraft']);
  assert.doesNotMatch(JSON.stringify(result), /commandLine|isMinecraft/);
});

test('Steam discovery shares one fixed registry read while refreshing installed game manifests', async () => {
  let queries = 0, installed = 1;
  const run = async (program, args, options) => {
    ++queries;
    assert.equal(program, 'C:\\Windows\\System32\\reg.exe');
    assert.deepEqual(args, ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    assert.equal(options.windowsHide, true); assert.notEqual(options.shell, true);
    return { stdout: 'SteamPath    REG_SZ    D:\\Games\\Steam' };
  };
  const options = { run, environment: { SystemRoot: 'C:\\Windows' },
    readdir: async directory => directory === 'D:\\Games\\Steam\\steamapps' ? Array.from({ length: installed }, (_, index) => `appmanifest_${index + 1}.acf`) : [],
    readFile: async filename => { if (!filename.endsWith('.acf')) throw Error('not present'); const id = /appmanifest_(\d+)/.exec(filename)[1]; return `"appid" "${id}" "name" "Game ${id}" "installdir" "Game${id}"`; }
  };
  const first = await Promise.all([readInstalledGames(options), readInstalledGames(options)]);
  assert.equal(first[0].length, 1); assert.equal(queries, 1);
  installed = 2; assert.equal((await readInstalledGames(options)).length, 2); assert.equal(queries, 1);
});

test('a failed Steam registry lookup is cached instead of repeatedly launching a blocked child', async () => {
  let queries = 0;
  const options = { run: async () => { ++queries; throw Error('blocked'); }, readdir: async () => [], readFile: async () => { throw Error('not present'); } };
  for (let i = 0; i < 3; i++) await readInstalledGames(options);
  assert.equal(queries, 1);
});

test('a game returning after an absent visible snapshot resets its elapsed session without hidden-process inspection', async () => {
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const mainWindow = new EventEmitter(); let tick;
  const process = { name: 'RobloxPlayerBeta.exe', pid: 42, startedAt: 1000, visible: true };
  let processes = [process];
  const timers = { setInterval(fn) { tick = fn; return 1; }, clearInterval() {} };
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'chatapp://app/index.html' }, getURL: () => 'chatapp://app/index.html', isDestroyed: () => false, sent: [], send(_channel, state) { this.sent.push(state); } });
  const controller = createGameActivity({ ipcMain, mainWindow, timers, platform: 'win32', getInstalls: async () => [], getProcesses: async () => processes, enrichGames: async games => games });
  controller.bindContents(contents); ipcMain.emit('chat-games:enabled', { sender: contents, senderFrame: contents.mainFrame }, true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(contents.sent.at(-1).games[0].startedAt, 1000);
  processes = []; await tick(); await tick();
  processes = [process]; await tick(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(contents.sent.at(-1).games[0].startedAt > 1000, 'time spent closed in the tray is not included on reopening');
  controller.destroy();
});

test('global catalog recognizes an uninstalled game without a machine-specific list', () => {
  const game = detectGames([{name:'hades.exe', path:'Z:\\portable\\Hades\\x64\\Hades.exe', visible:true}], []);
  assert.ok(game.some(item => /Hades/i.test(item.title)));
  assert.ok(game.every(item => !('path' in item)));
});
test('ambiguous catalog process names require their precise published suffix', () => {
  const {compileGameCatalog,catalogGame} = require('../games.cjs');
  const catalog = compileGameCatalog([
    ['123456','Game A','a'.repeat(32),'game-a/game.exe'],
    ['234567','Game B','b'.repeat(32),'game-b/game.exe'],
    ['345678','Single','c'.repeat(32),'single.exe']
  ]);
  assert.equal(catalogGame({name:'game.exe',path:'C:\\other\\game.exe'},catalog),null);
  assert.equal(catalogGame({name:'game.exe',path:'C:\\games\\game-b\\game.exe'},catalog).title,'Game B');
  assert.equal(catalogGame({name:'single.exe'},catalog).title,'Single');
});
test('Dawn and Feather Minecraft clients retain canonical artwork and never disclose JVM tokens', () => {
  const result = detectGames([{name:'javaw.exe', isMinecraft:true, minecraftClient:'Dawn Client', commandLine:'PRIVATE'}, {name:'feather.exe'}],[]);
  assert.equal(result.length,1); assert.equal(result[0].title,'Minecraft');
  assert.match(result[0].experienceTitle,/Client/); assert.match(result[0].icon,/^data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|commandLine/);
});
test('Fortnite state is never invented from its process name and verified provider fields survive', () => {
  const base=detectGames([{name:'fortniteclient-win64-shipping.exe'}],[])[0];
  assert.equal(base.state,undefined); assert.equal(base.privacy,undefined);
  const rich=detectGames([{name:'fortniteclient-win64-shipping.exe',gameActivity:{mode:'Creative',state:'In lobby',privacy:'Private',experienceTitle:'Creator Island',creator:'Island Author'}}],[])[0];
  assert.equal(rich.mode,'Creative'); assert.equal(rich.state,'In lobby'); assert.equal(rich.privacy,'Private'); assert.equal(rich.creator,'Island Author');
});

test('unchanged rich experience artwork is retained between scans without alternating base icons', async () => {
  const ipcMain=new EventEmitter();ipcMain.handle=()=>{};ipcMain.removeHandler=()=>{};
  const mainWindow=new EventEmitter();let tick;
  const contents=Object.assign(new EventEmitter(),{mainFrame:{url:'chatapp://app/index.html'},getURL:()=> 'chatapp://app/index.html',isDestroyed:()=>false,sent:[],send(_channel,state){this.sent.push(state);}});
  const controller=createGameActivity({ipcMain,mainWindow,platform:'win32',timers:{setInterval(fn){tick=fn;return 1},clearInterval(){}},getProcesses:async()=>[{name:'robloxplayerbeta.exe'}],getInstalls:async()=>[],enrichGames:async games=>games.map(game=>({...game,experienceTitle:'Experience',creator:'Creator',icon:'https://example.com/icon.png',platformIcon:'https://example.com/platform.png'}))});
  controller.bindContents(contents);ipcMain.emit('chat-games:enabled',{sender:contents,senderFrame:contents.mainFrame},true);
  await new Promise(resolve=>setImmediate(resolve));const count=contents.sent.length;
  for(let i=0;i<12;i++){await tick();await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(contents.sent.length,count);assert.equal(contents.sent.at(-1).games[0].experienceTitle,'Experience');controller.destroy();
});

test('Dawn replaces Java window icons with the shared launcher artwork and Minecraft platform badge', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const processes = [{ name: 'javaw.exe', path: 'C:\\Java\\javaw.exe', isMinecraft: true, minecraftClient: 'Dawn Client', icon: png }, { name: 'feather.exe' }];
  const enrich = createGameEnricher({ getFileIcon: async () => { throw Error('Never read JVM artwork'); }, readRobloxActivity: async () => null });
  const games = await enrich(detectGames(processes, []), processes);
  assert.equal(games.length, 1); assert.equal(games[0].experienceTitle, 'Dawn Client');
  assert.notEqual(games[0].icon, png); assert.notEqual(games[0].platformIcon, png);
  assert.notEqual(games[0].icon, games[0].platformIcon);
  assert.equal(games[0].icon, publicGameMetadata({title:'Minecraft', experienceTitle:'Dawn Client'}).icon);
  assert.doesNotMatch(JSON.stringify(games), /Java|path|commandLine/);
});

test('Minecraft client artwork accepts checked window art or its own launcher, never generic JVM or a different client', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const java = {name:'javaw.exe',path:'C:\\Runtime\\javaw.exe',isMinecraft:true,minecraftClient:'Lunar Client',icon:png};
  assert.notEqual(detectGames([java],[])[0].icon,png,'unchecked JVM window icons are discarded');
  assert.equal(detectGames([{...java,clientIcon:png}],[])[0].icon,png,'helper-checked custom client artwork survives');
  const files=[];
  const enrich=createGameEnricher({readRobloxActivity:async()=>null,getFileIcon:async file=>{files.push(file);return png;}});
  const wrong=[java,{name:'feather.exe',path:'C:\\Feather\\feather.exe'}];
  const result=await enrich(detectGames([java],[]),wrong);
  assert.equal(files.length,0);assert.notEqual(result[0].icon,png,'Feather is not used as Lunar artwork');
});
test('FNF engines, renamed mods and standalone indie executables are detected without ambiguous game.exe matching', () => {
  for (const name of ['Funkin.exe', 'PsychEngine.exe', 'FNF-SillyBilly.exe', 'Codename Engine.exe']) assert.match(detectGames([{ name }], [])[0].title, /Friday Night Funkin/);
  assert.match(detectGames([{ name:'renamed.exe', path:'C:\\Games\\Friday Night Funkin Mods\\Whitty\\renamed.exe' }], [])[0].title, /Friday Night Funkin/);
  assert.equal(detectGames([{ name:'whitty.exe', isFridayNightFunkin:true, gameTitle:"Friday Night Funkin': VS Whitty" }], [])[0].experienceTitle, 'VS Whitty');
  assert.equal(detectGames([{name:'PsychEngine.exe'}], [])[0].experienceTitle, 'Psych Engine');
  assert.equal(detectGames([{name:'ULTRAKILL.exe'}], [])[0].title, 'ULTRAKILL');
  assert.equal(detectGames([{name:'totally-private.exe'}], []).length, 0);
  assert.equal(detectGames([{name:'chrome.exe', gameTitle:'Psych Engine downloads'}], []).length, 0, 'an unrelated title alone is not a native game classification');
});

test('FNF manifests enrich only the active named mod, cache bounded reads, and never expose paths', async () => {
  const {createFnfMetadataReader} = require('../games.cjs');
  const files = new Map([
    ['C:\\PRIVATE\\mods\\whitty\\pack.json', JSON.stringify({name:'VS Whitty', author:'Whitty Team', description:'PRIVATE'})],
    ['C:\\PRIVATE\\mods\\unplayed\\_polymod_meta.json', JSON.stringify({title:'Unplayed Mod', contributors:[{name:'Other Team'}]})]
  ]);
  let reads = 0;
  const read = createFnfMetadataReader({
    stat: async file => {if(!files.has(file)) throw Error('missing'); return {isFile:()=>true,size:files.get(file).length};},
    readFile: async file => {++reads; if(!files.has(file))throw Error('missing');return files.get(file);},
    readdir: async () => ['whitty','unplayed'].map(name=>({name,isDirectory:()=>true,isSymbolicLink:()=>false}))
  });
  const processes = [{name:'renamed.exe',path:'C:\\PRIVATE\\renamed.exe',isFridayNightFunkin:true,gameTitle:"Friday Night Funkin': VS Whitty"}];
  const base = detectGames(processes, []);
  const first = publicGameMetadata(await read(base[0],processes,[]));
  assert.equal(first.experienceTitle,'VS Whitty');assert.equal(first.creator,'Whitty Team');assert.equal(first.experienceId,'fnf:vswhitty');
  assert.doesNotMatch(JSON.stringify(first),/PRIVATE|path|description|folder/);
  await read(base[0],processes,[]);assert.equal(reads,2,'cached manifests are not repeatedly read');
  processes[0].gameTitle = 'Psych Engine';
  const engine = await read(detectGames(processes,[])[0],processes,[]);
  assert.equal(engine.experienceTitle,'Psych Engine');assert.equal(engine.creator,undefined,'installed mods are not assumed active');
});

test('native base and subgame timers handle same-title distinct IDs, leave, and rejoin', () => {
  const {gameSessionTimes} = require('../games.cjs');
  let game = gameSessionTimes({title:'Roblox',startedAt:1000},null,10000);
  game = gameSessionTimes({title:'Roblox',experienceId:'one',experienceTitle:'Same title'},game,20000);
  assert.equal(game.startedAt,1000);assert.equal(game.experienceStartedAt,20000);
  game = gameSessionTimes({title:'Roblox',experienceId:'one',experienceTitle:'Same title'},game,30000);
  assert.equal(game.experienceStartedAt,20000);
  game = gameSessionTimes({title:'Roblox',experienceId:'two',experienceTitle:'Same title'},game,40000);
  assert.equal(game.experienceStartedAt,40000);assert.equal(game.startedAt,1000);
  game = gameSessionTimes({title:'Roblox'},game,50000);
  assert.equal(game.experienceStartedAt,undefined);assert.equal(game.experienceId,undefined);assert.equal(game.startedAt,1000);
  game = gameSessionTimes({title:'Roblox',experienceId:'two',experienceTitle:'Same title'},game,60000);
  assert.equal(game.experienceStartedAt,60000);
});
