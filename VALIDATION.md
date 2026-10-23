# Validation — 2026.10.23-1 / Desktop source 1.7.4

Executed October 23, 2026 against the updated source archive, with local Firebase and storage fixtures.

- Full application unit suite: 513 passed, 0 failed.
- Full desktop unit suite: 132 passed, 0 failed. The test-only adm-zip dependency was installed outside the deliverable; no dependencies or generated files were added to the ZIP.
- Cached asset upgrade and native gate browser regression passed, including the new Admin Panel default, exact label/input-only markup and placement, automatic saves, reopening persistence, remote realtime changes, limits above/below 100 MB, invalid values, denied writes and serialized overlapping saves. Admin Panel screenshot visually inspected.
- Browser smoke passed through file:// and HTTP: startup, login, room entry, sending, polls, profile/settings, schedules and home, with no page errors.
- Focused voice/attachment embed browser regression passed for web and desktop modes: audio import, recording, pause/resume, combination, playback, one attachment and immediate external image embeds.
- Policy tests cover cancellation/retry of Firebase listeners, ignoring stale callbacks, missing/invalid defaults, positive decimal MB values, initial-load gating and existing descriptor readability after lowering the limit. Worker tests cover uncached live Firebase reads, upload signing/completion boundaries, failed policy reads and retained range/deletion behavior. Clipboard tests cover default/lower/higher limits and bridge compatibility.
- The broader chat-files-sounds browser suite stops at its preexisting unread-count assertion (expected 1, observed 0, line 168). The untouched input ZIP was extracted separately and produces the same failure. This is unrelated to the upload setting; the broader suite is not claimed as passing.

No production Firebase, B2, Worker or GitHub data was changed. Real deployed service/network acceptance remains unverified. Deploy the updated Worker from README.md once to replace its old fixed limit. No EXE was built; installing a future build from the updated desktop source is needed for Explorer clipboard pastes above an old native bridge's size limit. Ordinary Upload and drag/drop use the shared web policy.

All 463 original file paths are preserved. Every top-level folder has at most 92 files recursively; the 16 root files can upload together. GitHub's browser selection limit still applies to selecting all folders together. Package entries and build-info.json receive fresh timestamps during final packaging. Web version: 2026.10.23-1. Asset revision: 20261023-file-upload-limit. Native source version: 1.7.4; native source changed, no binary included.

---

## Prior supplied validation record
# Validation — 2026.10.18-2 / Desktop 1.7.4

Executed on October 18, 2026 against the newly supplied source archive.

- Full application unit suite: 507 passed, 0 failed.
- Full native desktop unit suite: 129 passed, 0 failed.
- Camera/call browser regression passed using a real canvas camera track with web owner and desktop-mode viewer: start/stop, viewer arrival/departure, category preferences, independent camera/screen shares and realtime echo deduplication.
- Notification unit suite: 23 passed (included above). Desktop/web browser regression passed, including foreground-room suppression, multiple room pings, dismissal on room focus, native v2 focus bridge, delayed message fetch and initial-render races, and actual shared Filters/Pins navigation to and highlighting of a message outside the initial history tail. Same-room clicks avoid reopening; concurrent different-room clicks preserve the latest destination.
- Real Electron automated ring/ping integration passed: nonactivating popup arrival, always-interactive ping surface, restore/moveTop/focus on open, exact room/message IPC, room-specific suppression/dismissal, independent rings, DND, expiry and remaining stacked-card identity.
- Cached web asset update and native version gating browser checks passed.

Physical Windows mouse-input validation was stopped with Escape before a successful popup click; it remains unverified. Electron integration tests dispatch input through Chromium and do not prove native Windows hit testing. Live production multi-user delivery, all desktop/game configurations and Avast classification cannot be exhaustively verified by local tests. No antivirus setting was disabled or bypassed; no guarantee of antivirus clearance is made. No production backend, bucket, Firebase or GitHub data was changed.

The ZIP retains 463 original files and paths. Top-level recursive counts: activities 19; activity-modules 9; assets 11; backend 5; tests 92; unread-icons 50; unread-icons-extra 50; desktop 74; js 83; scripts 1; vendor 3; call-modules 17; css 33. There are 16 loose root files. Dependencies, test output and build intermediates are excluded from chat.zip.

Native version 1.7.4, web version 2026.10.18-2, asset revision 20261018-camera-ping-fixes. Existing portable launcher and GitHub updater are retained. Creation metadata is recorded in build-info.json.

Historical validation limits from the supplied release: its full chat-files-sounds browser suite has an unrelated unread-count fixture failure (expected 1, observed 0); that suite was not rerun for this follow-up. Prior validation remains in the release history, not claimed as fresh follow-up testing.
