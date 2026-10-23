/* Uses the in-memory fixture; run: node tests/people-settings.browser.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');
const {createSharedFirebaseBackend} = require('./shared-firebase-backend.cjs');

async function verifyCloakKeys(browser) {
  const backend = createSharedFirebaseBackend(2), contexts = [], errors = [];
  const isCloaked = page => page.evaluate(() => !!document.getElementById('__shift_z_blackout__')?.classList.contains('on'));
  const press = async (page, keys) => { await page.waitForTimeout(140); for (const key of keys) await page.keyboard.press(key); };
  const openSettings = async page => {
    await page.evaluate(() => ChatApp.$('btn-side-settings').click());
    await page.click('#settings-tab-preferences');
  };
  const login = async (page, code) => {
    await page.click('#btn-go-login'); await page.fill('#login-code', code); await page.click('#btn-login');
    await page.waitForFunction(code => ChatApp.currentUser?.code === code, code);
  };
  const openDevice = async () => {
    const context = await browser.newContext(); contexts.push(context); await backend.bind(context);
    await context.addInitScript(() => localStorage.setItem('chatapp_cloak_keys', '["Escape","Escape"]'));
    await context.route(/^https?:\/\//, route => route.fulfill({status:200, contentType:'application/json', body:'null', headers:{'access-control-allow-origin':'*'}}));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    return page;
  };
  try {
    const page = await openDevice();
    await press(page, ['Escape', 'Escape']);
    assert.equal(await isCloaked(page), false, 'stale unscoped Escape+Escape is ignored');
    await press(page, ['Shift+Z']); assert.equal(await isCloaked(page), true, 'fresh default is Shift+Z');
    await press(page, ['Shift+Z']); assert.equal(await isCloaked(page), false);
    await login(page, 'P1'); await openSettings(page);
    assert.equal(await page.inputValue('#settings-cloak-display'), 'Shift + Z');
    await press(page, ['Escape']);
    assert.equal(await page.locator('#modal').isVisible(), true, 'Escape alone never closes settings');
    await page.click('#btn-settings-cloak-edit');
    await press(page, ['Shift+Z']);
    assert.equal(await isCloaked(page), false, 'current shortcut is inert while being recorded');
    assert.equal(await page.inputValue('#settings-cloak-display'), 'Shift + Z');
    await page.click('#btn-settings-cloak-edit');
    await page.click('#btn-settings-cloak-edit'); await press(page, ['s', 'x']);
    assert.equal(await page.inputValue('#settings-cloak-display'), 'S + X');
    await page.click('#btn-settings-cloak-edit');
    assert.deepEqual(await page.evaluate(() => ChatApp.currentSettings.blackoutCloakKeys), ['S', 'X']);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem(ChatApp.LS.CLOAK_KEYS))), ['S', 'X']);
    await press(page, ['s', 'x']); assert.equal(await isCloaked(page), true, 'custom shortcut takes effect immediately');
    await press(page, ['s', 'x']); assert.equal(await isCloaked(page), false);
    await press(page, ['Shift+Z', 'Escape', 'Escape']); assert.equal(await isCloaked(page), false, 'only the selected shortcut is active');
    await page.waitForFunction(() => !ChatApp.settingsSaveTimer && !ChatApp.settingsSaveInFlight);
    assert.deepEqual(backend.get('users/P1/settings/blackoutCloakKeys'), ['S','X'], 'custom shortcut is saved in Firebase');
    await page.reload(); await page.waitForFunction(() => ChatApp.currentUser?.code === 'P1');
    await press(page, ['s','x']); assert.equal(await isCloaked(page), true, 'saved shortcut survives reload');
    await press(page, ['s','x']); assert.equal(await isCloaked(page), false);
    const second = await openDevice(); await login(second, 'P1');
    await press(second, ['s','x']); assert.equal(await isCloaked(second), true, 'fresh device receives account binding');
    await press(second, ['s','x']); assert.equal(await isCloaked(second), false);
    await second.evaluate(() => ChatApp.logoutToLanding()); await login(second, 'P2');
    await press(second, ['s','x']); assert.equal(await isCloaked(second), false, 'previous account binding is not retained after switching');
    await press(second, ['Shift+Z']); assert.equal(await isCloaked(second), true);
    await press(second, ['Shift+Z']); assert.equal(await isCloaked(second), false);
    await openSettings(page); await page.click('#btn-settings-cloak-edit');
    await press(page, ['Escape', 'Escape']);
    assert.equal(await page.locator('#modal').isVisible(), true, 'recording Escape does not dismiss modal');
    assert.equal(await isCloaked(page), false);
    assert.equal(await page.inputValue('#settings-cloak-display'), 'Escape + Escape');
    await page.click('#btn-settings-cloak-edit');
    await press(page, ['Escape']); assert.equal(await isCloaked(page), false);
    await page.keyboard.press('Escape'); assert.equal(await isCloaked(page), true, 'explicitly saved Escape sequence remains supported');
    await press(page, ['Escape','Escape']); assert.equal(await isCloaked(page), false);
    assert.equal(await page.locator('#modal').isVisible(), true);
    await page.reload(); await page.waitForFunction(() => ChatApp.currentUser?.code === 'P1');
    await press(page, ['Escape','Escape']); assert.equal(await isCloaked(page), true, 'intentional Escape binding is preserved across reload');
    await press(page, ['Escape','Escape']); assert.equal(await isCloaked(page), false);
    await openSettings(page); await page.click('#btn-settings-cloak-edit');
    await press(page, ['Escape','Escape']); assert.equal(await isCloaked(page), false, 'recording existing Escape shortcut cannot cloak');
    await page.click('#btn-modal-close'); await page.waitForFunction(() => ChatApp.modalEl.hidden);
    assert.equal(await page.evaluate(() => !!ChatApp.cloakHotkeyEditing), false, 'closing settings removes recording capture');
    await page.evaluate(() => ChatApp.updateSettingsState({blackoutCloakKeys:['Shift','Z']}));
    await page.waitForTimeout(140); await page.keyboard.down('Shift'); await page.waitForTimeout(600); await page.keyboard.down('z');
    assert.equal(await isCloaked(page), true, 'held chord works after the sequence timeout');
    await page.waitForTimeout(160); await page.keyboard.down('z'); assert.equal(await isCloaked(page), true, 'key repeat does not toggle');
    await page.keyboard.up('z'); await page.keyboard.up('Shift');
    await press(page, ['Shift+Z']); assert.equal(await isCloaked(page), false);
    await page.evaluate(() => ChatApp.updateSettingsState({blackoutCloakKeys:['S','X']}));
    await press(page, ['s']); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.keyboard.press('x');
    assert.equal(await isCloaked(page), false, 'losing focus resets a partially entered binding');
    await openSettings(page); await page.click('#settings-search-input'); await page.keyboard.press('s');
    await page.click('#btn-settings-cloak-edit'); await page.keyboard.press('x');
    assert.equal(await isCloaked(page), false, 'entering recording clears an earlier sequence');
    assert.equal(await page.inputValue('#settings-cloak-display'), 'X');
    assert.deepEqual(errors, []);
    console.log('PASS real cloak keypresses: default, stale legacy cache, immediate custom save, reload, device/account isolation, Escape editing, held chords, repeat and blur reset');
  } finally { for (const context of contexts) await context.close(); }
}

(async () => {
  const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true});
  try {
    await verifyCloakKeys(browser);
    if (process.env.CHAT_FOCUSED_CLOAK_TEST === '1') return;
    for (const device of [
      {name: 'desktop', viewport: {width: 1440, height: 900}},
      {name: 'ios', viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'},
      {name: 'android', viewport: {width: 412, height: 915}, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'}
    ]) {
      const {name, ...options} = device;
      const context = await browser.newContext(options);
      await context.addInitScript(installFirebaseMock);
      await context.route(/^https?:\/\//, route => route.fulfill({status: 200, contentType: 'application/json', headers: {'access-control-allow-origin': '*'}, body: 'null'}));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      assert.equal(await page.locator('body').getAttribute('data-sidebar-position'), 'left', `${name}: a new session starts with the sidebar on the Left`);
      await page.click('#btn-go-create');
      assert.equal(await page.locator('label[for="create-username"]').textContent(), 'Username');
      assert.equal(await page.locator('#create-username').getAttribute('placeholder'), 'Your username');
      await page.click('#btn-back-from-create');
      await page.click('#btn-go-login');
      assert.equal(await page.locator('#view-login .muted.small').first().textContent(), 'Enter your password.');
      if (name === 'ios') await page.evaluate(() => __testDatabase.ref('users/TEST-USER/settings/sidebarPosition').set('right'));
      await page.fill('#login-code', 'TEST-USER');
      await page.click('#btn-login');
      await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
      assert.equal(await page.locator('body').getAttribute('data-sidebar-position'), name === 'ios' ? 'right' : 'left', `${name}: account settings retain the expected sidebar side`);
      await page.evaluate(() => ChatApp.openRoom('test', {quiet: true}));
      await page.waitForFunction(() => ChatApp.currentRoomId === 'test' && !ChatApp.bulkLoading);
      await page.evaluate(async () => {
        const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><path fill="#61cfc6" d="M0 0h150v200H0z"/><path fill="#d571a0" d="M150 0h150v200H150z"/></svg>');
        await __testDatabase.ref('users/TEST-USER').update({photoDataURL: photo, photoTransform: {unit:'rel',x:0.12,y:-0.09,scale:1.6}, bannerDataURL:photo, bannerTransform:{unit:'rel',x:-0.06,y:0.08,scale:1.35}});
        await __testDatabase.ref('messages/test/media-crop').set({userCode:'TEST-USER',username:'Tester',text:'A multiline message that must keep its profile picture circular. '.repeat(7),createdAt:Date.now()});
      });
      await page.waitForSelector('.msg-avatar[data-usercode="TEST-USER"] .app-cropped-image');
      const mediaGeometry = await page.evaluate(() => [...document.querySelectorAll('.msg-avatar, #sidebar-nav-surface .room-avatar')].map(el => {
        const r = el.getBoundingClientRect(); return {w:r.width,h:r.height,radius:getComputedStyle(el).borderRadius};
      }).filter(r => r.w));
      assert(mediaGeometry.every(r => Math.abs(r.w-r.h) < 1 && r.radius === '50%'), `${name}: message and room avatars stay circular ${JSON.stringify(mediaGeometry)}`);
      if (name === 'desktop') {
        await page.hover('#btn-time-display');
        await page.waitForSelector('#sidebar-tooltip.is-visible');
        const firstTime = await page.locator('#sidebar-tooltip').textContent();
        assert.match(firstTime, /^\d{2}:\d{2}:\d{2} [AP]M$/);
        await page.waitForFunction(first => document.querySelector('#sidebar-tooltip').textContent !== first, firstTime);
        assert.match(await page.locator('#sidebar-tooltip').textContent(), /^\d{2}:\d{2}:\d{2} [AP]M$/);
      }
      await page.evaluate(() => document.querySelector('#btn-side-settings').click());
      await page.waitForSelector('.settings-tabs');
      assert.equal(await page.locator('.settings-pane:visible').count(), 1);
      assert.equal(await page.getAttribute('#settings-tab-profile', 'aria-selected'), 'true');
      const crops = await page.evaluate(() => {
        const state = selector => {
          const img = document.querySelector(selector), frame = img.parentElement;
          const r = frame.getBoundingClientRect();
          return {left:img.style.left, marginTop:img.style.marginTop, transform:img.style.transform,ratio:r.width/r.height};
        };
        return {avatar:state('#settings-pfp-img'),avatarPreview:state('#settings-profile-preview .user-profile-avatar img'),banner:state('#settings-banner-img'),bannerPreview:state('#settings-profile-preview .user-profile-banner img')};
      });
      for (const key of ['left','marginTop','transform']) {
        assert.equal(crops.avatar[key],crops.avatarPreview[key],`${name}: profile crop ${key} matches editor`);
        assert.equal(crops.banner[key],crops.bannerPreview[key],`${name}: banner crop ${key} matches editor`);
      }
      assert(Math.abs(crops.banner.ratio-crops.bannerPreview.ratio) < 0.025, `${name}: banners have the same responsive aspect ratio`);
      await page.fill('#settings-bio', 'A compact profile with a saved draft.');
      await page.click('#settings-tab-account');
      assert.equal(await page.locator('#settings-code-display:visible').count(), 1);
      assert.equal(await page.locator('#btn-settings-copy:visible').count(), 1);
      assert.equal(await page.locator('#btn-logout:visible').count(), 1);
      await page.fill('#settings-search-input', 'Sound Effects');
      assert.equal(await page.locator('#settings-sound-effects').count(), 1);
      assert.equal(await page.locator('.settings-search-empty:visible').count(), 0);
      await page.fill('#settings-search-input', 'Auto Scroll');
      assert.equal(await page.locator('.settings-toggle-card:has(#settings-autoscroll):visible').count(), 1);
      assert.equal(await page.locator('#settings-pane-preferences:visible').count(), 1);
      await page.fill('#settings-search-input', 'zzzz-no-setting');
      assert.equal(await page.locator('.settings-search-empty:visible').count(), 1);
      await page.fill('#settings-search-input', '');
      assert.equal(await page.getAttribute('#settings-tab-account', 'aria-selected'), 'true');
      await page.click('#settings-tab-profile');
      assert.equal(await page.inputValue('#settings-bio'), 'A compact profile with a saved draft.');
      await page.waitForFunction(() => __testDatabase.get('users/TEST-USER/bio') === 'A compact profile with a saved draft.');
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.settings-refresh input:not([type="checkbox"]), .settings-refresh textarea, .settings-refresh .settings-panel')].filter(el => el.getBoundingClientRect().width && (el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || el.getBoundingClientRect().left < -1)).map(el => el.id || el.className));
      assert.deepEqual(overflow, [], `${name}: settings controls must fit the viewport`);
      for (const tab of ['appearance', 'preferences', 'account']) {
        await page.click(`#settings-tab-${tab}`);
        assert.equal(await page.locator('.settings-pane:visible').count(), 1);
      }
      await page.keyboard.press('Home');
      assert.equal(await page.getAttribute('#settings-tab-profile', 'aria-selected'), 'true');
      if (process.env.QA_SCREENSHOTS) {
        await page.waitForTimeout(350);
        await page.screenshot({path: path.join(process.env.QA_SCREENSHOTS, `settings-${name}.png`)});
      }
      await page.evaluate(() => ChatApp.closeModal());
      await page.evaluate(() => {
        ChatApp.setMembersListVisible?.(true);
        if (document.body.dataset.membersSidebar !== '1') ChatApp.toggleMembersListVisibility();
      });
      await page.waitForSelector('.members-sidebar .member-row');
      await page.click('.members-sidebar .member-row');
      await page.waitForSelector('.user-profile-popover.is-open');
      await page.evaluate(() => {
        window.__mediaOriginalCard = document.querySelector('#user-profile-card .user-profile-shell');
        window.__mediaOriginalImage = document.querySelector('#user-profile-card .user-profile-avatar img');
      });
      await page.evaluate(() => __testDatabase.ref('users/TEST-USER').update({photoTransform:{unit:'rel',x:-0.14,y:0.05,scale:2}}));
      await page.waitForFunction(() => document.querySelector('#user-profile-card .user-profile-avatar img').style.left === '36%');
      assert(await page.evaluate(() => __mediaOriginalCard === document.querySelector('#user-profile-card .user-profile-shell') && __mediaOriginalImage === document.querySelector('#user-profile-card .user-profile-avatar img')), `${name}: live picture updates retain card/image DOM nodes`);
      assert.equal(await page.locator('#user-profile-card .user-profile-presence').textContent(), 'Online');
      await page.evaluate(() => __testDatabase.ref('users/TEST-USER').update({gameActivitySessions:{desktop:{updatedAt:ChatApp.appPresenceNow(),games:[{title:'Fortnite',experienceTitle:'Creator Island',creator:'Island Creator',mode:'Creative',state:'In Match',privacy:'Private'}]}}}));
      await page.waitForFunction(() => document.querySelector('#user-profile-card [data-activity-kind="game"] .user-profile-activity-text')?.textContent === 'Playing Creator Island on Fortnite · Creative · In Match · Private');
      assert.equal(await page.locator('#user-profile-card .user-profile-game-author').textContent(), 'By Island Creator', `${name}: profile shows the creator once beside complete game details`);
      const gameStatus = await page.evaluate(() => ChatApp.getMemberActivityStatuses('', ChatApp.liveUserCache.get('TEST-USER')).find(status => status.kind === 'game'));
      assert.equal(gameStatus.text, 'Playing Creator Island on Fortnite · Creative · In Match · Private', `${name}: online status keeps game details without duplicate creator`);
      assert.equal(gameStatus.label, gameStatus.text, `${name}: game tooltip shares the complete status label`);
      const bounds = await page.locator('#user-profile-popover').boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= options.viewport.width + 1, `${name}: profile must fit viewport`);
      if (name !== 'desktop') assert(await page.evaluate(() => +getComputedStyle(document.querySelector('#user-profile-popover')).zIndex > +getComputedStyle(document.querySelector('#members-sidebar')).zIndex));
      await page.evaluate(() => ChatApp.refreshOpenUserProfileCard());
      await page.click('#user-profile-card .user-profile-more');
      await page.waitForFunction(() => ChatApp.msgMenuEl && !ChatApp.msgMenuEl.hidden);
      await page.evaluate(() => ChatApp.closeMsgMenu(true));
      if (process.env.QA_SCREENSHOTS) await page.screenshot({path: path.join(process.env.QA_SCREENSHOTS, `profile-${name}.png`)});
      await page.evaluate(() => {
        const now = ChatApp.appPresenceNow();
        return __testDatabase.ref('users/TEST-USER').update({gameActivitySessions:{desktop:{updatedAt:now,games:[
          {id:'minecraft',title:'Minecraft',experienceTitle:'Dawn Client',icon:'data:image/png;base64,iVBORw0KGgo=',startedAt:now-18000000,experienceStartedAt:now-3600000},
          {id:'roblox',title:'Roblox',experienceTitle:'Football Fusion 3 by XSTNS GAMES',creator:'XSTNS GAMES',startedAt:now-18000000,experienceStartedAt:now-65000}
        ]}}});
      });
      await page.waitForFunction(() => document.querySelectorAll('#user-profile-card [data-activity-kind="game"]').length === 2);
      assert.equal(await page.locator('#user-profile-card [data-activity-started-at]').count(),4, `${name}: base and subgame have distinct timers`);
      assert.equal(await page.locator('#user-profile-card .user-profile-game-author').textContent(),'By XSTNS GAMES');
      assert.equal(await page.locator('#user-profile-card .user-profile-activity-text').last().textContent(),'Playing Football Fusion 3 on Roblox');
      assert(await page.locator('#user-profile-card .user-profile-game-art > img').first().evaluate(img=>img.complete&&img.naturalWidth>0), `${name}: supplied Dawn launcher artwork decodes`);
      if (process.env.QA_SCREENSHOTS) { await page.waitForTimeout(250); await page.screenshot({path:path.join(process.env.QA_SCREENSHOTS,`game-profile-${name}.png`)}); }
      await page.click('#user-profile-card .user-profile-close');
      await page.waitForFunction(() => document.querySelector('#user-profile-popover').hidden);
      const gamePrimary = page.locator('.members-sidebar .member-row[data-usercode="TEST-USER"] .member-activity-primary');
      assert.equal(await gamePrimary.locator('.member-game-art').count(),2, `${name}: both games keep icons below the name`);
      assert(await gamePrimary.evaluate(el=>el.querySelector('.member-game-icons').getBoundingClientRect().right<=el.querySelector('.member-activity-text').getBoundingClientRect().left),`${name}: game icons do not overlap the label`);
      await gamePrimary.focus();
      await page.waitForSelector('.member-activities-floating.is-visible');
      assert.equal(await page.locator('.member-activities-tooltip .member-activity-tooltip-row').count(),2, `${name}: tooltip shows one icon and label for each game`);
      assert.equal(await page.locator('.member-activities-tooltip .member-game-art').count(),2);
      if (process.env.QA_SCREENSHOTS) { await page.waitForTimeout(250); await page.screenshot({path:path.join(process.env.QA_SCREENSHOTS,`game-tooltip-${name}.png`)}); }
      assert.deepEqual(errors, [], `${name}: no runtime errors`);
      console.log(`${name}: settings tabs/search/drafts/account actions/layout; member profiles/actions/close passed`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
