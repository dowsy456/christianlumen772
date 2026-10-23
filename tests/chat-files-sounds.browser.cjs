/* Real chat geometry, file transfer events, Firebase prefs and taskbar totals. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');
async function checkVoiceAndImmediateEmbeds(page) {
  await page.evaluate(async () => {
    const app = ChatApp;
    app.openVoicePopover();
    const context = new AudioContext({ sampleRate: 48000 });
    window.__voiceTestContext = context;
    const samples = 12000, wav = new ArrayBuffer(44 + samples * 2), view = new DataView(wav);
    const put = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    put(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    put(36, 'data'); view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 8000), true);
    await app.importVoiceAudio(new File([wav], 'intro.wav', { type: 'audio/wav' }));
    window.__voiceIntro = app.voicePreviewBlob;
    const source = context.createOscillator(), output = context.createMediaStreamDestination();
    source.frequency.value = 880; source.connect(output); source.start();
    app.ensureVoiceRecorderStream = async () => output.stream;
  });
  assert.equal(await page.locator('#btn-voice-start').textContent(), 'Add Recording');
  assert.equal(await page.evaluate(() => ChatApp.getVoicePreviewFile().name), 'intro.wav', 'unmodified imports preserve their file name and type');
  assert.equal(await page.evaluate(() => ChatApp.pendingFiles.length), 0, 'import stays in the voice editor');
  await page.click('#btn-voice-start');
  await page.waitForFunction(() => ChatApp.voiceRecorder?.state === 'recording');
  await page.waitForTimeout(180);
  await page.click('#btn-voice-pause');
  const pausedAt = await page.evaluate(() => ChatApp.getVoiceRecordingElapsedMs());
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => ChatApp.getVoiceRecordingElapsedMs()), pausedAt, 'pause excludes elapsed silence');
  assert.equal(await page.evaluate(() => ChatApp.voiceRecorder.state), 'paused');
  await page.click('#btn-voice-pause');
  await page.waitForTimeout(180);
  await page.click('#btn-voice-stop');
  await page.waitForFunction(() => !ChatApp.voiceRecorder && !ChatApp.voiceDraftBusy && ChatApp.voicePreviewBlob !== __voiceIntro);
  const audio = await page.evaluate(async () => {
    const buffer = await __voiceTestContext.decodeAudioData(await ChatApp.voicePreviewBlob.arrayBuffer());
    const samples = buffer.getChannelData(0);
    const energy = (from, to) => samples.slice(from, to).reduce((sum, value) => sum + Math.abs(value), 0) / (to - from);
    return { type: ChatApp.voicePreviewBlob.type, duration: buffer.duration, intro: energy(0, 10000), speech: energy(14000, Math.min(samples.length, 20000)) };
  });
  assert.equal(audio.type, 'audio/wav');
  assert.ok(audio.duration > .5 && audio.duration < 1.5, JSON.stringify(audio));
  assert.ok(audio.intro > .1 && audio.speech > .1, 'both imported audio and recorded speech are playable');
  await page.click('#btn-voice-stop');
  await page.waitForFunction(() => ChatApp.pendingFiles.length === 1);
  assert.deepEqual(await page.evaluate(() => ({ voice: ChatApp.pendingFiles[0].isVoiceMessage, name: ChatApp.pendingFiles[0].name.endsWith('.wav') })), { voice: true, name: true });
  await page.evaluate(async () => {
    ChatApp.clearPendingFiles(); await __voiceTestContext.close();
    const original = ChatApp.resolveAttachmentURL;
    window.__embedResolverCalls = 0;
    ChatApp.resolveAttachmentURL = (...args) => { __embedResolverCalls++; return original(...args); };
    const fragment = document.createDocumentFragment();
    const row = ChatApp.appendMessageRow({ _key: 'instant-embed', userCode: 'peer', username: 'Peer', createdAt: Date.now(), files: [{ kind: 'image', provider: 'b2-worker-v1', objectKey: 'attachments/test/instant/files/0', size: 5000000, mimeType: 'image/png', fileName: 'instant.png' }] }, { target: fragment, preview: true });
    window.__immediateEmbed = { src: row.querySelector('img.att-media')?.getAttribute('src'), loading: row.querySelector('img.att-media')?.loading, calls: __embedResolverCalls };
    ChatApp.resolveAttachmentURL = original;
  });
  const embed = await page.evaluate(() => __immediateEmbed);
  assert.ok(embed.src?.endsWith('/objects/attachments/test/instant/files/0'), JSON.stringify(embed));
  assert.equal(embed.loading, 'eager'); assert.equal(embed.calls, 0, 'first render does not wait for a resolver or observer');
  const unavailable = await page.evaluate(() => {
    const configuration = globalThis.CHAT_FILE_CONFIG;
    try {
      globalThis.CHAT_FILE_CONFIG = { endpoint: '' };
      const row = ChatApp.appendMessageRow({ _key:'unconfigured-embed', userCode:'peer', username:'Peer', text:'Message survives missing storage configuration', createdAt:Date.now(), files:[{ kind:'image', provider:'b2-worker-v1', objectKey:'attachments/test/missing/files/0', size:5000000, mimeType:'image/png', fileName:'missing.png' }] }, { target:document.createDocumentFragment(), preview:true });
      return { card:!!row.querySelector('button.att-file:not(:disabled)'), text:row.textContent.includes('Message survives missing storage configuration') };
    } finally { globalThis.CHAT_FILE_CONFIG = configuration; }
  });
  assert.deepEqual(unavailable,{card:true,text:true},'missing storage endpoint leaves a readable row with a retryable attachment');
  const lifetime = await page.evaluate(async () => {
    const app = ChatApp, owner = app.currentUser, generation = app.accountSessionGeneration, roomId = app.currentRoomId;
    const join = app.joinVoiceSegments, getStream = app.ensureVoiceRecorderStream;
    const context = new AudioContext(), source = context.createOscillator(); source.start();
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitIdle = async () => { for(let i=0;i<200&&(app.voiceRecorder||app.voiceDraftBusy);i++) await wait(10); if(app.voiceRecorder||app.voiceDraftBusy)throw Error('Voice draft did not settle'); };
    const results = [];
    try {
      app.openVoicePopover();
      for (const action of ['clear', 'room', 'account']) {
        await app.importVoiceAudio(__voiceIntro);
        let release, entered;
        const enteredPromise = new Promise(resolve => entered = resolve);
        app.joinVoiceSegments = async () => { entered(); await new Promise(resolve => release = resolve); return __voiceIntro; };
        app.ensureVoiceRecorderStream = async () => { const output = context.createMediaStreamDestination(); source.connect(output); return output.stream; };
        await app.startVoiceRecording(); await wait(100); app.finishVoiceRecording(); await enteredPromise;
        if(action==='clear') app.clearVoiceRecordingDraft();
        if(action==='room') app.currentRoomId='another-room';
        if(action==='account') { app.currentUser={...owner,code:'other-account'}; app.accountSessionGeneration++; }
        release(); await waitIdle();
        results.push({ action, discarded: !app.voicePreviewBlob });
        app.currentUser=owner;app.accountSessionGeneration=generation;app.currentRoomId=roomId;
      }
      // Permission prompts can finish after navigation. Their late stream must
      // stop without starting a recorder in the new room.
      let allow;
      const output = context.createMediaStreamDestination();source.connect(output);
      app.ensureVoiceRecorderStream=()=>new Promise(resolve=>allow=resolve);
      const pending=app.startVoiceRecording();app.currentRoomId='another-room';allow(output.stream);await pending;
      results.push({ action:'late microphone', discarded:!app.voiceRecorder&&output.stream.getTracks().every(track=>track.readyState==='ended') });
      app.currentRoomId=roomId;
      const mp3 = new File([__voiceIntro], 'saved-name.mp3', {type:'audio/mpeg'});
      await app.importVoiceAudio(mp3);
      results.push({ action:'original file', discarded:app.getVoicePreviewFile()===mp3 });
      await app.importVoiceAudio(new File([__voiceIntro], 'no-mime.flac'));
      results.push({ action:'inferred mime', discarded:app.getVoicePreviewFile().type==='audio/flac'&&app.getVoicePreviewFile().name==='no-mime.flac' });
      return results;
    } finally {
      app.currentUser=owner;app.accountSessionGeneration=generation;app.currentRoomId=roomId;
      app.joinVoiceSegments=join;app.ensureVoiceRecorderStream=getStream;app.clearVoiceRecordingDraft();app.closeVoicePopover();await context.close();
    }
  });
  assert.ok(lifetime.every(result=>result.discarded), JSON.stringify(lifetime));
}
(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    for (const desktop of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      await context.addInitScript(installFirebaseMock);
      await context.addInitScript(desktop => {
        const messages = {};
        for (let i = 0; i < 60; i++) messages[`old-${String(i).padStart(3,'0')}`] = { userCode: 'peer', username: 'Peer', text: `Older message ${i}. ` + 'Read the message content. '.repeat(3), createdAt: 1000 + i };
        __testDatabase.values.messages = { test: messages };
        __testDatabase.values.rooms.test.messageCount = 60;
        __testDatabase.values.memberships['TEST-USER'].test = { joinedAt: 1, lastSeenCount: 0 };
        window.__badges = [];
        if (desktop) {
          window.chatDesktopNotifications = { setUnreadCount: count => __badges.push(count) };
          window.chatDesktopClipboard = { readFiles: async () => [{ name: 'explorer.txt', type: 'text/plain', data: new TextEncoder().encode('from Explorer').buffer }] };
        }
      }, desktop);
      await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.click('#btn-go-login'); await page.fill('#login-code', 'TEST-USER'); await page.click('#btn-login');
      await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
      await page.evaluate(() => ChatApp.openRoom('test', { quiet: true }));
      await page.waitForFunction(() => !ChatApp.bulkLoading && ChatApp.msgDataByKey.size === 60 && ChatApp.canSeeMessage('test', 'old-059'));
      if (process.env.CHAT_FOCUSED_FILES_TEST) {
        await checkVoiceAndImmediateEmbeds(page);
        assert.deepEqual(errors, []);
        await context.close();
        continue;
      }
      await page.evaluate(() => { ChatApp.closeToast(); window.__sounds = []; ChatApp.playNotificationSound = name => __sounds.push(name); });
      async function incoming(key, text = 'Incoming message', userCode = 'peer') {
        await page.evaluate(async ({key,text,userCode}) => {
          await ChatApp.db.ref(`messages/test/${key}`).set({ userCode, username: 'Peer', text, createdAt: Date.now() });
          if (userCode === 'TEST-USER') await ChatApp.updateRoomLastMessage('test', text, key, userCode);
          else await ChatApp.db.ref('rooms/test/messageCount').transaction(n => n + 1);
        }, {key,text,userCode});
        await page.waitForTimeout(220);
      }
      await incoming('visible', '@Tester visible message');
      assert.deepEqual(await page.evaluate(() => __sounds), [], 'visible incoming ping is silent');
      await page.evaluate(() => { ChatApp.roomEntryScroll = null; ChatApp.chatScrollFollowing = false; ChatApp.chatScrollUserReading = true; ChatApp.messagesEl.scrollTop = 0; });
      await incoming('offscreen');
      assert.deepEqual(await page.evaluate(() => __sounds), ['Message'], 'offscreen message in current room alerts');
      assert.equal(await page.evaluate(() => ChatApp.getRoomMissedCount('test')), 1, 'unread room remains unread while scrolled up');
      await incoming('offscreen-ping', '@Tester offscreen');
      assert.deepEqual(await page.evaluate(() => __sounds), ['Message', 'Ping']);
      await incoming('self', 'My message', 'TEST-USER');
      assert.deepEqual(await page.evaluate(() => __sounds), ['Message', 'Ping'], 'own messages never alert');
      assert.equal(await page.evaluate(() => ChatApp.getRoomMissedCount('test')), 2, 'own messages do not add unread or clear unseen peers');
      await page.evaluate(() => ChatApp.creditOwnMessageRead('test', 'self', 'TEST-USER', 64));
      assert.equal(await page.evaluate(() => ChatApp.getRoomMissedCount('test')), 2, 'own read credit is idempotent');
      if (desktop) assert.ok((await page.evaluate(() => __badges)).includes(2), 'badge counts messages, not rooms');
      await page.evaluate(() => { ChatApp.messagesEl.scrollTop = ChatApp.messagesEl.scrollHeight; ChatApp.queueReadReceiptSync(); });
      await page.waitForFunction(() => ChatApp.getRoomMissedCount('test') === 0);

      // The file chooser, drag/drop, paste and direct additions share one cap.
      await page.locator('#file-input').setInputFiles(Array.from({length:13}, (_,i) => ({name:`file-${i}.txt`,mimeType:'text/plain',buffer:Buffer.from('contents')})));
      await page.waitForFunction(() => ChatApp.pendingFiles.length === 12);
      assert.equal(await page.evaluate(async () => ChatApp.addPendingFile(new File(['extra'],'extra.txt'))), false);
      assert.equal(await page.locator('#files-bar-limit').textContent(), '12/12');
      await page.evaluate(() => {
        ChatApp.clearPendingFiles();
        const data = new DataTransfer(); data.items.add(new File(['pasted'], 'clipboard.txt', {type:'text/plain'}));
        document.getElementById('msg-input').dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data}));
      });
      await page.waitForFunction(() => ChatApp.pendingFiles[0]?.name === 'clipboard.txt');
      await page.evaluate(() => {
        ChatApp.clearPendingFiles();
        const data = new DataTransfer(); for (let i=0;i<14;i++) data.items.add(new File(['drop'], `drop-${i}.txt`));
        document.getElementById('messages').dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:data}));
      });
      await page.waitForFunction(() => ChatApp.pendingFiles.length === 12);
      assert.deepEqual(await page.evaluate(async () => {
        ChatApp.clearPendingFiles();
        const limit = 100 * 1024 * 1024;
        const accepted = await ChatApp.addPendingFile({ name: 'at-limit.bin', size: limit });
        const descriptor = { encoding: 'base64-parts-v1', storagePath: 'attachmentBlobs/test/limit/files/0', size: limit, chunkBytes: ChatApp.ATTACHMENT_CHUNK_BYTES, chunkCount: Math.ceil(limit / ChatApp.ATTACHMENT_CHUNK_BYTES) };
        const readable = ChatApp.isStoredAttachment(descriptor);
        ChatApp.clearPendingFiles();
        const rejected = await ChatApp.addPendingFile({ name: 'too-large.zip', size: limit + 1 });
        return { limit: ChatApp.CHAT_FILE_MAX_BYTES, accepted, readable, rejected };
      }), { limit: 100 * 1024 * 1024, accepted: true, readable: true, rejected: false });
      assert.deepEqual(await page.evaluate(async () => {
        const results = [];
        for (let i = 0; i < 4; i++) results.push(await ChatApp.addVoiceMessageFile(new File(['voice'], `voice-${i}.webm`, { type: 'audio/webm' })));
        const canRecordAfterFour = !document.getElementById('btn-voice-start').disabled;
        for (let i = 0; i < 8; i++) results.push(await ChatApp.addPendingFile(new File(['file'], `file-${i}.txt`)));
        const atLimit = {
          total: ChatApp.pendingFiles.length,
          counter: document.getElementById('voice-count').textContent,
          recordDisabled: document.getElementById('btn-voice-start').disabled,
          uploadDisabled: document.getElementById('btn-voice-upload').disabled
        };
        const extraVoice = await ChatApp.addVoiceMessageFile(new File(['voice'], 'extra.webm', { type: 'audio/webm' }));
        const extraFile = await ChatApp.addPendingFile(new File(['file'], 'extra.txt'));
        let microphoneRequested = false;
        const ensureStream = ChatApp.ensureVoiceRecorderStream;
        ChatApp.ensureVoiceRecorderStream = async () => { microphoneRequested = true; throw new Error('Microphone should not be requested when full'); };
        await ChatApp.startVoiceRecording();
        ChatApp.ensureVoiceRecorderStream = ensureStream;
        ChatApp.removePendingFile(0);
        const afterRemove = { count: document.getElementById('voice-count').textContent, recordDisabled: document.getElementById('btn-voice-start').disabled };
        ChatApp.clearPendingFiles();
        const allVoice = [];
        for (let i = 0; i < 12; i++) allVoice.push(await ChatApp.addVoiceMessageFile(new File(['voice'], `voice-${i}.webm`, { type: 'audio/webm' })));
        const voiceTotal = ChatApp.pendingFiles.length;
        ChatApp.clearPendingFiles();
        return { allAdded: results.every(Boolean), canRecordAfterFour, atLimit, extraVoice, extraFile, microphoneRequested, afterRemove, allVoice: allVoice.every(Boolean), voiceTotal, clearedCount: document.getElementById('voice-count').textContent };
      }), { allAdded: true, canRecordAfterFour: true, atLimit: { total: 12, counter: '12/12', recordDisabled: true, uploadDisabled: true }, extraVoice: false, extraFile: false, microphoneRequested: false, afterRemove: { count: '11/12', recordDisabled: false }, allVoice: true, voiceTotal: 12, clearedCount: '0/12' });
      assert.equal(await page.evaluate(async () => { try { await ChatApp.writeMessageAttachmentsToRef({}, Array(13).fill({})); return false; } catch { return true; } }), true);
      if (desktop) {
        await page.evaluate(() => document.getElementById('msg-input').dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:new DataTransfer()})));
        await page.waitForFunction(() => ChatApp.pendingFiles[0]?.name === 'explorer.txt');
      }
      await page.evaluate(() => { ChatApp.clearPendingFiles(); ChatApp.closeToast(); });
      await page.click('#btn-side-settings'); await page.click('#settings-tab-preferences');
      await page.click('#settings-sound-effects-details');
      assert.equal(await page.locator('[data-sound-effect]').count(), 10);
      assert.equal(await page.locator('[data-sound-effect]:checked').count(), 10);
      await incoming('behind-settings', '@Tester behind settings');
      assert.equal((await page.evaluate(() => __sounds)).at(-1), 'Ping', 'covered current-room message alerts');
      await page.locator('label:has(#settings-sound-startwatching)').click();
      await page.waitForFunction(() => __testDatabase.get('users/TEST-USER/settings/soundEffects/startwatching') === false);
      assert.equal(await page.evaluate(() => ChatApp.isSoundEffectEnabled('StartWatching')), false);
      await page.locator('label:has(#settings-sound-effects)').click();
      await page.waitForFunction(() => __testDatabase.get('users/TEST-USER/settings/soundEffectsEnabled') === false);
      assert.equal(await page.evaluate(() => ChatApp.isSoundEffectEnabled('Message')), false);
      const stored = await page.evaluate(async () => {
        const settings = await ChatApp.loadSettingsForUser('TEST-USER');
        ChatApp.applyResolvedSettings(settings);
        return { enabled: settings.soundEffectsEnabled, watching: settings.soundEffects.startwatching, count: Object.keys(settings.soundEffects).length };
      });
      assert.deepEqual(stored, {enabled:false,watching:false,count:10});
      await page.evaluate(() => ChatApp.closeModal());
      await page.evaluate(async () => {
        await ChatApp.db.ref('rooms/other').set({name:'Other',messageCount:5});
        await ChatApp.db.ref('memberships/TEST-USER/other').set({joinedAt:1,lastSeenCount:2});
        await ChatApp.db.ref('rooms/third').set({name:'Third',messageCount:6});
        await ChatApp.db.ref('memberships/TEST-USER/third').set({joinedAt:1,lastSeenCount:2});
      });
      await page.waitForFunction(() => ChatApp.syncUnreadTaskbarBadge() === 7);
      if (desktop) assert.equal(await page.evaluate(() => __badges.at(-1)), 7);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log(process.env.CHAT_FOCUSED_FILES_TEST ? 'Voice and immediate embeds passed for web and desktop: imported PCM + real recorded speech, pause/resume, combined playback, single attachment, eager external image source without resolver/observer delay.' : 'Chat files/sounds passed for web and desktop: visible/hidden/own message sounds, shared 12-file/voice cap, chooser/drop/paste/Explorer, 100 MB boundary and send guard, ten Firebase sound preferences, total unread badge.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
