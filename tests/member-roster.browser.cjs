/* Regressions run only against the in-memory database, never production. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const mock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(mock);
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.click('#btn-go-login');
    await page.fill('#login-code', 'TEST-USER');
    await page.click('#btn-login');
    await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
    await page.evaluate(async () => {
      const db = window.__testDatabase;
      await db.ref('rooms/other').set({ name: 'Other room', createdBy: 'TEST-USER' });
      for (const [code, record] of [['ALICE', { username: 'Alice' }], ['REAL-USER', { username: 'User' }], ['AUTHOR', { username: 'CalendarAuthor' }], ['MALFORMED', { calendarReminders: { note: true } }]]) {
        await db.ref(`users/${code}`).set(record);
      }
      for (const code of ['TEST-USER', 'ALICE', 'REAL-USER', 'ORPHAN', 'MALFORMED']) {
        await db.ref(`memberships/${code}`).set({ test: true, other: true });
        await db.ref(`roomMembers/test/${code}`).set(true);
        await db.ref(`roomMembers/other/${code}`).set(true);
      }
      await db.ref('memberships/NOT-JOINED/test').set(false);
      await db.ref('rooms/test/online/ORPHAN').set({ username: 'FormerAccount', typing: true });
      await db.ref('rooms/test/online/PRESENCE-ONLY').set({ username: 'Nobody' });
      await db.ref('rooms/test/online/not-a-presence').set(true);
      await db.ref('calls/test/members/NO-ACCOUNT').set({ connected: true, username: 'Missing', joinedAt: Date.now() });
      await ChatApp.openRoom('test', { quiet: true });
    });
    const roster = () => page.locator('#online-list .member-row').evaluateAll(rows => rows.map(row => row.dataset.usercode).sort());
    await page.waitForFunction(() => ChatApp.liveUserCache.get('ALICE')?.username === 'Alice' && ChatApp.liveUserCache.has('ORPHAN'));
    assert.deepEqual(await roster(), ['ALICE', 'REAL-USER', 'TEST-USER'], 'membership and presence records require an actual account');

    const row = page.locator('#online-list .member-row[data-usercode="ALICE"]');
    // Activity categories share one detail row and promote the next priority
    // immediately when a live provider clears its session.
    await page.evaluate(async () => {
      window.__originalRosterClassName = ChatApp.getClassNameAtTimestamp;
      window.__originalMemberClassmates = ChatApp.getMemberClassmates;
      ChatApp.getMemberClassmates = (code, timestamp) => code === 'ALICE' ? [ChatApp.currentUser] : window.__originalMemberClassmates(code, timestamp);
      ChatApp.getClassNameAtTimestamp = (stamp, options) => options?.username === 'Alice' ? 'Physics' : window.__originalRosterClassName(stamp, options);
      await ChatApp.db.ref('users/ALICE').update({
        gameActivitySessions: {desktop:{updatedAt:Date.now(),games:[{id:'roblox',title:'Roblox',experienceTitle:'Community Adventure',creator:'A Creator Group',mode:'Adventure',state:'adventure',privacy:'Private',icon:'https://example.com/game.png',platformIcon:'https://example.com/roblox.png',startedAt:Date.now()-125000}]}},
        spotifySessions: {desktop:{updatedAt:Date.now(),track:{id:'1234567890123456789012',title:'First song',artist:'The Artist'}}}
      });
    });
    await page.waitForFunction(() => document.querySelector('[data-usercode="ALICE"] .member-sub')?.dataset.activityKind === 'game');
    assert.equal(await row.locator('.member-activity-text').textContent(), 'Playing Community Adventure on Roblox · Adventure · Private');
    assert.equal(await row.locator('.member-activity-more').textContent(), '+2');
    assert.equal(await row.locator('.member-name-row .member-activity-indicator').count(), 0);
    const activityTooltip = page.locator('.member-activities-floating');
    await row.locator('.member-activity-primary').hover();
    await activityTooltip.waitFor({state:'visible'});
    assert.equal(await activityTooltip.locator('.member-activity-tooltip-row').first().textContent(), 'Playing Community Adventure on Roblox · Adventure · Private', 'hovered game tooltip preserves details and suppresses duplicate mode/state labels');
    await row.locator('.member-activity-more').hover();
    assert.match(await activityTooltip.textContent(), /First song.*The Artist/);
    assert.equal(await activityTooltip.locator('.member-activity-tooltip-row').last().textContent(), 'Physics');
    assert.equal(await activityTooltip.locator('.member-activity-tooltip-row .schedule-activity-icon').count(), 1);
    assert.equal(await activityTooltip.locator('.member-activity-tooltip-section').last().locator('.call-viewers-label').textContent(), 'In Class With');
    assert.equal(await activityTooltip.evaluate(node => getComputedStyle(node.querySelector('.member-activity-tooltip-row')).fontSize), '11px');
    await row.click();
    await page.locator('#user-profile-popover').waitFor({state:'visible'});
    await activityTooltip.waitFor({state:'hidden'});
    assert.match(await page.locator('.user-profile-activity[data-activity-kind="game"]').textContent(), /Community Adventure.*A Creator Group/);
    assert.equal(await page.locator('.user-profile-game-platform').count(), 1);
    assert.ok((await page.locator('[data-activity-started-at]').textContent()).length > 0, 'profile displays game duration');
    await row.locator('.member-activity-more').hover();
    assert.equal(await activityTooltip.isVisible(), false, 'profile suppresses the member tooltip');
    await page.locator('.user-profile-close').click();
    await page.locator('#user-profile-popover').waitFor({state:'hidden'});
    await page.mouse.move(1, 1);
    await row.locator('.member-activity-more').hover();
    await page.evaluate(() => ChatApp.db.ref('users/ALICE/spotifySessions/desktop/track/title').set('Updated song'));
    await page.waitForFunction(() => document.querySelector('.member-activities-floating')?.textContent.includes('Updated song'));
    await page.mouse.move(1, 1);
    await activityTooltip.waitFor({state:'hidden'});
    await page.evaluate(() => ChatApp.db.ref('users/ALICE/gameActivitySessions').remove());
    await page.waitForFunction(() => document.querySelector('[data-usercode="ALICE"] .member-sub')?.dataset.activityKind === 'spotify');
    assert.equal(await row.locator('.member-activity-more').textContent(), '+1');
    assert.match(await row.locator('.member-activity-text').textContent(), /Updated song/);
    await row.locator('.member-activity-more').focus();
    await activityTooltip.waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await activityTooltip.waitFor({state:'hidden'});
    await page.evaluate(() => ChatApp.db.ref('users/ALICE/spotifySessions').remove());
    await page.waitForFunction(() => document.querySelector('[data-usercode="ALICE"] .member-sub')?.dataset.activityKind === 'class');
    assert.equal(await row.locator('.member-activity-text').textContent(), 'Physics');
    assert.equal(await row.locator('.member-activity-more').isVisible(), false);
    await page.evaluate(() => { ChatApp.getClassNameAtTimestamp = window.__originalRosterClassName; ChatApp.getMemberClassmates = window.__originalMemberClassmates; ChatApp.refreshOnlineIndicatorStatusTexts(); });
    let menuOpens = 0;
    await page.exposeFunction('__countMemberMenu', () => { menuOpens++; });
    await page.evaluate(() => {
      const original = ChatApp.openAvatarContextMenuFor;
      ChatApp.openAvatarContextMenuFor = (...args) => { window.__countMemberMenu(); return original(...args); };
    });
    for (const target of [row.locator('.member-name'), row.locator('.online-ava-img'), row]) {
      await target.click({ button: 'right', position: target === row ? { x: 220, y: 20 } : undefined });
      await page.waitForFunction(() => ChatApp.msgMenuCtx?.menu === 'avatar' && ChatApp.msgMenuCtx?.userCode === 'ALICE' && !ChatApp.msgMenuEl.hidden);
      assert.equal(await page.evaluate(() => ChatApp.msgMenuCtx.username), 'Alice');
      await page.evaluate(() => ChatApp.closeMsgMenu(true));
    }
    assert.equal(menuOpens, 3, 'name, avatar, and empty row area each open the existing menu exactly once');

    // Calendar author cache hydration must never add a nonmember to a room.
    await page.waitForFunction(() => ChatApp.calendarState?.ready);
    await page.evaluate(async () => {
      const author = { code: 'AUTHOR', username: 'CalendarAuthor' };
      const authorKey = await ChatApp.sha256Hex(author.username.toLowerCase());
      await ChatApp.db.ref(`usernames/${authorKey}`).set({ code: author.code });
      const date = ChatApp.calendarState.today;
      await ChatApp.db.ref(`calendar/years/${ChatApp.calendarState.year}/${date}/author-note`).set({ text: 'Author outside this room', authorUsername: author.username, createdAt: Date.now(), updatedAt: Date.now() });
      ChatApp.showCalendarDay(date);
    });
    await page.locator('.calendar-author-button:not(:disabled)').waitFor();
    for (const roomId of ['other', 'test', 'other', 'test']) {
      await page.evaluate(roomId => ChatApp.openRoom(roomId, { quiet: true }), roomId);
      await page.waitForFunction(() => document.querySelectorAll('#online-list .member-row').length === 3);
      assert.deepEqual(await roster(), ['ALICE', 'REAL-USER', 'TEST-USER'], `Calendar navigation and ${roomId} room transitions do not create extra people`);
    }

    // A room subscription may already have queued a callback when Calendar detaches it.
    await page.evaluate(() => {
      const staleMembers = ChatApp.roomMembersCb;
      ChatApp.showCalendarPage();
      staleMembers({ exists: () => true, val: () => ({ AUTHOR: { test: true } }) });
      if (ChatApp.roomMembersCache.size !== 0) throw new Error('Detached room callback repopulated the members cache');
    });
    await page.evaluate(() => ChatApp.openRoom('test', { quiet: true }));
    await page.waitForFunction(() => document.querySelectorAll('#online-list .member-row').length === 3);

    await page.evaluate(() => ChatApp.db.ref('users/ALICE').remove());
    await row.waitFor({ state: 'detached' });
    assert.deepEqual(await roster(), ['REAL-USER', 'TEST-USER'], 'a deleted member disappears even while the membership remains');
    await page.evaluate(() => ChatApp.db.ref('users/ALICE').set({ username: 'AliceRestored' }));
    await row.waitFor();
    assert.equal(await row.locator('.member-name').textContent(), 'AliceRestored');

    // A resolved Calendar author from an earlier render cannot resurrect a deleted account.
    await page.evaluate(() => ChatApp.showCalendarDay(ChatApp.calendarState.today));
    await page.locator('.calendar-author-button:not(:disabled)').waitFor();
    await page.evaluate(async () => { await ChatApp.db.ref('users/AUTHOR').remove(); ChatApp.renderCalendar(); });
    await page.waitForFunction(() => ChatApp.liveUserCache.get('AUTHOR') === null);
    await page.evaluate(() => ChatApp.renderCalendar());
    assert.equal(await page.locator('.calendar-author-button').isDisabled(), true);
    assert.equal(await page.evaluate(() => ChatApp.liveUserCache.get('AUTHOR')), null);

    // Firebase val() returns an array for dense numeric room keys. An offline
    // member has no room/call presence to compensate for skipping that map.
    await page.evaluate(async () => {
      const db = window.__testDatabase;
      await db.ref('rooms/1').set({ name: 'Numbered room', createdBy: 'TEST-USER' });
      await db.ref('memberships/TEST-USER/1').set({ joinedAt: Date.now() });
      for (const [code, username] of [['WILLIAM', 'William'], ['LEGACY', 'LegacyMember'], ['NOT-JOINED', 'NotJoined']]) {
        await db.ref(`users/${code}`).set({ username });
      }
      await db.ref('memberships/WILLIAM').set([null, { joinedAt: Date.now() }]);
      await db.ref('memberships/LEGACY').set([null, true]);
      await db.ref('memberships/ORPHAN').set([null, true]);
      await db.ref('memberships/MALFORMED').set([null, true]);
      await db.ref('memberships/NOT-JOINED').set([null, false]);
      await db.ref('roomMembers/1').set({'TEST-USER':true,WILLIAM:true,LEGACY:true,ORPHAN:true,MALFORMED:true});
      await ChatApp.openRoom('1', { quiet: true });
    });
    await page.waitForFunction(() => ChatApp.roomMembersCache.has('TEST-USER'));
    assert.equal(await page.evaluate(() => ChatApp.roomMembersCache.has('WILLIAM')), true,
      'offline members of numbered rooms must survive Firebase array serialization');
    await page.waitForFunction(() => ChatApp.liveUserCache.get('WILLIAM')?.username === 'William' && ChatApp.liveUserCache.get('LEGACY')?.username === 'LegacyMember');
    const numericRoster = ['LEGACY', 'TEST-USER', 'WILLIAM'];
    assert.deepEqual(await roster(), numericRoster, 'numeric memberships retain real offline users without restoring phantom members');
    const william = page.locator('#online-list .member-row[data-usercode="WILLIAM"]');
    assert.equal(await william.locator('.member-name').textContent(), 'William');
    assert.equal(await william.locator('.member-status-dot').getAttribute('data-state'), 'offline');
    assert.equal(await page.evaluate(() => ChatApp.onlineLabelEl.textContent), 'Members - 3');
    assert.equal(await page.evaluate(() => ChatApp.onlinePresenceCache.has('WILLIAM') || ChatApp.roomCallMembersCache.has('WILLIAM') || ChatApp.appPresenceCache.has('WILLIAM')), false,
      'the offline fixture must not rely on presence to appear');

    // Joining/leaving a named room changes Firebase's map representation only.
    for (const memberships of [{ 1: { joinedAt: 123 }, general: true }, [null, { joinedAt: 123 }]]) {
      await page.evaluate(value => ChatApp.db.ref('memberships/WILLIAM').set(value), memberships);
      assert.deepEqual(await roster(), numericRoster, 'array/object transitions retain the same room member');
    }
    // A sparse array hole is not membership; adding the child restores it.
    await page.evaluate(async () => {
      await ChatApp.db.ref('memberships/WILLIAM').set([null, null, true]);
      await ChatApp.db.ref('roomMembers/1/WILLIAM').remove();
    });
    await william.waitFor({ state: 'detached' });
    assert.deepEqual(await roster(), ['LEGACY', 'TEST-USER']);
    await page.evaluate(async () => {
      await ChatApp.db.ref('memberships/WILLIAM').set([null, { joinedAt: 123 }, true]);
      await ChatApp.db.ref('roomMembers/1/WILLIAM').set(true);
    });
    await william.waitFor();
    assert.deepEqual(await roster(), numericRoster);
    await page.evaluate(() => ChatApp.showCalendarPage());
    await page.evaluate(() => ChatApp.openRoom('1', { quiet: true }));
    await william.waitFor();
    assert.deepEqual(await roster(), numericRoster, 'offline members survive Calendar and room navigation');
    const mobile = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await mobile.addInitScript(mock);
    await mobile.route(/^https?:\/\//, route => route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
    const touchPage = await mobile.newPage();
    touchPage.on('pageerror', error => errors.push(error.stack || error.message));
    await touchPage.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    await touchPage.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await touchPage.click('#btn-go-login'); await touchPage.fill('#login-code','TEST-USER'); await touchPage.click('#btn-login');
    await touchPage.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
    await touchPage.evaluate(async () => {
      ChatApp.getClassNameAtTimestamp = () => 'Physics';
      await ChatApp.db.ref('users/MOBILE-FRIEND').set({username:'MobileFriend',displayName:'Mobile Friend',
        gameActivitySessions:{desktop:{updatedAt:Date.now(),games:[{id:'game',title:'A very long community adventure game'}]}},
        spotifySessions:{desktop:{updatedAt:Date.now(),track:{id:'1234567890123456789012',title:'A long song title',artist:'A performer with a long name'}}}
      });
      await ChatApp.db.ref('memberships/MOBILE-FRIEND/test').set(true);
      await ChatApp.db.ref('roomMembers/test/MOBILE-FRIEND').set(true);
      await ChatApp.openRoom('test',{quiet:true});
    });
    await touchPage.waitForFunction(() => document.querySelector('[data-usercode="MOBILE-FRIEND"] .member-activity-more')?.textContent === '+2');
    if (!await touchPage.locator('#members-sidebar').isVisible()) await touchPage.locator('#btn-members').tap();
    await touchPage.locator('[data-usercode="MOBILE-FRIEND"] .member-activity-more').tap();
    const touchTooltip = touchPage.locator('.member-activities-floating');
    await touchTooltip.waitFor({state:'visible'});
    await touchPage.waitForTimeout(200);
    assert.equal(await touchTooltip.isVisible(), true, 'the touch tooltip stays visible after synthetic hover ends');
    assert.equal(await touchPage.evaluate(() => ChatApp.userProfileOpen), false, 'tapping +2 opens activities without opening the member profile');
    const geometry = await touchTooltip.boundingBox();
    assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= 390, 'mobile activity tooltip remains within the viewport');
    assert.match(await touchTooltip.textContent(), /A long song title/);
    if (process.env.QA_SCREENSHOTS) {
      require('node:fs').mkdirSync(process.env.QA_SCREENSHOTS,{recursive:true});
      await touchPage.waitForTimeout(180);
      await touchPage.screenshot({path:path.join(process.env.QA_SCREENSHOTS,'mobile-member-activities.png')});
    }
    await touchPage.touchscreen.tap(8, 400);
    await touchTooltip.waitFor({state:'hidden'});
    await mobile.close();
    assert.deepEqual(errors, []);
    console.log('Offline numeric-room members, member roster, Calendar navigation/deletion, and whole-row context menus: PASS');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
