/* accounts/codes: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.randomCode16 = function () {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 16; i++) out += chars[bytes[i] % chars.length];
  return out;
};
App.formatCode = function (code16) {
  const s = code16.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16);
  return s.match(/.{1,4}/g)?.join("-") ?? s;
};
App.normalizeCodeInput = function (s) {
  let out = String(s ?? "").trim();

  // Spaces become dashes
  out = out.replace(/\s+/g, "-");

  // Keep only safe characters for Firebase keys + DOM selectors
  out = out.replace(/[^A-Za-z0-9_-]+/g, "-").toUpperCase();

  // Collapse / trim dashes
  out = out.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!out) return null;
  if (out.length > 20) return null;

  // Legacy convenience: if user typed a 16-char code without dashes, auto-format it
  const raw16 = out.replace(/[^A-Z0-9]/g, "");
  if (raw16.length === 16 && !out.includes("-") && !out.includes("_")) {
    return raw16.match(/.{1,4}/g)?.join("-") ?? raw16;
  }
  return out;
};

App.register("accounts/codes", function initializeFeature() {

});
})(globalThis.ChatApp);
