# Application structure

`index.html` is the main application document for both direct local opening and an HTTPS deployment. The package uses ordinary browser scripts, relative asset paths, and an explicit module manifest. Running or editing it does not require a bundler, development server, or build step.

## Startup and shared state

1. `index.html` loads the runtime, public call configuration, module manifest, and `app.js`.
2. `app.js` loads the bundled Firebase SDK and the feature scripts. `js/runtime/loader.js` schedules independent feature downloads in parallel and lets the browser manage connections.
3. Each feature registers its methods on `globalThis.ChatApp` and supplies an initializer through `App.register(id, initializer)`.
4. `js/runtime/application.js` verifies the registrations, then runs initializers synchronously in `js/module-manifest.js` order. State initialization, DOM listeners, and subscriptions belong in these initializers.

Feature files receive `ChatApp` as the local `App` parameter. Cross-feature calls use `App.method()` and shared state uses `App.property`. Methods are registered before initialization begins, so an earlier initializer can call a method implemented in a later file. Its required state must still be initialized first.

The other runtime globals are `ChatRuntime` (loader), `ChatAppModules` (ordered manifest), `ChatActivities` (activity documents), and `firebase` (the bundled SDK). Calling also exposes `ChatCallPolicy`, `CHAT_CALL_CONFIG`, and `getChatCallDiagnostics()`; activity launch configurations and controllers retain their existing parent/iframe communication properties.

This arrangement separates editing responsibilities while retaining shared application state and existing cross-feature dependencies. Features are not independently isolated packages. Private helper state can live inside a feature's closure; shared state belongs on `App`. Add new application features to the manifest and preserve initialization dependencies when changing its order.

## Module map

| Location | Responsibility |
| --- | --- |
| `app.js` | Startup coordination and startup error display |
| `js/runtime/` | Script loading, application registration, and lazy activity loading |
| `js/core/` | Firebase configuration, shared validation, session state, formatter cache, and startup |
| `js/accounts/`, `js/admin/` | Account creation, login, logout, and administrative UI |
| `js/chat/` | Message rendering/history, sending, composer controls, mentions, presence, and menus |
| `js/rooms/` | Room navigation, lists, membership, management, and cached room metadata |
| `js/profiles/` | Avatars, profile editing, and profile/activity popovers |
| `call-modules/`, `js/calling/` | Call signaling, connections, media, quality, presence, lifecycle, and panel controls |
| `activity-modules/` | HTML library storage, activity claims, and embedded window management |
| `js/media/`, `js/stickers/` | Uploads, playback, recording, media viewers, and sticker editing/library |
| `js/schedules/` | Schedule data, editing, rendering, and viewer presence |
| `js/tools/`, `js/settings/`, `js/ui/` | Notepad, camera, preferences, and shared interface behavior |
| `activities/` | On-demand game documents, scripts, styles, and image assets |
| `styles.css`, `css/` | Foundation styles and ordered feature/responsive overrides |
| `vendor/` | Locally bundled Firebase compatibility scripts |
| `tests/` | Offline regression fixtures and browser checks |

`call-modules/panel-resize.js` is a separately loaded UI enhancement. Its pointer handling does not need the main call transport to initialize. `call-config.js` exposes `CHAT_CALL_CONFIG` for deployment configuration; see [CALLING.md](CALLING.md).

## Embedded activities

`js/runtime/activity-loader.js` exposes `ChatActivities`. Selecting a bundled activity loads its `document.js` registration, followed by its iframe-only `game.js`, stylesheet, and images. These files do not load during ordinary chat startup.

Activity documents run in the existing sandboxed iframe using `srcdoc` or a blob URL with a base URL pointing at the app folder. This preserves relative assets, direct local opening, and the existing parent-window launch configuration. Launching an activity does not replace the main page.

## Editing and validation

### Live media and view updates

All profile pictures use `App.applyAvatar(frame, user)` from `js/profiles/avatars.js`. Give `user` its stable `code`; the helper attaches the shared account subscription and `data-avatar-usercode` binding automatically. For markup-created frames, `data-avatar-usercode="USER_CODE"` is enough: the added-subtree observer hydrates the frame from the shared cache. Give the frame equal width and height; do not give its image independent responsive or crop styles. Existing pictures update in place without replacing the surrounding menu, message, schedule row, or call tile.

Use `App.applyBanner(frame, user)` for banners and `App.applyRoomIcon(frameOrImage, roomId, metadata)` for room icons. Both editors and display surfaces use `App.applyCroppedImage(image, source, transform, frameWidth, legacyWidth)`. Stored transforms are `{unit:"rel", x, y, scale}` with **both offsets normalized to frame width**. Never hand-code image translations or use image height to normalize the vertical offset. Banner frames share the original 340:120 aspect ratio at every responsive width. Image source, offset and scale are patched only when changed; updates require no synchronous layout measurement.

Set `data-media-preview` on a draft editor/preview host to prevent remote account snapshots from replacing unsaved edits, and still call the same media renderer with the draft record. `App.patchUserProfileCard` updates settings previews and profile cards while retaining the card and its scroll position.

For all live data, use stable keyed nodes and patch changed text, attributes and media in place. Coalesce repeated work with `App.queueLiveUpdate(key, callback)` and reconcile lists with `App.reconcileChildren(parent, nodes)`. Do not replace a parent container on timestamp-only or media-only changes, and do not force focus, scroll position, or overlay geometry on unrelated data events. An existing code helper automatically provides live profile media; new interfaces should not implement their own Firebase avatar subscription or crop math.

Keep the CSS links in `index.html` in their existing cascade order. Keep the full folder together when uploading or copying the app. Changes to shared state or initialization order should be checked through the affected user flow, in addition to syntax checks. Browser checks should cover both local-file and HTTP operation; call transport tests and deployment requirements are described in [CALLING.md](CALLING.md).

## Storage format (web 2026.10.14-2)

New message files contain metadata and a storagePath under attachmentBlobs/<room>/<message>/files/<index>. The encoding is base64-parts-v1; parts use independent base64 strings keyed by six-digit indexes, each representing at most 786432 bytes. The message never contains those parts. Blob decoding and object URLs preserve binary data without concatenating a full-file base64 string. Legacy inline dataURL fields remain readable.

The writer acknowledges all bounded concurrent writes before transactionally replacing the pending file list on the existing message. A missing message stays missing; edit transactions follow the same rule. Clear events invalidate queued work and obsolete uploads while retaining pins. Clearing discovers attachment owner keys through a shallow request and cleans absent unpinned owners asynchronously. Renderer cards request large files on demand; small visible images may preload. No Firebase Storage or other upload service is used.

## Fresh database schema (v6)

The new database is intentionally empty. No old-project migration runs. Persistent browser credentials, bootstrap data, room caches and notepad drafts are scoped by the Firebase project so an old account cannot populate the new UI.

| Path | Contents and access |
| --- | --- |
| credentials / users | Credential hashes resolve stable account IDs; users contain profiles, settings and personal data. Only the active credentialHash is accepted at login. Small old credential aliases remain reserved to avoid cross-device cleanup races; they do not keep old passwords valid. |
| usernames / displayNames | Unique name lookup indexes. |
| rooms / roomNames / roomMembers / memberships | Room metadata, unique-name directory, roster index and each user's room list/read position. Name changes use transient per-room locks with token-specific disconnect cleanup. |
| messages / pinnedMessages / attachmentBlobs | Paginated messages and pins contain external descriptors; attachmentBlobs keeps a compact cleanup index. Legacy base64 parts remain readable there. New files are at most 100 MiB. |
| htmlHub/meta / htmlHub/files / htmlHub/byOwner | One metadata record per published item, an external object descriptor in files, and a compact owner index. Legacy content chunks remain readable. Pending progress stays local. |
| stickers/meta / stickers/assets / stickers/byOwner / stickerCollections / stickerSavers | Descriptors, separate file bodies and ownership/saved indexes. The picker starts bounded prefetch only while open. |
| appPresence / scheduleViewers / calls / activities | Ephemeral leases, signaling and active game state. Heartbeats patch timestamps rather than re-sending full unchanged state; disconnect cleanup and existing expiry handling remain. |
| readReceipts / pings / activePolls / roomSystemEvents | Lightweight message/UI coordination, poll scheduling and deduplication. |
| calendar / calendarReminders / admin | Shared calendar, personal reminders and explicit administrative overrides. |

Profiles use a grouped set of leaf listeners (`App.fieldGroupRef`) and `App.readUserProfile(code)`. Room-list listeners likewise exclude typing/online branches and system-message bookkeeping. Default settings/avatars are inferred from local code. Settings patches compare against the last loaded/saved snapshot and send changed leaves only, eliding values equal to defaults. Browser editing previews, upload percentages and DOM layout are not database state.

New attachment/HTML bytes bypass RTDB entirely through the configured B2/Worker provider in core/config.js. Binary PUT is followed by HEAD verification before publication; descriptors and a compact cleanup index permit deletion without scanning message history. External objects support Range reads. The old bounded/paced RTDB writer remains only for legacy paths and unchanged small assets.

The admin editor shallow-reads branches. Expanding chunk collections shows Load Value controls instead of eagerly fetching each payload string. Normal scalar leaves remain live; quiet refresh discovers structure but skips loaded binary/HTML values. Manual refresh and editing remain available.

Optional backend functions explicitly target the new project. They are retained as source for deployments that already use them; this release does not deploy paid services. Server call lifecycle handling ignores state changes unrelated to membership/connection lifecycle before making extra database reads.
