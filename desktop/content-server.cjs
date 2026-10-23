'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

function resolveContentPath(root, url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'chatapp:' || parsed.hostname !== 'app' || parsed.port || parsed.username || parsed.password) return null;
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { return null; }
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.includes(':')) return null;
  const relative = pathname.replace(/^\/+/, '') || 'index.html';
  const result = path.resolve(root, relative);
  const base = path.resolve(root) + path.sep;
  return result.startsWith(base) ? result : null;
}

function createContentHandler(getRoot, net) {
  return async request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    const root = getRoot();
    if (!root) return new Response('App is starting', { status: 503 });
    const file = resolveContentPath(root, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(file).href, { method: request.method, headers: request.headers });
      // The same chatapp URL can point to a new GitHub release after restart.
      // Never let a prior release's CSS/JS shadow the selected shared web files.
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch { return new Response('Not found', { status: 404 }); }
  };
}

function isSignedB2UploadURL(value) {
  try {
    const url = new URL(value);
    const host = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(url.hostname);
    if (url.protocol !== 'https:' || !host || url.port || url.username || url.password || url.hash) return false;
    if (!/^\/[A-Za-z0-9-]{6,63}\/(attachments|html)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(url.pathname)) return false;
    const values = {};
    for (const name of ['Algorithm', 'Credential', 'Date', 'Expires', 'SignedHeaders', 'Signature']) {
      const matches = url.searchParams.getAll('X-Amz-' + name);
      if (matches.length !== 1) return false;
      values[name] = matches[0];
    }
    const scope = /^[^/\s]{1,256}\/(\d{8})\/([a-z0-9-]+)\/s3\/aws4_request$/.exec(values.Credential);
    return values.Algorithm === 'AWS4-HMAC-SHA256' && !!scope && scope[2] === host[1] &&
      /^\d{8}T\d{6}Z$/.test(values.Date) && values.Date.startsWith(scope[1]) &&
      /^\d{1,6}$/.test(values.Expires) && Number(values.Expires) > 0 && Number(values.Expires) <= 604800 &&
      /^[a-fA-F0-9]{64}$/.test(values.Signature) &&
      /^(?:[a-z0-9-]+;)*host(?:;[a-z0-9-]+)*$/.test(values.SignedHeaders);
  } catch { return false; }
}

function isAppMainFrameRequest(details, contents) {
  try {
    if (!contents || contents.isDestroyed() || details.webContentsId !== contents.id ||
      (details.webContents != null && details.webContents !== contents) ||
      (details.frame != null && details.frame !== contents.mainFrame) ||
      (details.initiatorOrigin != null && details.initiatorOrigin !== 'chatapp://app')) return false;
    const url = new URL(contents.getURL());
    const frameURL = new URL(contents.mainFrame?.url);
    return [url, frameURL].every(value => value.protocol === 'chatapp:' && value.host === 'app' && !value.username && !value.password);
  } catch { return false; }
}

function configureB2UploadCors(ses, getContents) {
  // Chromium's custom scheme can produce missing/opaque CORS response headers
  // for otherwise authorized signed uploads. This compatibility rule is limited
  // to successful PUT/preflight responses from the active app's signed B2 URL.
  // Electron may omit frame/initiator metadata on a preflight; the WebContents
  // ID and its current main-frame origin still have to identify this app.
  const filter = { urls: ['https://*.backblazeb2.com/*'] };
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (!['PUT', 'OPTIONS'].includes(details.method) || !isSignedB2UploadURL(details.url) ||
      !isAppMainFrameRequest(details, getContents()) || new URL(details.url).searchParams.get('X-Amz-SignedHeaders').split(';').includes('origin')) return callback({});
    const requestHeaders = { ...details.requestHeaders };
    for (const key of Object.keys(requestHeaders)) if (key.toLowerCase() === 'origin') delete requestHeaders[key];
    // B2 supports the standard opaque web origin; its custom-scheme parser does
    // not consistently accept chatapp://app across regional endpoints.
    requestHeaders.Origin = 'null'; callback({ requestHeaders });
  });
  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    if (!['PUT', 'OPTIONS'].includes(details.method) || !isSignedB2UploadURL(details.url) ||
      !isAppMainFrameRequest(details, getContents()) || details.statusCode < 200 || details.statusCode >= 300) return callback({});
    const headers = details.responseHeaders || {};
    const responseHeaders = { ...headers };
    const set = (name, value) => {
      for (const key of Object.keys(responseHeaders)) if (key.toLowerCase() === name.toLowerCase()) delete responseHeaders[key];
      responseHeaders[name] = [value];
    };
    set('Access-Control-Allow-Origin', '*');
    if (details.method === 'OPTIONS') { set('Access-Control-Allow-Methods', 'PUT, OPTIONS'); set('Access-Control-Allow-Headers', 'Content-Type'); }
    callback({ responseHeaders });
  });
}

module.exports = { resolveContentPath, createContentHandler, isSignedB2UploadURL, configureB2UploadCors };
