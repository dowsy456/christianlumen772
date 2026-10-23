/* Browser regressions use the local in-memory database; all remote requests are stubbed. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const mock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.addInitScript(mock);
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    async function assertDocumentScrolling(selector, contentSelector, label) {
      const scroll = page.locator(selector), content = page.locator(contentSelector);
      assert.equal(await page.locator('.media-zoom-controls').count(), 0, `${label}: no document zoom UI`);
      await scroll.evaluate(el => { el.scrollTop = 0; });
      const width = await content.evaluate(el => el.getBoundingClientRect().width);
      assert.equal(await scroll.evaluate(el => {
        const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
        el.dispatchEvent(wheel); return wheel.defaultPrevented;
      }), false, `${label}: document wheel events retain native scrolling`);
      await scroll.hover(); await page.mouse.wheel(0, 420);
      await page.waitForFunction(selector => document.querySelector(selector).scrollTop > 0, selector);
      const down = await scroll.evaluate(el => el.scrollTop);
      await page.mouse.wheel(0, -240);
      await page.waitForFunction(({selector,down}) => document.querySelector(selector).scrollTop < down, {selector,down});
      await scroll.focus(); await page.keyboard.press('+'); await page.keyboard.press('-');
      assert.ok(Math.abs(await content.evaluate(el => el.getBoundingClientRect().width) - width) < 1, `${label}: wheel and +/- never resize document pages`);
    }
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.click('#btn-go-login');
    await page.fill('#login-code', 'TEST-USER');
    await page.click('#btn-login');
    await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
    await page.evaluate(async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#79c"/></svg>';
      window.__mediaData = 'data:image/svg+xml;base64,' + btoa(svg);
      await __testDatabase.ref('users/AUTHOR').set({ code: 'AUTHOR', username: 'BrognatheLongDisplayName', displayName: 'BrognatheLongDisplayName' });
      await __testDatabase.ref('messages/test/media').set({ userCode: 'AUTHOR', username: 'BrognatheLongDisplayName', createdAt: Date.now(), files: [{ kind: 'image', dataURL: __mediaData, fileName: 'test.svg' }] });
      await __testDatabase.ref('readReceipts/test/media').set({ ALICE: 1, BOB: 1 });
      await ChatApp.openRoom('test', { quiet: true });
    });
    await page.waitForFunction(() => !ChatApp.bulkLoading && ChatApp.readReceiptState?.key === 'media');
    await page.waitForSelector('.message-seen-avatar[data-usercode="ALICE"]');
    const geometry = await page.evaluate(() => {
      const name = document.querySelector('.bubble-name');
      const time = document.querySelector('.bubble-time').getBoundingClientRect();
      const seen = document.querySelector('.message-seen').getBoundingClientRect();
      const avatars = [...document.querySelectorAll('.message-seen-avatar')].map(el => el.getBoundingClientRect());
      return { nameFits: name.scrollWidth <= name.clientWidth, sameLine: seen.y < time.bottom && seen.bottom > time.y, avatarRow: avatars.every(r => Math.abs(r.y - avatars[0].y) < 1) };
    });
    assert.deepEqual(geometry, { nameFits: true, sameLine: true, avatarRow: true }, 'gallery dimensions cannot compress message metadata');
    await page.locator('.bubble-time').hover();
    await page.locator('#timestamp-tooltip').waitFor({state:'visible'});
    await page.mouse.move(5,5);
    await page.locator('#timestamp-tooltip').waitFor({state:'hidden'});
    // A replaced timestamp may disappear without ever emitting pointerleave.
    await page.evaluate(() => {
      const time = document.querySelector('.bubble-time').cloneNode(true);
      document.body.appendChild(time);
      ChatApp.showTimestampTooltipFor(time);
      time.remove();
    });
    await page.locator('#timestamp-tooltip').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(() => ChatApp.activeTimestampTooltipTarget), null, 'detached timestamps cannot retain their tooltip');
    assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), true, 'uncovered attachment is visible');
    const contentVisibility = await page.evaluate(() => {
      const item = document.querySelector('.att-item');
      const before = item.style.cssText;
      item.style.visibility = 'hidden';
      const invisible = ChatApp.canSeeLatestMessage();
      item.style.cssText = before;
      item.style.transform = 'translateY(2000px)';
      const offscreen = ChatApp.canSeeLatestMessage();
      item.style.cssText = before;
      return { invisible, offscreen };
    });
    assert.deepEqual(contentVisibility, { invisible: false, offscreen: false }, 'a visible author header alone is insufficient');

    // An arbitrary covering surface, including one outside the chat DOM.
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = 'fixture-occluder';
      overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483646';
      document.body.appendChild(overlay);
    });
    assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), false, 'covered message is not read');
    await page.evaluate(() => { document.querySelector('#fixture-occluder').style.pointerEvents = 'none'; });
    assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), false, 'visual overlay still blocks even with pointer events disabled');
    await page.evaluate(() => document.querySelector('#fixture-occluder').remove());

    // Blackout is attached to <html>, outside <body>, and is aria-hidden.
    await page.keyboard.press('Shift+Z');
    assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), false, 'blackout never counts as a read');
    await page.waitForTimeout(150);
    await page.keyboard.press('Shift+Z');
    assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), true);
    await page.evaluate(() => ChatApp.openModal({ title: 'Fixture Modal', bodyHTML: '<p>Message covered</p>' }));
    assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), false, 'modal blocks reading');
    await page.evaluate(() => ChatApp.closeModal());

    // Receipt timers must be cancelled while the UI obstructs the message.
    await page.evaluate(async () => {
      const cover = document.createElement('div'); cover.id = 'fixture-cover';
      cover.style.cssText = 'position:fixed;inset:0;background:#123;z-index:2147483646'; document.body.appendChild(cover);
      await __testDatabase.ref('messages/test/newest').set({ userCode: 'AUTHOR', username: 'BrognatheLongDisplayName', createdAt: Date.now() + 1, text: 'Read this only while it is visible.' });
    });
    await page.waitForFunction(() => ChatApp.readReceiptState?.key === 'newest');
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => !!ChatApp.readReceiptState.receipts['TEST-USER']), false, 'new message behind an overlay cannot accrue a read');
    await page.evaluate(() => document.querySelector('#fixture-cover').remove());
    await page.waitForFunction(() => !!ChatApp.readReceiptState.receipts['TEST-USER']);
    const completedReceipt = await page.evaluate(() => {
      const original = ChatApp.canSeeLatestMessage;
      let visibilityChecks = 0;
      ChatApp.canSeeLatestMessage = () => { visibilityChecks++; return original(); };
      ChatApp.readReceiptTimer = setTimeout(() => { throw new Error('Stale receipt timer was not cancelled'); }, 100);
      ChatApp.scheduleReceiptRead();
      ChatApp.canSeeLatestMessage = original;
      return { visibilityChecks, timer: ChatApp.readReceiptTimer };
    });
    assert.deepEqual(completedReceipt, { visibilityChecks: 0, timer: null }, 'completed receipts skip geometry and cancel stale timers');

    const state = await page.evaluate(() => {
      const mode = document.body.dataset;
      mode.activityMode = '1'; mode.activityChat = '0';
      const activityHidden = ChatApp.canSeeLatestMessage();
      mode.activityMode = '0'; mode.callChatMode = '1'; mode.callChat = '0';
      const callHidden = ChatApp.canSeeLatestMessage();
      mode.callChatMode = '0'; mode.companionChat = '1'; mode.membersSidebar = '1';
      const membersHidden = ChatApp.canSeeLatestMessage();
      mode.companionChat = '0'; mode.membersSidebar = '0';
      return { activityHidden, callHidden, membersHidden };
    });
    assert.deepEqual(state, { activityHidden: false, callHidden: false, membersHidden: false });

    // Exercise real activity chrome: its full-screen, pointer-transparent
    // backdrop paints below the companion, so geometry alone is insufficient.
    await page.evaluate(() => ChatApp.openMergePartyActivity('test'));
    await page.waitForFunction(() => document.querySelector('#games-frame')?.contentWindow?.__mergeParty);
    assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), false, 'full activity hides chat');
    for (const side of ['left', 'right']) {
      await page.evaluate(side => {
        ChatApp.applySidebarPosition(side);
        ChatApp.setActivityChatOpen(true);
        ChatApp.messagesEl.scrollTop = ChatApp.messagesEl.scrollHeight;
      }, side);
      await page.waitForFunction(() => ChatApp.canSeeLatestMessage());
      assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), true, `${side} activity chat paints above its backdrop`);
      await page.evaluate(() => ChatApp.setActivityChatOpen(false));
      assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), false, `${side} closed activity chat is unreadable`);
    }
    await page.evaluate(() => ChatApp.closeGamesStage({ preserve: false }));
    await page.waitForFunction(() => !ChatApp.gamesStageOpen);

    await page.evaluate(() => {
      ChatApp.currentCallRoomId = 'test';
      ChatApp.openCallMenu();
      ChatApp.setCallMenuExpanded(true);
    });
    assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), false, 'expanded call covers normal chat');
    for (const side of ['left', 'right']) {
      await page.evaluate(async side => {
        ChatApp.applySidebarPosition(side);
        await ChatApp.toggleExpandedCallChat();
        ChatApp.messagesEl.scrollTop = ChatApp.messagesEl.scrollHeight;
      }, side);
      await page.waitForFunction(() => ChatApp.canSeeLatestMessage());
      assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), true, `${side} expanded call companion can be read`);
      await page.evaluate(() => ChatApp.toggleExpandedCallChat());
      assert.equal(await page.evaluate(() => ChatApp.canSeeLatestMessage()), false, `${side} closed call chat is unreadable`);
    }
    await page.evaluate(() => { ChatApp.closeCallMenu(); ChatApp.currentCallRoomId = null; });

    // Shared cached metadata comes in before this older history row is mounted.
    await page.evaluate(async () => {
      const meta = { id: 'old', name: 'Old Sticker', kind: 'image', state: 'ready', mimeType: 'image/svg+xml' };
      await __testDatabase.ref('stickers/meta/old').set(meta);
      await __testDatabase.ref('stickers/assets/old').set({ dataURL: __mediaData, dataChunkCount: 1 });
      window.__stickerOff = ChatApp.watchStickerMeta('old', () => {});
      await new Promise(resolve => setTimeout(resolve, 10));
      const fragment = document.createDocumentFragment();
      ChatApp.appendMessageRow({ _key: 'old-sticker', userCode: 'AUTHOR', createdAt: Date.now() + 2, sticker: meta }, { target: fragment, suppressScroll: true });
      await new Promise(resolve => setTimeout(resolve, 30));
      ChatApp.messagesListEl.appendChild(fragment);
      ChatApp.messagesEl.scrollTop = ChatApp.messagesEl.scrollHeight;
    });
    await page.waitForFunction(() => document.querySelector('[data-msgkey="old-sticker"] .sticker-message img')?.naturalWidth > 0);
    await page.evaluate(() => __stickerOff());
    await page.evaluate(() => ChatApp.openMediaModal('image', __mediaData, { fileName: 'fixture.svg' }));
    await page.waitForSelector('#btn-media-create-sticker:not([hidden])');
    const order = await page.evaluate(() => document.querySelector('#btn-media-create-sticker').getBoundingClientRect().x < document.querySelector('#btn-modal-close').getBoundingClientRect().x);
    assert.equal(order, true, 'Create Sticker precedes Close in the media viewer');
    await page.evaluate(() => {
      ChatApp.closeModal();
      const image = (w, h) => 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#69c"/></svg>`);
      ChatApp.appendMessageRow({ _key:'attachment-layout', userCode:'AUTHOR', createdAt:Date.now() + 3, files:[
        {kind:'image',fileName:'panorama.svg',dataURL:image(1800,180)},
        {kind:'image',fileName:'portrait.svg',dataURL:image(180,1800)},
        {kind:'image',fileName:'square.svg',dataURL:image(1800,1800)},
        {kind:'code',fileName:'A Very Long Document Name That Must Remain Completely Readable.txt',mimeType:'text/plain',dataURL:'data:text/plain;base64,'+btoa('<script>window.__badText=true</script>\nHello viewer')},
        {kind:'audio',fileName:'A Very Long Audio Recording Name.wav',dataURL:'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='}
      ] }, { suppressScroll:true });
      ChatApp.messagesEl.scrollTop = ChatApp.messagesEl.scrollHeight;
    });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-msgkey="attachment-layout"] img.att-media')].every(image => image.naturalWidth));
    for (const width of [1440, 390]) {
      await page.setViewportSize({width,height:960});
      await page.evaluate(() => { ChatApp.syncMobileUiMode(); ChatApp.closeMobileDrawers?.(); });
      await page.waitForFunction(() => document.querySelector('[data-msgkey="attachment-layout"] .att-gallery')?.clientWidth > 100);
      const boxes = await page.locator('[data-msgkey="attachment-layout"]').evaluate(row => {
        const gallery = row.querySelector('.att-gallery');
        return {
          images:[...row.querySelectorAll('img.att-media')].map(image => { const r=image.getBoundingClientRect(); return {w:r.width,h:r.height,ratio:image.naturalWidth/image.naturalHeight}; }),
          galleryOverflow:gallery.scrollWidth > gallery.clientWidth + 1,
          fullFileName:getComputedStyle(row.querySelector('.att-file-name')).whiteSpace,
          audioControls:['toggle','seek','loop','vol','rate'].every(name => row.querySelector(`[data-audio="${name}"]`))
        };
      });
      assert.equal(boxes.galleryOverflow,false,`${width}px: attachments fit chat`);
      assert.equal(boxes.fullFileName,'normal'); assert.equal(boxes.audioControls,true);
      boxes.images.forEach(box => { assert.ok(box.w <= 168.5 && box.h <= 168.5); assert.ok(Math.abs(box.w/box.h - box.ratio) < .06,'image is never cropped'); });
    }
    await page.setViewportSize({width:1440,height:960});
    await page.locator('[data-msgkey="attachment-layout"] .att-item').first().hover();
    await page.waitForTimeout(180);
    const download = await page.locator('[data-msgkey="attachment-layout"] .att-dl').first().evaluate(button => { const r=button.getBoundingClientRect(), p=button.parentElement.getBoundingClientRect(); return {top:r.top-p.top,right:p.right-r.right,opacity:getComputedStyle(button).opacity}; });
    assert.ok(download.top <= 6 && download.right <= 6); assert.equal(download.opacity,'0.5');
    await page.locator('[data-msgkey="attachment-layout"] .att-file').click();
    await page.waitForSelector('.media-document-text');
    assert.match(await page.locator('.media-document-text').textContent(), /<script>/);
    assert.equal(await page.evaluate(() => !!window.__badText),false,'TXT is displayed literally');
    assert.equal(await page.locator('#btn-media-create-sticker').isVisible(),false,'documents never offer sticker creation');
    await page.evaluate(() => {
      ChatApp.closeModal();
      const text = Array.from({length:300},(_,i)=>`Document line ${i+1}`).join('\n');
      ChatApp.openMediaModal('text','data:text/plain,'+encodeURIComponent(text),{fileName:'Long notes.txt'});
    });
    await page.waitForSelector('.media-document-text');
    await assertDocumentScrolling('.media-document-text','.media-document-text','Text');
    await page.evaluate(() => {
      ChatApp.closeModal();
      ChatApp.loadPdfViewerLibrary = async () => ({base:'',library:{getDocument:()=>({promise:Promise.resolve({numPages:3,getPage:async()=>({getViewport:()=>({width:600,height:800}),render:()=>({promise:Promise.resolve(),cancel(){}})})}),destroy(){}})}});
      ChatApp.openMediaModal('pdf','data:application/pdf;base64,JVBERi0xLjQ=',{fileName:'Three Pages.pdf',mimeType:'application/pdf'});
    });
    await page.waitForSelector('.media-pdf-page canvas');
    assert.equal(await page.locator('.media-pdf-page').count(),3);
    await page.locator('[data-pdf="next"]').click();
    assert.equal(await page.locator('[data-pdf="page"]').inputValue(),'2');
    await page.locator('[data-pdf="page"]').fill('3'); await page.locator('[data-pdf="page"]').press('Enter');
    assert.equal(await page.locator('[data-pdf="page"]').inputValue(),'3');
    assert.equal(await page.locator('[data-pdf="next"]').isDisabled(),true);
    await assertDocumentScrolling('.media-pdf-pages','.media-pdf-stack','Multi-page PDF');
    await page.evaluate(() => ChatApp.closeModal());
    const cleanup = await page.evaluate(async () => {
      const originalSource = ChatApp.getFastMediaModalSrc, originalMount = ChatApp.mountDocumentViewer, originalLibrary = ChatApp.loadPdfViewerLibrary;
      let releaseSource, mountedAfterClose = 0, destroyed = 0;
      ChatApp.getFastMediaModalSrc = () => new Promise(resolve => { releaseSource = resolve; });
      ChatApp.mountDocumentViewer = (...args) => { mountedAfterClose++; return originalMount(...args); };
      ChatApp.openMediaModal('text','data:text/plain,late',{fileName:'Late.txt'});
      ChatApp.closeModal(); releaseSource('data:text/plain,late');
      await new Promise(resolve => setTimeout(resolve,20));
      ChatApp.getFastMediaModalSrc = originalSource; ChatApp.mountDocumentViewer = originalMount;
      const host = document.createElement('div'); document.body.append(host);
      ChatApp.loadPdfViewerLibrary = async () => ({base:'',library:{getDocument:()=>({promise:Promise.reject(new Error('Invalid PDF')),destroy(){destroyed++;return Promise.reject(new Error('Already Closed'));}})}});
      const stop = ChatApp.mountDocumentViewer(host,'pdf','about:blank','Invalid.pdf');
      await new Promise(resolve => setTimeout(resolve,20));
      const fallback = !!host.querySelector('.media-document-pdf');
      stop(); host.remove(); ChatApp.loadPdfViewerLibrary = originalLibrary;
      return {mountedAfterClose,destroyed,fallback};
    });
    assert.deepEqual(cleanup,{mountedAfterClose:0,destroyed:1,fallback:true},'closed viewers cannot mount late and PDF fallback releases its failed worker exactly once');

    assert.deepEqual(await page.evaluate(()=>['report.docx','slides.pptx','page.html','notes.md','data.csv','script.js','old.doc'].map(name=>ChatApp.getDocumentPreviewKind(name))),['docx','pptx','html','text','text','text','']);
    await page.evaluate(()=>ChatApp.openMediaModal('html','data:text/html,'+encodeURIComponent('<h1>HTML preview</h1><button onclick="this.textContent=\'Clicked\'">Try preview</button><script>try{parent.__htmlEscaped=true}catch(e){document.body.dataset.isolated="true"}</script>'),{fileName:'preview.html'}));
    await page.waitForSelector('.media-document-html');
    const html = page.frameLocator('.media-document-html');
    await html.getByRole('button',{name:'Try preview'}).click();
    assert.equal(await html.getByRole('button').textContent(),'Clicked','HTML scripts work inside the isolated preview');
    assert.equal(await html.locator('body').getAttribute('data-isolated'),'true');
    assert.equal(await page.evaluate(()=>!!window.__htmlEscaped),false,'an HTML attachment cannot access the chat window');
    assert.equal(await page.locator('.media-zoom-controls').count(),0,'HTML uses its own page layout without image zoom');
    await page.evaluate(()=>ChatApp.closeModal());

    // Renderer integration and lifecycle stay deterministic in this offline suite.
    // The pinned browser libraries are also exercised with real OOXML fixtures
    // during release verification; mocks here isolate the app's responsibilities.
    await page.evaluate(()=>{
      window.__originalOfficeLoader=ChatApp.loadOfficeViewerLibrary;
      window.__officeDestroyed=0;
      ChatApp.loadOfficeViewerLibrary=async kind=>kind==='docx'?{renderAsync:async(buffer,body)=>{body.innerHTML='<section style="width:816px;height:1100px;background:white">Word document page</section>'.repeat(3);}}:{RECOMMENDED_ZIP_LIMITS:{maxEntries:4000},PptxViewer:{open:async(buffer,body)=>{body.innerHTML='<section style="width:960px;height:540px;background:blue">Slide preview</section>'.repeat(4);return{destroy(){window.__officeDestroyed++;}};}}};
    });
    for(const kind of ['docx','pptx']) {
      await page.evaluate(kind=>ChatApp.openMediaModal(kind,'data:application/octet-stream;base64,AA==',{fileName:`test.${kind}`}),kind);
      await page.waitForSelector('.media-office-content section');
      await assertDocumentScrolling('.media-office-pages','.media-office-content',kind.toUpperCase());
      await page.setViewportSize({width:390,height:844});
      await page.waitForFunction(()=>document.querySelector('.media-office-pages').scrollWidth<=document.querySelector('.media-office-pages').clientWidth+1);
      await assertDocumentScrolling('.media-office-pages','.media-office-content',`Mobile ${kind.toUpperCase()}`);
      await page.setViewportSize({width:1440,height:960});
      await page.evaluate(()=>ChatApp.closeModal());
    }
    assert.equal(await page.evaluate(()=>window.__officeDestroyed),1,'closing a presentation releases its renderer');
    await page.evaluate(()=>{ChatApp.loadOfficeViewerLibrary=window.__originalOfficeLoader;ChatApp.openMediaModal('image',__mediaData,{fileName:'Zoom.svg'});});
    await page.waitForSelector('.media-zoom-target');
    assert.equal(await page.locator('.media-zoom-controls button').count(),1,'only the percentage reset button remains');
    const zoomPosition=await page.locator('.media-zoom-controls').evaluate(el=>({x:el.getBoundingClientRect().left,y:el.getBoundingClientRect().top,opacity:getComputedStyle(el).opacity}));
    assert.ok(Math.abs(zoomPosition.x-12)<1 && Math.abs(zoomPosition.y-12)<1 && zoomPosition.opacity==='1','zoom is pinned to the upper-left viewer edge and opaque over empty margins');
    await page.locator('.media-zoom-viewport').hover(); await page.mouse.wheel(0,-100);
    await page.waitForFunction(()=>document.querySelector('[data-media-zoom="percent"]').textContent==='150%');
    await page.mouse.wheel(0,100);
    await page.waitForFunction(()=>document.querySelector('[data-media-zoom="percent"]').textContent==='100%');
    await page.locator('.media-zoom-viewport').focus();
    for(let i=0;i<8;i++) await page.keyboard.press('+');
    assert.equal(await page.locator('[data-media-zoom="percent"]').textContent(),'500%');
    await page.keyboard.press('+');assert.equal(await page.locator('[data-media-zoom="percent"]').textContent(),'600%');
    await page.keyboard.press('-');assert.equal(await page.locator('[data-media-zoom="percent"]').textContent(),'500%');
    await page.keyboard.press('-');assert.equal(await page.locator('[data-media-zoom="percent"]').textContent(),'450%');
    await page.evaluate(()=>{ChatApp.closeModal();ChatApp.openMediaModal('video','data:video/webm;base64,AA==',{fileName:'Fullscreen.webm'});});
    await page.waitForSelector('.vpu-video');
    await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
      canvas.getContext('2d').fillRect(0,0,1280,720);
      const video=document.querySelector('.vpu-video');video.srcObject=canvas.captureStream(1);video.muted=true;await video.play();window.__fullscreenCanvas=canvas;
    });
    await page.locator('.vpu-full').click();await page.waitForFunction(()=>!!document.fullscreenElement);
    const fullscreen=await page.locator('.vpu-controls').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,height:innerHeight,zoom:document.querySelector('.media-zoom-controls').classList.contains('is-over-content')}));
    assert.ok(Math.abs(fullscreen.bottom-fullscreen.height)<2,'fullscreen video transport touches the viewport bottom');
    assert.equal(fullscreen.zoom,true,'readout becomes translucent when it overlaps the painted video');
    await page.locator('.media-zoom-viewport').hover(); await page.mouse.wheel(0,-100);
    await page.waitForFunction(()=>document.querySelector('[data-media-zoom="percent"]').textContent==='150%');
    await page.mouse.wheel(0,100);
    await page.waitForFunction(()=>document.querySelector('[data-media-zoom="percent"]').textContent==='100%');
    await page.evaluate(async()=>{document.querySelector('.vpu-video').srcObject.getTracks().forEach(track=>track.stop());await document.exitFullscreen();ChatApp.closeModal();});
    assert.deepEqual(errors, []);
    console.log('Media/receipts passed: metadata/receipts, natural text/PDF/DOCX/PPTX scrolling without document zoom, responsive Office pages, HTML isolation, image/video wheel zoom, and fullscreen transport.');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
