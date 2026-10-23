"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness(width = 700) {
  const nodes = new Map();
  function node(id) {
    const element = { id, hidden: false, dataset: {}, parentElement: null, children: [], attributes: {},
      getBoundingClientRect: () => ({ width }),
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      appendChild(child) {
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
        child.parentElement = this;
        this.children.push(child);
      }
    };
    nodes.set(id, element);
    return element;
  }
  const ids = ["btn-emoji", "btn-stickers", "btn-voice", "btn-members", "btn-activities"];
  [...ids, "composer-row", "composer-actions-direct", "composer-more-actions", "btn-composer-more"].forEach(node);
  const app = { register() {}, $: id => nodes.get(id), COMPOSER_OPTIONAL_TOOL_IDS: ids,
    currentRoomId: "room", getStoredPlace: () => "room:room", views: { chat: { dataset: { active: "true" } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/chat/emoji.js"), "utf8"), { ChatApp: app });
  app.closeComposerMoreMenu = () => { app.closed = true; };
  return { app, nodes };
}

test("every composer width has either zero or at least two overflow tools", () => {
  const { app } = harness();
  for (let count = 0; count <= 5; count++) for (let width = 200; width <= 1000; width++) {
    const direct = app.getComposerDirectToolCount(width, count);
    assert.ok(direct >= 0 && direct <= count);
    assert.notEqual(count - direct, 1, `Width ${width}, tools ${count}`);
  }
  assert.equal(app.getComposerDirectToolCount(700, 5), 5, "The fifth tool replaces More Tools without using extra width");
});

test("hidden and missing tools do not create an empty or one-item overflow menu", () => {
  const { app, nodes } = harness(550);
  app.syncComposerToolLayout();
  assert.equal(nodes.get("composer-more-actions").children.length, 2);
  assert.equal(nodes.get("btn-composer-more").hidden, false);
  nodes.get("btn-activities").hidden = true;
  app.syncComposerToolLayout();
  assert.equal(nodes.get("btn-composer-more").hidden, true);
  assert.equal(nodes.get("btn-members").parentElement.id, "composer-actions-direct");
  assert.equal(app.closed, true);
  nodes.delete("btn-activities");
  app.syncComposerToolLayout();
  assert.equal(nodes.get("btn-composer-more").hidden, true);
});

function pollHarness() {
  const values = new Map();
  const app = { register() {}, currentUser: { code: "a", username: "Alice" }, sanitizeRoomCode: value => value, firebaseServerTimeOffsetMs: 0 };
  app.db = { ref: key => ({
    once: async () => ({ val: () => values.get(key) || null, exists: () => values.has(key) }),
    transaction: async update => {
      const next = update(values.get(key) || null);
      if (next !== undefined) { if (next === null) values.delete(key); else values.set(key, next); }
      return { committed: next !== undefined, snapshot: { val: () => values.get(key) || null } };
    }
  }) };
  const context = { ChatApp: app, Date, console, setTimeout, clearTimeout };
  for (const file of ["composer-state.js", "send.js"]) vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../js/chat", file), "utf8"), context);
  app.logs = [];
  app.realWriteRoomSystemMessage = app.writeRoomSystemMessage;
  app.writeRoomSystemMessage = async (...args) => { app.logs.push(args); return true; };
  values.set("memberships/a/room", true);
  const message = { userCode: "a", poll: { question: "Lunch?", options: [{ id: "a0", text: "Pizza" }, { id: "a1", text: "Tacos" }], allowMultiple: false, endsAt: Date.now() + 3600000 } };
  values.set("messages/room/poll", message);
  return { app, values, message };
}
test("poll drafts support exact durations, legacy drafts, limits and a separate payload", () => {
  const { app } = pollHarness();
  for (const durationHours of [1, 4, 8, 24, 72, 168]) {
    const draft = app.validatePollDraft({ question: "Lunch?", answers: ["Pizza", "🌮 Tacos"], durationHours, allowMultiple: true });
    assert.equal(draft.durationSeconds, durationHours * 3600);
    assert.equal(draft.allowMultiple, true);
  }
  const custom = app.validatePollDraft({ question: 'When?', answers: ['a', 'b'], duration: { days: 2, hours: 3, minutes: 4, seconds: 5 } });
  assert.equal(custom.durationSeconds, 183845);
  for (const durationSeconds of [1, 59, 60, 7200, 183845]) assert.equal(app.validatePollDraft({question:'When?',answers:['a','b'],durationSeconds}).durationSeconds,durationSeconds);
  assert.equal(app.pollRemainingText(1500), '2 seconds left');
  assert.equal(app.pollRemainingText(500), '1 second left');
  for (const change of [{ question: "" }, { question: "x".repeat(301) }, { answers: ["One"] }, { answers: ["Same", "same"] }, { answers: Array(11).fill("a") }, { answers: ["x".repeat(56), "b"] }, { durationSeconds: 0 }, { durationSeconds: -1 }, { durationSeconds: 1.5 }, { durationSeconds: Infinity }, { durationSeconds: Number.MAX_SAFE_INTEGER }, { duration: {hours:24} }, { duration: {minutes:60} }, { duration: {seconds:60} }]) {
    assert.throws(() => app.validatePollDraft({ question: "Question", answers: ["a", "b"], durationHours: 24, ...change }));
  }
});
test("poll voting replaces a member's vote and supports removal", async () => {
  const { app, values } = pollHarness();
  await app.voteInPoll("room", "poll", ["a0"]);
  await app.voteInPoll("room", "poll", ["a1"]);
  assert.deepEqual([...values.get("messages/room/poll").poll.votes.a.options], ["a1"]);
  assert.equal(app.getPollResults(values.get("messages/room/poll").poll).total, 1);
  await app.voteInPoll("room", "poll", []);
  assert.equal(app.getPollResults(values.get("messages/room/poll").poll).total, 0);
});
test("polls reject nonmembers, multiple single-choice selections and expired votes", async () => {
  const { app, message, values } = pollHarness();
  await assert.rejects(app.voteInPoll("room", "poll", ["a0", "a1"]), /ended|deleted/);
  values.delete("memberships/a/room");
  await assert.rejects(app.voteInPoll("room", "poll", ["a0"]), /Join/);
  values.set("memberships/a/room", false);
  await assert.rejects(app.voteInPoll("room", "poll", ["a0"]), /Join/);
  values.set("memberships/a/room", true); message.poll.endsAt = Date.now() - 1;
  await assert.rejects(app.voteInPoll("room", "poll", ["a0"]), /ended/);
});
test("multi-answer poll results count people once, dedupe options and preserve ties", async () => {
  const { app, values, message } = pollHarness(); message.poll.allowMultiple = true;
  await app.voteInPoll("room", "poll", ["a0", "a1", "a1", "invalid"]);
  const result = app.getPollResults(values.get("messages/room/poll").poll);
  assert.equal(result.total, 1);
  assert.equal(result.counts.a0, 1); assert.equal(result.counts.a1, 1);
  assert.deepEqual([...result.winners], ["Pizza", "Tacos"]);
});
test("only creator may end early, natural expiry works for viewers, deleted polls stay deleted", async () => {
  const { app, values, message } = pollHarness();
  app.currentUser = { code: "b", username: "Bob" };
  assert.equal(await app.finishPoll("room", "poll", { early: true }), false);
  assert.equal(message.poll.endedAt, undefined);
  message.poll.endsAt = Date.now() - 1;
  assert.equal(await app.finishPoll("room", "poll"), true);
  assert.equal(values.get("messages/room/poll").poll.endedBy, "timer");
  assert.equal(app.logs[0][2], "poll-ended:poll");
  assert.equal(app.logs[0][1].total, 0);
  values.delete("messages/room/poll");
  assert.equal(await app.finishPoll("room", "poll"), false);
  assert.equal(values.has("messages/room/poll"), false);
});
test("poll end retries an interrupted system log without reopening voting", async () => {
  const { app, values } = pollHarness();
  let fail = true;
  app.writeRoomSystemMessage = async () => { if (fail) { fail = false; throw Error("offline"); } app.logs.push("saved"); };
  await assert.rejects(app.finishPoll("room", "poll", { early: true }), /offline/);
  assert.ok(values.get("messages/room/poll").poll.endedAt);
  await app.finishPoll("room", "poll");
  assert.deepEqual(app.logs, ["saved"]);
});
test("finishing a poll automatically retries a transient log failure with a stable event", async () => {
  const { app, values } = pollHarness();
  const attempts = [];
  app.writeRoomSystemMessage = app.realWriteRoomSystemMessage;
  app.commitRoomSystemMessage = async (room, event, id) => {
    attempts.push({ room, event, id });
    if (attempts.length === 1) throw Error("disconnected");
    return true;
  };
  await app.finishPoll("room", "poll", { early: true });
  assert.ok(values.get("messages/room/poll").poll.endedAt);
  assert.equal(attempts.length, 2, "retry happens without a user action or rerender");
  assert.equal(attempts[0].id, attempts[1].id);
  assert.equal(attempts[0].event.createdAt, attempts[1].event.createdAt);
});
