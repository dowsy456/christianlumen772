"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../call-modules/panel-resize.js"), "utf8");

function browser({ savedHeight = null, hidden = false } = {}) {
  const callbacks = new Map();
  const observers = [];
  let nextFrame = 0;
  let layoutReads = 0;
  const values = new Map(savedHeight === null ? [] : [["chat.callPanelHeight.v1", savedHeight]]);
  function node() {
    const events = new Map();
    const attributes = new Map();
    const style = new Map();
    const classes = new Set();
    return {
      dataset: {}, hidden: false,
      style: { setProperty: (k, v) => style.set(k, v), getPropertyValue: (k) => style.get(k) || "", removeProperty: (k) => style.delete(k) },
      classList: { contains: (v) => classes.has(v), add: (v) => classes.add(v), remove: (v) => classes.delete(v) },
      setAttribute: (k, v) => attributes.set(k, v), getAttribute: (k) => attributes.get(k),
      addEventListener: (k, v) => events.set(k, v), focus() {},
      setPointerCapture(id) { this.captured = id; },
      hasPointerCapture(id) { return this.captured === id; },
      releasePointerCapture() { this.captured = null; },
      fire(type, extra = {}) {
        const event = { pointerId: 1, button: 0, isPrimary: true, clientY: 300, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
        events.get(type)?.(event);
        return event;
      },
    };
  }
  const menu = node();
  const card = node();
  menu.hidden = hidden;
  menu.querySelector = (selector) => selector === ".call-menu-card" ? card : menu.handle;
  menu.appendChild = (child) => { menu.handle = child; };
  card.getBoundingClientRect = () => {
    layoutReads++;
    return { top: 80, height: Number.parseFloat(menu.style.getPropertyValue("--call-panel-height")) || 300 };
  };
  const window = Object.assign(node(), { innerHeight: 900 });
  const document = Object.assign(node(), { readyState: "complete", body: node(), getElementById: () => menu, createElement: node });
  const context = {
    window, document,
    localStorage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) },
    requestAnimationFrame(fn) { const id = ++nextFrame; callbacks.set(id, fn); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    ResizeObserver: class { observe() {} },
  };
  vm.runInNewContext(source, context);
  return {
    menu, card, window, document, handle: menu.handle, values,
    height: () => Number.parseFloat(menu.style.getPropertyValue("--call-panel-height")),
    layoutReads: () => layoutReads,
    frameCount: () => callbacks.size,
    mutate: () => observers.forEach((fn) => fn()),
    flush() { const queued = [...callbacks]; callbacks.clear(); for (const [, fn] of queued) fn(); },
  };
}

test("pointer movements coalesce without layout reads, and commit the final pointer position", () => {
  const page = browser();
  page.handle.fire("pointerdown", { clientY: 300 });
  const reads = page.layoutReads();
  page.handle.fire("pointermove", { clientY: 320 });
  page.handle.fire("pointermove", { clientY: 350 });
  assert.equal(page.frameCount(), 1);
  assert.equal(page.layoutReads(), reads);
  assert.ok(Number.isNaN(page.height()));
  page.flush();
  assert.equal(page.height(), 350);
  page.handle.fire("pointerup", { clientY: 380 });
  assert.equal(page.height(), 380);
  assert.equal(page.values.get("chat.callPanelHeight.v1"), "380");
  assert.equal(page.document.body.dataset.callPanelResizing, undefined);
  assert.equal(page.handle.captured, null);
});

test("Escape and pointer cancellation restore the previous preference", () => {
  const page = browser({ savedHeight: "400" });
  page.handle.fire("pointerdown");
  page.handle.fire("pointermove", { clientY: 420 });
  page.flush();
  assert.equal(page.height(), 520);
  const escape = page.handle.fire("keydown", { key: "Escape" });
  assert.equal(page.height(), 400);
  assert.equal(escape.stopped, true);
  assert.equal(page.values.get("chat.callPanelHeight.v1"), "400");
  page.handle.fire("pointerdown");
  page.handle.fire("pointermove", { clientY: 200 });
  page.flush();
  page.handle.fire("pointercancel");
  assert.equal(page.height(), 400);
});

test("keyboard resizing clamps to the viewport and supports resetting", () => {
  const page = browser();
  page.handle.fire("keydown", { key: "ArrowDown" });
  assert.equal(page.height(), 316);
  page.handle.fire("keydown", { key: "ArrowUp", shiftKey: true });
  assert.equal(page.height(), 280);
  page.handle.fire("keydown", { key: "Home" });
  assert.equal(page.height(), 280);
  page.handle.fire("keydown", { key: "End" });
  assert.equal(page.height(), 692);
  page.handle.fire("keydown", { key: "Enter" });
  assert.ok(Number.isNaN(page.height()));
  assert.equal(page.menu.dataset.callResized, undefined);
  assert.equal(page.values.has("chat.callPanelHeight.v1"), false);
});

test("expanded and hidden menus cannot be resized; restoration preserves preference", () => {
  const page = browser({ savedHeight: "380" });
  page.menu.classList.add("is-expanded");
  page.mutate();
  page.flush();
  assert.equal(page.handle.hidden, true);
  assert.equal(page.handle.tabIndex, -1);
  page.handle.fire("pointerdown");
  page.handle.fire("pointermove", { clientY: 500 });
  page.handle.fire("keydown", { key: "End" });
  assert.equal(page.height(), 380);
  assert.equal(page.document.body.dataset.callPanelResizing, undefined);
  page.menu.classList.remove("is-expanded");
  page.mutate();
  page.flush();
  assert.equal(page.handle.hidden, false);
  assert.equal(page.height(), 380);
  page.menu.hidden = true;
  page.mutate();
  page.flush();
  assert.equal(page.handle.hidden, true);
});

test("viewport shrinking constrains the saved size without losing it", () => {
  const page = browser({ savedHeight: "650" });
  page.window.innerHeight = 500;
  page.window.fire("resize");
  page.flush();
  assert.ok(page.height() < 404);
  assert.equal(page.values.get("chat.callPanelHeight.v1"), "650");
  page.window.innerHeight = 900;
  page.window.fire("resize");
  page.flush();
  assert.equal(page.height(), 650);
});

test("invalid saved heights and another pointer cannot start or hijack resizing", () => {
  const page = browser({ savedHeight: "not-a-number" });
  assert.ok(Number.isNaN(page.height()));
  page.handle.fire("pointerdown", { button: 2 });
  assert.equal(page.handle.captured, undefined);
  page.handle.fire("pointerdown");
  page.handle.fire("pointermove", { pointerId: 2, clientY: 800 });
  page.handle.fire("pointerup", { pointerId: 2, clientY: 800 });
  assert.equal(page.handle.captured, 1);
  page.handle.fire("pointercancel");
  assert.ok(Number.isNaN(page.height()));
});
