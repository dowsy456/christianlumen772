/* Explicit load and initialization order. No build step required. */
globalThis.ChatAppModules = Object.freeze([
  {
    "id": "core/formatters",
    "src": "js/core/formatters.js"
  },
  {
    "id": "core/config",
    "src": "js/core/config.js"
  },
  {
    "id": "ui/dom-and-mobile",
    "src": "js/ui/dom-and-mobile.js"
  },
  {
    "id": "chat/mentions",
    "src": "js/chat/mentions.js"
  },
  {
    "id": "activities/html-library",
    "src": "activity-modules/html-library.js"
  },
  {
    "id": "activities/window-state",
    "src": "activity-modules/window-state.js"
  },
  {
    "id": "activities/library-storage",
    "src": "activity-modules/library-storage.js"
  },
  {
    "id": "activities/window-controls",
    "src": "activity-modules/window-controls.js"
  },
  {
    "id": "schedules/presence",
    "src": "js/schedules/presence.js"
  },
  {
    "id": "activities/room-games",
    "src": "activity-modules/room-games.js"
  },
  {
    "id": "activities/library-ui",
    "src": "activity-modules/library-ui.js"
  },
  {
    "id": "activities/viewer",
    "src": "activity-modules/viewer.js"
  },
  {
    "id": "activities/activity-mode",
    "src": "activity-modules/activity-mode.js"
  },
  {
    "id": "profiles/avatar-defaults",
    "src": "js/profiles/avatar-defaults.js"
  },
  {
    "id": "core/validation",
    "src": "js/core/validation.js"
  },
  {
    "id": "accounts/codes",
    "src": "js/accounts/codes.js"
  },
  { "id": "accounts/password", "src": "js/accounts/password.js" },
  {
    "id": "profiles/photo-editor",
    "src": "js/profiles/photo-editor.js"
  },
  {
    "id": "ui/toasts",
    "src": "js/ui/toasts.js"
  },
  {
    "id": "ui/navigation",
    "src": "js/ui/navigation.js"
  },
  {
    "id": "ui/modals",
    "src": "js/ui/modals.js"
  },
  {
    "id": "core/session",
    "src": "js/core/session.js"
  },
  {
    "id": "admin/panel",
    "src": "js/admin/panel.js"
  },
  {
    "id": "calling/policy",
    "src": "call-modules/policy.js"
  },
  {
    "id": "calling/connectivity",
    "src": "call-modules/connectivity.js"
  },
  {
    "id": "calling/media-policy",
    "src": "call-modules/media-policy.js"
  },
  {
    "id": "calling/state",
    "src": "call-modules/state.js"
  },
  {
    "id": "calling/playback",
    "src": "call-modules/playback.js"
  },
  {
    "id": "calling/microphone",
    "src": "call-modules/microphone.js"
  },
  {
    "id": "calling/screen-share",
    "src": "call-modules/screen-share.js"
  },
  {
    "id": "calling/viewers",
    "src": "call-modules/viewers.js"
  },
  {
    "id": "calling/quality",
    "src": "call-modules/quality.js"
  },
  {
    "id": "calling/signaling",
    "src": "call-modules/signaling.js"
  },
  {
    "id": "calling/peers",
    "src": "call-modules/peers.js"
  },
  {
    "id": "calling/presence",
    "src": "call-modules/presence.js"
  },
  {
    "id": "calling/panel",
    "src": "call-modules/panel.js"
  },
  {
    "id": "calling/desktop-overlay",
    "src": "js/calling/desktop-overlay.js"
  },
  {
    "id": "calling/audio-settings",
    "src": "call-modules/audio-settings.js"
  },
  {
    "id": "calling/notification-sounds",
    "src": "js/calling/notification-sounds.js"
  },
  {
    "id": "calling/lifecycle",
    "src": "call-modules/lifecycle.js"
  },
  {
    "id": "rooms/actions",
    "src": "js/rooms/actions.js"
  },
  {
    "id": "rooms/cache",
    "src": "js/rooms/cache.js"
  },
  {
    "id": "chat/presence-state",
    "src": "js/chat/presence-state.js"
  },
  {
    "id": "chat/app-presence",
    "src": "js/chat/app-presence.js"
  },
  {
    "id": "chat/message-surface",
    "src": "js/chat/message-surface.js"
  },
  {
    "id": "chat/text-context-menu",
    "src": "js/chat/text-context-menu.js"
  },
  {
    "id": "profiles/status",
    "src": "js/profiles/status.js"
  },
  {
    "id": "profiles/popover",
    "src": "js/profiles/popover.js"
  },
  {
    "id": "ui/clock",
    "src": "js/ui/clock.js"
  },
  {
    "id": "ui/layout",
    "src": "js/ui/layout.js"
  },
  {
    "id": "profiles/avatars",
    "src": "js/profiles/avatars.js"
  },
  {
    "id": "rooms/home",
    "src": "js/rooms/home.js"
  },
  {
    "id": "rooms/collections",
    "src": "js/rooms/collections.js"
  },
  {
    "id": "schedules/people-and-data",
    "src": "js/schedules/people-and-data.js"
  },
  {
    "id": "schedules/admin",
    "src": "js/schedules/admin.js"
  },
  {
    "id": "schedules/render",
    "src": "js/schedules/render.js"
  },
  {
    "id": "media/uploads",
    "src": "js/media/uploads.js"
  },
  {
    "id": "rooms/list",
    "src": "js/rooms/list.js"
  },
  {
    "id": "rooms/memberships",
    "src": "js/rooms/memberships.js"
  },
  {
    "id": "chat/notification-audio",
    "src": "js/chat/notification-audio.js"
  },
  {
    "id": "chat/notifications",
    "src": "js/chat/notifications.js"
  },
  {
    "id": "chat/header",
    "src": "js/chat/header.js"
  },
  {
    "id": "chat/presence",
    "src": "js/chat/presence.js"
  },
  {
    "id": "chat/composer-state",
    "src": "js/chat/composer-state.js"
  },
  {
    "id": "rooms/icon-editor",
    "src": "js/rooms/icon-editor.js"
  },
  {
    "id": "chat/composer-overlays",
    "src": "js/chat/composer-overlays.js"
  },
  {
    "id": "chat/message-menu",
    "src": "js/chat/message-menu.js"
  },
  {
    "id": "chat/message-history",
    "src": "js/chat/message-history.js"
  },
  {
    "id": "chat/message-render",
    "src": "js/chat/message-render.js"
  },
  {
    "id": "chat/read-receipts",
    "src": "js/chat/read-receipts.js"
  },
  {
    "id": "rooms/open",
    "src": "js/rooms/open.js"
  },
  { "id": "rooms/names", "src": "js/rooms/names.js" },
  {
    "id": "rooms/management",
    "src": "js/rooms/management.js"
  },
  {
    "id": "chat/send-bindings",
    "src": "js/chat/send-bindings.js"
  },
  {
    "id": "chat/emoji",
    "src": "js/chat/emoji.js"
  },
  {
    "id": "media/voice-recorder",
    "src": "js/media/voice-recorder.js"
  },
  {
    "id": "chat/send",
    "src": "js/chat/send.js"
  },
  {
    "id": "media/video-player",
    "src": "js/media/video-player.js"
  },
  {
    "id": "media/viewer",
    "src": "js/media/viewer.js"
  },
  {
    "id": "stickers/library",
    "src": "js/stickers/library.js"
  },
  {
    "id": "stickers/editor",
    "src": "js/stickers/editor.js"
  },
  {
    "id": "profiles/edit",
    "src": "js/profiles/edit.js"
  },
  {
    "id": "ui/page-buttons",
    "src": "js/ui/page-buttons.js"
  },
  {
    "id": "tools/notepad",
    "src": "js/tools/notepad.js"
  },
  {
    "id": "tools/camera",
    "src": "js/tools/camera.js"
  },
  {
    "id": "ui/tool-buttons",
    "src": "js/ui/tool-buttons.js"
  },
  {
    "id": "ui/sidebar",
    "src": "js/ui/sidebar.js"
  },
  {
    "id": "settings/preferences",
    "src": "js/settings/preferences.js"
  },
  {
    "id": "accounts/logout",
    "src": "js/accounts/logout.js"
  },
  {
    "id": "accounts/create",
    "src": "js/accounts/create.js"
  },
  {
    "id": "accounts/login",
    "src": "js/accounts/login.js"
  },
  {
    "id": "ui/chat-popovers",
    "src": "js/ui/chat-popovers.js"
  },
  {
    "id": "calendar/data",
    "src": "js/calendar/data.js"
  },
  {
    "id": "calendar/date-picker",
    "src": "js/calendar/date-picker.js"
  },
  {
    "id": "calendar/render",
    "src": "js/calendar/render.js"
  },
  {
    "id": "calendar/authors",
    "src": "js/calendar/authors.js"
  },
  {
    "id": "activities/activity-presence",
    "src": "activity-modules/activity-presence.js"
  },
  {
    "id": "chat/game-presence",
    "src": "js/chat/game-presence.js"
  },
  {
    "id": "chat/spotify-presence",
    "src": "js/chat/spotify-presence.js"
  },
  {
    "id": "calling/ringing",
    "src": "js/calling/ringing.js"
  },
  {
    "id": "core/start",
    "src": "js/core/start.js"
  }
]);
