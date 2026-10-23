# Chat App — 2026.10.23-1

File uploads default to **100 MB per file**. Vinny can change the numeric MB value in **Admin Panel → File Upload Limit**, directly below Update URL. The field saves valid positive values as they are typed to `admin/fileUploadLimitMB` in Firebase and updates connected clients in real time. There is no separate save button or extra caption. Existing files remain readable after the limit is lowered.

**Deploy the updated storage Worker code below once** to remove its old fixed 100 MB ceiling. The updated Worker reads the current Firebase limit for each upload request; later Admin Panel changes need no redeployment. This archive updates source only and does not deploy your Worker. Desktop file chooser/drop uploads use the shared policy; Explorer clipboard pasting above 100 MB also needs a rebuild from the updated desktop source. No EXE is included in this source archive.

The included desktop source remains version **1.7.4** and retains the prior popup, navigation and camera sound fixes. Shared web changes continue through the existing GitHub updater. See RELEASE-NOTES.md and VALIDATION.md for this release.

This source package uses **chatappv6-e9da9** and https://chatappv6-e9da9-default-rtdb.firebaseio.com. Existing v6 accounts, rooms and content remain compatible. The old pre-v6 project is not contacted. Account creation is enabled when its database setting is absent; Vinny can still disable it. The username exactly `Vinny` retains the existing admin tools.

## Firebase rules to paste

Open the new project's Realtime Database → Rules, replace the existing rules with this JSON, then click Publish:

```json
{
  "rules": {
    ".read": true,
    ".write": true,
    "activities": {
      "boplRoyale": {
        "rooms": {
          "$room": {
            "events": { ".indexOn": ["at"] }
          }
        }
      }
    }
  }
}
```

These rules have no expiry and allow anyone to read, edit, or delete all data, as requested. The Vinny check controls the app's UI; public rules do not enforce that check or protect accounts. The event index avoids downloading an entire game event collection for its cleanup query. This ZIP does not publish Firebase rules or change production data.

## Upload one top-level folder at a time

Extract chat.zip. From your GitHub repository root, drag each top-level folder into Upload files separately. Upload the 16 loose root files together, including `.nojekyll`. Keep `index.html` at the repository root; the ZIP has no extra enclosing folder.

All **463 original files and paths** are preserved, with no added or removed files. Every top-level folder, including its subfolders, is below 100 files:

| Folder | Files |
| --- | ---: |
| activities | 19 |
| activity-modules | 9 |
| assets | 11 |
| backend | 5 |
| call-modules | 17 |
| css | 33 |
| desktop | 74 |
| js | 83 |
| scripts | 1 |
| tests | 92 |
| unread-icons | 50 |
| unread-icons-extra | 50 |
| vendor | 3 |

The original ZIP already had this arrangement. GitHub's browser limit applies to the entire upload selection, so do not select all folders together. GitHub Desktop/Git can commit the whole project in one operation. [GitHub upload documentation](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository).

Upload feature folders first and the root entry/revision files last. Refresh clients after all files are uploaded. Browser assets have a new revision so caches fetch this release.

## What changed in this release

- Added the minimal File Upload Limit field below Update URL, with automatic Firebase saves and realtime updates for all clients. The default remains 100 MB; positive decimal MB values and values above 100 are supported.
- File selection, drop, paste, sending, voice imports and external uploads use the current limit. Existing uploaded descriptors remain readable when the limit decreases.
- The documented storage Worker checks the current Firebase value for each sign/completion request, with no cached policy. Update the deployed Worker once to enable this behavior.
- The desktop clipboard bridge source forwards the current byte limit and remains compatible with older callers. Rebuild the native app to update that bridge; existing EXEs can use Upload or drag-and-drop above their older clipboard limit.
- All 463 original files and paths are retained, with each top-level folder below GitHub's 100-file browser selection limit. Asset revisions and packaging timestamps are refreshed.

## Earlier included updates

- PDF, DOCX, PPTX, HTML and text previews scroll naturally without custom zoom controls or wheel interception. Office pages still fit the available width automatically. Image and video zoom remain available.
- Call zoom starts at 100% and is available only on focused screens/cameras, fullscreen screens and individual feeds in Multi Screen View. Zoomed feeds can be dragged inside their fixed viewport. A click toggles the viewer controls; completing a drag does not. Fullscreen does not toggle controls.
- Each viewed feed has its own zoom/pan state. Leaving focus, fullscreen or Multi Screen View resets it. Wheel and pointer updates are coalesced to animation frames, reuse cached geometry and transform the original video without rerendering the call roster. Zoom cannot restore detail absent from the transmitted video.
- Multi Screen View has transparent tile backgrounds and compact labels, attached viewers buttons and zoom percentages. Individual minimize/fullscreen/close actions remain hidden. Zoom and viewers controls are half their former size. The multi-view button sits left of Show Chat and uses the same button styling; the chat tooltip becomes Hide Chat while open.
- Blackout cloak uses the active saved shortcut, with Shift+Z as the default. Custom chords such as S+X work immediately and after reload. Shortcut recording can include Escape, and Escape no longer dismisses application modals.

The preceding update's password fixes, file preview formats, voice import/recording, fullscreen video layout, manual screen Pause/Resume, remote-user mute, mobile companion chat, attachment embed improvements and send icon remain included. The storage Worker now reads the configurable Firebase upload limit; B2 configuration is unchanged.

See `VALIDATION.md` for checks and boundaries. All 463 file paths and the folder upload layout are preserved; entry assets use a new cache revision. Native source version remains 1.7.4; the clipboard bridge source accepts the configured upload limit. No cloud configuration was deployed.

## Previous native upload release (1.7.2)

- Native version **1.7.2** fixes chat attachment and HTML Hub uploads from the desktop app. Backblaze returns `Access-Control-Allow-Origin: null` for `chatapp://app`; the native host corrects only that header on signed B2 uploads from the trusted app main frame. Browser security remains enabled.
- This fix requires replacing the EXE once. The existing portable launcher, opening behavior and GitHub web-update system remain in place. The fix is built from `desktop/content-server.cjs` and `desktop/main.cjs` in this ZIP, not injected into an executable. Worker and bucket settings do not need changing for this native fix.
- New message attachments and HTML Hub files use external binary object storage. Realtime Database keeps compact references and cleanup indexes, never these new file bodies. Existing RTDB files still open and delete correctly.
- Message attachments default to **100 MB (100 × 1024 × 1024 bytes)** per file. Vinny can change the limit live in the Admin Panel. File counts are unchanged, and voice imports follow the configured size limit.
- New accounts have random permanent IDs independent of their login password. Existing account IDs remain stable so messages and ownership stay linked. A field such as createdBy is an ownership ID, not the current password: changing a password must not replace it with a new secret. Display names resolve from the current account; room labels resolve from the current room record. Name claims and edits handle conflicts without dropping the old claim.
- Signup asks for Username and initializes username and display name together. Login says Enter your password. Sidebar defaults to Left while respecting explicitly saved Right preferences.
- Chat clearing removes unpinned messages and their external objects. Pinned messages and their files remain, matching the existing app behavior. Unpin and clear again to remove them. Deletion errors are reported and the cleanup index remains available for retry.

## Free external file storage — setup required once

Use **Backblaze B2 Cloud Storage + Cloudflare Workers Free**. No Firebase Storage, R2, paid Worker plan or Firebase Functions deployment is required. B2 includes the first 10 GB of storage; Workers Free includes 100,000 requests per day. Downloads travel through the Worker to use the Backblaze/Cloudflare free-transfer integration. Free storage is finite: 10 GB is roughly 95 files at the maximum 100 MiB size, or many more smaller files. There is no unlimited permanent free cloud storage promise. Keep the accounts free and without a billing method; if a screen requires payment, stop instead of upgrading. B2 public buckets may require a payment history, so **create a private bucket** and use the Worker below.

Sources: [B2 pricing](https://www.backblaze.com/cloud-storage/pricing), [private buckets and public-bucket requirements](https://www.backblaze.com/docs/cloud-storage-create-and-manage-buckets), [B2/Cloudflare free transfers](https://www.backblaze.com/docs/cloud-storage-cloudflare-integrations), [Workers Free pricing](https://developers.cloudflare.com/workers/platform/pricing/).

1. Create a free B2 Cloud Storage account at Backblaze. Do not purchase Computer Backup. Leave billing unset and keep the free caps; in Caps & Alerts keep any spending caps at $0. Quota exhaustion should stop requests, not trigger an upgrade. Free plans also have API-operation limits.
2. Create a **new private bucket just for this app**, for example a unique name beginning chatapp-files-. Do not enable Object Lock or retention rules that prohibit deletion. Note its S3 endpoint, such as https://s3.us-west-004.backblazeb2.com; the middle part is the region. Do not set rules that expire current files if you want long-term retention.
3. Create an application key restricted to that bucket, with read/write/list/delete permissions. Save its keyID and applicationKey privately. The Worker needs to list and permanently delete object versions. Never paste these secrets into GitHub, call-config.js, Firebase, screenshots or chat.
4. Enable browser PUT uploads on the bucket. The simple web-console download CORS option is insufficient. Install the official [B2 command-line tool](https://www.backblaze.com/docs/cloud-storage-command-line-tools), then run its interactive account authorization locally using a key allowed to update bucket CORS. Use your master key only for this local setup if necessary, never in the app. The [official CORS guide](https://help.backblaze.com/hc/en-us/articles/360010522673-B2-CLI-CORS-rules-in-the-command-line) documents this step; the [current CLI reference](https://b2-command-line-tool.readthedocs.io/en/master/subcommands/bucket_update.html) confirms the command syntax below. In **PowerShell 7.3 or newer**, with the downloaded executable renamed b2.exe:

```powershell
.\b2.exe account authorize
$chatCors = '[{"corsRuleName":"chat-app-direct-uploads","allowedOrigins":["*"],"allowedHeaders":["content-type"],"allowedOperations":["s3_put"],"exposeHeaders":["etag"],"maxAgeSeconds":3600}]'
.\b2.exe bucket update --cors-rules $chatCors YOUR_BUCKET_NAME allPrivate
.\b2.exe account clear
```

The wildcard allows browser origins to send an already signed PUT. Native version 1.7.3 handles signed-upload custom origins, missing optional Electron request metadata, and successful opaque CORS responses. The rule does not make the B2 bucket public. This command replaces CORS on the new dedicated bucket only. If you use a different shell, follow its argument-quoting instructions from the linked guide.

5. Create a **Cloudflare Workers Free** account and a Worker with a workers.dev address. Open Edit Code, replace the default module with the complete Worker code at the end of this README, and deploy it. There is no package install or build step for the Worker. Keep the Free plan; no R2 bucket is needed.
6. In the Worker's Settings → Variables and Secrets, set B2_KEY_ID and B2_APP_KEY as **secrets**. Set B2_BUCKET to your bucket name, B2_REGION to its region (for example us-west-004), and ALLOWED_ORIGINS to a comma-separated list of app origins. Example: https://YOURNAME.github.io,null,chatapp://app. An origin has no repository path or trailing slash; null permits local file openings. Use the actual desktop origin if it differs. Redeploy after saving settings.
7. Set only the public Worker URL in the existing call-config.js:

```javascript
globalThis.CHAT_FILE_CONFIG = globalThis.CHAT_FILE_CONFIG || {
  endpoint: 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev'
};
```

8. Open that URL with /health appended. It should report ready:true. This checks configuration shape; the actual upload below also tests B2 credentials and CORS. Upload all updated app folders and root files to GitHub, then reload every client. Older clients could otherwise continue writing RTDB file bytes.
9. Upload a small attachment, open/download it from a second browser or phone, and upload/open an HTML Hub file. Clear an unpinned attachment message's chat, then check that the B2 object is gone, including old versions. Delete the HTML item and check that its objects disappear too. Test a larger video on your actual connection. Earlier release notes reported isolated live uploads. This release validates upload behavior with isolated tests; the deployed Worker/B2 service and affected users’ networks still need a live acceptance check.

Until endpoint setup is complete, new attachment/HTML uploads show a clear setup message and do not fall back to filling RTDB. Text chat, old attachments and the other existing features remain available. The Worker intentionally follows the existing public read/write model: CORS is not authentication, and anyone able to call its API can consume the free quota. Free-plan limits can interrupt service; check both dashboards periodically.

## Transfer speed, clearing and retention

Files go as their original binary bytes directly from the browser to B2 using a short-lived signed PUT. The app does not base64-encode, proxy the upload through a Worker, or impose the old 32 MiB/minute RTDB pacing. A server HEAD verifies size before a message or HTML entry becomes available to everyone. Media reads support byte ranges through the Worker, so a phone can stream video without downloading the entire file first.

33 MB in three seconds and 100 MB in eight seconds require roughly 90–105 Mbps of upstream capacity before overhead. Network conditions, device suspension and provider latency prevent a guaranteed time. Ordinary mobile File/Blob uploads and progress are supported; keep the tab open during upload. There is no unmeasured three-second or eight-second claim.

Clear operates on a snapshot of attachment message IDs, preserves pins and messages that arrive after the cutoff, and deletes every stored B2 version under each removed message. It does not just hide objects with S3 delete markers. If deletion fails, the app reports it and keeps compact references so Clear can retry. HTML deletion removes external content before removing its database reference. Normal cancellation/failure attempts object cleanup. A force-closed tab or network loss at exactly the storage/RTDB handoff can still leave an orphan because the services cannot share an atomic transaction; inspect and remove abandoned objects in the dedicated B2 bucket when needed. No background process silently expires saved files or paid service is required.

Existing legacy RTDB uploads are not automatically copied elsewhere, avoiding a large download/reupload and unexpected quota use. Clearing their messages still deletes the legacy payloads. Stickers, small profile/settings media, live game state and normal chat records retain their current storage behavior. The app's previous targeted listeners, sparse settings writes and paginated history remain in place.

## Desktop and verification

This source ZIP accompanies the freshly rebuilt **Chat App.exe 1.7.2**; web version is **2026.10.14-3**. Upload the source folders to the existing GitHub repository and replace the old EXE with the new one. Later compatible web updates continue to load through the existing updater. If distributing through the Admin Panel's native Update URL, publish the new EXE at a new HTTPS URL and save that URL so its version is recorded as 1.7.2. No Firebase rules, existing user data, storage settings or cloud deployments are changed by this archive.

Build with `npm.cmd --prefix desktop ci` followed by `npm.cmd --prefix desktop run dist`. The existing launcher uses standard .NET ZIP and process APIs and does not launch PowerShell scripts. No antivirus exclusions, disabled protections, obfuscation, or security bypass switches are added. The build is unsigned because no signing certificate is configured; antivirus false-positive behavior cannot be guaranteed.

Run npm ci and npm test. Tests use local Firebase and external-storage fixtures; see VALIDATION.md for actual checks. build-info.json and every ZIP entry get the current packaging timestamp. All 463 original paths are preserved. The Worker is included below inside this existing README to avoid adding a file.

## Cloudflare Worker source

Copy the complete code block below into the Cloudflare Worker editor. Secrets are supplied through Worker settings, not inserted into this source.

<!-- BEGIN STORAGE WORKER -->
```javascript
// Paste this entire module into a Cloudflare Workers Free worker.
// B2_KEY_ID and B2_APP_KEY are Worker secrets, never browser configuration.
const encoder = new TextEncoder();
const DEFAULT_FILE_LIMIT_MB = 100;
const FILE_LIMIT_URL = 'https://chatappv6-e9da9-default-rtdb.firebaseio.com/admin/fileUploadLimitMB.json';
async function readFileLimit() {
  let value;
  try {
    const response = await fetch(FILE_LIMIT_URL, {cache:'no-store', headers:{'Cache-Control':'no-cache'}});
    if (!response.ok) throw new Error('Firebase settings unavailable.');
    value = await response.json();
  } catch {
    throw Object.assign(new Error('The File Upload Limit could not be loaded. Please retry.'), {status:503});
  }
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  const number = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ? Number(text) : NaN;
  const bytes = Math.floor(number * 1024 * 1024);
  const megabytes = Number.isFinite(number) && number > 0 && Number.isSafeInteger(bytes) && bytes >= 1 ? number : DEFAULT_FILE_LIMIT_MB;
  return {megabytes, bytes:Math.floor(megabytes * 1024 * 1024)};
}
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hex = value => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const validKey = key => typeof key === 'string' && key.length <= 400 && /^(attachments|html)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(key);
const decodeXML = value => String(value || '').replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[entity]);
const xmlValue = (xml, name) => decodeXML(xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'))?.[1]);
async function hmac(key, text) {
  const imported = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return crypto.subtle.sign('HMAC', imported, encoder.encode(text));
}
let keyCache;
async function signS3(env, method, key = '', query = {}, contentType = '') {
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = now.slice(0, 8), scope = `${day}/${env.B2_REGION}/s3/aws4_request`;
  const endpoint = `https://s3.${env.B2_REGION}.backblazeb2.com`;
  const pathname = '/' + encode(env.B2_BUCKET) + '/' + key.split('/').map(encode).join('/');
  const signedHeaders = contentType ? 'content-type;host' : 'host';
  const params = { ...query, 'X-Amz-Algorithm':'AWS4-HMAC-SHA256', 'X-Amz-Credential':`${env.B2_KEY_ID}/${scope}`,
    'X-Amz-Date':now, 'X-Amz-Expires':'300', 'X-Amz-SignedHeaders':signedHeaders };
  const canonicalQuery = Object.entries(params).map(([k,v]) => [encode(k),encode(String(v))]).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).map(pair => pair.join('=')).join('&');
  const canonicalHeaders = (contentType ? `content-type:${contentType}\n` : '') + `host:s3.${env.B2_REGION}.backblazeb2.com\n`;
  const canonical = [method, pathname, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const hash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(canonical)));
  if (!keyCache || keyCache.day !== day || keyCache.id !== env.B2_KEY_ID || keyCache.secret !== env.B2_APP_KEY || keyCache.region !== env.B2_REGION) {
    const dateKey = await hmac('AWS4' + env.B2_APP_KEY, day);
    const regionKey = await hmac(dateKey, env.B2_REGION);
    const serviceKey = await hmac(regionKey, 's3');
    keyCache = { day, id:env.B2_KEY_ID, secret:env.B2_APP_KEY, region:env.B2_REGION, key:await hmac(serviceKey, 'aws4_request') };
  }
  const signature = hex(await hmac(keyCache.key, `AWS4-HMAC-SHA256\n${now}\n${scope}\n${hash}`));
  return `${endpoint}${pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
async function storage(env, method, key = '', query = {}, headers = {}) {
  const response = await fetch(await signS3(env, method, key, query), {method, headers, redirect:'manual'});
  if (!response.ok) {
    const error = new Error(`File storage returned ${response.status}. Check B2 credentials, permissions and free quota.`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  return response;
}
async function readJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('Request body required.'), {status:400});
  const chunks = []; let length = 0;
  for (;;) {
    const {value, done} = await reader.read(); if (done) break;
    length += value.length;
    if (length > 65536) { await reader.cancel(); throw Object.assign(new Error('Request too large.'), {status:413}); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw Object.assign(new Error('Invalid request JSON.'), {status:400}); }
}
async function deletePage(env, body) {
  const prefix = String(body.prefix || '');
  if (!validKey(prefix) || (body.exact !== true && !prefix.endsWith('/'))) throw Object.assign(new Error('Invalid deletion prefix.'), {status:400});
  const keep = body.keepPrefixes || [];
  if (!Array.isArray(keep) || keep.length > 1000 || keep.some(value => !validKey(value) || !value.startsWith(prefix) || !value.endsWith('/'))) {
    throw Object.assign(new Error('Invalid retained-file prefixes.'), {status:400});
  }
  const query = {versions:'', prefix, 'max-keys':'16'};
  if (body.cursor && body.cursor.restart !== true) {
    if (!validKey(body.cursor.key) || !body.cursor.key.startsWith(prefix) || typeof body.cursor.version !== 'string' || body.cursor.version.length > 1024) {
      throw Object.assign(new Error('Invalid continuation.'), {status:400});
    }
    query['key-marker'] = body.cursor.key;
    query['version-id-marker'] = body.cursor.version;
  }
  const listing = await storage(env, 'GET', '', query);
  const xml = await listing.text();
  if (!xml.includes('<ListVersionsResult')) throw new Error('Invalid storage listing.');
  const versions = [...xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)].map(match => ({key:xmlValue(match[2], 'Key'),version:xmlValue(match[2], 'VersionId')}));
  let deleted = 0;
  // Explicit version IDs permanently free bytes. Plain S3 DELETE only adds a
  // delete marker, which would leave the old file consuming storage.
  for (const file of versions) {
    if (!validKey(file.key) || !file.key.startsWith(prefix) || !file.version) throw new Error('Invalid object version.');
    if ((body.exact === true && file.key !== prefix) || keep.some(value => file.key.startsWith(value))) continue;
    const response = await storage(env, 'DELETE', file.key, {versionId:file.version});
    await response.body?.cancel(); deleted++;
  }
  let cursor = null;
  if (xmlValue(xml, 'IsTruncated') === 'true') {
    if (deleted > 0) cursor = {restart:true}; // Never continue from a deleted version marker.
    else {
      cursor = { key:xmlValue(xml,'NextKeyMarker'), version:xmlValue(xml,'NextVersionIdMarker') };
      if (!validKey(cursor.key) || !cursor.version || (cursor.key === body.cursor?.key && cursor.version === body.cursor?.version)) throw new Error('Storage continuation did not advance.');
    }
  }
  return {deleted,cursor};
}
export default {
  async fetch(request, env) {
    const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type, Range', 'Access-Control-Expose-Headers':'Content-Length, Content-Range, Accept-Ranges',
      'Access-Control-Max-Age':'86400', 'Cache-Control':'no-store' };
    const json = (value, status = 200) => new Response(JSON.stringify(value), {status,headers:{...cors,'Content-Type':'application/json'}});
    try {
      if (!env.B2_KEY_ID || !env.B2_APP_KEY || !/^[a-z0-9-]+$/.test(env.B2_REGION || '') || !/^[A-Za-z0-9-]{6,63}$/.test(env.B2_BUCKET || '')) {
        return json({error:'Worker storage configuration is incomplete.'}, 503);
      }
      const url = new URL(request.url);
      // CORS is a browser restriction, not authentication. This intentionally
      // follows the app's public read/write model; keep B2 spending caps at $0.
      if (request.method === 'POST' || request.method === 'OPTIONS') {
        const origins = String(env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
        if (!origins.includes(request.headers.get('Origin') || '')) return json({error:'This app origin is not enabled for uploads.'}, 403);
      }
      if (request.method === 'OPTIONS') return new Response(null, {status:204,headers:cors});
      if (request.method === 'GET' && url.pathname === '/health') return json({ready:true,provider:'b2-worker-v1',maxFileBytes:(await readFileLimit()).bytes});
      if (request.method === 'POST') {
        const body = await readJSON(request);
        if (url.pathname === '/sign') {
          const limit = await readFileLimit();
          if (!validKey(body.path) || body.path.length > 360 || body.path.endsWith('/') || !Number.isSafeInteger(body.size) || body.size < 0 || body.size > limit.bytes) return json({error:`Invalid file or size. Maximum ${limit.megabytes} MB.`}, 400);
          const objectKey = `${body.path}-${crypto.randomUUID()}`;
          const contentType = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(body.mimeType || '') ? body.mimeType : 'application/octet-stream';
          return json({objectKey,contentType,uploadURL:await signS3(env,'PUT',objectKey,{},contentType)});
        }
        if (url.pathname === '/complete') {
          const limit = await readFileLimit();
          if (!validKey(body.objectKey) || !Number.isSafeInteger(body.size) || body.size < 0 || body.size > limit.bytes) return json({error:`Invalid file reference. Maximum ${limit.megabytes} MB.`}, 400);
          const stored = await storage(env, 'HEAD', body.objectKey);
          if (!stored.headers.has('Content-Length') || Number(stored.headers.get('Content-Length')) !== body.size) return json({error:'The uploaded file size does not match. Retry the upload.'}, 409);
          return json({complete:true});
        }
        if (url.pathname === '/delete') return json(await deletePage(env, body));
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/objects/')) {
        const key = decodeURIComponent(url.pathname.slice('/objects/'.length));
        if (!validKey(key) || key.endsWith('/')) return json({error:'Invalid file reference.'}, 400);
        const headers = {};
        if (request.headers.has('Range')) headers.Range = request.headers.get('Range');
        const stored = await storage(env, request.method, key, {}, headers);
        const output = new Headers(cors);
        for (const name of ['Content-Type','Content-Length','Content-Range','Accept-Ranges','ETag','Last-Modified']) {
          if (stored.headers.has(name)) output.set(name,stored.headers.get(name));
        }
        output.set('X-Content-Type-Options','nosniff');
        output.set('Content-Security-Policy',"sandbox; default-src 'none'");
        // HTML runs only in the app's existing sandbox, never as Worker code.
        if (/html|svg|javascript|xml/i.test(output.get('Content-Type') || '')) output.set('Content-Disposition','attachment');
        return new Response(stored.body, {status:stored.status,headers:output});
      }
      return json({error:'Not found.'}, 404);
    } catch (error) {
      return json({error:error?.message || 'File storage is unavailable.'}, error?.status || 500);
    }
  }
};

```
<!-- END STORAGE WORKER -->
