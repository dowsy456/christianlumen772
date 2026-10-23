'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const OWNER = 'dowsy456';
const PREFIX = 'christianlumen';
const MAX_PAGES = 100;
const LIMITS = Object.freeze({ compressed: 150 * 1024 * 1024, extracted: 500 * 1024 * 1024, files: 10000 });
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const METADATA = 'desktop-release.json';
const GOOD_FILE = 'known-good-release.json';

class InvalidRelease extends Error {}
class HttpError extends Error {
  constructor(status, url) { super(`Update server returned HTTP ${status}.`); this.status = status; this.url = url; }
}

function validIdentity(value) {
  return value && Number.isSafeInteger(value.index) && value.index >= 0 && SHA_PATTERN.test(value.sha || '');
}

function status(callback, message, detail = '', progress = 0, error) {
  if (typeof callback === 'function') {
    try { callback({ message, detail, progress: Math.round(progress * 100), ...(error ? { error: String(error.message || error) } : {}) }); } catch (_) {}
  }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { return null; }
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

// The AbortController remains live while the response body is read, not just
// until headers arrive. Electron's net.fetch can be supplied to use OS trust.
async function fetchBytes(url, { fetchImpl = globalThis.fetch, timeout = 18000, maxBytes = 5 * 1024 * 1024, onProgress } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('The update request timed out.')), timeout);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: url.includes('api.github.com') ? 'application/vnd.github+json' : 'application/zip', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'follow'
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(response.status, url);
    }
    const length = Number(response.headers.get('content-length')) || 0;
    if (length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new InvalidRelease('The update exceeds the download size limit.');
    }
    const chunks = [];
    let received = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The update response has no body.');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) throw new InvalidRelease('The update exceeds the download size limit.');
        chunks.push(Buffer.from(value));
        if (onProgress) onProgress(received, length);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, received);
  } finally { clearTimeout(timer); }
}

async function fetchJson(url, options) {
  const bytes = await fetchBytes(url, options);
  try { return JSON.parse(bytes.toString('utf8')); } catch (_) { throw new Error('The update server returned invalid JSON.'); }
}

function repositoryIndexes(repositories) {
  const result = new Set();
  for (const repository of repositories) {
    if (!repository || typeof repository.name !== 'string') continue;
    if (repository.owner?.login && repository.owner.login.toLowerCase() !== OWNER) continue;
    const match = /^christianlumen(\d+)$/.exec(repository.name);
    if (!match) continue;
    const index = Number(match[1]);
    // A leading-zero repository is a different name from christianlumen<index>.
    if (Number.isSafeInteger(index) && String(index) === match[1]) result.add(index);
  }
  return [...result].sort((a, b) => b - a);
}

async function discoverRepositories({ fetchImpl, onStatus, maxPages = MAX_PAGES, branches = new Map() } = {}) {
  const indexes = new Set();
  for (let page = 1; page <= maxPages; page++) {
    status(onStatus, 'Checking for updates', `Reading app releases · page ${page}`, 0.08);
    const repos = await fetchJson(`https://api.github.com/users/${OWNER}/repos?per_page=100&page=${page}&sort=full_name&direction=asc&fresh=${Date.now()}`, { fetchImpl });
    if (!Array.isArray(repos)) throw new Error('The update server returned an invalid repository list.');
    for (const index of repositoryIndexes(repos)) indexes.add(index);
    for (const repository of repos) {
      const [index] = repositoryIndexes([repository]);
      if (index !== undefined && typeof repository.default_branch === 'string' && repository.default_branch) branches.set(index, repository.default_branch);
    }
    if (repos.length < 100) return [...indexes].sort((a, b) => b - a);
  }
  throw new Error('The release list exceeded the update discovery limit.');
}

function safeRelativeFile(value) {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f:]/.test(value) || value.startsWith('/')) {
    throw new InvalidRelease('The update contains an unsafe file path.');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new InvalidRelease('The update contains an unsafe file path.');
  }
  return parts.join('/');
}

function archivePlan(entries, expectedRoot, limits = LIMITS) {
  if (entries.length > limits.files) throw new InvalidRelease('The update contains too many files.');
  const paths = new Set();
  const plan = [];
  let total = 0;
  for (const entry of entries) {
    const original = Buffer.isBuffer(entry.rawEntryName) ? entry.rawEntryName.toString('utf8') : entry.entryName;
    if (typeof original !== 'string') throw new InvalidRelease('The update contains an invalid file name.');
    const directory = original.endsWith('/');
    const normalized = safeRelativeFile(directory ? original.slice(0, -1) : original);
    const segments = normalized.split('/');
    if (segments.shift() !== expectedRoot) throw new InvalidRelease('The update archive has an unexpected root folder.');
    const mode = ((entry.header.attr >>> 16) & 0xffff) & 0xf000;
    if (mode && mode !== 0x8000 && mode !== 0x4000) throw new InvalidRelease('The update contains a symbolic link or special file.');
    if (mode === 0x4000 && !directory) throw new InvalidRelease('The update contains an invalid directory entry.');
    if (entry.header.flags & 1) throw new InvalidRelease('Encrypted update files are not supported.');
    if (!segments.length) {
      if (!directory) throw new InvalidRelease('The update archive root is not a folder.');
      continue;
    }
    const relative = segments.join('/');
    const key = relative.toLowerCase();
    if (paths.has(key)) throw new InvalidRelease('The update contains duplicate file paths.');
    paths.add(key);
    const size = entry.header.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new InvalidRelease('The update contains an invalid file size.');
    total += size;
    if (total > limits.extracted) throw new InvalidRelease('The update exceeds the extracted size limit.');
    plan.push({ entry, relative, directory, size });
  }
  if (!plan.length) throw new InvalidRelease('The update archive is empty.');
  return plan;
}

async function extractArchive(bytes, destination, expectedRoot, limits = LIMITS) {
  if (bytes.length > limits.compressed) throw new InvalidRelease('The update exceeds the download size limit.');
  let plan;
  try { plan = archivePlan(new AdmZip(bytes).getEntries(), expectedRoot, limits); } catch (error) {
    if (error instanceof InvalidRelease) throw error;
    throw new InvalidRelease('The update archive is damaged or unsupported.');
  }
  // Destination is a newly created private staging directory. Never let ZIP
  // library extraction helpers decide paths or follow archive-created links.
  const root = path.resolve(destination);
  await fs.mkdir(root, { recursive: false });
  for (const file of plan) {
    const target = path.resolve(root, ...file.relative.split('/'));
    if (!target.startsWith(`${root}${path.sep}`)) throw new InvalidRelease('The update contains an unsafe destination.');
    if (file.directory) { await fs.mkdir(target, { recursive: true }); continue; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    let data;
    try {
      // adm-zip bounds deflate output for non-empty files. Avoid invoking its
      // unbounded zero-length inflate case for purportedly empty entries.
      if (file.size === 0) {
        if (file.entry.header.crc !== 0) throw new Error('Invalid empty-file checksum.');
        data = Buffer.alloc(0);
      } else data = file.entry.getData();
    } catch (_) { throw new InvalidRelease('The update archive failed its integrity check.'); }
    if (data.length !== file.size) throw new InvalidRelease('An update file has an invalid size.');
    await fs.writeFile(target, data, { flag: 'wx' });
  }
}

async function isRegularChild(root, relative) {
  try {
    const parts = safeRelativeFile(relative).split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) return false;
    }
    return true;
  } catch (_) { return false; }
}

function localAsset(value) {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return null;
  let local;
  try { local = decodeURIComponent(value.split(/[?#]/, 1)[0]); } catch (_) { throw new InvalidRelease('The app contains an invalid asset URL.'); }
  local = local.replace(/^\/+/, '').replace(/^\.\//, '');
  return safeRelativeFile(local);
}

async function validateAppDir(dir) {
  try {
    const root = path.resolve(dir);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !await isRegularChild(root, 'index.html')) return false;
    // Bridge capabilities prevent a cached or remote old page from silently
    // removing native features. Future matching web releases remain eligible.
    if (!await isRegularChild(root, 'desktop-capabilities.json')) return false;
    const capabilities = await readJson(path.join(root, 'desktop-capabilities.json'));
    if (!hasDesktopCapabilities(capabilities)) return false;
    for (const file of ['js/calling/desktop-overlay.js', 'js/calling/ringing.js', 'js/calling/notification-sounds.js', 'js/chat/game-presence.js', 'js/chat/notification-audio.js', 'js/profiles/status.js', ...['Message', 'Ping', 'Ringing', 'Called', 'JoinCall', 'LeaveCall'].map(name => `assets/sounds/${name}.mp3`)]) if (!await isRegularChild(root, file)) return false;
    const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
    if (!/<html\b/i.test(html) || !/<head\b/i.test(html) || !/<body\b/i.test(html)) return false;
    const localFiles = new Set();
    for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
      const tag = match[0];
      if (match[1].toLowerCase() === 'link' && !/\brel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
      const attr = match[1].toLowerCase() === 'script' ? /\bsrc\s*=\s*["']([^"']+)["']/i : /\bhref\s*=\s*["']([^"']+)["']/i;
      const value = attr.exec(tag)?.[1];
      if (value) { const relative = localAsset(value); if (relative) localFiles.add(relative); }
    }
    // This app loads many modules dynamically from this classic-script manifest.
    if (await isRegularChild(root, 'js/module-manifest.js')) {
      const manifest = await fs.readFile(path.join(root, 'js/module-manifest.js'), 'utf8');
      for (const match of manifest.matchAll(/["']?src["']?\s*:\s*["']([^"']+)["']/g)) {
        const relative = localAsset(match[1]);
        if (relative) localFiles.add(relative);
      }
    }
    for (const relative of localFiles) if (!await isRegularChild(root, relative)) return false;
    return true;
  } catch (_) { return false; }
}

async function bundledCandidate({ userData, bundledDir }) {
  if (!await validateAppDir(bundledDir)) return null;
  const metadata = await readJson(path.join(bundledDir, METADATA));
  return {
    dir: path.resolve(bundledDir), index: validIdentity(metadata) ? metadata.index : null,
    sha: validIdentity(metadata) ? metadata.sha.toLowerCase() : null,
    source: 'bundled', confirmedLatest: false, userData: path.resolve(userData)
  };
}

function webRevision(capabilities) {
  return Number.isSafeInteger(capabilities?.webRevision) && capabilities.webRevision >= 0 ? capabilities.webRevision : 0;
}
function hasDesktopCapabilities(capabilities) {
  return ['callOverlay', 'callAudioExclusion', 'roomRinging', 'gameActivity', 'notificationAudio', 'manualStatus', 'callEventAudio', 'performanceRevision', 'backgroundRunning'].every(key => capabilities?.[key] === 1);
}
async function appRevision(dir) {
  return webRevision(await readJson(path.join(dir, 'desktop-capabilities.json')));
}

async function getFallbacks({ userData, bundledDir }) {
  const results = [];
  const saved = await readJson(path.join(userData, GOOD_FILE));
  const bundled = await bundledCandidate({ userData, bundledDir });
  if (validIdentity(saved)) {
    if (saved.kind === 'bundled' && bundled?.index === saved.index && bundled?.sha === saved.sha) results.push(bundled);
    if (saved.kind === 'release') {
      const dir = path.join(userData, 'releases', `${saved.index}-${saved.sha.toLowerCase()}`);
      const metadata = await readJson(path.join(dir, METADATA));
      if (validIdentity(metadata) && metadata.index === saved.index && metadata.sha === saved.sha && await validateAppDir(dir)) {
        results.push({ dir: path.resolve(dir), index: saved.index, sha: saved.sha, source: 'known-good', confirmedLatest: false, userData: path.resolve(userData) });
      }
    }
  }
  if (bundled && !results.some(item => item.dir === bundled.dir)) results.push(bundled);
  // Installing a rebuilt desktop must not silently restore an older cached UI.
  // Future web revisions remain independently updatable without a new EXE.
  const ranked = await Promise.all(results.map(async item => ({ item, revision: await appRevision(item.dir) })));
  const minimum = bundled ? await appRevision(bundled.dir) : 0;
  return ranked.filter(entry => entry.revision >= minimum).sort((a, b) => b.revision - a.revision).map(entry => entry.item);
}

async function markReady(candidate) {
  if (!candidate?.userData || !await validateAppDir(candidate.dir)) throw new Error('Cannot mark an invalid app release as ready.');
  // Older bundles without release metadata still work, but cannot serve as a
  // numbered update-cache entry.
  if (!validIdentity(candidate)) return;
  const root = path.resolve(candidate.userData);
  if (candidate.source !== 'bundled') {
    const expected = path.join(root, 'releases', `${candidate.index}-${candidate.sha.toLowerCase()}`);
    if (path.resolve(candidate.dir) !== expected) throw new Error('The ready app is outside its release cache.');
  }
  await atomicJson(path.join(root, GOOD_FILE), {
    version: 1, kind: candidate.source === 'bundled' ? 'bundled' : 'release',
    index: candidate.index, sha: candidate.sha.toLowerCase(), savedAt: new Date().toISOString()
  });
}

async function downloadRelease({ userData, index, sha, fetchImpl, onStatus }) {
  const releases = path.join(userData, 'releases');
  await fs.mkdir(releases, { recursive: true });
  const dir = path.join(releases, `${index}-${sha}`);
  const metadata = await readJson(path.join(dir, METADATA));
  if (metadata?.index === index && metadata?.sha === sha && await validateAppDir(dir)) return dir;
  status(onStatus, 'Downloading Chat App', `Getting release ${index}`, 0.2);
  const bytes = await fetchBytes(`https://codeload.github.com/${OWNER}/${PREFIX}${index}/zip/${sha}`, {
    fetchImpl, timeout: 120000, maxBytes: LIMITS.compressed,
    onProgress: (received, total) => status(onStatus, 'Downloading Chat App', `${(received / 1048576).toFixed(1)} MB downloaded`, total ? 0.2 + Math.min(received / total, 1) * 0.55 : 0.35)
  });
  const staging = path.join(releases, `.staging-${crypto.randomUUID()}`);
  try {
    status(onStatus, 'Preparing Chat App', `Checking release ${index}`, 0.8);
    await extractArchive(bytes, staging, `${PREFIX}${index}-${sha}`);
    if (!await validateAppDir(staging)) throw new InvalidRelease('The release is missing the app page or required scripts and styles.');
    await atomicJson(path.join(staging, METADATA), { index, sha, downloadedAt: new Date().toISOString() });
    // A stale incomplete directory is never a boot-confirmed release. Move it
    // aside before installing the fully validated staging directory.
    let old;
    try {
      await fs.lstat(dir);
      old = path.join(releases, `.incomplete-${crypto.randomUUID()}`);
      await fs.rename(dir, old);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(staging, dir); } catch (error) {
      if (old) await fs.rename(old, dir).catch(() => {});
      throw error;
    }
    if (old) await fs.rm(old, { recursive: true, force: true }).catch(() => {});
    return dir;
  } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
}

async function resolveApp({ userData, bundledDir, onStatus, fetchImpl = globalThis.fetch, offline = process.env.CHAT_APP_OFFLINE === '1' }) {
  const options = { userData: path.resolve(userData), bundledDir: path.resolve(bundledDir) };
  let updateError;
  try {
    if (offline) throw new Error('Offline mode is enabled.');
    const branches = new Map();
    const indexes = await discoverRepositories({ fetchImpl, onStatus, branches });
    if (!indexes.length) throw new Error('No app releases were found.');
    const bundled = await bundledCandidate(options);
    const installed = await getFallbacks(options);
    const minimumRevision = installed.length ? await appRevision(installed[0].dir) : 0;
    for (const index of indexes) {
      status(onStatus, 'Checking Chat App', `Checking release ${index}`, 0.14);
      try {
        // The mutable branch lookup must never reuse an HTTP cache from an
        // earlier launch. Archive URLs below are pinned to immutable commits.
        let revision;
        try {
          revision = await fetchJson(`https://api.github.com/repos/${OWNER}/${PREFIX}${index}/commits/${encodeURIComponent(branches.get(index) || 'main')}?fresh=${Date.now()}`, { fetchImpl });
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
          const repository = await fetchJson(`https://api.github.com/repos/${OWNER}/${PREFIX}${index}?fresh=${Date.now()}`, { fetchImpl });
          if (!repository?.default_branch) throw new InvalidRelease('The release has no default branch.');
          revision = await fetchJson(`https://api.github.com/repos/${OWNER}/${PREFIX}${index}/commits/${encodeURIComponent(repository.default_branch)}?fresh=${Date.now()}`, { fetchImpl });
        }
        if (!SHA_PATTERN.test(revision?.sha || '')) throw new InvalidRelease('The release has no valid commit revision.');
        const sha = revision.sha.toLowerCase();
        if (bundled?.index === index && bundled.sha === sha && await appRevision(bundled.dir) >= minimumRevision) return { ...bundled, confirmedLatest: index === indexes[0] };
        // Older releases predate native call overlays. Check a tiny marker
        // before downloading, and use the installed compatible app until the
        // new web files have been published. Do not download every old repo.
        let capabilities;
        try {
          capabilities = await fetchJson(`https://raw.githubusercontent.com/${OWNER}/${PREFIX}${index}/${sha}/desktop-capabilities.json`, { fetchImpl, maxBytes: 4096 });
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
        }
        if (!hasDesktopCapabilities(capabilities)) throw new InvalidRelease('The published web app does not yet support this desktop version.');
        // Numbered releases are monotonic. Once a complete published app is
        // older than the installed one, retain the bundle without walking all
        // historical repositories (and exhausting shared GitHub rate limits).
        if (webRevision(capabilities) < minimumRevision) throw new Error('The installed web app is newer than the published release.');
        const dir = await downloadRelease({ userData: options.userData, index, sha, fetchImpl, onStatus });
        if (await appRevision(dir) < minimumRevision) throw new InvalidRelease('The downloaded app predates the installed web revision.');
        return { dir, index, sha, source: 'downloaded', confirmedLatest: index === indexes[0], userData: options.userData };
      } catch (error) {
        if (error instanceof InvalidRelease || error instanceof HttpError && [404, 422].includes(error.status)) {
          status(onStatus, 'Checking the next app release', `Release ${index} is incomplete`, 0.15);
          continue;
        }
        throw error;
      }
    }
    throw new Error('No complete app release was available.');
  } catch (error) { updateError = error; }
  const fallbacks = await getFallbacks(options);
  if (!fallbacks.length) throw new Error(`Chat App could not start. ${updateError.message}`);
  status(onStatus, 'Opening your saved Chat App', offline ? 'Offline mode · using the installed app' : 'Latest update could not be confirmed · using the saved app', 0.9, updateError);
  return fallbacks[0];
}

module.exports = { resolveApp, markReady, getFallbacks, validateAppDir,
  _test: { repositoryIndexes, discoverRepositories, archivePlan, extractArchive, fetchBytes, LIMITS, InvalidRelease } };
