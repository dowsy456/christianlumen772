/* core/formatters: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.getDateTimeFormatter = function (locale, options) {
  const key = JSON.stringify([locale, options]);
  let formatter = App.dateTimeFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (App.dateTimeFormatterCache.size >= 64) {
      App.dateTimeFormatterCache.delete(App.dateTimeFormatterCache.keys().next().value);
    }
    App.dateTimeFormatterCache.set(key, formatter);
  }
  return formatter;
};

App.register("core/formatters", function initializeFeature() {
App.dateTimeFormatterCache = new Map();
App.messageTimestampDateKey = "";
});
})(globalThis.ChatApp);
