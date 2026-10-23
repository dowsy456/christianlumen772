"use strict";
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onValueWritten } = require("firebase-functions/v2/database");
const { expireCalendar, expireReminders } = require("./cleanup");

initializeApp({
  projectId: "chatappv6-e9da9",
  databaseURL: "https://chatappv6-e9da9-default-rtdb.firebaseio.com"
});

// Keep system-event metadata ordered identically to the browser renderer,
// including messages saved by the older, unadjusted call-end clock.
function systemMessageTimestamp(message, key) {
  const alphabet = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
  let keyTime = 0;
  if (/^[\w-]{20}$/.test(String(key || ""))) {
    for (const char of key.slice(0, 8)) keyTime = keyTime * 64 + alphabet.indexOf(char);
  }
  const createdAt = Number(message?.createdAt) || Number(message?.system?.createdAt);
  if (Number.isFinite(createdAt) && createdAt > 0 && createdAt <= 8640000000000000) return keyTime ? Math.min(createdAt, keyTime) : createdAt;
  return keyTime;
}

// Browser and worker use the same event claims. This makes retries, multiple
// viewers expiring a poll, and onDisconnect call cleanup produce one message.
async function writeSystemMessage(roomId, event, eventId) {
  const db = getDatabase();
  event = { ...event, createdAt: Math.min(Number(event.createdAt) || Date.now(), Date.now()) };
  const room = (await db.ref(`rooms/${roomId}`).get()).val();
  if (!room || Number(event.createdAt) <= Number(room.messagesClearedAt || 0)) return;
  if (event.pollMessageKey && !(await db.ref(`messages/${roomId}/${event.pollMessageKey}`).get()).exists()) return;
  const key = db.ref(`messages/${roomId}`).push().key;
  const hash = encodeURIComponent(eventId).replace(/\./g, "%2E");
  const claimRef = db.ref(`roomSystemEvents/${roomId}/${hash}`);
  const claim = await claimRef.transaction(value => value?.done ? undefined : value || { key, at: Date.now(), event });
  const record = claim.snapshot.val();
  if (!record || record.done) return;
  event = record.event || event;
  const epoch = Number(room.messagesClearedAt) || 0;
  if (Number(event.createdAt) <= epoch) { await claimRef.update({ done: true }); return; }
  const beforeWrite = (await db.ref(`rooms/${roomId}`).get()).val();
  if (!beforeWrite || (Number(beforeWrite.messagesClearedAt) || 0) !== epoch) { await claimRef.update({ done: true }); return; }
  const messageRef = db.ref(`messages/${roomId}/${record.key}`);
  const result = await messageRef.transaction(value => value ? undefined : { t: "system", system: event, createdAt: event.createdAt || Date.now() });
  if (result.committed || result.snapshot.val()?.t === "system") {
    const saved = result.snapshot.val();
    event = saved.system || event;
    const savedAt = systemMessageTimestamp(saved, record.key);
    if (savedAt <= epoch) { await messageRef.remove(); await claimRef.update({ done: true }); return; }
    const latest = (await db.ref(`rooms/${roomId}`).get()).val();
    if (!latest || (Number(latest.messagesClearedAt) || 0) !== epoch) { await messageRef.remove(); await claimRef.update({ done: true }); return; }
    let preview = "The call ended.";
    if (event.type === "poll_ended") preview = `Poll ended: ${event.question}`;
    if (event.type === "member_joined") preview = `${event.displayName} joined the room.`;
    if (event.type === "member_left") preview = `${event.displayName} left the room.`;
    if (event.type === "call_started") preview = `${event.displayName} started a call.`;
    await db.ref(`rooms/${roomId}`).transaction(current => {
      if (!current) return null;
      if ((Number(current.messagesClearedAt) || 0) !== epoch) return;
      if (current.countedSystemMessages?.[record.key]) return;
      const next = { ...current, messageCount: (Number(current.messageCount) || 0) + 1, countedSystemMessages: { ...(current.countedSystemMessages || {}), [record.key]: true } };
      if (Number(current.lastMessageAt || 0) <= savedAt) { next.lastMessageAt = savedAt; next.lastMessageKey = record.key; next.lastMessagePreview = preview.slice(0, 90); }
      return next;
    });
  }
  await claimRef.update({ done: true });
}
function pollSummary(poll) {
  const options = Array.isArray(poll.options) ? poll.options : [];
  const counts = Object.fromEntries(options.map(option => [option.id, 0]));
  let total = 0;
  for (const vote of Object.values(poll.votes || {})) {
    const ids = [...new Set(Array.isArray(vote?.options) ? vote.options : [])].filter(id => Object.hasOwn(counts, id));
    if (!ids.length) continue;
    total += 1;
    for (const id of (poll.allowMultiple ? ids : ids.slice(0, 1))) counts[id] += 1;
  }
  const maximum = Math.max(0, ...Object.values(counts));
  return { total, winners: maximum ? options.filter(option => counts[option.id] === maximum).map(option => option.text) : [] };
}
async function logPollEnd(roomId, key, poll) {
  if (!poll?.endedAt) return;
  await writeSystemMessage(roomId, { type: "poll_ended", question: poll.question, ...pollSummary(poll), pollMessageKey: key, createdAt: poll.endedAt }, `poll-ended:${key}`);
}
exports.trackPolls = onValueWritten({ ref: "/messages/{roomId}/{messageKey}/poll", region: "us-central1", retry: true }, async event => {
  const { roomId, messageKey } = event.params;
  const poll = event.data.after.val();
  const ref = getDatabase().ref(`activePolls/${roomId}/${messageKey}`);
  if (!poll || poll.endedAt) {
    await ref.remove();
    if (poll?.endedAt) await logPollEnd(roomId, messageKey, poll);
  } else if (Number(poll.endsAt) > 0 && (!event.data.before.exists() || event.data.before.val()?.endsAt !== poll.endsAt)) {
    await ref.set({ endsAt: poll.endsAt });
  }
});
exports.finishExpiredPolls = onSchedule({ schedule: "* * * * *", timeZone: "UTC", region: "us-central1", timeoutSeconds: 120, maxInstances: 1 }, async () => {
  const db = getDatabase();
  const active = (await db.ref("activePolls").get()).val() || {};
  const now = Date.now();
  const jobs = [];
  for (const [roomId, polls] of Object.entries(active)) for (const [key, entry] of Object.entries(polls || {})) {
    if (Number(entry.endsAt) > now) continue;
    jobs.push(async () => {
      const result = await db.ref(`messages/${roomId}/${key}`).transaction(message => {
        if (!message) return null;
        if (!message.poll || message.poll.endedAt || Number(message.poll.endsAt) > now) return;
        return { ...message, poll: { ...message.poll, endedAt: Number(message.poll.endsAt), endedBy: "timer" } };
      });
      const message = result.snapshot.val();
      if (message?.poll?.endedAt) await logPollEnd(roomId, key, message.poll);
      if (!message?.poll || message.poll.endedAt) await db.ref(`activePolls/${roomId}/${key}`).remove();
    });
  }
  for (let index = 0; index < jobs.length; index += 10) await Promise.all(jobs.slice(index, index + 10).map(job => job()));
  // Respect the same reconnect grace as the browser before retiring calls
  // whose last tab was closed. The compare-and-swap preserves a fresh rejoin.
  const pendingCalls = (await db.ref("pendingCallEnds").get()).val() || {};
  for (const [roomId, pending] of Object.entries(pendingCalls)) {
    if (pending.canceled || Number(pending.eligibleAt) > now) continue;
    await db.ref(`calls/${roomId}`).transaction(call => {
      if (!call) return null;
      if (call.instanceId !== pending.instanceId) return;
      const members = Object.values(call.members || {}).filter(member => member?.sessionId);
      if (members.some(member => member.connected !== false || now - (Number(member.updatedAt || member.lastSeenAt) || now) < 45000)) return;
      return null;
    });
    await db.ref(`pendingCallEnds/${roomId}`).transaction(current => current?.instanceId === pending.instanceId && current.eligibleAt === pending.eligibleAt ? null : undefined);
  }
});
exports.logRoomMembership = onValueWritten({ ref: "/memberships/{userCode}/{roomId}", region: "us-central1", retry: true }, async event => {
  const before = event.data.before.val();
  const after = event.data.after.val();
  if (!!before === !!after) return;
  const { userCode, roomId } = event.params;
  const [username, displayName] = await Promise.all(["username", "displayName"].map(field => getDatabase().ref(`users/${userCode}/${field}`).get()));
  const user = { username: username.val(), displayName: displayName.val() };
  const type = after ? "member_joined" : "member_left";
  const joinedAt = Number((after || before)?.joinedAt) || 0;
  await writeSystemMessage(roomId, { type, userCode, username: user.username || "User", displayName: user.displayName || user.username || "User", createdAt: after ? joinedAt || Date.parse(event.time) : Date.parse(event.time) }, `${after ? "member-joined" : "member-left"}:${userCode}:${joinedAt}`);
});
exports.logCallLifecycle = onValueWritten({ ref: "/calls/{roomId}", region: "us-central1", retry: true }, async event => {
  const before = event.data.before.val();
  const after = event.data.after.val();
  // WebRTC candidates, volumes and motion do not change call lifecycle.
  // Avoid additional reads on every such event if this optional worker is used.
  const lifecycle = call => JSON.stringify([call?.instanceId || "", Object.entries(call?.members || {}).filter(([, member]) => member?.sessionId).map(([code, member]) => [code, member.sessionId, member.connected !== false]).sort()]);
  if (lifecycle(before) === lifecycle(after)) return;
  const members = call => Object.values(call?.members || {}).filter(member => member?.sessionId);
  const hadMembers = members(before).length > 0;
  const hasMembers = members(after).length > 0;
  const roomId = event.params.roomId;
  if (!(await getDatabase().ref(`rooms/${roomId}`).get()).exists()) { await getDatabase().ref(`pendingCallEnds/${roomId}`).remove(); return; }
  const allDisconnected = call => members(call).length > 0 && members(call).every(member => member.connected === false);
  const eventAt = Date.parse(event.time) || Date.now();
  const savePending = value => getDatabase().ref(`pendingCallEnds/${roomId}`).transaction(current => Number(current?.eventAt || 0) >= eventAt ? undefined : { ...value, eventAt });
  if (allDisconnected(after)) {
    if (!allDisconnected(before) || before?.instanceId !== after?.instanceId) await savePending({ instanceId: after.instanceId, eligibleAt: eventAt + 45000, canceled: false });
  } else if (allDisconnected(before) || !after) await savePending({ instanceId: before?.instanceId || "", eligibleAt: 0, canceled: true });
  if (hadMembers && (!hasMembers || before?.instanceId !== after?.instanceId) && before?.instanceId) {
    await writeSystemMessage(roomId, { type: "call_ended", createdAt: Date.parse(event.time) || Date.now() }, `call-ended:${before.instanceId}`);
  }
  if (hasMembers && (!hadMembers || before?.instanceId !== after?.instanceId) && after?.instanceId) {
    const starter = after.members?.[after.startedBy] || members(after).sort((a, b) => (Number(a.joinedAt) || 0) - (Number(b.joinedAt) || 0))[0];
    const code = after.startedBy || starter.code || Object.keys(after.members || {})[0];
    await writeSystemMessage(roomId, { type: "call_started", userCode: code, username: starter.username || "User", displayName: starter.displayName || starter.username || "User", createdAt: Number(after.startedAt) || Date.parse(event.time) || Date.now() }, `call-started:${after.instanceId}`);
  }
});

// Local midnight deadlines are stored by the browser. The worker does not
// reinterpret them in UTC and can run while every browser is closed.
exports.cleanupCalendar = onSchedule({
  schedule: "* * * * *",
  timeZone: "UTC",
  region: "us-central1",
  timeoutSeconds: 120,
  maxInstances: 1
}, async () => {
  const db = getDatabase();
  const now = Date.now();
  // The first callback can be null before Firebase has fetched the server
  // value. Propose null once so the server retries with its current record;
  // undefined would abort and silently skip cleanup on a cold function start.
  await db.ref("calendar").transaction(value => {
    const next = expireCalendar(value, now);
    return next === undefined ? value : next;
  });
  const accounts = await db.ref("calendarReminders").get();
  const codes = Object.keys(accounts.val() || {});
  // Bounded batches avoid opening a transaction for every account at once.
  for (let offset = 0; offset < codes.length; offset += 20) {
    await Promise.all(codes.slice(offset, offset + 20).map(code =>
      db.ref(`calendarReminders/${code}`).transaction(value => {
        const next = expireReminders(value, now);
        return next === undefined ? value : next;
      })
    ));
  }
});
