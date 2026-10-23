const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createContentHandler, isSignedB2UploadURL, configureB2UploadCors } = require('../content-server.cjs');

test('native host serves the selected web release without caching or injecting UI', async t => {
  const fixtureRoot = path.resolve(__dirname, '../../../../updater-test-fixtures');
  await fs.mkdir(fixtureRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(fixtureRoot, 'content-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'first'), next = path.join(dir, 'next');
  await fs.mkdir(first); await fs.mkdir(next);
  const oldUI = '<html><body>Previous shared UI</body></html>';
  const newUI = '<html><body><span id="call-in-call">Shared roster</span></body></html>';
  await fs.writeFile(path.join(first, 'index.html'), oldUI);
  await fs.writeFile(path.join(next, 'index.html'), newUI);
  let selected = first;
  const handler = createContentHandler(() => selected, { fetch: async url => new Response(await fs.readFile(fileURLToPath(url))) });
  const request = { url: 'chatapp://app/index.html', method: 'GET', headers: {} };
  assert.equal(await (await handler(request)).text(), oldUI);
  selected = next;
  const response = await handler(request);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(await response.text(), newUI, 'shared file bytes are served unchanged');
});

function signedUploadURL(kind = 'attachments') {
  const url = new URL(`https://s3.us-west-004.backblazeb2.com/chat-app-files/${kind}/room_1/message_2/file-3`);
  for (const [name, value] of Object.entries({
    Algorithm: 'AWS4-HMAC-SHA256', Credential: 'key-id/20261014/us-west-004/s3/aws4_request',
    Date: '20261014T120000Z', Expires: '300', SignedHeaders: 'content-type;host', Signature: 'a'.repeat(64)
  })) url.searchParams.set('X-Amz-' + name, value);
  return url.href;
}

function corsFixture() {
  let listener, outgoing, filter;
  const mainFrame = { url: 'chatapp://app/index.html' };
  const contents = { id: 7, mainFrame, isDestroyed: () => false, getURL: () => mainFrame.url };
  configureB2UploadCors({ webRequest: { onHeadersReceived: (value, callback) => { filter = value; listener = callback; }, onBeforeSendHeaders: (_value, callback) => { outgoing = callback; } } }, () => contents);
  const details = {
    method: 'PUT', url: signedUploadURL(), webContentsId: 7, webContents: contents,
    frame: mainFrame, initiatorOrigin: 'chatapp://app', resourceType: 'xhr',
    statusCode: 200, responseHeaders: { 'Access-Control-Allow-Origin': ['null'], ETag: ['"file-etag"'], Vary: ['Origin'] }
  };
  const receive = overrides => { let result; listener({ ...details, ...overrides }, value => { result = value; }); return result; };
  const send = overrides => { let result; outgoing({ ...details, requestHeaders: { Origin: 'chatapp://app', 'Content-Type': 'text/plain' }, ...overrides }, value => { result = value; }); return result; };
  return { details, contents, mainFrame, filter, receive, send };
}

test('desktop B2 compatibility normalizes successful signed chat and HTML uploads and preflights', () => {
  const { details, filter, receive } = corsFixture();
  assert.deepEqual(filter, { urls: ['https://*.backblazeb2.com/*'] });
  for (const kind of ['attachments', 'html']) for (const method of ['PUT', 'OPTIONS']) {
    const result = receive({ url: signedUploadURL(kind), method });
    assert.deepEqual(result, { responseHeaders: {
      ...details.responseHeaders, 'Access-Control-Allow-Origin': ['*'], ...(method === 'OPTIONS' ? { 'Access-Control-Allow-Methods': ['PUT, OPTIONS'], 'Access-Control-Allow-Headers': ['Content-Type'] } : {})
    } });
  }
  assert.deepEqual(details.responseHeaders['Access-Control-Allow-Origin'], ['null'], 'input headers are not mutated');
});

test('desktop B2 compatibility repairs missing or invalid response CORS while retaining server errors', () => {
  const { receive } = corsFixture();
  for (const responseHeaders of [
    {}, { 'Access-Control-Allow-Origin': ['*'] }, { 'Access-Control-Allow-Origin': ['https://example.com'] },
    { 'Access-Control-Allow-Origin': ['null', '*'] },
    { 'Access-Control-Allow-Origin': ['null'], 'access-control-allow-origin': ['null'] }
  ]) {
    const corrected = receive({ responseHeaders }).responseHeaders;
    assert.deepEqual(corrected['Access-Control-Allow-Origin'], ['*']);
    assert.equal(Object.keys(corrected).filter(key => key.toLowerCase() === 'access-control-allow-origin').length, 1);
  }
  assert.deepEqual(receive({ responseHeaders: { 'access-control-allow-origin': ['null'], 'x-test': ['retained'] } }), {
    responseHeaders: { 'Access-Control-Allow-Origin': ['*'], 'x-test': ['retained'] }
  });
  for (const statusCode of [301, 400, 401, 403, 404, 429, 500, 503]) assert.deepEqual(receive({ statusCode }), {});
});

test('desktop B2 compatibility excludes subframes, other windows, opaque origins and navigated app pages', () => {
  const { receive, contents, mainFrame } = corsFixture();
  for (const override of [
    { initiatorOrigin: 'null' }, { initiatorOrigin: 'https://example.com' },
    { webContentsId: 8 }, { webContentsId: undefined }, { webContents: {} },
    { frame: { url: mainFrame.url } }
  ]) assert.deepEqual(receive(override), {});
  mainFrame.url = 'https://example.com';
  assert.deepEqual(receive(), {});
  mainFrame.url = 'chatapp://app/index.html';
  contents.isDestroyed = () => true;
  assert.deepEqual(receive(), {});
});

test('desktop signed-upload matching tolerates optional Electron metadata without trusting foreign frames', () => {
  const { receive, send } = corsFixture();
  for (const method of ['PUT', 'OPTIONS']) for (const override of [
    { initiatorOrigin: undefined }, { webContents: undefined }, { frame: undefined }, { frame: null },
    { initiatorOrigin: undefined, webContents: undefined, frame: null }
  ]) {
    assert.deepEqual(receive({ method, ...override, responseHeaders: {} }).responseHeaders['Access-Control-Allow-Origin'], ['*']);
    assert.deepEqual(send({ method, ...override }).requestHeaders, { Origin: 'null', 'Content-Type': 'text/plain' });
  }
  for (const override of [{ initiatorOrigin: 'https://attacker.test' }, { frame: {} }, { webContentsId: 8 }, { webContentsId: undefined }]) {
    assert.deepEqual(receive(override), {}); assert.deepEqual(send(override), {});
  }
  const signedOrigin = new URL(signedUploadURL()); signedOrigin.searchParams.set('X-Amz-SignedHeaders', 'content-type;host;origin');
  assert.deepEqual(send({ url: signedOrigin.href }), {}, 'never alter a header included in a request signature');
});

test('desktop B2 compatibility rejects unsigned, mismatched or unrelated storage requests', () => {
  const { receive } = corsFixture();
  assert.equal(isSignedB2UploadURL(signedUploadURL()), true);
  for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) assert.deepEqual(receive({ method }), {});
  for (const change of [
    url => { url.protocol = 'http:'; },
    url => { url.hostname = 's3.us-west-004.backblazeb2.com.attacker.example'; },
    url => { url.hostname = 's3.us-west-999.backblazeb2.com'; },
    url => { url.hostname = 'other.backblazeb2.com'; },
    url => { url.username = 'user'; }, url => { url.port = '8443'; }, url => { url.hash = 'extra'; },
    url => { url.pathname = '/chat-app-files/other/file'; },
    url => { url.searchParams.delete('X-Amz-Signature'); },
    url => { url.searchParams.append('X-Amz-Signature', 'a'.repeat(64)); },
    url => { url.searchParams.set('X-Amz-Signature', 'unsigned'); },
    url => { url.searchParams.set('X-Amz-Algorithm', 'different'); },
    url => { url.searchParams.set('X-Amz-Expires', '0'); },
    url => { url.searchParams.set('X-Amz-Expires', '604801'); },
    url => { url.searchParams.set('X-Amz-Date', '20261015T120000Z'); },
    url => { url.searchParams.set('X-Amz-SignedHeaders', 'content-type'); }
  ]) {
    const url = new URL(signedUploadURL()); change(url);
    assert.equal(isSignedB2UploadURL(url.href), false, url.href);
    assert.deepEqual(receive({ url: url.href }), {});
  }
});
