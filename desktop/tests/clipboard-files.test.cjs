'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { readClipboardFiles } = require('../clipboard-files.cjs');
const options = (files, size = 3) => ({ platform:'win32', executeImpl: async (program, args, opts) => {
  assert.match(program, /helpers[\\/]game-process-helper\.exe$/); assert.equal(opts.windowsHide, true);
  assert.deepEqual(args, ['--clipboard-files']); assert.notEqual(opts.shell, true);
  return { stdout:JSON.stringify(files) };
}, fsImpl:{ stat:async () => ({ isFile:() => true, size }), readFile:async () => Buffer.from('abc') } });
test('Explorer file clipboard supports up to twelve files with names, MIME and bytes', async () => {
  const files = await readClipboardFiles(12, options(Array.from({length:12}, (_, i) => `C:\\files\\${i}.png`)));
  assert.equal(files.length, 12); assert.equal(files[0].name, '0.png'); assert.equal(files[0].type, 'image/png');
  assert.equal(Buffer.from(files[0].data).toString(), 'abc');
});
test('clipboard rejects oversize and excess files instead of silently truncating', async () => {
  await assert.rejects(readClipboardFiles(1, options(['a.txt','b.txt'])), /1 more file/);
  assert.equal((await readClipboardFiles(12, options(['at-limit.bin'], 100*1024*1024))).length, 1);
  await assert.rejects(readClipboardFiles(12, options(['too-large.bin'], 100*1024*1024+1)), /100 MB/);
  assert.deepEqual(await readClipboardFiles(0, options(['a.txt'])), []);
});

test('clipboard follows the current positive byte limit above and below the default', async () => {
  const mebibyte = 1024 * 1024;
  assert.equal((await readClipboardFiles(12, { ...options(['at-limit.bin'], 250 * mebibyte), maxFileBytes:250 * mebibyte })).length, 1);
  await assert.rejects(readClipboardFiles(12, { ...options(['too-large.bin'], 250 * mebibyte + 1), maxFileBytes:250 * mebibyte }), /250 MB/);
  assert.equal((await readClipboardFiles(12, { ...options(['at-limit.bin'], 2.5 * mebibyte), maxFileBytes:2.5 * mebibyte })).length, 1);
  await assert.rejects(readClipboardFiles(12, { ...options(['too-large.bin'], 2.5 * mebibyte + 1), maxFileBytes:2.5 * mebibyte }), /2\.5 MB/);
  for (const maxFileBytes of [undefined, null, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '250']) {
    await assert.rejects(readClipboardFiles(12, { ...options(['too-large.bin'], 100 * mebibyte + 1), maxFileBytes }), /100 MB/);
  }
});

test('clipboard preload forwards the optional byte limit and keeps older calls compatible', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const bridges = {}, calls = [];
  const context = vm.createContext({
    process:{ isMainFrame:true, argv:[] }, window:{ location:{ protocol:'chatapp:', host:'app' } },
    require: name => { assert.equal(name, 'electron'); return {
      contextBridge:{ exposeInMainWorld:(name, value) => { bridges[name] = value; } },
      ipcRenderer:{ invoke:(...args) => { calls.push(args); return Promise.resolve([]); } },
    }; },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../overlay-app-preload.cjs'), 'utf8'), context);
  assert.equal(bridges.chatDesktopClipboard.version, 2);
  assert.equal(Object.isFrozen(bridges.chatDesktopClipboard), true);
  await bridges.chatDesktopClipboard.readFiles(3, 250 * 1024 * 1024);
  await bridges.chatDesktopClipboard.readFiles(4);
  assert.deepEqual(calls, [['chat-clipboard:files', 3, 250 * 1024 * 1024], ['chat-clipboard:files', 4, undefined]]);
});

test('clipboard main handler validates the optional byte limit and trusted focused caller', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  let handler;
  const calls = [], frame = {}, wc = { isDestroyed:() => false, mainFrame:frame, getURL:() => 'chatapp://app/index.html' };
  let focused = true;
  const context = vm.createContext({
    ipcMain:{ handle:(channel, callback) => { assert.equal(channel, 'chat-clipboard:files'); handler = callback; } },
    appView:{ webContents:wc }, mainWindow:{ isFocused:() => focused }, isAppURL:url => url.startsWith('chatapp://app/'),
    readClipboardFiles:(limit, options) => { calls.push({ limit, maxFileBytes:options.maxFileBytes }); return []; },
  });
  vm.runInContext(source.slice(source.indexOf("    ipcMain.handle('chat-clipboard:files'"), source.indexOf('\n    createMainWindow();')), context);
  const event = { sender:wc, senderFrame:frame };
  await handler(event, 3, 250 * 1024 * 1024);
  await handler(event, 4);
  for (const invalid of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '250']) await handler(event, 5, invalid);
  assert.deepEqual(calls[0], { limit:3, maxFileBytes:250 * 1024 * 1024 });
  assert.equal(calls.slice(1).every(call => call.maxFileBytes === undefined), true);
  const trustedCalls = calls.length;
  focused = false;
  await handler(event, 3, 250 * 1024 * 1024);
  focused = true;
  await handler({ sender:{}, senderFrame:frame }, 3, 250 * 1024 * 1024);
  assert.equal(calls.length, trustedCalls);
});

test('clipboard helper uses a fixed STA native mode and never accepts renderer commands or paths', async () => {
  const source = require('../scripts/benchmark-games.cjs').HELPER_SOURCE;
  assert.match(source, /\[STAThread\]/);
  assert.match(source, /Clipboard\.GetFileDropList\(\)/);
  assert.match(source, /args\.Length == 1 && args\[0\] == "--clipboard-files"/);
  const folder = options(['folder']); folder.fsImpl.stat = async () => ({ isFile: () => false, size: 0 });
  await assert.rejects(readClipboardFiles(12, folder), /folders cannot be attached/);
  const unsupported = options(['a.txt']); unsupported.platform = 'darwin';
  unsupported.executeImpl = () => { throw Error('Must not launch'); };
  assert.deepEqual(await readClipboardFiles(12, unsupported), []);
});
