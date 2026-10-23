'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { resolveApp, getFallbacks, validateAppDir, markReady } = require('../updater.cjs');
const fixtureRoot = path.resolve(__dirname, '../../../../updater-test-fixtures');
const bridgeCapabilities = { callOverlay: 1, callAudioExclusion: 1, roomRinging: 1, gameActivity: 1, notificationAudio: 1, manualStatus: 1, callEventAudio: 1, performanceRevision: 1, backgroundRunning: 1 };
const featureFiles = ['js/calling/desktop-overlay.js', 'js/calling/ringing.js', 'js/calling/notification-sounds.js', 'js/chat/game-presence.js', 'js/chat/notification-audio.js', 'js/profiles/status.js', ...['Message', 'Ping', 'Ringing', 'Called', 'JoinCall', 'LeaveCall'].map(name => `assets/sounds/${name}.mp3`)];

async function fixture(t) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(fixtureRoot, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function makeApp(root, compatible) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), '<html><head></head><body>Chat App</body></html>');
  if (compatible) {
    await fs.writeFile(path.join(root, 'desktop-capabilities.json'), JSON.stringify({ ...bridgeCapabilities, callExperience: 2 }));
    for (const file of featureFiles) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), '// fixture'); }
  }
}
const sha = 'a'.repeat(40);
function remote(compatible, experience = 2, revision = 0) {
  const zip = new AdmZip();
  const prefix = `christianlumen123-${sha}/`;
  zip.addFile(prefix + 'index.html', Buffer.from('<html><head></head><body>Updated</body></html>'));
  if (compatible) {
    zip.addFile(prefix + 'desktop-capabilities.json', Buffer.from(JSON.stringify({ ...bridgeCapabilities, callExperience: experience, webRevision: revision })));
    for (const file of featureFiles) zip.addFile(prefix + file, Buffer.from('// future feature'));
  }
  return async url => {
    if (url.includes('/users/')) return new Response(JSON.stringify([{ name: 'christianlumen123', owner: { login: 'dowsy456' } }]));
    if (url.includes('/commits/main')) return new Response(JSON.stringify({ sha }));
    if (url.startsWith('https://raw.githubusercontent.com/')) return compatible ? new Response(JSON.stringify({ ...bridgeCapabilities, callExperience: experience, webRevision: revision })) : new Response('Not found', { status: 404 });
    if (url.startsWith('https://codeload.github.com/')) return new Response(zip.toBuffer());
    throw Error(`Unexpected URL: ${url}`);
  };
}
test('reject old web updates and retain the bundled overlay release', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  const chosen = await resolveApp({ userData, bundledDir, fetchImpl: remote(false), offline: false });
  assert.equal(chosen.source, 'bundled');
  assert.equal(chosen.dir, bundledDir);
});
test('future compatible web updates still download, validate and become known-good', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  const chosen = await resolveApp({ userData, bundledDir, fetchImpl: remote(true), offline: false });
  assert.equal(chosen.source, 'downloaded');
  assert.equal(chosen.sha, sha);
  assert.equal(await validateAppDir(chosen.dir), true);
  await markReady(chosen);
  const cached = await resolveApp({ userData, bundledDir, offline: true });
  assert.equal(cached.source, 'known-good');
  assert.equal(cached.dir, chosen.dir);
});
test('an old known-good cache cannot override a compatible new bundle', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  const old = path.join(userData, 'releases', `122-${sha}`);
  await makeApp(bundledDir, true);
  await makeApp(old, false);
  await fs.writeFile(path.join(old, 'desktop-release.json'), JSON.stringify({ index: 122, sha }));
  await fs.writeFile(path.join(userData, 'known-good-release.json'), JSON.stringify({ kind: 'release', index: 122, sha }));
  assert.equal(await validateAppDir(old), false);
  assert.deepEqual((await getFallbacks({ userData, bundledDir })).map(x => x.source), ['bundled']);
});
test('capability marker without bridge module is incomplete', async t => {
  const root = await fixture(t);
  await makeApp(root, true);
  await fs.unlink(path.join(root, 'js/calling/desktop-overlay.js'));
  assert.equal(await validateAppDir(root), false);
});

test('a high web revision cannot erase ringing, games, DND or bundled notification sounds', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  for (const feature of ['roomRinging', 'gameActivity', 'notificationAudio', 'manualStatus', 'callEventAudio', 'performanceRevision']) {
    const get = remote(true, 99, 9999999999); let downloaded = false;
    const chosen = await resolveApp({ userData, bundledDir, offline: false, fetchImpl: url => {
      if (url.startsWith('https://raw.githubusercontent.com/')) return Promise.resolve(new Response(JSON.stringify({ ...bridgeCapabilities, [feature]: undefined, webRevision: 9999999999 })));
      if (url.startsWith('https://codeload.github.com/')) downloaded = true;
      return get(url);
    } });
    assert.equal(chosen.source, 'bundled', feature); assert.equal(downloaded, false);
  }
  for (const file of ['js/calling/notification-sounds.js', 'assets/sounds/Called.mp3', 'assets/sounds/JoinCall.mp3', 'assets/sounds/LeaveCall.mp3']) {
    const target = path.join(bundledDir, file), content = await fs.readFile(target);
    await fs.unlink(target);
    assert.equal(await validateAppDir(bundledDir), false, `capabilities cannot promise missing ${file}`);
    await fs.writeFile(target, content);
  }
});

test('the earlier overlay release cannot replace the call-audio fix', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  const old = path.join(root, 'old-overlay');
  await makeApp(old, true);
  await fs.writeFile(path.join(old, 'desktop-capabilities.json'), '{"callOverlay":1}');
  assert.equal(await validateAppDir(old), false);
  const get = remote(true);
  let downloaded = false;
  const fetchImpl = async url => {
    if (url.startsWith('https://raw.githubusercontent.com/')) return new Response('{"callOverlay":1}');
    if (url.startsWith('https://codeload.github.com/')) downloaded = true;
    return get(url);
  };
  const chosen = await resolveApp({ userData, bundledDir, fetchImpl, offline: false });
  assert.equal(chosen.source, 'bundled');
  assert.equal(downloaded, false);
});

test('shared UI revisions can update without rebuilding the native EXE', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  const old = path.join(userData, 'releases', `122-${sha}`);
  await makeApp(old, true);
  await fs.writeFile(path.join(old, 'desktop-capabilities.json'), JSON.stringify(bridgeCapabilities));
  await fs.writeFile(path.join(old, 'desktop-release.json'), JSON.stringify({ index: 122, sha }));
  await fs.writeFile(path.join(userData, 'known-good-release.json'), JSON.stringify({ kind: 'release', index: 122, sha }));
  assert.equal(await validateAppDir(old), true);
  const offline = await resolveApp({ userData, bundledDir, offline: true });
  assert.equal(offline.source, 'known-good');
  const get = remote(true, 3);
  let downloaded = false;
  const online = await resolveApp({ userData, bundledDir, offline: false, fetchImpl: url => {
    if (url.startsWith('https://codeload.github.com/')) downloaded = true;
    return get(url);
  } });
  assert.equal(online.source, 'downloaded');
  assert.equal(downloaded, true);
  assert.match(await fs.readFile(path.join(online.dir, 'index.html'), 'utf8'), /Updated/);
  assert.equal(JSON.parse(await fs.readFile(path.join(online.dir, 'desktop-capabilities.json'), 'utf8')).callExperience, 3);
  await markReady(online);
  assert.equal((await resolveApp({ userData, bundledDir, offline: true })).dir, online.dir);
});

test('a rebuilt EXE preserves its web fixes against an older published or cached release', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  await fs.writeFile(path.join(bundledDir, 'desktop-capabilities.json'), JSON.stringify({ ...bridgeCapabilities, webRevision: 2026092003 }));
  const old = path.join(userData, 'releases', `122-${sha}`);
  await makeApp(old, true);
  await fs.writeFile(path.join(old, 'desktop-release.json'), JSON.stringify({ index: 122, sha }));
  await fs.writeFile(path.join(userData, 'known-good-release.json'), JSON.stringify({ kind: 'release', index: 122, sha }));
  assert.deepEqual((await getFallbacks({ userData, bundledDir })).map(item => item.source), ['bundled']);
  const legacy = remote(true, 2);
  let downloaded = false;
  const retained = await resolveApp({ userData, bundledDir, offline: false, fetchImpl: url => {
    if (url.startsWith('https://codeload.github.com/')) downloaded = true;
    return legacy(url);
  } });
  assert.equal(retained.source, 'bundled');
  assert.equal(downloaded, false, 'older web assets are rejected before downloading');
  const newer = await resolveApp({ userData, bundledDir, offline: false, fetchImpl: remote(true, 4, 2026092004) });
  assert.equal(newer.source, 'downloaded', 'newer shared web code needs no native rebuild');
  await markReady(newer);
  assert.equal((await resolveApp({ userData, bundledDir, offline: true })).dir, newer.dir);
});

test('a newer known-good web release also prevents a published downgrade', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  await fs.writeFile(path.join(bundledDir, 'desktop-capabilities.json'), JSON.stringify({ ...bridgeCapabilities, webRevision: 2026092003 }));
  const newer = await resolveApp({ userData, bundledDir, offline: false, fetchImpl: remote(true, 5, 2026092005) });
  await markReady(newer);
  const chosen = await resolveApp({ userData, bundledDir, offline: false, fetchImpl: remote(true, 4, 2026092004) });
  assert.equal(chosen.source, 'known-good');
  assert.equal(chosen.dir, newer.dir);
  assert.equal(JSON.parse(await fs.readFile(path.join(chosen.dir, 'desktop-capabilities.json'))).webRevision, 2026092005);
});

test('an incompatible newest repository cannot hide the next compatible update', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  const valid = remote(true, 4, 2);
  const chosen = await resolveApp({ userData, bundledDir, offline: false, fetchImpl: async (url, options) => {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    if (url.includes('/users/')) return new Response(JSON.stringify([{ name:'christianlumen124' }, { name:'christianlumen123' }]));
    if (url.includes('/christianlumen124/commits/')) return new Response(JSON.stringify({ sha:'b'.repeat(40) }));
    if (url.includes('/christianlumen124/')) return new Response('{}');
    return valid(url, options);
  } });
  assert.equal(chosen.source, 'downloaded'); assert.equal(chosen.index, 123);
});

test('default-branch releases update when main no longer exists', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  const valid = remote(true, 4, 3);
  const chosen = await resolveApp({ userData, bundledDir, offline: false, fetchImpl: async (url, options) => {
    if (url.includes('/commits/main')) return new Response('Not found', { status:404 });
    if (url.includes('/commits/release')) return new Response(JSON.stringify({ sha }));
    if (/\/repos\/dowsy456\/christianlumen123\?/.test(url)) return new Response(JSON.stringify({ default_branch:'release' }));
    return valid(url, options);
  } });
  assert.equal(chosen.source, 'downloaded'); assert.equal(chosen.sha, sha);
});

test('the published default branch wins even when a stale main branch still exists', async t => {
  const root = await fixture(t), bundledDir = path.join(root, 'bundle'), userData = path.join(root, 'profile');
  await makeApp(bundledDir, true);
  const valid = remote(true, 4, 3);
  let usedMain = false;
  const chosen = await resolveApp({ userData, bundledDir, offline: false, fetchImpl: async (url, options) => {
    if (url.includes('/users/')) return new Response(JSON.stringify([{ name:'christianlumen123', default_branch:'published' }]));
    if (url.includes('/commits/main')) { usedMain = true; return new Response(JSON.stringify({ sha:'b'.repeat(40) })); }
    if (url.includes('/commits/published')) return new Response(JSON.stringify({ sha }));
    return valid(url, options);
  } });
  assert.equal(usedMain, false); assert.equal(chosen.source, 'downloaded'); assert.equal(chosen.sha, sha);
});
