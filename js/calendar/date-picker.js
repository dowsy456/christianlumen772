/* Shared date picker; Calendar keeps its year bounds, search can browse years. */
(function (App) {
  "use strict";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const states = new WeakMap();
  let active = null;
  const icon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2m-8 3h2"/></svg>';
  function key(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function parse(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(y, m - 1, d, 12);
    return key(date) === value ? date : null;
  }
  function today() { return App.calendarState?.today || key(new Date()); }
  function year() { return App.calendarState?.year || new Date().getFullYear(); }
  function label(value) {
    const date = parse(value);
    return date ? `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}` : "Choose date";
  }
  function allowed(state, value) {
    return !!parse(value) && value >= state.min && value <= state.max && (state.allowYears || Number(value.slice(0, 4)) === year());
  }
  function button(text, action, aria) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    if (action) node.dataset.action = action;
    if (aria) node.setAttribute("aria-label", aria);
    return node;
  }
  function position() {
    if (!active) return;
    const { trigger, pop } = active;
    if (!trigger.isConnected) { close(false); return; }
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const viewportWidth = viewport?.width || window.innerWidth, viewportHeight = viewport?.height || window.innerHeight;
    const width = Math.min(304, Math.max(1, viewportWidth - 24));
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${Math.max(1, viewportHeight - 24)}px`;
    const height = pop.getBoundingClientRect().height;
    pop.style.left = `${Math.max(left + 12, Math.min(rect.right - width, left + viewportWidth - width - 12))}px`;
    let top = rect.bottom + 8;
    if (top + height > topEdge + viewportHeight - 12) top = rect.top - height - 8;
    pop.style.top = `${Math.max(topEdge + 12, Math.min(top, topEdge + viewportHeight - height - 12))}px`;
  }
  function close(restoreFocus = false) {
    const state = active;
    if (!state) return;
    active = null;
    state.pop.remove();
    state.pop = null;
    state.trigger.setAttribute("aria-expanded", "false");
    state.trigger.removeAttribute("aria-controls");
    state.cleanup?.();
    state.cleanup = null;
    if (restoreFocus && state.trigger.isConnected) state.trigger.focus({ preventScroll: true });
  }
  function focusDate(state, value) {
    if (!allowed(state, value)) return;
    const date = parse(value);
    state.year = date.getFullYear();
    state.month = date.getMonth();
    state.focusDate = value;
    state.monthsOpen = false;
    render(state);
    state.pop.querySelector(`[data-date="${value}"]`)?.focus({ preventScroll: true });
  }
  function render(state) {
    if (!state.pop) return;
    const y = state.allowYears ? state.year : year();
    const header = document.createElement("div");
    header.className = "calendar-date-picker-header";
    const prev = button("‹", "prev", "Previous month");
    prev.disabled = (!state.allowYears && state.month === 0) || key(new Date(y, state.month, 0, 12)) < state.min;
    const title = button(`${MONTHS[state.month]} ${y}`, "months", "Choose month");
    title.className = "calendar-date-picker-month";
    title.setAttribute("aria-expanded", String(state.monthsOpen));
    const next = button("›", "next", "Next month");
    next.disabled = (!state.allowYears && state.month === 11) || (y >= Number(state.max.slice(0, 4)) && state.month >= Number(state.max.slice(5, 7)) - 1) || key(new Date(y, state.month + 1, 1, 12)) > state.max;
    const dismiss = button("×", "close", "Close date picker");
    header.append(prev, title, next, dismiss);
    state.pop.replaceChildren(header);
    if (state.allowYears) {
      const years = document.createElement("div"); years.className = "calendar-date-picker-years";
      const previous = button("‹", "previous-year", "Previous Year");
      previous.disabled = y <= Number(state.min.slice(0, 4));
      const value = document.createElement("input"); value.type = "number"; value.value = String(y);
      value.min = state.min.slice(0, 4); value.max = state.max.slice(0, 4); value.setAttribute("aria-label", "Year");
      const nextYear = button("›", "next-year", "Next Year"); nextYear.disabled = y >= Number(state.max.slice(0, 4));
      value.addEventListener("change", () => {
        const next = Math.trunc(Number(value.value));
        if (!Number.isFinite(next) || next < Number(value.min) || next > Number(value.max)) { value.value = String(y); return; }
        state.year = next; render(state); state.pop.querySelector('.calendar-date-picker-years input')?.focus({ preventScroll: true });
      });
      years.append(previous, value, nextYear); state.pop.append(years);
    }
    if (state.monthsOpen) {
      const months = document.createElement("div");
      months.className = "calendar-date-picker-months";
      MONTHS.forEach((name, m) => {
        const item = button(name.slice(0, 3), "month", name);
        item.dataset.month = String(m);
        item.setAttribute("aria-pressed", String(m === state.month));
        item.disabled = key(new Date(y, m + 1, 0, 12)) < state.min || key(new Date(y, m, 1, 12)) > state.max;
        months.append(item);
      });
      state.pop.append(months);
    } else {
      const weekdays = document.createElement("div");
      weekdays.className = "calendar-date-picker-weekdays";
      weekdays.setAttribute("aria-hidden", "true");
      DAYS.forEach(day => { const item = document.createElement("span"); item.textContent = day; weekdays.append(item); });
      const grid = document.createElement("div");
      grid.className = "calendar-date-picker-grid";
      grid.setAttribute("role", "group");
      grid.setAttribute("aria-label", `${MONTHS[state.month]} ${y}`);
      const offset = new Date(y, state.month, 1, 12).getDay();
      const count = new Date(y, state.month + 1, 0, 12).getDate();
      for (let i = 0; i < offset; i++) grid.append(document.createElement("span"));
      let focus = state.focusDate;
      if (!focus || parse(focus)?.getMonth() !== state.month || parse(focus)?.getFullYear() !== y || !allowed(state, focus)) {
        focus = Array.from({ length: count }, (_, i) => key(new Date(y, state.month, i + 1, 12))).find(value => allowed(state, value));
      }
      for (let day = 1; day <= count; day++) {
        const value = key(new Date(y, state.month, day, 12));
        const item = button(String(day), null, label(value));
        item.dataset.date = value;
        item.disabled = !allowed(state, value);
        item.tabIndex = value === focus ? 0 : -1;
        item.setAttribute("aria-pressed", String(value === state.value));
        if (value === today()) item.setAttribute("aria-current", "date");
        grid.append(item);
      }
      state.pop.append(weekdays, grid);
    }
    const footer = document.createElement("div");
    footer.className = "calendar-date-picker-footer";
    const current = button("Today", "today");
    current.disabled = !allowed(state, today());
    footer.append(current);
    if (state.allowClear) footer.append(button("Clear", "clear"));
    state.pop.append(footer);
    position();
  }
  function choose(state, value) {
    if (!(value === "" && state.allowClear) && !allowed(state, value)) return;
    App.updateCalendarDatePicker(state.trigger, { value });
    close(true);
    state.onChange?.(value);
    state.trigger.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function open(state) {
    if (state.trigger.disabled) return;
    if (active === state) { close(true); return; }
    close(false);
    active = state;
    const value = allowed(state, state.value) ? state.value : allowed(state, today()) ? today() : state.min;
    state.month = parse(value)?.getMonth() || 0;
    state.year = parse(value)?.getFullYear() || year();
    state.focusDate = value;
    state.monthsOpen = false;
    const pop = document.createElement("div");
    pop.className = "calendar-date-picker-pop";
    if (state.trigger.closest("#room-search-panel")) pop.dataset.searchPicker = "1";
    pop.id = `${state.trigger.id || "calendar-date"}-popup`;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", state.label || "Choose date");
    state.pop = pop;
    document.body.append(pop);
    state.trigger.setAttribute("aria-expanded", "true");
    state.trigger.setAttribute("aria-controls", pop.id);
    render(state);
    pop.querySelector(`[data-date="${value}"]`)?.focus({ preventScroll: true });
    pop.addEventListener("click", event => {
      const target = event.target.closest("button");
      if (!target || target.disabled) return;
      if (target.dataset.date) { choose(state, target.dataset.date); return; }
      const action = target.dataset.action;
      if (action === "close") { close(true); return; }
      if (action === "today") { choose(state, today()); return; }
      if (action === "clear") { choose(state, ""); return; }
      if (action === "prev" || action === "next") {
        const date = new Date(state.year, state.month + (action === "prev" ? -1 : 1), 1, 12);
        state.month = date.getMonth(); state.year = date.getFullYear();
      }
      if (action === "previous-year" || action === "next-year") state.year += action === "previous-year" ? -1 : 1;
      if (action === "months") state.monthsOpen = !state.monthsOpen;
      if (action === "month") { state.month = Number(target.dataset.month); state.monthsOpen = false; }
      render(state);
      const focus = action === "month" ? '[data-action="months"]' : `[data-action="${action}"]:not(:disabled)`;
      (pop.querySelector(focus) || pop.querySelector('[data-action="months"]')).focus({ preventScroll: true });
    });
    pop.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
      const value = event.target.dataset.date;
      if (!value) return;
      const date = parse(value);
      let offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
      if (event.key === "Home") offset = -date.getDay();
      if (event.key === "End") offset = 6 - date.getDay();
      if (offset !== undefined) date.setDate(date.getDate() + offset);
      else if (event.key === "PageUp" || event.key === "PageDown") {
        const targetMonth = date.getMonth() + (event.key === "PageUp" ? -1 : 1);
        const day = date.getDate();
        date.setDate(1); date.setMonth(targetMonth);
        date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
      } else return;
      event.preventDefault();
      focusDate(state, key(date));
    });
    const outside = event => {
      if (!pop.contains(event.target) && !state.trigger.contains(event.target)) close(false);
    };
    const onFocus = event => {
      if (!pop.contains(event.target) && !state.trigger.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    window.addEventListener("scroll", position, true);
    const observer = new MutationObserver(() => { if (!state.trigger.isConnected) close(false); });
    observer.observe(document.body, { childList: true, subtree: true });
    state.cleanup = () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      window.removeEventListener("scroll", position, true);
      observer.disconnect();
    };
  }
  App.createCalendarDatePicker = function (options) {
    const trigger = button("", null);
    trigger.id = options.id || "calendar-date";
    trigger.className = "calendar-date-input calendar-date-picker-trigger";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    const state = { trigger, value: options.value ?? today(), label: options.label || "Choose date", onChange: options.onChange, allowYears: !!options.allowYears, allowClear: !!options.allowClear, min: `${year()}-01-01`, max: `${year()}-12-31` };
    states.set(trigger, state);
    trigger.addEventListener("click", () => open(state));
    App.updateCalendarDatePicker(trigger, options);
    return trigger;
  };
  App.updateCalendarDatePicker = function (trigger, options = {}) {
    const state = states.get(trigger);
    if (!state) return;
    const changedValue = options.value !== undefined && options.value !== state.value;
    const changed = ["value", "min", "max"].some(field => options[field] !== undefined && options[field] !== state[field]);
    for (const field of ["value", "min", "max", "label"]) if (options[field] !== undefined) state[field] = options[field];
    if (options.disabled !== undefined) trigger.disabled = !!options.disabled;
    trigger.dataset.value = state.value;
    trigger.setAttribute("aria-label", `${state.label}: ${label(state.value)}`);
    trigger.replaceChildren(document.createTextNode(label(state.value)));
    const glyph = document.createElement("span"); glyph.innerHTML = icon; trigger.append(glyph);
    if (active === state) {
      if (trigger.disabled) close(false);
      else if (changed) {
        const focused = state.pop.contains(document.activeElement) ? document.activeElement : null;
        const selector = focused?.dataset.date ? `[data-date="${focused.dataset.date}"]` : focused?.dataset.action ? `[data-action="${focused.dataset.action}"]` : null;
        state.month = changedValue ? parse(state.value)?.getMonth() || 0 : Math.max(0, Math.min(11, state.month));
        if (changedValue) state.year = parse(state.value)?.getFullYear() || year();
        render(state);
        if (selector) (state.pop.querySelector(selector) || state.pop.querySelector('[data-action="months"]'))?.focus({ preventScroll: true });
      }
    }
  };
  App.closeCalendarDatePicker = function () { close(false); };
  App.register("calendar/date-picker", function () {});
})(globalThis.ChatApp);
