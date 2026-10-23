# Release 2026.10.23-1 / Desktop source 1.7.4

- Default file upload limit remains 100 MB per file. Vinny's Admin Panel now has only the File Upload Limit label and a text input directly below Update URL. Valid numeric MB changes save automatically to Firebase at admin/fileUploadLimitMB and update connected clients in real time.
- All upload entry points and the send/upload checks use the current limit. Positive decimal MB and values above 100 are supported. Lowering the limit does not invalidate existing stored-file references. Invalid values and failed writes remain unsaved and are reflected through the input's validation state.
- The existing README storage Worker now reads the current Firebase limit for each upload request. Deploy this updated Worker once; later limit changes need no deployment. The native clipboard bridge source accepts the current byte limit; rebuilding the desktop app is required for Explorer clipboard pastes above an installed EXE's fixed limit. Upload and drag-and-drop use shared web code.
- All 463 original source files and paths remain. Every top-level folder has at most 92 files recursively, so each can upload separately through GitHub's website. The whole-project browser selection limit is controlled by GitHub; use Git or GitHub Desktop for one whole-project operation.

No production Firebase, Worker, B2 or GitHub data was changed. No executable was built or included. See VALIDATION.md for the checks performed on this release.

---
# Release 2026.10.18-2 / Desktop 1.7.4

- Cameras now use the same Screen sound category as screen sharing for starting, stopping and viewer changes, on web and desktop. Screen and camera generations are tracked independently, with local confirmation deduplicated against realtime echoes.
- Desktop ping popups are suppressed only when the app is visible and focused in the pinged room. Opening that room dismisses its existing popups; other rooms' concurrent pings stay visible. Returning from another application, restoring a minimized window, switching rooms and delayed message fetches recheck this policy.
- Desktop ping surfaces accept mouse clicks immediately, without a cursor-polling race. Clicking raises and focuses Chat App, opens the destination only if needed and uses the same bounded history jump and highlight as Filters/Pins. Consecutive clicks serialize room entry so the newest destination wins even while an activity closes.
- Push Notifications, DND privacy/sound behavior, three-second lifetime, close animation and separate ring popup handling are preserved.

Desktop 1.7.4 must be installed for the native popup input and focus changes. Shared sound/navigation changes remain in the web source and use the existing GitHub update system. The portable launch mechanism is unchanged. No runtime PowerShell scripts, antivirus exclusions or security-setting changes were added.

All 463 original source file paths are retained. Each top-level folder contains at most 92 files recursively; upload one top-level folder at a time at the repository root, then the 16 loose root files. Selecting the entire project still exceeds GitHub's 100-file selection limit.

See VALIDATION.md for tests and limits.

---

# Release 2026.10.18-1 / Desktop 1.7.3

- Removed the watched-camera label icon; the viewers eye sits after the zoom percentage and opens an unclipped tooltip.
- High screen/camera zoom uses a bounded visible crop instead of an enormous transformed video layer. Focused, fullscreen and Multi Screen View retain per-feed zoom and pan.
- Watching survives call-menu dismissal. Hiding multi-view controls retains the same column layout and increases available media area. Ordinary call grids center incomplete rows; minimum panel sizing preserves readable avatars, previews and controls.
- Desktop signed uploads handle opaque/custom origins and missing optional Electron request metadata. Transient transfer failures retry the same object before publishing its descriptor.
- Ring/Stop updates optimistically with session-scoped cleanup. Stale member snapshots cannot cancel fresh invitations. Desktop DND waits for account policy before playing blocked sounds or showing rings; it silences an invitation without declining it.
- Desktop DND ends after six hours or the next 6 AM, using the same network-adjusted time and timezone as Time Display, with a persisted deadline and offline retry.
- Native ring windows are prewarmed and shown without activation. Desktop ping notifications use an independent bottom-right stack, retain Push Notifications control, last three seconds with an exit animation, close via X, and open the exact message. DND retains the popup but removes its message preview and sound.
- Join Call uses an upright handset. Blackout cloak immediately publishes Idle, and Tab Name/Icon/Presets are omitted from desktop settings.
- Caden's Monday-Friday schedule matches the supplied screenshots; lunch is retained, room codes omit H, and homeroom stays after Period 1.

The EXE was rebuilt because popup-window and upload-origin changes require native code. It still loads shared web releases through the existing GitHub updater and uses the existing portable launcher. No runtime PowerShell scripts, antivirus exclusions, or security-setting changes were added.

The ZIP retains all 463 original file paths. Each top-level folder has at most 92 files recursively; upload each folder separately at the repository root, followed by the 16 root files. GitHub's 100-file selection limit still applies to selecting the entire project at once. See VALIDATION.md for executed checks and remaining live-environment limits.

---

# Release 2026.10.14-5

- Natural scrolling for multi-page PDF, DOCX and PPTX and text/HTML previews; no document zoom badge or wheel interception. Image/video zoom remains.
- Focused, fullscreen and multi-view screen/camera zoom with a 100% minimum, bounded drag-to-pan, independent per-feed state and reliable click-versus-drag handling. Unfocused tiles cannot zoom. Leaving the viewing mode resets zoom and pan.
- Frame-coalesced per-tile transforms avoid global layout work during wheel/drag input. The existing source resolution, encoding and network budgets remain in place; magnification cannot add missing source pixels.
- Compact zoom status and viewers button; viewers attached to the label. Transparent multi-view backgrounds retain the label, viewers and percentage while omitting minimize/fullscreen/close actions.
- Multi Screen View button moved left of Show Chat with matching styling; the tooltip changes to Hide Chat when chat is open.
- Blackout cloak reads the active saved shortcut instead of a stale legacy setting. Default Shift+Z, custom chords, shortcut editing and reload persistence are repaired. Escape no longer closes application modals.

The preceding account, media, voice, screen pause/mute, mobile chat and attachment embed changes remain included. All 463 source paths and existing upload/storage configuration are preserved. Each top-level folder remains below 100 files. Upload folders separately, then the 16 loose root files. Uploading all 463 files in one operation requires Git/GitHub Desktop; ZIP changes cannot remove GitHub's browser selection limit.

No production Firebase, B2, Worker or GitHub changes were deployed. Native desktop version remains 1.7.2. See VALIDATION.md for executed checks. ZIP timestamps and build-info.json are refreshed during final packaging.
