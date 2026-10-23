/* Isolated GitHub/CDN fixtures: no production database or repository writes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');
const root = path.resolve(__dirname, '..');
const mime = {'.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg'};
const sha1 = 'a'.repeat(40), sha2 = 'b'.repeat(40);
const prefix = '/christianlumen737/';
const server = http.createServer((req,res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(prefix)) {res.writeHead(404);return res.end();}
  const file = path.resolve(root, decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html');
  if (!file.startsWith(root + path.sep)) {res.writeHead(403);return res.end();}
  fs.readFile(file, (err,data) => {
    res.writeHead(err ? 404 : 200, {'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});
    res.end(err ? 'Not found' : data);
  });
});

async function main() {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true});
  const results=[];
  try {
    for (const scenario of ['latest-and-update','raw-unavailable','api-unavailable','missing-module','missing-css']) {
      const context = await browser.newContext();
      await context.addInitScript(installFirebaseMock);
      const requests=[], missing=[], errors=[];
      let revision=sha1;
      await context.route('**/*',async route => {
        const url = new URL(route.request().url());
        requests.push(url.href);
        if (url.protocol === 'file:') return route.continue();
        const fulfill=(status,body,type='application/json') => route.fulfill({status,body,contentType:type,headers:{'access-control-allow-origin':'*','x-content-type-options':'nosniff'}});
        if (url.hostname === 'api.github.com') {
          if (scenario === 'api-unavailable') return fulfill(403,'{}');
          if (url.pathname.startsWith('/users/')) {
            if (url.searchParams.get('page') === '1') {
              // No exposed Link header: a full page must still trigger page 2.
              return fulfill(200,JSON.stringify(Array.from({length:100},(_,i)=>({name:'unrelated'+i}))));
            }
            return fulfill(200,JSON.stringify([{name:'christianlumen736'},{name:'christianlumen737'},{name:'christianlumen738'},{name:'christianlumen-nope'}]));
          }
          return fulfill(200,JSON.stringify({sha:revision}));
        }
        if (url.hostname === 'raw.githubusercontent.com') {
          if (scenario === 'raw-unavailable' || !url.pathname.includes('/christianlumen737/')) return fulfill(404,'Not found','text/plain');
          return fulfill(200,fs.readFileSync(path.join(root,'index.html'),'utf8'),'text/plain');
        }
        if (url.hostname === 'cdn.jsdelivr.net') {
          const match=url.pathname.match(/^\/gh\/dowsy456\/christianlumen737@([^/]+)\/(.+)$/);
          if (!match) return fulfill(404,'Not found','text/plain');
          assert.equal(match[1],scenario==='api-unavailable'?'main':revision,'all assets use the selected revision');
          const relative=decodeURIComponent(match[2]);
          const file=path.resolve(root,relative);
          if ((scenario==='missing-module'&&relative==='js/core/start.js') || (scenario==='missing-css'&&relative==='css/chat.css')) return fulfill(404,'Missing fixture','text/plain');
          if (!file.startsWith(root+path.sep)||!fs.existsSync(file)) {missing.push(relative);return fulfill(404,'Not found','text/plain');}
          return fulfill(200,fs.readFileSync(file),mime[path.extname(file)]||'application/octet-stream');
        }
        // Fixtures for every other remote endpoint, including Firebase.
        return fulfill(200,'null');
      });
      const page=await context.newPage();
      await page.goto(pathToFileURL(path.join(root,'chaptersauto.svg')).href);
      async function open() {
        const popupPromise=page.waitForEvent('popup');
        await page.locator('#startBtnGroup').click();
        const app=await popupPromise;
        app.on('pageerror',e=>errors.push(e.message));
        await page.waitForFunction(()=>document.getElementById('startBtnGroup').getAttribute('aria-disabled')==='false',null,{timeout:75000}).catch(async error=>{
          console.error({scenario,status:await page.locator('#statusText').textContent(),app:await app.evaluate(()=>({ready:document.documentElement.dataset.appReady,state:document.readyState,boot:window.ChatAppBootError,body:document.body?.innerText.slice(0,500)})),errors,requests:requests.slice(-8)});
          throw error;
        });
        const frame=await app.$('#chatapp-frame');
        return frame ? await frame.contentFrame() : app;
      }
      const app=await open();
      if (scenario.startsWith('missing-')) {
        assert.match(await app.locator('h1').textContent(),/Could not open/,scenario + ': ' + await page.locator('#statusText').textContent());
        assert.match(await app.locator('body').textContent(),scenario==='missing-module'?/js\/core\/start.js/:/stylesheet/);
        assert.match(await page.locator('#statusText').textContent(),/Could not load/);
      } else {
        assert.equal(await app.getAttribute('html','data-app-ready'),'true');
        assert.equal(await app.evaluate(()=>ChatRuntime.base.href),`https://cdn.jsdelivr.net/gh/dowsy456/christianlumen737@${scenario==='api-unavailable'?'main':revision}/`);
        const resourceTypes=await app.evaluate(()=>[...document.querySelectorAll('link[rel="stylesheet"]')].every(link=>!!link.sheet));
        assert.equal(resourceTypes,true,'all app stylesheets load');
        assert.match(await app.evaluate(()=>ChatApp.patchUploadedHtmlToSameOrigin('<html><head></head><body></body></html>')),/base href="https:\/\/cdn.jsdelivr.net/);
        const documents=await app.evaluate(()=>Promise.all(['bopl-royale','merge-party'].map(id=>ChatActivities.load(id))));
        for(const html of documents)assert.ok(html.includes(`christianlumen737@${scenario==='api-unavailable'?'main':revision}/`));
        assert.equal(requests.some(url=>url.includes('/christianlumen736/')),false,'skip ZIP-only newest repo, then stop at readable app');
        if(scenario==='api-unavailable')assert.match(await page.locator('#statusText').textContent(),/could not be confirmed/);
        if(scenario==='latest-and-update') {
          assert.equal(await app.evaluate(()=>{localStorage.setItem('launcher-test','ok');const value=localStorage.getItem('launcher-test');localStorage.removeItem('launcher-test');return value;}),'ok','local SVG app retains usable storage');
          await app.click('#btn-go-login');
          await app.fill('#login-code','TEST-USER');
          await app.click('#btn-login');
          await app.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER'&&document.querySelector('#view-chat').dataset.active==='true');
          await app.evaluate(()=>ChatApp.openRoom('test',{quiet:true}));
          await app.waitForFunction(()=>ChatApp.currentRoomId==='test'&&!ChatApp.bulkLoading);
          await app.fill('#msg-input','SVG launch test');
          await app.evaluate(()=>ChatApp.sendTextMessage());
          await app.waitForFunction(()=>document.querySelector('#messages-inner').textContent.includes('SVG launch test'));
          await app.click('#btn-side-settings');
          await app.waitForFunction(()=>!document.querySelector('#modal').hidden);
          await app.evaluate(()=>ChatApp.closeModal());
          for(const id of ['bopl-royale','merge-party']) {
            await app.evaluate(async id=>{
              window.__boplRoyaleLaunchConfig={debug:true,roomId:'TEST',user:{code:'TEST-USER',username:'Tester'}};
              window.__mergePartyLaunchConfig={offline:true,roomId:'TEST',user:{code:'TEST-USER',username:'Tester'}};
              const frame=document.createElement('iframe');frame.id='launcher-activity-test';
              frame.srcdoc=await ChatActivities.load(id);document.body.append(frame);
            },id);
            const activity=await (await app.$('#launcher-activity-test')).contentFrame();
            await activity.waitForFunction(id=>id==='bopl-royale'?!!window.__boplRoyale?.debug:!!window.__mergeParty?.debug,id);
            assert.equal(await activity.evaluate(()=>getComputedStyle(document.body).margin),'0px');
            if(id==='bopl-royale')assert.equal(await activity.evaluate(async()=>{
              const results=await Promise.all(Object.values(window.__boplRoyale.debug.ballArt).map(src=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth>0);image.onerror=()=>resolve(false);image.src=src;})));
              return results.every(Boolean);
            }),true,'CDN activity images decode');
            await app.evaluate(()=>document.getElementById('launcher-activity-test').remove());
          }
          revision=sha2;
          const updated=await open();
          assert.equal(await updated.getAttribute('html','data-app-ready'),'true');
          assert.ok(await updated.evaluate(()=>ChatRuntime.base.href.endsWith('@'+'b'.repeat(40)+'/')),'next click checks the current commit');
        }
        assert.deepEqual(errors,[]);
      }
      assert.deepEqual(missing,[],'all requested app assets exist with exact paths');
      results.push({scenario,passed:true});
      await context.close();
    }

    // Real HTTP subdirectory: emulates a GitHub Pages project path.
    const context=await browser.newContext();
    await context.addInitScript(installFirebaseMock);
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/,route=>route.fulfill({status:200,contentType:'application/json',body:'null'}));
    const page=await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}${prefix}`);
    await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
    assert.equal(await page.evaluate(()=>ChatRuntime.base.pathname),prefix);
    for(const id of ['bopl-royale','merge-party']) {
      const html=await page.evaluate(id=>ChatActivities.load(id),id);
      assert.ok(html.includes(prefix));
    }
    results.push({scenario:'github-pages-subdirectory',passed:true});
    await context.close();
    console.log(JSON.stringify(results,null,2));
  } finally {await browser.close();server.close();}
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
