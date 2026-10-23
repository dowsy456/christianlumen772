'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function uploadHarness() {
  const app = { register() {}, RTDB_DATA_CHUNK_SIZE: 3000, RTDB_BLOB_READ_BYTES: 3072, ATTACHMENT_CHUNK_BYTES: 3072, RTDB_STRING_UPLOAD_BATCH_SIZE: 3, RTDB_BATCH_UPLOAD_CONCURRENCY: 3, RTDB_CHUNK_UPLOAD_CONCURRENCY: 2, RTDB_CHUNK_UPLOAD_RETRIES: 1, CHAT_FILE_MAX_COUNT: 12, firebase: { database: { ServerValue: { TIMESTAMP: 42 } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/core/config.js'), 'utf8'), { ChatApp: app, URL });
  app.db = { ref: () => ({ on: (_event, callback) => callback({ val: () => null }) }) };
  app.startFileUploadLimitListener();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/media/uploads.js'), 'utf8'), { ChatApp: app, Blob, URL, document: { querySelectorAll: () => [] }, TextEncoder, TextDecoder, Uint8Array, btoa, setTimeout, clearTimeout, AbortController });
  app.externalObjects = new Map();
  app.assertExternalStorageConfigured = () => 'https://files.example.test';
  app.isExternalBlobDescriptor = file => file?.provider === 'b2-worker-v1' && typeof file.objectKey === 'string';
  app.getExternalBlobURL = file => 'https://files.example.test/objects/' + file.objectKey;
  app.uploadExternalBlob = async (blob, options) => {
    const objectKey = options.path + '-unique';
    app.externalObjects.set(objectKey, blob); options.onProgress?.(1);
    return { provider: 'b2-worker-v1', objectKey, downloadURL: app.getExternalBlobURL({ objectKey }), size: blob.size, mimeType: blob.type };
  };
  app.deleteExternalBlob = async file => app.externalObjects.delete(file.objectKey);
  app.deleteExternalBlobPrefix = async prefix => { for (const key of app.externalObjects.keys()) if (key.startsWith(prefix)) app.externalObjects.delete(key); };
  return app;
}

test('production upload initialization retains the default and realtime upload limit', () => {
  let initialize, receivePolicy;
  const app = { register: (name, init) => { if (name === 'media/uploads') initialize = init; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/core/config.js'), 'utf8'), { ChatApp: app, URL });
  app.db = { ref: () => ({ on: (_event, callback) => { receivePolicy = callback; callback({ val: () => null }); } }) };
  app.startFileUploadLimitListener();
  assert.equal(app.CHAT_FILE_MAX_BYTES, 100 * 1024 * 1024);
  assert.equal(app.CHAT_FILE_MAX_LABEL, '100 MB');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/media/uploads.js'), 'utf8'), {
    ChatApp: app, Blob, window: { addEventListener() {} }, navigator: { deviceMemory: 8 }
  });
  assert.equal(app.isChatAttachmentOverSizeLimit({ size: 100 * 1024 * 1024 }), false);
  assert.equal(app.isChatAttachmentOverSizeLimit({ size: 100 * 1024 * 1024 + 1 }), true);
  receivePolicy({ val: () => 250 });
  app.bindChatFileTransfers = () => {};
  initialize();
  assert.equal(app.CHAT_FILE_MAX_BYTES, 250 * 1024 * 1024, 'a snapshot received before upload initialization must survive');
  assert.equal(app.CHAT_FILE_MAX_LABEL, '250 MB');
  receivePolicy({ val: () => 2.5 });
  assert.equal(app.CHAT_FILE_MAX_BYTES, 2.5 * 1024 * 1024);
  assert.equal(app.CHAT_FILE_MAX_LABEL, '2.5 MB');
  assert.equal(app.isChatAttachmentOverSizeLimit({ size: 2.5 * 1024 * 1024 }), false);
  assert.equal(app.isChatAttachmentOverSizeLimit({ size: 2.5 * 1024 * 1024 + 1 }), true);
  assert.equal(app.BULK_UPLOAD_BYTES_PER_MINUTE, 32 * 1024 * 1024);
  app.scheduleMessageMediaRefresh('room', 'message');
  assert.equal(app.pendingMessageMediaRefreshTimers.size, 0, 'large upload placeholders never start repetitive polling');
});

test('upload pacing accounts for encoded UTF-8 bytes and cancels queued work promptly', async () => {
  const app = uploadHarness();
  app.BULK_UPLOAD_BYTES_PER_MINUTE = 60000;
  const payload = { html: '🐱'.repeat(1000) };
  const started = Date.now();
  await app.waitForBulkUploadBudget(payload);
  assert.ok(app.bulkUploadNextWriteAt >= started + Buffer.byteLength(JSON.stringify(payload)));
  const abort = new AbortController();
  const pending = app.waitForBulkUploadBudget(payload, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  app.bulkUploadConnected = false;
  await assert.rejects(app.waitForBulkUploadBudget(payload), /disconnected/);
});

test('changing places aborts writes before cleanup instead of racing their late acknowledgement', async () => {
  const app = uploadHarness();
  app.activeFirebaseUploads = new Map(); app.activeFirebaseUploadSeq = 0;
  let cleaned = 0;
  const scope = app.createFirebaseUploadScope({ place: 'room:old', cleanup: async () => { cleaned++; } });
  app.abortFirebaseUploadsForPlaceChange('room:new');
  assert.equal(scope.signal.aborted, true);
  assert.equal(cleaned, 0, 'the writer must drain in-flight SDK writes before removing data');
  await app.cleanupFirebaseUploadScope(scope);
  await app.cleanupFirebaseUploadScope(scope);
  assert.equal(cleaned, 1);
});

test('an upload cannot report success while disconnect cleanup remains armed', async () => {
  const app = uploadHarness();
  app.activeFirebaseUploads = new Map(); app.activeFirebaseUploadSeq = 0;
  let cleaned = 0;
  const ref = { onDisconnect: () => ({ remove: async () => { throw new Error('registration failed'); }, cancel: async () => { throw new Error('cancel failed'); } }) };
  const scope = app.createFirebaseUploadScope({ disconnectRefs: [ref], cleanup: async () => { cleaned++; } });
  await assert.rejects(app.armFirebaseUploadDisconnect(scope), /registration failed/);
  await assert.rejects(app.finishFirebaseUploadScope(scope), /cancel failed/);
  assert.equal(scope.done, false);
  await app.cleanupFirebaseUploadScope(scope);
  assert.equal(cleaned, 1);
});

function htmlHubHarness() {
  const app = uploadHarness();
  app.HTML_HUB_CHUNK_SIZE = 8;
  app.HTML_HUB_BY_OWNER_NODE = 'htmlHub/byOwner';
  app.HTML_HUB_ENABLE_LEGACY_MIGRATION = false;
  app.currentUser = { code: 'owner', username: 'Vinny' };
  app.activeFirebaseUploads = new Map(); app.activeFirebaseUploadSeq = 0;
  app.makeHtmlHubId = () => 'html-one';
  app.htmlHubPath = () => 'htmlHub/files'; app.htmlHubMetaPath = () => 'htmlHub/meta';
  app.getStoredPlace = () => 'home'; app.isVinny = () => true;
  app.forgetParkedGamesFrame = () => {};
  app.htmlHubItemsCache = [];
  const records = new Map(), writes = [], reads = [];
  let activeReads = 0, maxReads = 0;
  const valueAt = key => {
    if (records.has(key)) return records.get(key);
    const out = {};
    for (const [path, value] of records) {
      if (!path.startsWith(key + '/')) continue;
      const relative = path.slice(key.length + 1);
      if (!relative.includes('/')) out[relative] = value;
    }
    return Object.keys(out).length ? out : null;
  };
  const store = (key, value) => {
    for (const path of records.keys()) if (path === key || path.startsWith(key + '/')) records.delete(path);
    if (value != null) records.set(key, value);
  };
  const ref = (key = '') => ({
    key: key.split('/').pop(), child: part => ref(key + '/' + part),
    onDisconnect: () => ({ remove: async () => {}, cancel: async () => {} }),
    remove: async () => { writes.push({ path: key, remove: true }); store(key, null); },
    update: async payload => {
      writes.push({ path: key, payload: JSON.parse(JSON.stringify(payload)) });
      for (const [name, value] of Object.entries(payload)) store(key ? key + '/' + name : name, value);
    },
    once: async () => {
      reads.push(key); activeReads++; maxReads = Math.max(maxReads, activeReads);
      await new Promise(resolve => setImmediate(resolve)); activeReads--;
      const value = valueAt(key); return { val: () => value, exists: () => value != null };
    }
  });
  app.db = { ref };
  for (const file of ['window-state.js', 'library-storage.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../activity-modules', file), 'utf8'), { ChatApp: app, Blob, File, AbortController,
      fetch: async url => { const blob = app.externalObjects.get(url.split('/objects/')[1]); return { ok: !!blob, blob: async () => blob }; }
    });
  }
  app.htmlHubPath = () => 'htmlHub/files'; app.htmlHubMetaPath = () => 'htmlHub/meta';
  return { app, writes, reads, records, valueAt, maxReads: () => maxReads };
}

test('HTML publishing keeps binary bytes external and only compact metadata in the database', async () => {
  const { app, writes, reads, valueAt, maxReads } = htmlHubHarness();
  const html = '<html><body>' + '🐱 Hello! '.repeat(24) + '</body></html>';
  const progress = [];
  const id = await app.createHtmlHubItem({ title: 'Game', html, onProgress: p => progress.push(p) });
  const content = valueAt('htmlHub/files/' + id);
  const meta = valueAt('htmlHub/meta/' + id);
  assert.equal(content.provider, 'b2-worker-v1');
  assert.equal(content.size, new Blob([html]).size);
  assert.equal(app.externalObjects.size, 1);
  assert.equal(meta.schemaVersion, 4); assert.equal(meta.title, 'Game');
  assert.equal(writes.filter(write => write.path === '').length, 1, 'publish index exactly once, when chunks are ready');
  assert.ok(writes.every(write => !JSON.stringify(write).includes('uploadProgress')));
  const item = await app.readHtmlHubItem(id);
  assert.equal(item.html, html);
  assert.ok(reads.every(path => !/\/html(?:\d+|ChunkCount)?$/.test(path)), 'external files never read legacy RTDB chunks');
  assert.ok(writes.every(write => !JSON.stringify(write).includes('<html>')), 'HTML bytes never enter RTDB');
  assert.equal(progress.at(-1), 100);
});

test('empty HTML Hub does not scan accounts or content and deletion removes modern records', async () => {
  const { app, writes, reads, valueAt } = htmlHubHarness();
  app.acquireHtmlHubMigrationLease = () => { throw new Error('Legacy scan must be opt-in'); };
  app.fetchHtmlHubChildKeys = () => { throw new Error('Empty modern index is authoritative'); };
  await app.migrateLegacyHtmlLibrariesToHub();
  assert.deepEqual(Array.from(await app.readHtmlHub()), []);
  assert.deepEqual(reads, ['htmlHub/meta']);
  const id = await app.createHtmlHubItem({ title: 'Delete me', html: '<p>Hi</p>' });
  app.forgetParkedGamesFrame = () => {};
  assert.equal(await app.deleteHtmlHubItem(id), true);
  assert.equal(valueAt('htmlHub/files/' + id), null);
  assert.equal(valueAt('htmlHub/meta/' + id), null);
  assert.equal(valueAt('htmlHub/byOwner/owner/' + id), null);
  assert.equal(app.externalObjects.size, 0);
  assert.equal(writes.at(-1).payload['htmlHub/meta/' + id], null, 'new uploads leave no permanent tombstone');
});

test('failed external HTML deletion retains metadata and file reference until a successful retry', async () => {
  const { app, valueAt } = htmlHubHarness();
  const id = await app.createHtmlHubItem({ title: 'Retry', html: '<p>Retained</p>' });
  const remove = app.deleteExternalBlobPrefix;
  app.deleteExternalBlobPrefix = async () => { throw Error('provider offline'); };
  await assert.rejects(app.deleteHtmlHubItem(id), /provider offline/);
  assert.ok(valueAt('htmlHub/meta/' + id)); assert.ok(valueAt('htmlHub/files/' + id));
  assert.equal(app.externalObjects.size, 1);
  app.deleteExternalBlobPrefix = remove; app.forgetParkedGamesFrame = () => {};
  assert.equal(await app.deleteHtmlHubItem(id), true);
  assert.equal(valueAt('htmlHub/meta/' + id), null); assert.equal(app.externalObjects.size, 0);
});

test('external media resolves to a cached streaming URL without downloading bytes and bounds URL references', async () => {
  const app = uploadHarness(); app.attachmentURLCache = new Map();
  for (let i = 0; i < 520; i++) {
    const file = { provider: 'b2-worker-v1', objectKey: 'attachments/room/message/file' + i, size: 100 * 1024 * 1024 };
    const url = await app.resolveAttachmentURL(file);
    assert.equal(app.getCachedAttachmentURL(file), url, 'Renderer repaint must see media ready, not restart its load');
    assert.equal(app.attachmentURLCache.get(app.attachmentCacheKey(file)).size, 0, 'Remote URL retains no file bytes');
  }
  assert.equal(app.attachmentURLCache.size, 512);
  app.pruneAttachmentURLCache(true); assert.equal(app.attachmentURLCache.size, 0);
});

test('unavailable external downloads show failure instead of saving the provider error response', async () => {
  const notices = [], app = { register() {}, showToast: notice => notices.push(notice) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/media/viewer.js'), 'utf8'), {
    ChatApp: app, console: { error() {} },
    fetch: async () => ({ ok: false, status: 404, blob: async () => { throw Error('Must not read an error body as file bytes'); } }),
    document: { createElement() { throw Error('Must not offer an error response as a download'); } }
  });
  await app.downloadFileViaObjectURL('https://files.example.test/missing', 'missing.bin');
  await app.downloadHtmlViaObjectURL('https://files.example.test/missing', 'missing.html');
  assert.equal(notices.length, 2); assert.ok(notices.every(notice => notice.title === 'Download failed'));
});

test('cancelled HTML upload removes external bytes and never publishes its index', async () => {
  const { app, writes, valueAt } = htmlHubHarness();
  const controller = new AbortController();
  await assert.rejects(app.createHtmlHubItem({ title: 'Cancel me', html: 'x'.repeat(200), signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(valueAt('htmlHub/files/html-one'), null);
  assert.equal(valueAt('htmlHub/meta/html-one'), null);
  assert.equal(writes.filter(write => write.path === '').length, 0);
  assert.equal(app.externalObjects.size, 0);
});
test('binary attachment uploads share two slots and publish only compact descriptors', async () => {
  const app = uploadHarness(), blobs = [new Blob(['one']), new Blob(['two']), new Blob(['three'])];
  const baseUpload = app.uploadExternalBlob;
  let active = 0, peak = 0, manifest, index = null;
  app.uploadExternalBlob = async (blob, options) => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve));
    assert.ok(blobs.includes(blob), 'provider receives the original Blob without base64 encoding');
    const descriptor = await baseUpload(blob, options); active--; return descriptor;
  };
  app.waitForBulkUploadBudget = () => { throw new Error('External uploads must not use RTDB pacing'); };
  app.db = { ref: () => ({ set: async value => { index = value; }, remove: async () => {} }) };
  const message = { transaction: async change => {
    assert.equal(active, 0); manifest = change({ userCode: 'author', createdAt: 1 });
    return { committed: true, snapshot: { val: () => manifest } };
  } };
  await app.writeMessageAttachmentsToRef(message, blobs.map((blob, i) => ({ fileObject: blob, name: i + '.bin' })), { roomId: 'room with spaces', msgKey: 'key' });
  assert.equal(peak, 2); assert.equal(manifest.files.length, 3);
  assert.equal(index.files.length, 3); assert.ok(JSON.stringify(index).length < 2000);
  assert.ok(manifest.files.every(file => app.isStoredAttachment(file) && !file.dataURL && !file.parts && !file.encoding));
  assert.equal(manifest.userCode, 'author'); assert.equal(manifest.attachmentsSyncedAt, 42);
  assert.ok(manifest.files.every(file => /^attachments\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\//.test(file.objectKey)));
});

test('failed external workers settle before cleanup and never publish a ready manifest', async () => {
  const app = uploadHarness(), original = app.uploadExternalBlob;
  let active = 0, calls = 0, committed = false, removed = false;
  app.uploadExternalBlob = async (blob, options) => {
    active++; const call = ++calls;
    await new Promise(resolve => setTimeout(resolve, call === 1 ? 1 : 10)); active--;
    if (call === 1) throw new Error('offline');
    return original(blob, options);
  };
  app.db = { ref: () => ({ remove: async () => { assert.equal(active, 0); removed = true; } }) };
  await assert.rejects(app.writeMessageAttachmentsToRef({ transaction: async () => { committed = true; } }, [{ fileObject: new Blob(['one']) }, { fileObject: new Blob(['two']) }], { roomId: 'room', msgKey: 'key' }), /offline/);
  assert.equal(active, 0); assert.equal(committed, false); assert.equal(removed, true); assert.equal(app.externalObjects.size, 0);
});

test('100 MB original Blob is accepted without encoding, and one byte above is rejected before upload', async () => {
  const app = uploadHarness();
  class GeneratedBlob extends Blob {
    constructor(size) { super([]); this.byteSize = size; }
    get size() { return this.byteSize; }
    arrayBuffer() { throw new Error('Do not materialize the entire upload in JS'); }
    slice() { throw new Error('Do not base64 chunk external uploads'); }
  }
  let uploads = 0, manifest;
  const original = app.uploadExternalBlob;
  app.uploadExternalBlob = async (blob, options) => { uploads++; return original(blob, options); };
  app.db = { ref: () => ({ set: async () => {}, remove: async () => {} }) };
  const message = { transaction: async change => { manifest = change({ userCode: 'author' }); return { committed: true, snapshot: { val: () => manifest } }; } };
  const blob = new GeneratedBlob(app.CHAT_FILE_MAX_BYTES);
  await app.writeMessageAttachmentsToRef(message, [{ fileObject: blob }], { roomId: 'room', msgKey: 'large' });
  assert.equal(manifest.files[0].size, 100 * 1024 * 1024); assert.equal(uploads, 1);
  await assert.rejects(app.writeMessageAttachmentsToRef(message, [{ fileObject: new GeneratedBlob(app.CHAT_FILE_MAX_BYTES + 1) }], { roomId: 'room', msgKey: 'oversize' }), /100 MB/);
  assert.equal(uploads, 1);
});

test('missing external setup fails before any attachment or HTML database write', async () => {
  const app = uploadHarness(); let touched = false;
  app.assertExternalStorageConfigured = () => { throw new Error('File storage needs setup'); };
  app.db = { ref: () => { touched = true; throw new Error('Unexpected database access'); } };
  await assert.rejects(app.writeMessageAttachmentsToRef({}, [{ fileObject: new Blob(['file']) }]), /needs setup/);
  assert.equal(touched, false);
  const hub = htmlHubHarness(); hub.app.assertExternalStorageConfigured = app.assertExternalStorageConfigured;
  await assert.rejects(hub.app.createHtmlHubItem({ title: 'Setup', html: 'file' }), /needs setup/);
  assert.equal(hub.writes.length, 0);
});

test('lower upload limit preserves legacy 200 MB message references', () => {
  const app = uploadHarness(), size = 200 * 1024 * 1024;
  const legacy = { encoding: 'base64-parts-v1', storagePath: 'attachmentBlobs/room/old/files/0', size, chunkBytes: app.ATTACHMENT_CHUNK_BYTES, chunkCount: Math.ceil(size / app.ATTACHMENT_CHUNK_BYTES) };
  assert.equal(app.isStoredAttachment(legacy), true);
  assert.equal(app.isChatAttachmentOverSizeLimit({ size }), true);
});

function harness() {
  let timerId = 0;
  const timers = new Map();
  const observers = [];
  const revoked = [];
  const registrations = [];
  function events(target) {
    target.listeners = new Map();
    target.addEventListener = (type, fn) => {
      if (!target.listeners.has(type)) target.listeners.set(type, new Set());
      target.listeners.get(type).add(fn);
    };
    target.removeEventListener = (type, fn) => target.listeners.get(type)?.delete(fn);
    target.fire = (type, values = {}) => {
      const event = { target, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() { this.stopped = true; }, ...values };
      for (const fn of target.listeners.get(type) || []) { fn(event); if (event.stopped) break; }
      return event;
    };
    return target;
  }
  let document;
  class Element {
    constructor(tag = 'div') {
      events(this);
      this.tagName = tag.toUpperCase();
      this.dataset = {};
      this.attributes = {};
      this.style = {
        getPropertyValue(name) { return this[name] || ''; },
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) { delete this[name]; }
      };
      this.children = [];
      this.className = '';
      this.hidden = false;
      this.offsetWidth = 174;
      this.offsetHeight = 100;
      this.value = '';
      this.classList = {
        contains: value => this.className.split(/\s+/).includes(value),
        add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...values])].join(' '); },
        remove: (...values) => { this.className = this.className.split(/\s+/).filter(v => !values.includes(v)).join(' '); },
        toggle: (value, enabled) => { if (enabled) this.classList.add(value); else this.classList.remove(value); }
      };
    }
    get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
    set textContent(value) { this._text = value; this.children.forEach(child => { child.parentElement = null; }); this.children = []; }
    get textContent() { return this._text || ''; }
    set innerHTML(value) {
      this.textContent = '';
      this._html = value;
      if (value.includes('sticker-tile-media')) {
        const media = new Element('span'); media.className = 'sticker-tile-media'; this.appendChild(media);
      }
      for (const match of value.matchAll(/data-sticker-menu-action="([^"]+)"/g)) {
        const button = new Element('button');
        button.setAttribute('data-sticker-menu-action', match[1]);
        button.setAttribute('role', 'menuitem');
        this.appendChild(button);
      }
    }
    get innerHTML() { return this._html || ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, next) {
      child.remove();
      const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      child.parentElement = this;
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    matches(selector) {
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const attr = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
      if (attr) return this.getAttribute(attr[1]) === attr[2];
      return this.tagName.toLowerCase() === selector;
    }
    querySelectorAll(selector) {
      const result = [];
      const visit = el => { for (const child of el.children) { if (child.matches(selector)) result.push(child); visit(child); } };
      visit(this);
      return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 20, top: 30, right: 140, bottom: 150, width: 120, height: 120 }; }
  }
  class Video extends Element { constructor() { super('video'); } play() { return Promise.resolve(); } pause() {} }
  document = events({ documentElement: { clientWidth: 390, clientHeight: 700 }, createElement: tag => tag === 'video' ? new Video() : new Element(tag) });
  document.body = new Element('body');
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.body.querySelector(selector);
  const elements = {};
  for (const id of ['sticker-context-menu', 'sticker-popover', 'sticker-grid', 'sticker-popover-status', 'sticker-search', 'btn-stickers', 'btn-sticker-upload', 'sticker-file-input']) {
    const el = new Element(); el.id = id; elements[id] = el; document.body.appendChild(el);
  }
  elements['sticker-popover'].appendChild(elements['sticker-context-menu']);
  elements['sticker-popover'].appendChild(elements['sticker-grid']);
  elements['sticker-context-menu'].hidden = true;
  const window = events({ innerWidth: 390, innerHeight: 700 });
  const app = {
    register: (id, fn) => { if (id !== 'ui/chat-popovers') registrations.push(fn); },
    $: id => elements[id] || null,
    currentUser: { code: 'me' },
    currentRoomId: 'room',
    escapeHtml: value => String(value),
    isVinny: () => false,
    hasAllChunkedFieldParts: () => true,
    readChunkedField: (value, field) => value[field],
    closeEmojiPopover() {}, closeVoicePopover() {}, closeComposerMoreMenu() {},
    getStoredPlace: () => 'room:room',
    db: { ref: () => ({ once: async () => ({ val: () => ({ dataURL: 'data:image/png;base64,AA==' }) }) }) }
  };
  const ctx = vm.createContext({ ChatApp: app, window, document, console, Blob, DOMException, navigator: { connection: {} },
    innerWidth: 390, innerHeight: 700,
    getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', maxWidth: el.style['max-width'] || 'none', maxHeight: el.style['max-height'] || 'none', minWidth: el.style['min-width'] || '0px' }),
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { timers.set(++timerId, { fn, ms: 16 }); return timerId; },
    cancelAnimationFrame: id => timers.delete(id), queueMicrotask,
    HTMLVideoElement: Video,
    IntersectionObserver: class {
      constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
      observe(el) { this.targets.add(el); }
      unobserve(el) { this.targets.delete(el); }
      disconnect() { this.targets.clear(); }
    },
    URL: { createObjectURL: () => 'blob:sticker-' + Math.random(), revokeObjectURL: url => revoked.push(url) },
    fetch: async () => ({ blob: async () => new Blob(['sticker'], { type: 'image/png' }) })
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ui/chat-popovers.js'), 'utf8'), ctx);
  for (const file of ['library.js', 'editor.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/stickers', file), 'utf8'), ctx);
  registrations.forEach(fn => fn());
  app.syncStickerSavedUI = () => {};
  const flushTimers = () => { const pending = [...timers]; timers.clear(); pending.forEach(([, t]) => t.fn()); };
  return { app, ctx, elements, document, window, observers, timers, revoked, flushTimers, Element };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const meta = (id = 'one') => ({ id, name: id, nameLower: id, kind: 'image', state: 'ready', creatorCode: 'me', byteSize: 1024, createdAt: 1 });

test('sticker crop allows 50 percent framing while keeping the default at 100 percent', () => {
  const {app} = harness();app.STICKER_OUTPUT_SIZE = 320;
  const defaults = {panX:0,panY:0};app.clampStickerCrop(defaults,640,640);
  assert.equal(defaults.zoom,1);
  const state = {zoom:.5,panX:500,panY:-500};
  const crop = app.clampStickerCrop(state,640,640);
  assert.equal(state.zoom,.5);assert.equal(crop.scale,.25);
  assert.equal(Math.abs(state.panX),0);assert.equal(Math.abs(state.panY),0);
  state.zoom=.1;app.clampStickerCrop(state,640,640);assert.equal(state.zoom,.5);
});

test('publishing a sticker reuses local bytes and cancels only its own disconnect cleanup', async () => {
  const { app } = harness();
  app.currentUser.username = 'Vinny';
  app.firebase = { database: { ServerValue: { TIMESTAMP: 42 } } };
  const writes = [], cancelled = [];
  const ref = (path = '') => ({
    key: 'new-sticker', push: () => ref(path + '/new-sticker'),
    set: async data => writes.push({ path, data }),
    update: async data => writes.push({ path, data }),
    onDisconnect: () => ({ update: async () => {}, cancel: async () => cancelled.push(path) })
  });
  app.db = { ref };
  app.createFirebaseUploadScope = () => ({ signal: new AbortController().signal });
  app.finishFirebaseUploadScope = async () => {};
  app.throwIfUploadAborted = () => {};
  app.countDataURLChunksForBlob = () => 1;
  app.writeBlobDataURLToRef = async () => 1;
  await app.publishStickerBlob(new Blob(['local'], { type: 'image/png' }), { name: 'Local', kind: 'image' });
  assert.equal(cancelled.length, 5);
  assert.ok(cancelled.every(path => path.includes('/new-sticker') || path.includes('/new-sticker/')));
  assert.equal(cancelled.includes(''), false, 'presence cleanup at unrelated paths stays armed');
  assert.ok(writes.every(write => !JSON.stringify(write).includes('uploadProgress')));
  const local = await app.loadStickerAsset(meta('new-sticker'));
  assert.equal(local.byteSize, 5);
  assert.ok(local.url.startsWith('blob:'));
});

test('cached sticker metadata survives detached history fragments and loads after mount', async () => {
  const { app, document, Element, observers } = harness();
  const row = new Element();
  const bubble = new Element();
  row.appendChild(bubble);
  let subscribed;
  app.watchStickerMeta = (_id, callback) => { subscribed = callback; return () => {}; };
  let reads = 0;
  app.loadStickerAsset = async () => { reads++; return { url: 'blob:history' }; };
  app.renderStickerMessageInto(bubble, row, meta());
  subscribed(meta()); // A cache callback arrives while still in a fragment.
  const button = bubble.querySelector('button');
  assert.equal(button.isConnected, false);
  const observer = observers.find(value => value.targets.has(button));
  assert(observer, 'unmounted history is registered for a later viewport intersection');
  assert.equal(reads, 0);
  document.body.appendChild(row);
  observer.callback([{ target: button, isIntersecting: true }]);
  await flush();
  assert.equal(reads, 1);
  assert.equal(button.querySelector('img').src, 'blob:history');
  assert.equal(button.classList.contains('is-loading'), false);
});

test('sticker metadata retains pending uploads and ignores callbacks after cleanup', () => {
  const { app, document, Element } = harness();
  const row = new Element();
  const bubble = new Element();
  row.appendChild(bubble);
  document.body.appendChild(row);
  let subscribed;
  app.watchStickerMeta = (_id, callback) => { subscribed = callback; return () => {}; };
  app.renderStickerMessageInto(bubble, row, meta());
  const button = bubble.querySelector('button');
  subscribed({ ...meta(), state: 'pending' });
  assert.equal(button.classList.contains('is-deleted'), false);
  assert.equal(button.classList.contains('is-loading'), true);
  row.__stickerUnsubscribe();
  subscribed(meta());
  assert.equal(button.__loadStickerMessage, undefined);
});

test('foreground and prewarm share one asset request and discard stale completion after logout', async () => {
  const { app, revoked } = harness();
  let resolveRead;
  let reads = 0;
  app.db.ref = () => ({ once: () => { reads++; return new Promise(resolve => { resolveRead = resolve; }); } });
  const first = app.loadStickerAsset(meta());
  const second = app.loadStickerAsset(meta());
  assert.equal(reads, 1);
  resolveRead({ val: () => ({ dataURL: 'data:example' }) });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(await app.loadStickerAsset(meta()), a);
  assert.equal(reads, 1);
  const stale = app.loadStickerAsset(meta('stale'));
  app.stickerRuntimeEpoch++;
  resolveRead({ val: () => ({ dataURL: 'data:example' }) });
  await assert.rejects(stale, { name: 'AbortError' });
  assert.equal(revoked.length, 1);
  assert.equal(app.stickerAssetCache.has('stale'), false);
});

test('sticker sign-in preparation does not download hidden picker media', () => {
  const { app, timers } = harness();
  app.ensureStickerCollectionListener = () => {};
  app.stickerPopoverOpen = false;
  app.prepareStickerPicker();
  assert.equal(app.stickerPrewarmWanted, false);
  assert.equal(timers.size, 0);
  app.stickerPopoverOpen = true;
  app.prepareStickerPicker();
  assert.equal(app.stickerPrewarmWanted, true);
  assert.equal(timers.size, 1);
});

test('visible sticker loads share a two-request pool instead of downloading every tile at once', async () => {
  const { app } = harness();
  let active = 0, peak = 0;
  app.db.ref = () => ({ once: async () => {
    active++; peak = Math.max(peak, active);
    await flush(); active--;
    return { val: () => ({ dataURL: 'data:example' }) };
  } });
  await Promise.all(Array.from({ length: 12 }, (_, i) => app.loadStickerAsset(meta(String(i)))));
  assert.equal(peak, 2);
  assert.equal(app.stickerAssetLoadCount, 0);
  assert.equal(app.stickerAssetLoadQueue.length, 0);
});

test('prewarm loads only eight recent stickers with two concurrent reads and respects Data Saver', async () => {
  const { app, ctx } = harness();
  app.stickerPrewarmWanted = true;
  for (let i = 0; i < 30; i++) { app.savedStickerIds.add(String(i)); app.savedStickerTimes.set(String(i), i); app.stickerLibraryMeta.set(String(i), meta(String(i))); }
  let active = 0;
  let maxActive = 0;
  const ids = [];
  app.loadStickerAsset = async record => { ids.push(record.id); maxActive = Math.max(maxActive, ++active); await flush(); active--; return {}; };
  await app.prewarmStickerAssets();
  assert.equal(maxActive, 2);
  assert.deepEqual(ids.sort(), ['22', '23', '24', '25', '26', '27', '28', '29']);
  ctx.navigator.connection.saveData = true;
  await app.prewarmStickerAssets();
  assert.equal(ids.length, 8);
});

test('prewarm obeys byte budget and stops queuing assets when the account changes', async () => {
  const { app } = harness();
  app.stickerPrewarmWanted = true;
  for (let i = 0; i < 8; i++) { const id = String(i); app.savedStickerIds.add(id); app.stickerLibraryMeta.set(id, { ...meta(id), byteSize: 5 * 1024 * 1024 }); }
  let reads = 0;
  app.loadStickerAsset = async () => { reads++; await flush(); return {}; };
  await app.prewarmStickerAssets();
  assert.equal(reads, 2);
  for (const record of app.stickerLibraryMeta.values()) record.byteSize = 1024;
  reads = 0;
  app.loadStickerAsset = async () => { reads++; app.currentUser = null; await flush(); };
  await app.prewarmStickerAssets();
  assert.equal(reads, 1);
});

test('picker loads its first rows immediately, keeps rendered tiles, and defers distant media', async () => {
  const { app, elements, observers } = harness();
  for (let i = 0; i < 20; i++) app.stickerLibraryMeta.set(String(i), meta(String(i)));
  let reads = 0;
  app.loadStickerAsset = async record => { reads++; return { url: 'blob:' + record.id }; };
  app.renderStickerMenu();
  const originalTiles = [...elements['sticker-grid'].children];
  assert.equal(reads, 6);
  await flush();
  assert.equal(originalTiles[0].querySelector('img').loading, 'eager');
  assert.equal(observers.find(o => o.options.root === elements['sticker-grid']).targets.size, 14);
  app.renderStickerMenu();
  assert.equal(reads, 6);
  assert.deepEqual(elements['sticker-grid'].children, originalTiles);
  const image = originalTiles[0].querySelector('img');
  elements['sticker-search'].value = '0';
  app.renderStickerMenu();
  assert.equal(elements['sticker-grid'].children[0], originalTiles[0]);
  assert.equal(elements['sticker-grid'].children[0].querySelector('img'), image);
});

test('context menu uses shared surface, stays inside viewport, and Escape returns to picker', () => {
  const { app, elements, document, flushTimers } = harness();
  app.stickerPopoverOpen = true;
  const anchor = elements['btn-stickers'];
  const menu = elements['sticker-context-menu'];
  app.openStickerContextMenu(meta(), 389, 699, anchor);
  assert.equal(menu.parentElement, document.body);
  assert.equal(menu.classList.contains('msg-menu'), true);
  assert.equal(menu.classList.contains('open'), true);
  assert.ok(parseInt(menu.style.left) + menu.offsetWidth <= 380);
  assert.ok(parseInt(menu.style.top) + menu.offsetHeight <= 690);
  document.fire('keydown', { key: 'ArrowDown' });
  assert.equal(document.activeElement, menu.children[1]);
  document.fire('keydown', { key: 'Escape' });
  assert.equal(app.stickerPopoverOpen, true);
  assert.equal(document.activeElement, anchor);
  assert.equal(menu.classList.contains('closing'), true);
  flushTimers();
  assert.equal(menu.hidden, true);
});

test('account teardown removes retained tiles so revoked image URLs cannot survive into another session', async () => {
  const { app, elements } = harness();
  app.stickerLibraryMeta.set('one', meta());
  app.loadStickerAsset = async () => ({ url: 'blob:old-user' });
  app.renderStickerMenu();
  await flush();
  assert.equal(elements['sticker-grid'].children.length, 1);
  app.teardownStickerRuntime();
  assert.equal(elements['sticker-grid'].children.length, 0);
  assert.equal(app.stickerLibraryMeta.size, 0);
  assert.equal(app.stickerPrewarmWanted, false);
});

test('context menu dismisses on outside click, scrolling and selection, with reopen-safe animation cleanup', () => {
  const { app, elements, document, window, flushTimers } = harness();
  app.stickerPopoverOpen = true;
  const menu = elements['sticker-context-menu'];
  const open = () => app.openStickerContextMenu(meta(), 80, 80);
  open();
  document.fire('pointerdown', { target: menu.children[0] });
  assert.equal(menu.classList.contains('open'), true);
  assert.equal(app.stickerPopoverOpen, true);
  document.fire('pointerdown', { target: elements['sticker-grid'] });
  assert.equal(menu.classList.contains('closing'), true);
  open();
  flushTimers();
  assert.equal(menu.hidden, false);
  document.fire('scroll', { target: elements['sticker-grid'] });
  flushTimers();
  assert.equal(menu.hidden, true);
  let unsaved = '';
  app.unsaveSticker = async id => { unsaved = id; };
  open();
  menu.children[0].fire('click');
  flushTimers();
  assert.equal(unsaved, 'one');
  assert.equal(menu.hidden, true);
  open();
  window.fire('blur');
  assert.equal(menu.hidden, true);
});
