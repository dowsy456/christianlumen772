/* Bottom-edge call-panel resizing. Classic script so file:// remains supported. */
(() => {
  "use strict";

  const STORAGE_KEY = "chat.callPanelHeight.v1";

  function attachCallPanelResize() {
    const menu = document.getElementById("call-menu");
    const card = menu?.querySelector(".call-menu-card");
    if (!card || menu.querySelector(".call-panel-resize-handle")) return;

    const handle = document.createElement("div");
    handle.className = "call-panel-resize-handle";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-label", "Call panel height");
    handle.setAttribute("aria-controls", "call-menu-list");
    handle.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown Home End");
    handle.title = "Drag to resize · Arrow keys to adjust · Double-click to reset";
    handle.tabIndex = 0;
    menu.appendChild(handle);

    let preferredHeight = null;
    let drag = null;
    let pendingHeight = null;
    let frame = 0;
    let syncFrame = 0;
    let fitFrame = 0;
    const list = card.querySelector?.(".call-menu-list");

    function fitRoster() {
      fitFrame = 0;
      const stage = list?.querySelector(".call-stage.call-roster-grid");
      if (menu.hidden || !stage) return;
      const compact = !menu.classList.contains("is-expanded") && card.clientHeight < 240;
      if (menu.dataset.callCompact !== String(compact)) menu.dataset.callCompact = String(compact);
      if (list.classList.contains("is-focused") || list.classList.contains("is-multiview")) {
        delete stage.dataset.callFit;
        if (list.classList.contains("is-multiview")) {
          const count = stage.childElementCount;
          const ratio = Math.max(.25, list.clientWidth / Math.max(1, list.clientHeight));
          const visible = menu.classList.contains("is-focus-controls-visible");
          const calculated = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * ratio * 9 / 16))));
          // Keep the visible layout's columns when hiding chrome. Reflowing
          // from two columns to two rows could make each video *smaller* even
          // though the stage had gained height.
          const columns = !visible && stage.dataset.multiVisibleColumns
            ? Math.min(count, Number(stage.dataset.multiVisibleColumns)) : calculated;
          if (visible) stage.dataset.multiVisibleColumns = String(columns);
          stage.style.setProperty("--call-multi-columns", columns);
          stage.style.setProperty("--call-multi-rows", Math.ceil(count / columns));
        }
        return;
      }
      const count = stage.childElementCount;
      if (!count) return;
      const style = getComputedStyle(list);
      const width = list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2;
      const height = list.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 2;
      if (width <= 0 || height <= 0) return;
      // Size cells, not their contents. Portraits and controls keep readable
      // dimensions; large calls scroll once the minimum tile size is reached.
      const hasScreens = Number(stage.dataset.screens) > 0 || !!stage.querySelector(".call-screen-tile");
      const naturalWidth = hasScreens ? (menu.classList.contains("is-expanded") ? 360 : 280) : 160;
      const minimumWidth = hasScreens ? 160 : 128;
      const minimumHeight = 128;
      let best = null;
      const maxColumns = Math.max(1, Math.min(count, Math.floor((width + 12) / (minimumWidth + 12))));
      for (let columns = 1; columns <= maxColumns; columns++) {
        const rows = Math.ceil(count / columns);
        const availableWidth = (width - (columns - 1) * 12) / columns;
        const availableHeight = (height - (rows - 1) * 12) / rows;
        const tileWidth = Math.min(naturalWidth, availableWidth, hasScreens ? Math.max(minimumWidth, availableHeight * 16 / 9) : naturalWidth);
        const tileHeight = hasScreens ? Math.max(minimumHeight, tileWidth * 9 / 16) : 136;
        const fits = rows * tileHeight + (rows - 1) * 12 <= height + 1;
        const score = fits ? tileWidth : -rows;
        if (!best || score > best.score) best = { columns, rows, tileWidth, tileHeight, score };
      }
      const { tileWidth, tileHeight } = best;
      const properties = {
        "--call-fit-columns": String(best.columns * 2),
        "--call-fit-track-width": `${(tileWidth - 12) / 2}px`,
        "--call-fit-tile-width": `${tileWidth}px`,
        "--call-fit-tile-height": `${tileHeight}px`,
        "--call-fit-width": `${best.columns * tileWidth + (best.columns - 1) * 12}px`,
        "--call-fit-height": `${best.rows * tileHeight + (best.rows - 1) * 12}px`,
        "--call-fit-scale": "1"
      };
      for (const [name, value] of Object.entries(properties)) {
        if (stage.style.getPropertyValue(name) !== value) stage.style.setProperty(name, value);
      }
      stage.dataset.callFit = "true";
      // Center the last incomplete row instead of pinning it to the left.
      const remainder = count % best.columns;
      Array.from(stage.children).forEach((tile, index) => {
        tile.style.gridColumnStart = remainder && index === count - remainder ? String(best.columns - remainder + 1) : "";
      });
    }

    function scheduleFit() {
      if (list && !fitFrame) fitFrame = requestAnimationFrame(fitRoster);
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const value = stored === null ? NaN : Number(stored);
      if (Number.isFinite(value) && value >= 80 && value <= 4096) preferredHeight = value;
    } catch { /* Resizing also works when browser storage is unavailable. */ }

    const canResize = () => !menu.hidden && !menu.classList.contains("is-expanded") && !menu.classList.contains("is-preview");
    const clamp = (value, bounds) => Math.round(Math.max(bounds.min, Math.min(bounds.max, value)));

    function boundsFor(rect) {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
      const available = Math.max(140, viewportBottom - Math.max(viewportTop, rect.top) - 16);
      // Leave room for chat/composer controls and keep the panel usable on short screens.
      const max = Math.round(Math.min(1000, Math.max(140, available - Math.min(112, available * 0.18))));
      return { min: Math.min(280, max), max };
    }

    function updateAccessibleValue(height, bounds) {
      handle.setAttribute("aria-valuemin", String(bounds.min));
      handle.setAttribute("aria-valuemax", String(bounds.max));
      handle.setAttribute("aria-valuenow", String(Math.round(height)));
      handle.setAttribute("aria-valuetext", `${Math.round(height)} pixels high`);
    }

    function paintHeight(height, bounds) {
      const next = clamp(height, bounds);
      const value = `${next}px`;
      if (menu.style.getPropertyValue("--call-panel-height") !== value) {
        menu.style.setProperty("--call-panel-height", value);
      }
      if (menu.dataset.callResized !== "true") menu.dataset.callResized = "true";
      updateAccessibleValue(next, bounds);
      scheduleFit();
      return next;
    }

    function savePreference() {
      try {
        if (preferredHeight === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, String(preferredHeight));
      } catch { /* The current session still keeps the selected height. */ }
    }

    function sync() {
      syncFrame = 0;
      scheduleFit();
      if (drag && !canResize()) finishDrag(false);
      handle.hidden = !canResize();
      handle.tabIndex = canResize() ? 0 : -1;
      handle.setAttribute("aria-disabled", String(!canResize()));
      if (!canResize() || drag) return;
      const rect = card.getBoundingClientRect();
      const bounds = boundsFor(rect);
      if (preferredHeight !== null) paintHeight(preferredHeight, bounds);
      else updateAccessibleValue(rect.height, {
        min: Math.min(bounds.min, Math.round(rect.height)),
        max: Math.max(bounds.max, Math.round(rect.height)),
      });
    }

    function scheduleSync() {
      if (!syncFrame) syncFrame = requestAnimationFrame(sync);
    }

    function paintDrag() {
      frame = 0;
      if (!drag || pendingHeight === null || !canResize()) return;
      preferredHeight = paintHeight(pendingHeight, drag.bounds);
    }

    function finishDrag(commit) {
      if (!drag) return;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (commit) paintDrag();
      else {
        preferredHeight = drag.startPreference;
        if (preferredHeight === null) {
          menu.style.removeProperty("--call-panel-height");
          delete menu.dataset.callResized;
        } else paintHeight(preferredHeight, drag.bounds);
      }
      const pointerId = drag.pointerId;
      drag = null;
      pendingHeight = null;
      delete document.body.dataset.callPanelResizing;
      delete menu.dataset.callResizing;
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      if (commit) savePreference();
      scheduleSync();
    }

    handle.addEventListener("pointerdown", (event) => {
      if (!canResize() || drag || event.button !== 0 || event.isPrimary === false) return;
      const rect = card.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: rect.height,
        startPreference: preferredHeight,
        bounds: boundsFor(rect),
      };
      pendingHeight = rect.height;
      try { handle.setPointerCapture(event.pointerId); }
      catch { drag = null; pendingHeight = null; return; }
      document.body.dataset.callPanelResizing = "true";
      menu.dataset.callResizing = "true";
      handle.focus({ preventScroll: true });
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      // Pointer events only update numbers; DOM writes happen once per animation frame.
      pendingHeight = drag.startHeight + event.clientY - drag.startY;
      if (!frame) frame = requestAnimationFrame(paintDrag);
      event.preventDefault();
    });

    handle.addEventListener("pointerup", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      pendingHeight = drag.startHeight + event.clientY - drag.startY;
      finishDrag(true);
    });
    handle.addEventListener("pointercancel", (event) => {
      if (drag?.pointerId === event.pointerId) finishDrag(false);
    });
    handle.addEventListener("lostpointercapture", (event) => {
      if (drag?.pointerId === event.pointerId) finishDrag(false);
    });
    window.addEventListener("blur", () => finishDrag(false));

    function resetHeight() {
      if (!canResize()) return;
      finishDrag(false);
      preferredHeight = null;
      menu.style.removeProperty("--call-panel-height");
      delete menu.dataset.callResized;
      savePreference();
      scheduleSync();
    }

    handle.addEventListener("dblclick", resetHeight);
    handle.addEventListener("keydown", (event) => {
      if (!canResize()) return;
      if (event.key === "Escape" && drag) {
        // Do not let the app's global Escape handler close a call being resized.
        event.preventDefault();
        event.stopPropagation();
        finishDrag(false);
        return;
      }
      if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") { resetHeight(); return; }
      finishDrag(false);
      const rect = card.getBoundingClientRect();
      const bounds = boundsFor(rect);
      const step = event.shiftKey ? 40 : 16;
      const next = event.key === "Home" ? bounds.min : event.key === "End" ? bounds.max
        : rect.height + (event.key === "ArrowUp" ? -step : step);
      preferredHeight = paintHeight(next, bounds);
      savePreference();
    });

    // Existing call open/close/expand code needs no hooks into the resizing module.
    new MutationObserver(scheduleSync).observe(menu, { attributes: true, attributeFilter: ["class", "hidden"] });
    if (list) new MutationObserver(scheduleFit).observe(list, { childList: true, attributes: true, attributeFilter: ["class"] });
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => { if (!drag) scheduleSync(); }).observe(card);
      if (list) new ResizeObserver(scheduleFit).observe(list);
    }
    window.addEventListener("resize", () => { finishDrag(true); scheduleSync(); }, { passive: true });
    window.visualViewport?.addEventListener("resize", scheduleSync, { passive: true });
    window.visualViewport?.addEventListener("scroll", scheduleSync, { passive: true });
    sync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachCallPanelResize, { once: true });
  } else attachCallPanelResize();
})();
