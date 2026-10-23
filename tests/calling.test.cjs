'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const sourceRoot=process.env.CHAT_CALL_SOURCE_ROOT||path.resolve(__dirname,'../call-modules');

function harness(code='a'){
  const clock={now:100000};
  const timers=new Map();
  let timerId=0;
  const writes=[];
  const registrations=[];
  class FakeDate extends Date {static now(){return clock.now;}}
  class Track{
    constructor(kind,id){this.kind=kind;this.id=id;this.readyState='live';this.muted=false;this.enabled=true;this.settings={width:1920,height:1080};}
    getSettings(){return this.settings;}
    async applyConstraints(c){this.settings={...this.settings,width:c.width?.max||this.settings.width,height:c.height?.max||this.settings.height};this.constraints=c;}
    addEventListener(){}
    stop(){this.readyState='ended';}
  }
  class Stream{
    constructor(tracks=[]){this.tracks=tracks;}
    getTracks(){return this.tracks;}
    getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}
    getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}
    addTrack(track){this.tracks.push(track);}
  }
  class Sender{
    constructor(){this.track=null;this.params={encodings:[{}]};this.parameterWrites=0;this.replacements=0;}
    async replaceTrack(track){this.track=track;this.replacements++;}
    getParameters(){return structuredClone(this.params);}
    async setParameters(p){this.params=structuredClone(p);this.parameterWrites++;}
  }
  class PC{
    constructor(config){this.config=config;this.connectionState='new';this.iceConnectionState='new';this.signalingState='stable';this.tx=[];this.statsReads=0;this.restarts=0;this.closed=false;this.addedCandidates=[];}
    addTransceiver(kind,options){const tx={mid:null,sender:new Sender(),receiver:{track:new Track(kind,'remote-'+kind)},direction:options.direction};this.tx.push(tx);return tx;}
    getTransceivers(){return this.tx;}
    getSenders(){return this.tx.map(t=>t.sender);}
    getReceivers(){return this.tx.map(t=>t.receiver);}
    getConfiguration(){return this.config;}
    setConfiguration(config){this.config=config;}
    async createOffer(options){this.lastOfferOptions=options;return {type:'offer',sdp:'v=0\r\na=ice-ufrag:local\r\n'};}
    async createAnswer(){this.answerDirections=this.tx.filter(t=>t.mid!==null).map(t=>t.direction);return {type:'answer',sdp:'v=0\r\na=ice-ufrag:local\r\n'};}
    async setLocalDescription(d){this.localDescription=d.type==='rollback'?null:d;this.signalingState=d.type==='offer'?'have-local-offer':'stable';if(d.type==='offer')this.tx.forEach((t,i)=>t.mid=String(i));}
    async setRemoteDescription(d){
      this.remoteDescription=d;this.signalingState=d.type==='offer'?'have-remote-offer':'stable';
      if(d.type==='offer'){
        for(const [i,kind] of ['audio','video','audio','video'].entries()){
          // Browsers may create answer m-lines instead of associating an
          // answerer's premature addTransceiver calls with the remote offer.
          if(!this.tx.some(t=>t.mid===String(i))){const tx=this.addTransceiver(kind,{direction:'recvonly'});tx.mid=String(i);}
        }
      }
    }
    async addIceCandidate(c){this.addedCandidates.push(c);}
    restartIce(){this.restarts++;}
    close(){this.closed=true;this.connectionState='closed';}
    async getStats(){
      this.statsReads++;
      return new Map([
        ['audio',{type:'inbound-rtp',kind:'audio',packetsLost:0,packetsReceived:clock.now/10}],
        ['pair',{type:'candidate-pair',state:'succeeded',nominated:true,currentRoundTripTime:0.025,localCandidateId:'candidate'}],
        ['candidate',{type:'local-candidate',candidateType:'host'}],
        ['video',{type:'outbound-rtp',kind:'video',timestamp:clock.now,bytesSent:clock.now*40,qualityLimitationReason:'none'}]
      ]);
    }
  }
  function ref(location=''){
    return {
      child:key=>ref(location+'/'+key),on(){},off(){},once:async()=>({val:()=>null}),
      onDisconnect:()=>({remove:async()=>{},update:async()=>{},cancel:async()=>{}}),
      set:async value=>{writes.push({location,value});},update:async value=>{writes.push({location,value});},
      remove:async()=>{},push:value=>{writes.push({location,value});return Promise.resolve();},
      transaction:async cb=>({committed:false,snapshot:{val:()=>cb(null)}})
    };
  }
  const noop=()=>{};
  const document={visibilityState:'visible',addEventListener:noop,querySelector:()=>null,querySelectorAll:()=>[],getElementById:()=>null,body:{appendChild:noop,classList:{toggle:noop}},createElement:()=>({style:{},dataset:{},appendChild:noop,addEventListener:noop,setAttribute:noop,classList:{toggle:noop},remove:noop})};
  const context=vm.createContext({
    console,Date:FakeDate,Math,Map,Set,WeakMap,Promise,URL,AbortController,structuredClone,
    document,navigator:{},location:{href:'https://chat.example/index.html',protocol:'https:'},
    localStorage:{getItem:()=>null,setItem:noop},sessionStorage:{getItem:()=>null,setItem:noop,removeItem:noop},
    setTimeout:(fn,ms=0)=>{const id=++timerId;timers.set(id,{fn,at:clock.now+ms});return id;},
    clearTimeout:id=>timers.delete(id),setInterval:()=>++timerId,clearInterval:noop,
    queueMicrotask,requestAnimationFrame:()=>++timerId,cancelAnimationFrame:noop,performance:{now:()=>clock.now},
    MediaStream:Stream,RTCPeerConnection:PC,RTCIceCandidate:function(c){Object.assign(this,c);},RTCSessionDescription:function(d){Object.assign(this,d);},
    CSS:{escape:String},db:{ref},firebase:{database:{ServerValue:{TIMESTAMP:{'.sv':'timestamp'}}}},
    currentUser:{code,username:code},currentRoomId:'room',roomsMetaCache:new Map(),
    sanitizeRoomCode:String,roomDisplayName:()=> 'room',$:()=>null,showToast:noop,ensureLiveUserListener:noop,
    applyAvatar:noop,addEventListener:noop,fetch:async()=>{throw Error('Unconfigured test network');}
  });
  context.window=context;
  context.globalThis=context;
  const isNamespaced=fs.readFileSync(path.join(sourceRoot,'state.js'),'utf8').includes('App.register(');
  if(isNamespaced){
    context.ChatApp={...context,register:(name,initialize)=>registrations.push(initialize)};
  }
  const files=JSON.parse(fs.readFileSync(path.join(sourceRoot,'manifest.json'),'utf8'));
  for(const file of files){
    // UI binding is covered by browser tests; tests call the media components directly.
    if(file==='lifecycle.js' || file==='audio-settings.js') continue;
    vm.runInContext(fs.readFileSync(path.join(sourceRoot,file),'utf8'),context,{filename:file});
  }
  for(const initialize of registrations) initialize();
  const run=code=>vm.runInContext('with(globalThis.ChatApp||globalThis){'+code+'}',context);
  run(`currentCallRoomId='room';callSessionId='session-${code}';callLifecycleToken=1;callLocalStream=new MediaStream([new (${Track.toString()})('audio','mic')]);`);
  async function advance(ms){
    clock.now+=ms;
    for(let pass=0;pass<100;pass++){
      const due=Array.from(timers).filter(([,t])=>t.at<=clock.now);
      if(!due.length) break;
      for(const [id,timer] of due){timers.delete(id);await timer.fn();}
    }
    await Promise.resolve();
  }
  return {context,run,clock,timers,writes,advance,Track,Stream,PC};
}

test('opening screens and cameras adds independent viewers including your own media',()=>{
  const h=harness('a'); const app=h.context.ChatApp;
  app.callSharing=true; app.callCameraSharing=true;
  app.callMembersCache=[{code:'a',connected:true,sharing:true,cameraSharing:true},{code:'b',connected:true,sharing:true},{code:'c',connected:true,sharing:true}];
  app.openShareView('b','Blair');
  app.openShareView('c','Casey');
  app.openShareView('a','You');
  app.openShareView(app.callCameraKey('a'),'Your camera');
  assert.equal(app.callWatchedShareCodes.size,4,'Ordinary Watch preserves every selected stream');
  app.callCloseWatchedShare('b');
  assert.equal(app.callWatchedShareCodes.size,3);
  assert.equal(app.callWatchedShareCodes.has('a'),true,'Closing one stream leaves self screen open');
  assert.equal(app.callWatchedShareCodes.has(app.callCameraKey('a')),true,'Closing one stream leaves camera open');
  app.callMembersCache[2].connected=false;
  app.callPruneWatchedShares();
  assert.equal(app.callWatchedShareCodes.has('c'),false,'Departed shares are pruned');
  assert.equal(app.callWatchedShareCodes.size,2,'Other views remain open after a departure');
});

test('watch publishes its media subscription before waiting for the previous viewer cleanup',async()=>{
  const h=harness('a');
  const app=h.context.ChatApp;
  app.callMenuOpen=true;
  app.callMembersCache=[{code:'b',sessionId:'b-session',connected:true,sharing:true,shareId:'b-share'}];
  app.callWatchedShareCodes=new Set(['b']);
  let published=null;
  let release;
  const cleanup=new Promise(resolve=>{release=resolve;});
  app.myCallMemberRef={update:async value=>{published=value;}};
  app.callViewerPresenceRefs.set('old',{roomId:'room',sessionId:'session-a',shareId:'old-share',ref:{onDisconnect:()=>({cancel:()=>cleanup}),remove:async()=>{}}});
  const pending=app.callSyncViewerPresenceNow();
  await Promise.resolve();
  assert.equal(published?.viewingShares.b,'b-share','new media is requested while unrelated cleanup remains pending');
  release();
  await pending;
});

test('hiding the call panel preserves selected screen and camera subscriptions until explicitly closed',async()=>{
  const h=harness('a'), app=h.context.ChatApp;
  app.callMenuOpen=false;
  app.callMembersCache=[{code:'b',sessionId:'b-session',connected:true,sharing:true,shareId:'screen-b',cameraSharing:true,cameraShareId:'camera-b'}];
  app.callWatchedShareCodes=new Set(['b','camera:b']);
  let published;
  app.myCallMemberRef={update:async value=>{published=value;}};
  await app.callSyncViewerPresenceNow();
  assert.deepEqual({...published.viewingShares},{b:'screen-b','camera:b':'camera-b'});
  assert.equal(app.callGetShareViewerUsers('b').some(user=>user.code==='a'),true);
  app.callCloseWatchedShare('b');
  await app.callSyncViewerPresence();
  assert.deepEqual({...published.viewingShares},{'camera:b':'camera-b'});
  app.callCloseWatchedShare('camera:b');
  await app.callSyncViewerPresence();
  assert.equal(published.viewingShares,null);
});

test('high zoom crops source pixels to the viewport at any magnification and pan',()=>{
  const app=harness().context.ChatApp;
  const geometry={width:1920,height:1080,frameWidth:1920,frameHeight:1080};
  const crop=Array.from(app.callScreenCropGeometry(geometry,{percent:2000,x:0,y:0},1920,1080));
  assert.deepEqual(crop,[912,513,96,54,0,0,1920,1080]);
  const edge=Array.from(app.callScreenCropGeometry(geometry,{percent:2000,x:18240,y:10260},1920,1080));
  assert.deepEqual(edge,[0,0,96,54,0,0,1920,1080]);
  const portrait=Array.from(app.callScreenCropGeometry({...geometry,frameWidth:607.5},{percent:100,x:0,y:0},720,1280));
  assert.deepEqual(portrait,[0,0,720,1280,656.25,0,607.5,1080]);
});

test('expanding, restoring, and closing calls synchronize the companion chat',()=>{
  const h=harness();
  const app=h.context.ChatApp;
  const transitions=[];
  app.syncExpandedCallChat=()=>transitions.push([app.callMenuOpen,app.callMenuExpanded]);
  app.callMenuOpen=true;
  app.setCallMenuExpanded(true);
  app.setCallMenuExpanded(false);
  app.setCallMenuExpanded(true);
  app.closeCallUserContextMenu=()=>{};
  app.callHideScreenViewersFloating=()=>{};
  h.context.document.body.classList.remove=()=>{};
  app.closeCallMenu();
  assert.deepEqual(transitions,[[true,true],[true,false],[true,true],[false,false]]);
});

test('six-person mesh retains each viewer\'s 720p30 target and prioritizes speech',()=>{
  const h=harness();
  const budget=h.context.ChatCallPolicy.mediaBudget({peers:5,subscribers:5});
  assert.equal(budget.audioBitrate,48000);
  assert.equal(budget.videoBitrate,2400000);
  assert.ok(budget.videoBitrate*5<=budget.totalVideoBudget);
  assert.equal(budget.maxFramerate,30);
  assert.equal(budget.width,1280);
  const pressured=h.context.ChatCallPolicy.mediaBudget({peers:5,subscribers:5,constrained:true});
  assert.equal(pressured.maxFramerate,30);
  assert.equal(pressured.videoBitrate,2400000);
  assert.ok(h.context.ChatCallPolicy.mediaBudget({subscribers:32}).totalVideoBudget<=12000000);
});

test('viewer subscriptions are tied to both viewer session and share generation',()=>{
  const h=harness();
  const policy=h.context.ChatCallPolicy;
  const member={sessionId:'new',viewingSharesSessionId:'old',viewingShares:{owner:'share'}};
  assert.equal(policy.wantsScreen(member,'owner','share'),false);
  member.viewingSharesSessionId='new';
  assert.equal(policy.wantsScreen(member,'owner','share'),true);
  assert.equal(policy.wantsScreen(member,'owner','restarted-share'),false);
});

test('loss is measured in the current interval, and counter resets are harmless',()=>{
  const policy=harness().context.ChatCallPolicy;
  assert.equal(policy.packetDelta({lost:100,received:900},{lost:100,received:1900}),0);
  assert.equal(policy.packetDelta({lost:100,received:1900},{lost:110,received:1990}),10);
  assert.equal(policy.packetDelta({lost:110,received:1990},{lost:0,received:20}),0);
});

test('relay authorization timeout falls back instead of indefinitely blocking join',async()=>{
  const h=harness();
  h.context.CHAT_CALL_CONFIG={iceServersEndpoint:'https://ice.example/credentials',getIceAuthorization:()=>new Promise(()=>{})};
  const pending=h.run(`callRefreshIceServers();`);
  await Promise.resolve();
  await h.advance(4501);
  const servers=await pending;
  assert.ok(servers.length>0);
  assert.match(h.run(`callConnectivityStatus.lastError`),/timed out/);
  assert.equal(h.run(`callConnectivityStatus.relayConfigured`),false);
});

test('changed relay credentials migrate one owner path; unchanged refreshes do not restart',async()=>{
  const h=harness('a');
  let password='first';
  h.context.CHAT_CALL_CONFIG={iceServersEndpoint:'https://ice.example/credentials'};
  h.context.fetch=async()=>({ok:true,json:async()=>({iceServers:[{urls:['turn:relay.example:3478'],username:'user',credential:password}],ttlSeconds:600})});
  await h.run(`callRefreshIceServers();`);
  h.run(`callMembersCache=[{code:'b',sessionId:'session-b',connected:true}];callCreatePeer('b','room');const pc=callPeerMap.get('b');pc.remoteDescription={type:'answer',sdp:'v=0'};pc.__qualityStats={relay:true};globalThis.credentialRestarts=0;callSendOffer=async()=>{globalThis.credentialRestarts++;};`);
  password='second';
  h.clock.now+=16000;
  await h.run(`callRefreshIceServers({force:true});`);
  assert.ok(h.run(`callPeerMap.get('b').__credentialRestartTimer`));
  await h.advance(1100);
  assert.equal(h.context.credentialRestarts,1);
  h.clock.now+=16000;
  await h.run(`callRefreshIceServers({force:true});`);
  assert.equal(h.run(`callPeerMap.get('b').__credentialRestartTimer`),null);
  assert.equal(h.context.credentialRestarts,1);
});

test('brief signaling loss preserves a healthy peer; DTLS failures are not healthy',()=>{
  const policy=harness().context.ChatCallPolicy;
  const member={sessionId:'s',connected:false,disconnectedAt:1};
  const pc={__peerSessionId:'s',connectionState:'connected',iceConnectionState:'connected'};
  assert.equal(policy.keepMember(member,pc,100000,45000),true);
  pc.connectionState='failed';
  assert.equal(policy.keepMember(member,pc,100000,45000),false);
});

test('abandoned presence expires and confirmed disconnects disappear immediately unless media remains live',()=>{
  const policy=harness().context.ChatCallPolicy;
  const member={sessionId:'s',connected:true,lastSeenAt:1,joinedAt:1};
  assert.equal(policy.keepMember(member,null,130000,45000),false);
  const pc={__peerSessionId:'s',connectionState:'connected',iceConnectionState:'connected'};
  assert.equal(policy.keepMember(member,pc,130000,45000),true);
  assert.equal(policy.keepMember({...member,connected:false,disconnectedAt:129000},null,130000,45000),false);
  assert.equal(policy.keepMember({...member,departedSessionId:'s'},pc,130000,45000),false,'Explicit departure wins over a not-yet-closed peer');
  assert.equal(policy.keepMember({...member,departedSessionId:'previous'},pc,130000,45000),true,'A late departure cannot remove a newer session');
  assert.equal(policy.keepMember(member,{...pc,__peerSessionId:'older'},130000,45000),false);
  assert.equal(policy.isConnected({...pc,connectionState:'disconnected'}),false,'Stale ICE-connected must not mask disconnected DTLS');
});

test('cached member snapshots expire without waiting for another database event',()=>{
  const h=harness();
  const app=h.context.ChatApp;
  app.currentCallRoomId=null;
  app.syncCallButton=()=>{};
  app.callSyncMenuStatusDisplay=()=>{};
  app.callSyncViewerPresence=()=>{};
  const cleaned=[];
  app.callCleanupStaleMember=(_room,member)=>cleaned.push(member.code);
  app.attachCallObserver('room');
  const snapshot={val:()=>({b:{sessionId:'session-b',connected:true,lastSeenAt:h.clock.now}})};
  // Freeze the server value, then age the observer's retained snapshot.
  const memberValue=snapshot.val();
  app.callsRoomCb({val:()=>memberValue});
  assert.equal(app.callActive,true);
  app.callLocallyEndedSessions.add('session-b');
  app.callsRoomCb(app.callObservedMembersSnapshot);
  assert.equal(app.callActive,false,'A locally ended session never reappears from an offline snapshot');
  app.callLocallyEndedSessions.clear();
  app.callsRoomCb(app.callObservedMembersSnapshot);
  assert.equal(app.callActive,true);
  h.clock.now+=120001;
  app.callsRoomCb(app.callObservedMembersSnapshot);
  assert.equal(app.callActive,false);
  assert.deepEqual(cleaned,['b']);
});

test('polite hard recovery offers immediately without waiting for its connect watchdog',async()=>{
  const h=harness('b');
  h.run(`callMembersCache=[{code:'a',sessionId:'session-a',connected:true}];callCreatePeer('a','room');`);
  const old=h.run(`callPeerMap.get('a')`);
  await h.run(`callHardRestartPeer('a','room','test-recovery');`);
  const replacement=h.run(`callPeerMap.get('a')`);
  assert.notEqual(replacement,old);
  assert.equal(old.closed,true);
  assert.equal(replacement.__audioTx.sender.track.kind,'audio');
  assert.equal(replacement.signalingState,'have-local-offer');
  assert.equal(replacement.lastOfferOptions.iceRestart,true);
});

function lifecycleHarness(){
  const h=harness();
  const app=h.context.ChatApp;
  const registration=app.register;
  app.register=()=>{};
  vm.runInContext(fs.readFileSync(path.join(sourceRoot,'lifecycle.js'),'utf8'),h.context,{filename:'lifecycle.js'});
  app.register=registration;
  const noop=()=>{};
  app.LS={CALL_ROOM:'call-room'};
  for(const name of ['syncCallButton','syncCallControlsUI','callSetMobileAudioSession','callPrimePlaybackContextFromGesture','callClearAudioPreferenceScope','callClearDesktopOverlayScope','closeShareView','closeCallMenu','callStopWebRTC','attachCallObserver','callClosePlaybackContext','callDisposeMicrophoneGraph','openCallMenu','renderCallMenu','callBindLocalMicrophoneHealth']) app[name]=noop;
  return {...h,app};
}

test('offline Leave releases pending state while server cleanup awaits reconnection',async()=>{
  const h=lifecycleHarness();
  const {app}=h;
  let removeAttempted=false;
  app.myCallMemberRef={onDisconnect:()=>({cancel:()=>new Promise(()=>{})})};
  app.callRemoveMembershipSession=()=>{removeAttempted=true;return new Promise(()=>{});};
  let complete=false;
  void app.leaveCall({quiet:true}).then(()=>{complete=true;});
  for(let i=0;i<10;i++) await Promise.resolve();
  assert.equal(app.currentCallRoomId,null,'Local call ends before any server acknowledgement');
  await h.advance(1001);
  for(let i=0;i<10;i++) await Promise.resolve();
  assert.equal(removeAttempted,true);
  assert.equal(complete,true);
  assert.equal(app.callLeavePending,false);
  assert.equal(app.currentCallRoomId,null);
});

test('membership cleanup cannot delete a newer session after a rapid rejoin',async()=>{
  const {app}=lifecycleHarness();
  let record={instanceId:'instance',active:true,members:{a:{sessionId:'new-session',connected:true}}};
  app.db={ref:location=>({transaction:async update=>{
    const member=location.endsWith('/members/a');
    const value=update(member?record?.members.a:record);
    if(value!==undefined){
      if(member){if(value===null)delete record.members.a;else record.members.a=value;}
      else record=value;
    }
  }})};
  await app.callRemoveMembershipSession('room','a','old-session');
  assert.equal(record.members.a.sessionId,'new-session');
  await app.callRemoveMembershipSession('room','a','new-session');
  assert.equal(record,null);
});

test('leave publishes the small member removal before call retirement without a full-call read',async()=>{
  const {app}=lifecycleHarness();
  const operations=[];
  let finishRetirement;
  app.db={ref:location=>({
    once(){throw Error('Presence must not wait for a full-call read');},
    transaction:async update=>{
      operations.push(location);
      if(location.endsWith('/members/a')){
        assert.equal(update({sessionId:'session-a'}),null);
        return {committed:true};
      }
      assert.equal(update(null),null);
      return new Promise(resolve=>{finishRetirement=resolve;});
    }
  })};
  const cleanup=app.callRemoveMembershipSession('room','a','session-a');
  assert.deepEqual(operations,['calls/room/members/a'],'Removal is queued in the same event turn');
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.deepEqual(operations,['calls/room/members/a','calls/room']);
  finishRetirement({committed:true});
  await cleanup;
});

test('call-end logs use the server-adjusted clock even when the sender clock is a day ahead', async () => {
  const h=lifecycleHarness(), app=h.app, logs=[];
  app.firebaseServerTimeOffsetMs=-86400000;
  h.clock.now=86400000+100000;
  app.callHasLiveMembers=()=>false;
  app.writeRoomSystemMessage=async(...args)=>logs.push(args);
  app.db={ref:location=>({transaction:async update=>{
    const record=location.endsWith('/members/a')?{sessionId:'session-a'}:{instanceId:'one',members:{}};
    assert.equal(update(record),null);return {committed:true};
  }})};
  await app.callRemoveMembershipSession('room','a','session-a');
  assert.equal(logs.length,1);
  assert.equal(logs[0][1].createdAt,100000);
  assert.equal(logs[0][2],'call-ended:one');
});

test('pending joins survive stale snapshots and realtime departures publish menu and overlay synchronously',()=>{
  const h=harness();
  const app=h.context.ChatApp;
  app.callJoinPending=true;
  app.callMenuOpen=true;
  const self={code:'a',sessionId:'session-a',connected:true,displayName:'Alice',joinedAt:h.clock.now};
  const remote={code:'b',sessionId:'session-b',connected:true,displayName:'Bob',joinedAt:h.clock.now};
  app.callJoiningMember={roomId:'room',member:self};
  app.syncCallButton=app.callSyncMenuStatusDisplay=app.callSyncViewerPresence=app.callScheduleMediaBudget=app.callEnsurePeers=()=>{};
  const menus=[],overlays=[];
  app.renderCallMenu=()=>menus.push(Array.from(app.callMembersCache,member=>member.code));
  app.callPublishDesktopOverlay=()=>overlays.push(Array.from(app.callMembersCache,member=>member.code));
  app.attachCallObserver('room');
  app.callsRoomCb({val:()=>({b:remote})});
  assert.deepEqual(menus.at(-1),['a','b'],'Initial snapshot cannot blank the pending local join');
  assert.deepEqual(overlays.at(-1),['a','b']);
  app.callsRoomCb({val:()=>({})});
  assert.deepEqual(menus.at(-1),['a'],'Remote leave renders before callback returns');
  assert.deepEqual(overlays.at(-1),['a'],'Native overlay receives the same departure immediately');
  app.callJoiningMember=null;
  app.callJoinPending=false;
  app.callLocallyEndedSessions.add('session-a');
  app.currentCallRoomId=null;
  app.callsRoomCb({val:()=>({a:self})});
  assert.deepEqual(menus.at(-1),[],'Rollback or leave cannot be resurrected by cached membership');
});

test('a member acknowledgement timeout restores controls and stops delayed join continuation',async()=>{
  const h=lifecycleHarness();
  const app=h.app;
  app.currentCallRoomId=null;
  app.callSessionId=null;
  const stream=new h.Stream([new h.Track('audio','new-mic')]);
  app.callRequestMicPermission=async()=>stream;
  app.callRefreshIceServers=async()=>[];
  app.callAttachLocalStream=value=>{app.callLocalStream=value;};
  let finishMemberWrite;
  let metadataWrites=0;
  const ref={on(){},off(){},once:async()=>({val:()=>null}),child:()=>ref,update:async()=>{metadataWrites++;},onDisconnect:()=>({update:async()=>{},cancel:async()=>{}}),transaction:async update=>{
    const proposed=update(null);
    if(proposed?.members) return new Promise(resolve=>{finishMemberWrite=()=>resolve({committed:true,snapshot:{val:()=>proposed}});});
    return {committed:true,snapshot:{val:()=>proposed}};
  }};
  app.db={ref:()=>ref};
  const notices=[];
  app.showToast=notice=>notices.push(notice);
  const joining=app.joinCall('room');
  for(let i=0;i<15;i++) await Promise.resolve();
  assert.equal(app.callJoinPending,true);
  assert.equal(typeof finishMemberWrite,'function');
  assert.equal(app.myCallMemberRef,null,'No VAD/viewer publication before membership acknowledgement');
  await h.advance(15001);
  await joining;
  assert.equal(app.callJoinPending,false);
  assert.equal(app.currentCallRoomId,null);
  assert.equal(app.callMembersCache.length,0);
  assert.equal(stream.getAudioTracks()[0].readyState,'ended');
  finishMemberWrite();
  for(let i=0;i<10;i++) await Promise.resolve();
  assert.equal(metadataWrites,0,'A late acknowledgement cannot continue the canceled join');
  assert.match(notices.at(-1).body,/did not respond/);
});

test('password rejoin carries saved mute/deafen through membership before WebRTC starts',async()=>{
  for(const saved of [{muted:true,deafened:false},{muted:false,deafened:true}]){
    const h=lifecycleHarness(),app=h.app;
    app.currentCallRoomId=null;app.callSessionId=null;app.callMuted=false;app.callDeafened=false;
    const stream=new h.Stream([new h.Track('audio','rejoin-mic')]);
    app.callRequestMicPermission=async()=>stream;
    app.callRefreshIceServers=async()=>[];
    app.callAttachLocalStream=(value,options)=>{
      assert.equal(value.getAudioTracks()[0].enabled,false,'raw microphone is already disabled before stream attachment');
      assert.deepEqual({...options.preserveAudioState},saved);
      app.callLocalStream=value;
      assert.equal(app.callMuted,saved.muted);assert.equal(app.callDeafened,saved.deafened);
    };
    app.callCommitMembership=async(room,payload)=>{
      assert.equal(payload.muted,saved.muted);assert.equal(payload.deafened,saved.deafened);
      return {instanceId:'kept-call',members:{a:payload}};
    };
    app.callLoadAudioPreferences=(room,record,options)=>assert.deepEqual({...options.preserveAudioState},saved);
    let started=false;
    app.callStartWebRTC=()=>{
      started=true;
      assert.equal(app.callLocalStream.getAudioTracks()[0].enabled,false,'first peer never receives an enabled microphone');
      assert.equal(app.callMuted,saved.muted);assert.equal(app.callDeafened,saved.deafened);
    };
    app.callStartHeartbeat=()=>{};app.callLoadDesktopOverlayPreferences=()=>{};
    app.callResumeRemoteAudio=async()=>{};app.callStartNotificationSession=()=>{};
    await app.joinCall('room',{openMenu:false,preserveAudioState:saved});
    assert.equal(started,true);assert.equal(app.currentCallRoomId,'room');
  }
});

test('ICE candidates match actual generation and preserve future candidates',async()=>{
  const h=harness();
  h.run(`callMembersCache=[{code:'b',sessionId:'session-b',connected:true}];callCreatePeer('b','room');`);
  h.run(`const pc=callPeerMap.get('b');pc.remoteDescription={type:'answer',sdp:'v=0\\r\\na=ice-ufrag:current\\r\\n'};pc.__remoteSignalId='new-sdp';pc.__pendingCandidates=[{candidate:'candidate:one',usernameFragment:'current',signalId:'previous-sdp',__queuedAt:Date.now()},{candidate:'candidate:two',usernameFragment:'future',signalId:'next-sdp',__queuedAt:Date.now()}];`);
  await h.run(`callDrainPendingIce(callPeerMap.get('b'));`);
  assert.equal(h.run(`callPeerMap.get('b').addedCandidates.length`),1);
  assert.equal(h.run(`callPeerMap.get('b').__pendingCandidates.length`),1);
});

test('one ICE + connection failure produces one scheduled recovery',async()=>{
  const h=harness();
  h.run(`callMembersCache=[{code:'b',sessionId:'session-b',connected:true}];callCreatePeer('b','room');const pc=callPeerMap.get('b');pc.connectionState='failed';pc.iceConnectionState='failed';pc.oniceconnectionstatechange();pc.onconnectionstatechange();`);
  const recoveryTimer=h.run(`callPeerMap.get('b').__recoveryTimer`);
  assert.ok(recoveryTimer);
  h.run(`callPeerMap.get('b').oniceconnectionstatechange();`);
  assert.equal(h.run(`callPeerMap.get('b').__recoveryTimer`),recoveryTimer);
  await h.advance(100);
  assert.equal(h.run(`callPeerMap.get('b').__restartAttempts`),1);
  assert.equal(h.run(`callPeerMap.get('b').restarts`),1);
});

test('polite answerer attaches microphone to the offered m-line before answering',async()=>{
  const h=harness('b');
  h.run(`callMembersCache=[{code:'a',sessionId:'session-a',connected:true}];callCreatePeer('a','room');`);
  await h.run(`callEnsurePeers('room');`);
  assert.equal(h.run(`callPeerMap.get('a').getTransceivers().length`),0,'answerer must wait for offered m-lines');
  h.run(`const pc=callPeerMap.get('a');pc.__observedRemoteOfferId='offer-a';pc.__pendingRemoteOffer={offer:{id:'offer-a',type:'offer',sdp:'v=0\\r\\na=ice-ufrag:remote\\r\\n'},ref:db.ref('incoming-offer')};`);
  await h.run(`callDrainRemoteOffers(callPeerMap.get('a'));`);
  assert.equal(h.run(`callPeerMap.get('a').getTransceivers().length`),4,'exactly one microphone, screen video, screen audio and camera m-line');
  assert.equal(h.run(`callPeerMap.get('a').__audioTx.mid`),'0');
  assert.equal(h.run(`callPeerMap.get('a').__audioTx.sender.track.kind`),'audio');
  assert.equal(h.run(`callPeerMap.get('a').answerDirections.join(',')`),'sendrecv,sendrecv,sendrecv,sendrecv');
});

test('throttled VAD publishes the final silent state',async()=>{
  const h=harness();
  h.run(`myCallMemberRef=db.ref('test-speaking');callSetLocalSpeaking(true);`);
  h.clock.now+=80;
  h.run(`callSetLocalSpeaking(false);`);
  await h.advance(301);
  assert.deepEqual(h.writes.filter(w=>w.location==='test-speaking').map(w=>w.value.speaking),[true,false]);
});

test('six clients run a simulated ten-minute room without screen-driven reconnect churn',async()=>{
  const clients='abcdef'.split('').map(code=>harness(code));
  const members='abcdef'.split('').map(code=>({code,sessionId:'session-'+code,connected:true,sharing:true,shareId:'share-'+code,viewingSharesSessionId:'session-'+code,viewingShares:Object.fromEntries('abcdef'.split('').filter(x=>x!==code).map(x=>[x,'share-'+x]))}));
  for(let i=0;i<clients.length;i++){
    const h=clients[i],code='abcdef'[i];
    h.context.members=members;
    h.run(`callMembersCache=members;callSharing=true;callScreenShareId='share-${code}';callScreenTrack=new RTCPeerConnection({}).addTransceiver('video',{direction:'sendrecv'}).receiver.track;callScreenStream=new MediaStream([callScreenTrack]);callMenuOpen=true;callWatchedShareCodes=new Set(callMembersCache.filter(m=>m.code!==currentUser.code).map(m=>m.code));`);
    await h.run(`callEnsurePeers('room');`);
    await h.run(`Promise.all(Array.from(callPeerMap.values(),async pc=>{if(pc.__polite){pc.__observedRemoteOfferId='test-offer';pc.__pendingRemoteOffer={offer:{id:'test-offer',type:'offer',sdp:'v=0\\r\\na=ice-ufrag:remote\\r\\n'},ref:db.ref('incoming-offer')};await callDrainRemoteOffers(pc);}}));`);
    await h.run(`callRebalanceMedia();`);
    h.run(`for(const pc of callPeerMap.values()){pc.connectionState='connected';pc.iceConnectionState='connected';pc.signalingState='stable';pc.__pendingOfferId=null;pc.__offerQueued=false;pc.onconnectionstatechange();}`);
    assert.equal(h.run(`callPeerMap.size`),5);
    assert.equal(h.run(`Array.from(callPeerMap.values()).filter(pc=>pc.__screenTx.sender.track).length`),5);
    assert.equal(h.run(`Array.from(callPeerMap.values()).reduce((n,pc)=>n+pc.__screenTx.sender.params.encodings[0].maxBitrate,0)`),12000000);
  }
  for(let tick=0;tick<120;tick++){
    await Promise.all(clients.map(async h=>{
      await h.advance(5000);
      await h.run(`callUpdateConnectionQuality();`);
      await h.run(`callAuditLocalMediaSenders();`);
      await h.run(`callCheckScreenHealth();`);
    }));
  }
  for(const h of clients){
    assert.equal(h.run(`callPeerMap.size`),5);
    assert.equal(h.run(`Array.from(callPeerMap.values()).filter(pc=>pc.closed||pc.restarts).length`),0);
    assert.ok(h.run(`Array.from(callPeerMap.values()).every(pc=>pc.statsReads<=122)`));
    assert.ok(h.run(`Array.from(callPeerMap.values()).every(pc=>pc.__screenTx.sender.parameterWrites<=2)`));
    // A viewer closes this owner's share: only that sender detaches, audio stays.
    h.run(`const member=callMembersCache.find(m=>m.code!==currentUser.code);member.viewingShares={};`);
    await h.run(`callRebalanceMedia();`);
    assert.ok(h.run(`Array.from(callPeerMap.values()).some(pc=>pc.__screenTx.sender.track===null)`));
    assert.ok(h.run(`Array.from(callPeerMap.values()).every(pc=>pc.__audioTx.sender.track?.readyState==='live')`));
  }
});


test('camera subscriptions use a separate stable sender and preserve simultaneous screen and microphone', async () => {
  const h = harness('a'), App = h.context.ChatApp;
  App.callMembersCache = [{ code: 'b', sessionId: 'session-b', connected: true, viewingSharesSessionId: 'session-b', viewingShares: { a: 'screen', 'camera:a': 'camera' } }];
  App.callSharing = App.callCameraSharing = true;
  App.callScreenShareId = 'screen'; App.callCameraShareId = 'camera';
  App.callScreenTrack = new h.Track('video', 'screen-track');
  App.callCameraTrack = new h.Track('video', 'camera-track');
  await App.callEnsurePeers('room');
  const pc = App.callPeerMap.get('b');
  assert.equal(pc.getTransceivers().length, 4);
  assert.equal(pc.__screenTx.sender.track, App.callScreenTrack);
  assert.equal(pc.__cameraTx.sender.track, App.callCameraTrack);
  assert.notEqual(pc.__screenTx, pc.__cameraTx);
  assert.equal(pc.__cameraTx.sender.params.encodings[0].maxFramerate, 30);
  assert.equal(App.callIsCameraTrack(pc, { track: pc.__cameraTx.receiver.track, transceiver: pc.__cameraTx }), true);
  assert.equal(App.callIsCameraTrack(pc, { track: pc.__screenTx.receiver.track, transceiver: pc.__screenTx }), false);
  delete App.callMembersCache[0].viewingShares['camera:a'];
  await App.callRebalanceMedia();
  assert.equal(pc.__cameraTx.sender.track, null);
  assert.equal(pc.__screenTx.sender.track, App.callScreenTrack);
  assert.equal(pc.__audioTx.sender.track.kind, 'audio');
  App.callMembersCache[0].viewingShares['camera:a'] = 'older-camera';
  await App.callSetPeerCameraTrack(pc, App.callCameraTrack);
  assert.equal(pc.__cameraTx.sender.track, null, 'stale camera generations do not subscribe');
  App.callMembersCache[0].viewingShares['camera:a'] = 'camera';
  await App.callSetPeerCameraTrack(pc, App.callCameraTrack);
  assert.equal(pc.__cameraTx.sender.track, App.callCameraTrack);
  assert.equal(pc.getTransceivers().length, 4);
});

test('camera viewers exclude the owner and require the current camera generation', () => {
  const h = harness('a'), App = h.context.ChatApp;
  App.liveUserCache = new Map();
  App.callCameraSharing = true; App.callCameraShareId = 'camera-live';
  App.callMembersCache = [
    { code: 'a', sessionId: 'session-a', connected: true, viewingSharesSessionId: 'session-a', viewingShares: { 'camera:a': 'camera-live' } },
    { code: 'b', sessionId: 'session-b', connected: true, viewingSharesSessionId: 'session-b', viewingShares: { 'camera:a': 'camera-live' } },
    { code: 'c', sessionId: 'session-c', connected: true, viewingSharesSessionId: 'session-c', viewingShares: { 'camera:a': 'camera-old' } },
  ];
  assert.deepEqual(Array.from(App.callGetShareViewerUsers('camera:a'), user => user.code), ['b']);
});

test('a camera permission response after leaving stops every returned track and never publishes', async () => {
  const h = harness('a'), App = h.context.ChatApp;
  let resolveCapture, requestedConstraints;
  h.context.navigator.mediaDevices = { getUserMedia: constraints => { requestedConstraints = constraints; return new Promise(resolve => { resolveCapture = resolve; }); } };
  const capture = App.callToggleCamera({ deviceId: 'selected-usb-camera' });
  assert.equal(requestedConstraints.video.deviceId.exact, 'selected-usb-camera');
  assert.equal(requestedConstraints.video.width.max, 1280);
  assert.equal(requestedConstraints.video.height.max, 720);
  assert.equal(requestedConstraints.video.frameRate.max, 30);
  assert.equal(App.callCameraCapturePending, true);
  const track = new h.Track('video', 'late-camera');
  App.currentCallRoomId = null; App.callSessionId = null;
  resolveCapture(new h.Stream([track]));
  await capture;
  assert.equal(track.readyState, 'ended');
  assert.equal(App.callCameraSharing, false);
  assert.equal(App.callCameraCapturePending, false);
  assert.equal(h.writes.length, 0);
});

test('camera can stop immediately while its presence acknowledgement is pending', async () => {
  const h = harness('a'), App = h.context.ChatApp;
  const track = new h.Track('video', 'camera-track');
  h.context.navigator.mediaDevices = { getUserMedia: async () => new h.Stream([track]) };
  App.callCaptureScreenPreview = async () => null;
  let resolvePublish, member = { sessionId: App.callSessionId };
  App.db = { ref: () => ({ transaction: callback => {
    const next = callback(member);
    if (!next) return Promise.resolve({ committed: false });
    member = next;
    return member.cameraSharing ? new Promise(resolve => { resolvePublish = resolve; }) : Promise.resolve({ committed: true });
  } }) };
  App.callRemoveShareViewerGeneration = async () => {};
  const start = App.callToggleCamera();
  for (let i = 0; i < 8 && !resolvePublish; i++) await Promise.resolve();
  assert.equal(App.callCameraSharing, true);
  await App.callToggleCamera();
  assert.equal(App.callCameraSharing, false);
  assert.equal(track.readyState, 'ended');
  assert.equal(member.cameraSharing, false);
  resolvePublish({ committed: true });
  await start;
  assert.equal(App.callCameraStream, null, 'late acknowledgement cannot revive capture');
});


test('pagehide publishes a session-safe departure immediately and retains disconnect cleanup while offline',async()=>{
  const {app,writes}=lifecycleHarness();
  let canceled=false;
  app.myCallMemberRef={onDisconnect:()=>({cancel:async()=>{canceled=true;}})};
  app.callRemoveMembershipSession=()=>new Promise(()=>{});
  app.callHandlePageHide();
  assert.equal(app.currentCallRoomId,null,'Pagehide stops local call synchronously');
  assert.ok(writes.some(write=>write.location==='calls/room/members/a/departedSessionId' && write.value==='session-a'));
  assert.equal(canceled,false,'Server disconnect remains armed until membership removal is acknowledged');
});

test('startup video SDP hints preserve codecs, audio, RTX and congestion adaptation',()=>{
  const {app}=lifecycleHarness();
  const source={type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 102\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtpmap:102 H264/90000\r\na=fmtp:102 profile-level-id=42e01f;packetization-mode=1;x-google-start-bitrate=300\r\n'};
  const tuned=app.callPrepareLocalDescription(source);
  assert.equal(tuned.type,'offer');
  assert.match(tuned.sdp,/a=fmtp:96 x-google-start-bitrate=3000/);
  assert.match(tuned.sdp,/a=fmtp:102 profile-level-id=42e01f;packetization-mode=1;x-google-start-bitrate=3000/);
  assert.ok(tuned.sdp.includes('a=fmtp:97 apt=96\r\n'));
  assert.ok(tuned.sdp.includes('a=fmtp:111 minptime=10;useinbandfec=1\r\n'));
  assert.ok(!tuned.sdp.includes('x-google-min-bitrate'));
  assert.equal(app.callPrepareLocalDescription(tuned).sdp,tuned.sdp,'Renegotiation never duplicates hints');
  assert.equal(source.sdp.includes('x-google-start-bitrate=3000'),false,'Original description remains unchanged');
});

test('video tuning retries immediately when negotiated encodings first become available',async()=>{
  const h=harness();const app=h.context.ChatApp;
  app.callMembersCache=[{code:'b',sessionId:'session-b',connected:true}];
  const pc=app.callCreatePeer('b','room');
  await Promise.all([pc.__screenTrackPromise,pc.__cameraTrackPromise]);
  const sender=pc.__screenTx.sender;
  sender.track=new h.Track('video','screen');
  sender.params={encodings:[]};
  await app.callTuneScreenSender(sender);
  assert.equal(sender.parameterWrites,0);
  sender.params={encodings:[{}]};
  await app.callPrimePeerMedia(pc);
  assert.equal(sender.params.encodings[0].maxBitrate,4000000);
  assert.equal(sender.params.encodings[0].maxFramerate,30);
  assert.equal(sender.params.encodings[0].scaleResolutionDownBy,1.5);
});


test('a non-call observer hides a disconnected tile without deleting temporarily offline membership or SDP',async()=>{
  const h=harness(),app=h.context.ChatApp;
  app.currentCallRoomId=null;app.callSessionId=null;
  const member={code:'b',sessionId:'session-b',connected:false,lastSeenAt:h.clock.now-1000,disconnectedAt:h.clock.now};
  app.syncCallButton=app.callSyncMenuStatusDisplay=app.callSyncViewerPresence=()=>{};
  const cleanup=app.callCleanupStaleMember,scheduled=[];
  app.callCleanupStaleMember=(_room,value)=>scheduled.push(value.code);
  app.attachCallObserver('room');
  app.callsRoomCb({val:()=>({b:member})});
  assert.equal(app.callMembersCache.length,0,'Visual removal is immediate');
  assert.deepEqual(scheduled,[],'Visual absence is not authorization to delete shared membership');
  assert.equal(app.callHasLiveMembers({b:member}),true,'Room instance and preferences survive reconnect grace');
  let deleted=false;
  app.db={ref:()=>({transaction:async update=>{if(update(member)===null)deleted=true;return {committed:false};}})};
  await cleanup('room',member);
  assert.equal(deleted,false,'The destructive transaction independently rechecks its grace');
  const policy=h.context.ChatCallPolicy;
  assert.equal(policy.shouldCleanupMember({...member,departedSessionId:'session-b'},null,h.clock.now,45000),true,'Explicit session departure needs no grace');
  h.clock.now+=45001;
  assert.equal(policy.shouldCleanupMember(member,null,h.clock.now,45000),true);
  assert.equal(app.callHasLiveMembers({b:member}),false,'Abandoned instance can still expire after grace');
});

test('a join during signaling reconnect preserves the existing instance, peer signaling and audio preferences',async()=>{
  const {app,clock}=lifecycleHarness();
  const previous={instanceId:'existing-call',active:true,members:{b:{sessionId:'session-b',connected:false,disconnectedAt:clock.now}},webrtc:{b:{offer:'retained'}},audioPreferences:{b:{inputVolume:50}}};
  let committed;
  app.callRunTransaction=async(_ref,update)=>{committed=update(previous);return {committed:true,snapshot:{val:()=>committed}};};
  await app.callCommitMembership('room',{code:'a',sessionId:'session-a',connected:true});
  assert.equal(committed.instanceId,'existing-call');
  assert.equal(committed.members.b.sessionId,'session-b');
  assert.equal(committed.webrtc.b.offer,'retained');
  assert.equal(committed.audioPreferences.b.inputVolume,50);
});

test('established call joins transact only the new member and never fetch signaling', async () => {
  const { app, clock } = lifecycleHarness();
  const reads = [], transactions = [];
  const members = { b: { code: 'b', sessionId: 'session-b', connected: true, lastSeenAt: clock.now } };
  const values = { 'calls/room/instanceId': 'existing', 'calls/room/members': members, 'calls/room/startedAt': clock.now, 'calls/room/startedBy': 'b' };
  values['calls/room/audioPreferences/a'] = { users: { b: 275 }, mutedUsers: { b: true } };
  const ref = key => ({ key, child: name => ref(key + '/' + name), once: async () => { reads.push(key); return { val: () => values[key] ?? null }; } });
  app.db = { ref };
  app.callRunTransaction = async (target, update) => {
    transactions.push(target.key);
    values[target.key] = update(null);
    return { committed: true, snapshot: { val: () => values[target.key] } };
  };
  const joined = await app.callCommitMembership('room', { code: 'a', sessionId: 'session-a', connected: true });
  assert.equal(joined.instanceId, 'existing');
  assert.equal(joined.members.b.sessionId, 'session-b');
  assert.equal(joined.members.a.joinConfirmed, true);
  assert.deepEqual(joined.audioPreferences.a, values['calls/room/audioPreferences/a'], 'rejoin restores only the listener preferences');
  assert.deepEqual(transactions, ['calls/room/members/a']);
  assert.ok(reads.every(key => key !== 'calls/room' && !key.includes('/webrtc')));
});

test('a lost renegotiation answer retries without destroying connected audio', async () => {
  const h = harness(), app = h.context.ChatApp;
  app.callMembersCache = [{ code: 'b', sessionId: 'session-b', connected: true }];
  const pc = app.callCreatePeer('b', 'room');
  pc.connectionState = pc.iceConnectionState = 'connected';
  pc.remoteDescription = { type: 'answer', sdp: 'v=0' };
  await app.callSendOffer('b', 'room');
  const abandoned = pc.__pendingOfferId;
  await h.advance(15001);
  assert.equal(app.callPeerMap.get('b'), pc);
  assert.equal(pc.closed, false);
  assert.notEqual(pc.__pendingOfferId, abandoned);
  assert.equal(pc.__audioTx.sender.track.kind, 'audio');
});

test('reconnecting a current peer preserves its watched screen during the grace period', () => {
  const h = harness(), app = h.context.ChatApp;
  const member = { code: 'b', sessionId: 'session-b', connected: false, disconnectedAt: h.clock.now, sharing: true, shareId: 'screen-b' };
  app.callMembersCache = [member];
  app.callPeerMap.set('b', { __peerSessionId: 'session-b', connectionState: 'disconnected', iceConnectionState: 'disconnected' });
  app.callWatchedShareCodes.add('b');
  app.callPruneWatchedShares();
  assert.equal(app.callWatchedShareCodes.has('b'), true);
  h.clock.now += app.CALL_STALE_MEMBER_MS + 1;
  app.callPruneWatchedShares();
  assert.equal(app.callWatchedShareCodes.has('b'), false);
});

test('Connected toast lasts one second and waits for successful group media transport', async () => {
  const h = harness(), app = h.context.ChatApp, notices = [];
  app.showToast = notice => notices.push(notice);
  app.callMembersCache = [{ code: 'b', sessionId: 'session-b', connected: true }];
  const pc = app.callCreatePeer('b', 'room');
  app.callShowConnectivityNotice();
  assert.equal(notices.length, 0, 'Signaling membership alone is not a connected media path');
  pc.connectionState = pc.iceConnectionState = 'connected';
  pc.onconnectionstatechange();
  pc.oniceconnectionstatechange();
  assert.equal(notices.length, 1, 'Duplicate transport events never duplicate the notice');
  assert.equal(notices[0].title, 'Connected');
  assert.equal(notices[0].duration, 1000);
  assert.equal(notices[0].body, undefined);
  app.callConnectivityNoticeShown = false;
  app.currentCallRoomId = null;
  app.callShowConnectivityNotice();
  assert.equal(notices.length, 1, 'A late callback after leaving does not toast');
  app.currentCallRoomId = 'room';
  app.callMembersCache = [];
  app.callPeerMap.clear();
  app.callShowConnectivityNotice();
  assert.equal(notices.length, 2, 'An acknowledged solo call is immediately ready');
});

test('quality uses the selected ICE pair and separate screen/camera counter histories', async () => {
  const h = harness(), app = h.context.ChatApp;
  let tick = 0, screenActive = true;
  const pc = { __screenTx: { mid: '1' }, __cameraTx: { mid: '3' }, getStats: async () => new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'current' }],
    ['current', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: .025, availableOutgoingBitrate: 9000000, localCandidateId: 'relay' }],
    ['obsolete', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: .9, localCandidateId: 'host' }],
    ['relay', { type: 'local-candidate', candidateType: 'relay' }],
    ['host', { type: 'local-candidate', candidateType: 'host' }],
    ['audio', { type: 'inbound-rtp', kind: 'audio', packetsLost: 50 + tick, packetsReceived: 1000 + tick * 99 }],
    ['camera', { type: 'outbound-rtp', kind: 'video', mid: '3', timestamp: h.clock.now, bytesSent: 100 + tick * 125000, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }],
    ...(screenActive ? [['screen', { type: 'outbound-rtp', kind: 'video', mid: '1', timestamp: h.clock.now, bytesSent: 200000 + tick * 250000, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }]] : [])
  ]) };
  await app.callReadPeerStats(pc);
  tick++; h.clock.now += 5000;
  const second = await app.callReadPeerStats(pc);
  assert.equal(second.rttMs, 25, 'Old nominated ICE paths do not paint a healthy new path red');
  assert.equal(second.relay, true);
  assert.equal(second.availableOutgoingBitrate, 9000000);
  assert.equal(second.lossPct, 1, 'Lifetime losses are excluded');
  assert.equal(second.videoBitrate, 600000, 'Camera and screen byte deltas are summed independently');
  assert.deepEqual(Array.from(second.videoStreams, item => [item.source, item.bitrate, item.width, item.height, item.framesPerSecond]), [['camera', 200000, 1280, 720, 30], ['screen', 400000, 1280, 720, 30]]);
  screenActive = false; tick++; h.clock.now += 5000;
  const third = await app.callReadPeerStats(pc);
  assert.equal(third.videoBitrate, 200000, 'Stopping a screen does not reset or inflate camera throughput');
  assert.equal(pc.__outboundVideoSamples.size, 1, 'Ended SSRC samples do not accumulate');
  pc.getStats = async () => { throw Error('Temporary stats failure'); };
  h.clock.now += 5000;
  assert.equal(await app.callReadPeerStats(pc), third, 'A transient API error retains the last measured quality');
});

test('quality polls participant stats concurrently and labels poor/disconnected states honestly', async () => {
  const h = harness(), app = h.context.ChatApp;
  const resolvers = [];
  app.callReadPeerStats = () => new Promise(resolve => resolvers.push(resolve));
  const a = { connectionState: 'connected', iceConnectionState: 'connected' };
  const b = { connectionState: 'connected', iceConnectionState: 'connected' };
  app.callPeerMap = new Map([['b', a], ['c', b]]);
  const pending = app.callUpdateConnectionQuality();
  assert.equal(resolvers.length, 2, 'One slow peer does not delay starting another stats request');
  resolvers.forEach(resolve => resolve({ lossPct: 12, rttMs: 450 }));
  await pending;
  const elements = new Map(['call-menu-status', 'call-menu-quality-dot'].map(id => [id, { dataset: {} }]));
  app.$ = id => elements.get(id);
  app.callSyncMenuStatusDisplay();
  assert.equal(elements.get('call-menu-status').textContent, 'Poor connection');
  assert.match(elements.get('call-menu-quality-dot').className, /poor/);
  a.connectionState = a.iceConnectionState = 'disconnected';
  app.callReadPeerStats = async () => ({ lossPct: 0, rttMs: 20 });
  await app.callUpdateConnectionQuality();
  assert.equal(app.callConnectionQuality.level, 'reconnecting');
  assert.equal(elements.get('call-menu-status').textContent, 'Reconnecting');
  assert.equal(app.callConnectionQuality.detail, 'Recovering the media connection.');
});

test('screens preserve detail, cameras balance motion, and new capture tracks get tuned immediately', async () => {
  const h = harness(), app = h.context.ChatApp;
  app.callMembersCache = [{ code: 'b', sessionId: 'session-b', connected: true }];
  const pc = app.callCreatePeer('b', 'room');
  await Promise.all([pc.__screenTrackPromise, pc.__cameraTrackPromise]);
  const screen = pc.__screenTx.sender, camera = pc.__cameraTx.sender;
  screen.track = new h.Track('video', 'screen-one');
  camera.track = new h.Track('video', 'camera-one');
  await app.callPrimePeerMedia(pc);
  assert.equal(screen.params.degradationPreference, 'maintain-resolution');
  assert.equal(camera.params.degradationPreference, 'balanced');
  for (const sender of [screen, camera]) {
    assert.equal(sender.params.encodings[0].maxFramerate, 30);
    assert.equal(sender.params.encodings[0].maxBitrate, 4000000);
  }
  const writes = screen.parameterWrites;
  await app.callPrimePeerMedia(pc);
  assert.equal(screen.parameterWrites, writes, 'Identical tracks and limits need no extra browser IPC');
  screen.track = new h.Track('video', 'screen-two');
  await app.callPrimePeerMedia(pc);
  assert.equal(screen.parameterWrites, writes + 1, 'A capture replacement cannot inherit a stale tuning cache');
});

test('leaving cancels a pending screen request and a late permission result cannot clear the next request', async () => {
  const h = harness('a'), App = h.context.ChatApp;
  const pending = [];
  App.callGetDisplayMediaFunction = () => () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const oldCapture = App.callToggleShareScreen();
  assert.equal(App.callScreenCapturePending, true);
  App.callStopWebRTC();
  assert.equal(App.callScreenCapturePending, false, 'WebRTC leave teardown releases pending capture immediately');
  App.currentCallRoomId = 'room'; App.callSessionId = 'new-session';
  const newCapture = App.callToggleShareScreen();
  assert.equal(pending.length, 2, 'The new call can request sharing before the old permission response');
  const late = new h.Track('video', 'late-screen');
  pending[0].resolve(new h.Stream([late]));
  await oldCapture;
  assert.equal(late.readyState, 'ended');
  assert.equal(App.callScreenCapturePending, true, 'Old finally cannot clear the newer capture pending flag');
  App.callCancelScreenCapture();
  const second = new h.Track('video', 'canceled-screen');
  pending[1].resolve(new h.Stream([second]));
  await newCapture;
  assert.equal(second.readyState, 'ended');
  assert.equal(App.callSharing, false);
});

test('native screen compatibility retry rearms the same source choice and cancels its ticket', async () => {
  const h = harness('a'), App = h.context.ChatApp;
  const order = [], cancellations = [];
  h.context.chatDesktopCapture = {
    version:1,
    selectSource: async (id, options) => { order.push(['choose', id, options.audio]); return true; },
    cancelSelection: id => cancellations.push(id)
  };
  App.callGetDisplayMediaFunction = () => async () => {
    order.push(['capture']);
    if (order.filter(item => item[0] === 'capture').length === 1) throw Object.assign(new Error('unsupported first hints'), { name:'NotSupportedError' });
    return new h.Stream([]);
  };
  await App.callToggleShareScreen({ sourceId:'screen:chosen:0', shareAudio:true });
  assert.deepEqual(order, [['choose','screen:chosen:0',true],['capture'],['choose','screen:chosen:0',true],['capture']]);
  assert.equal(cancellations.length, 1);
  assert.equal(App.callScreenCapturePending, false);
});

test('a stable-state event cannot publish a new offer before the matching answer is serialized', async () => {
  const h = harness('z'), app = h.context.ChatApp;
  app.callMembersCache = [{ code: 'a', sessionId: 'session-a', connected: true }];
  const pc = app.callCreatePeer('a', 'room');
  let answerPublished = false, queuedOfferCreated = false;
  const setLocal = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = async description => {
    await setLocal(description);
    if (description.type === 'answer') {
      pc.__offerQueued = true;
      pc.onsignalingstatechange();
      await Promise.resolve();
    }
  };
  const createOffer = pc.createOffer.bind(pc);
  pc.createOffer = async options => {
    assert.equal(answerPublished, true, 'SDP answer must reach signaling before a queued offer starts');
    queuedOfferCreated = true;
    return createOffer(options);
  };
  pc.__pendingRemoteOffer = {
    offer: { id: 'remote-offer', type: 'offer', sdp: 'v=0\r\na=ice-ufrag:remote\r\n' },
    ref: { transaction: async () => {} },
    answerRef: { set: async value => { assert.equal(value.type, 'answer'); answerPublished = true; } }
  };
  await app.callDrainRemoteOffers(pc);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  if (pc.__offerPumpPromise) await pc.__offerPumpPromise;
  assert.equal(answerPublished, true);
  assert.equal(queuedOfferCreated, true, 'Queued negotiation resumes after publishing the answer');
});

test('a transient addIceCandidate error retries the candidate instead of losing its only relay path', async () => {
  const h = harness(), app = h.context.ChatApp;
  app.callMembersCache = [{ code: 'b', sessionId: 'session-b', connected: true }];
  const pc = app.callCreatePeer('b', 'room');
  pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:remote\r\n' };
  pc.__pendingCandidates = [{ candidate: 'relay-candidate', usernameFragment: 'remote', __queuedAt: h.clock.now }];
  let attempts = 0;
  pc.addIceCandidate = async value => { if (++attempts === 1) throw Error('Description changed during ICE add'); pc.addedCandidates.push(value); };
  await app.callDrainPendingIce(pc);
  assert.equal(pc.__pendingCandidates.length, 1);
  await h.advance(251);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(pc.addedCandidates.length, 1);
});

test('call quality never averages away a poor participant or calls unmeasured media excellent', async () => {
  const h = harness(), app = h.context.ChatApp;
  const pcs = Array.from({ length: 5 }, (_, index) => ({ connectionState: 'connected', iceConnectionState: 'connected', sample: { lossPct: index ? 0 : 12, rttMs: index ? 20 : 450 } }));
  app.callPeerMap = new Map(pcs.map((pc, index) => [String(index), pc]));
  app.callReadPeerStats = async pc => pc.sample;
  await app.callUpdateConnectionQuality();
  assert.equal(app.callConnectionQuality.level, 'poor');
  assert.equal(app.callConnectionQuality.lossPct, 12);
  assert.equal(app.callConnectionQuality.rttMs, 450);
  assert.match(app.callConnectionQuality.detail, /Worst participant path/);
  for (const pc of pcs) pc.sample = { lossPct: null, rttMs: null, measuredAt: 0 };
  await app.callUpdateConnectionQuality();
  assert.equal(app.callConnectionQuality.level, 'fair');
  assert.equal(app.callGetConnectionPresentation().text, 'Measuring connection…');
  app.callPeerMap.clear();
  app.callMembersCache = [{ code: 'b', sessionId: 'joining-peer', connected: true }];
  await app.callUpdateConnectionQuality();
  assert.equal(app.callConnectionQuality.connecting, true, 'A peer missing from the mesh is not a solo call');
  assert.equal(app.callGetConnectionPresentation().text, 'Connecting…');
  app.callMembersCache = [];
  app.callSignalingConnected = false;
  await app.callUpdateConnectionQuality();
  assert.equal(app.callGetConnectionPresentation().text, 'Reconnecting', 'A disconnected solo session must not claim it is connected');
});

test('quality measures both voice directions and jitter independently of high-volume video counters', async () => {
  const h = harness(), app = h.context.ChatApp;
  let sample = 0;
  const pc = { getStats: async () => new Map([
    ['voice', { type: 'inbound-rtp', kind: 'audio', packetsLost: 0, packetsReceived: 100 + sample * 100, jitter: .004 }],
    ['remote-voice', { type: 'remote-inbound-rtp', kind: 'audio', timestamp: h.clock.now, packetsLost: sample * 20, packetsReceived: 100 + sample * 80, roundTripTime: .260, jitter: .070 }],
    ['screen', { type: 'inbound-rtp', kind: 'video', packetsLost: 0, packetsReceived: 100000 + sample * 100000 }],
    ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: .025 }]
  ]) };
  const first = await app.callReadPeerStats(pc);
  assert.equal(first.lossPct, null, 'The first lifetime counter is not a current loss measurement');
  sample++; h.clock.now += 2100;
  const next = await app.callReadPeerStats(pc);
  assert.equal(next.lossPct, 20, 'Video traffic does not conceal outgoing voice loss');
  assert.equal(next.sendLossPct, 20);
  assert.equal(next.receiveLossPct, 0);
  assert.equal(next.rttMs, 260);
  assert.equal(next.jitterMs, 70);
  assert.equal(next.receivingAudio, true);
});

test('ICE connected while DTLS is still connecting is not a connected media path', () => {
  const policy = harness().context.ChatCallPolicy;
  assert.equal(policy.isConnected({ connectionState: 'connecting', iceConnectionState: 'connected' }), false);
  assert.equal(policy.isConnected({ iceConnectionState: 'completed' }), true, 'Old browsers retain their supported ICE fallback');
});

test('an unresolved autoplay promise cannot prevent another participant from playing', async () => {
  const h = harness(), app = h.context.ChatApp;
  let otherPlayed = false;
  app.callRemoteAudioEls = new Map([
    ['b', { dataset: { peerCode: 'b' }, srcObject: {}, play: () => new Promise(() => {}) }],
    ['c', { dataset: { peerCode: 'c' }, srcObject: {}, play: async () => { otherPlayed = true; } }]
  ]);
  app.callPrepareRemoteAudioElement = async () => {};
  app.callApplyRemoteUserVolume = () => {};
  app.callConnectRemoteWebAudio = () => false;
  const pending = app.callResumeRemoteAudio();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(otherPlayed, true, 'Participants play concurrently, before the blocked promise expires');
  await h.advance(1501);
  assert.equal(await pending, false);
  assert.equal(app.callAudioUnlockRequired, true);
  assert.equal(app.callGetConnectionPresentation().text, 'Enable audio');
});

test('peer creation uses the same server-adjusted clock as call membership observation', async () => {
  const h = harness(), app = h.context.ChatApp;
  h.clock.now = 500000;
  app.firebaseServerTimeOffsetMs = -400000;
  app.callMembersCache = [{ code: 'b', sessionId: 'session-b', connected: true, lastSeenAt: 100000 }];
  await app.callEnsurePeers('room');
  assert.equal(app.callPeerMap.has('b'), true, 'A client clock ahead of the server must not delete a fresh peer');
});

test('mobile interrupted audio contexts resume after the page returns to the foreground', async () => {
  const app = harness().context.ChatApp;
  let resumed = false;
  app.callPlaybackCtx = { state: 'interrupted', resume: async function () { resumed = true; this.state = 'running'; } };
  assert.equal(await app.callResumeRemoteAudio(), true);
  assert.equal(resumed, true);
  assert.equal(app.callAudioUnlockRequired, false);
});

test('join recovery resumes a suspended microphone graph even when its track is live', async () => {
  const app = harness().context.ChatApp;
  let resumed = 0;
  app.callMicCtx = { state: 'interrupted', resume: async function () { resumed++; this.state = 'running'; } };
  assert.equal(app.callGetLiveAudioTrack().readyState, 'live');
  assert.equal(await app.callResumeRemoteAudio({ fromGesture: false }), true);
  assert.equal(resumed, 1);
  assert.equal(app.callAudioUnlockRequired, false);
});

test('blocked microphone processing exposes audio unlock and a subsequent gesture recovers without refreshing', async () => {
  const app = harness().context.ChatApp;
  app.callMicCtx = { state: 'suspended', resume: async () => { throw new Error('gesture required'); } };
  assert.equal(await app.callResumeRemoteAudio(), false);
  assert.equal(app.callAudioUnlockRequired, true);
  app.callMicCtx.resume = async function () { this.state = 'running'; };
  assert.equal(await app.callResumeRemoteAudio({ fromGesture: true }), true);
  assert.equal(app.callAudioUnlockRequired, false);
});

test('media sender health repairs a closed microphone context despite live tracks', async () => {
  const app = harness().context.ChatApp;
  let reason = '';
  app.callMicCtx = { state: 'closed' };
  app.callScheduleMicRecovery = value => { reason = value; };
  await app.callAuditLocalMediaSenders();
  assert.equal(reason, 'microphone-context-closed');
});

test('call heartbeats do not accumulate offline or while a previous lease write is pending', async () => {
  const {context,app}=lifecycleHarness();
  let pulse,finish,writes=0,mirrors=0;
  context.setInterval=callback=>{pulse=callback;return 1;};
  app.callSyncViewerPresence=()=>{mirrors++;return Promise.resolve();};
  app.myCallMemberRef={update:()=>{writes++;return new Promise(resolve=>{finish=resolve;});}};
  app.callSignalingConnected=false;
  app.callStartHeartbeat(); pulse(); pulse();
  assert.equal(writes,0); assert.equal(mirrors,0);
  app.callSignalingConnected=true;
  pulse(); pulse(); pulse();
  assert.equal(writes,1); assert.equal(mirrors,1);
  finish(); await new Promise(resolve=>setImmediate(resolve));
  pulse(); assert.equal(writes,2,'one fresh pulse resumes after the acknowledged write');
  finish(); await new Promise(resolve=>setImmediate(resolve));
});

test('screen zoom changes step exactly at 500 percent in both directions', () => {
  const app = harness().context.ChatApp;
  assert.equal(app.callStepScreenZoom(450, 1), 500);
  assert.equal(app.callStepScreenZoom(500, 1), 600);
  assert.equal(app.callStepScreenZoom(600, -1), 500);
  assert.equal(app.callStepScreenZoom(500, -1), 450);
  assert.equal(app.callStepScreenZoom(100, -1), 100);
  assert.equal(app.callStepScreenZoom(50, -1), 100);
});

test('screen transforms are isolated by source and capture generation', () => {
  const app = harness().context.ChatApp;
  let generation = 'screen-one';
  app.callGetShareId = code => code === 'b' ? generation : 'camera-one';
  const first = app.callScreenTransformState('b');
  Object.assign(first, { percent: 350, x: 80, y: -40 });
  assert.equal(app.callScreenTransformState('b'), first, 'a live generation retains its viewport');
  assert.equal(app.callScreenTransformState('camera:b').percent, 100, 'camera has independent zoom');
  generation = 'screen-two';
  const restarted = app.callScreenTransformState('b');
  assert.equal(restarted.percent, 100);
  assert.equal(restarted.x, 0);
  assert.equal(restarted.y, 0);
  assert.notEqual(restarted, first, 'restarting capture never restores an earlier pan');
  app.callResetScreenZoom();
  assert.equal(app.callScreenTransforms.size, 0, 'leaving a presentation discards all source states');
});

test('multiscreen requires two watched remote sources and the enlarged panel', () => {
  const app = harness().context.ChatApp;
  app.callMembersCache = [{ code: 'b', connected: true, sharing: true, cameraSharing: true, shareId: 'screen', cameraShareId: 'cam' }];
  app.callMenuExpanded = true;
  app.callSharing = true;
  app.callWatchedShareCodes = new Set(['a', 'b']);
  assert.equal(app.callCanMultiView(), false, 'own source never counts');
  app.callWatchedShareCodes.add('camera:b');
  assert.equal(app.callCanMultiView(), true, 'screen plus camera counts');
  app.callMenuExpanded = false;
  assert.equal(app.callCanMultiView(), false);
  app.callMenuExpanded = true;
  app.callMembersCache[0].cameraSharing = false;
  assert.equal(app.callCanMultiView(), false, 'ended camera no longer counts');
});

test('screen pause rejects stale signals and survives a delayed database snapshot', () => {
  const app = harness().context.ChatApp;
  app.callMembersCache = [{ code: 'b', connected: true, sharing: true, shareId: 'screen', sharePaused: false, sharePauseVersion: 0 }];
  app.callRefreshScreenPauseDisplays = () => {};
  app.callReceiveScreenPause('b', { type: 'screen-pause', shareId: 'screen', paused: true, version: 10, frame: 'data:image/jpeg;base64,YQ==' });
  assert.equal(app.callGetScreenPauseState('b').paused, true);
  app.callReceiveScreenPause('b', { type: 'screen-pause', shareId: 'screen', paused: false, version: 9 });
  assert.equal(app.callGetScreenPauseState('b').paused, true);
  app.callMembersCache[0].sharePauseVersion = 11;
  assert.equal(app.callGetScreenPauseState('b').paused, false, 'newer durable resume supersedes direct pause');
  app.callReceiveScreenPause('b', { type: 'screen-pause', shareId: 'old-screen', paused: true, version: 12 });
  assert.equal(app.callGetScreenPauseState('b').paused, false);
});

test('manual pause during slow screen startup survives the initial sharing commit', async () => {
  const h = harness(), app = h.context.ChatApp;
  let finishPeers;
  const gate = new Promise(resolve => { finishPeers = resolve; });
  const track = new h.Track('video', 'screen');
  const stream = new h.Stream([track]);
  app.callGetDisplayMediaFunction = () => () => {};
  app.callRequestDisplayStream = async () => stream;
  app.callEnsurePeers = () => gate;
  app.callPreparePauseCapture = () => {};
  app.callPublishScreenPreview = async () => {};
  app.syncCallControlsUI = () => {};
  const starting = app.callToggleShareScreen();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.callSharing, true, 'local share is available before peer startup completes');
  app.callScreenPaused = true;
  app.callScreenPauseFrame = 'data:image/jpeg;base64,cGF1c2Vk';
  app.callScreenPauseVersion = 123;
  finishPeers();
  await starting;
  const commit = h.writes.find(item => item.value?.sharing === true).value;
  assert.equal(commit.sharePaused, true);
  assert.equal(commit.sharePauseVersion, 123);
  assert.equal(commit.sharePauseFrame, app.callScreenPauseFrame);
});

test('a late fullscreen grant is exited after its screen was closed', async () => {
  const h = harness(), app = h.context.ChatApp;
  let grant, exits = 0;
  const host = { classList: { add() {}, remove() {} }, requestFullscreen: () => new Promise(resolve => { grant = resolve; }) };
  app.$ = id => id === 'call-menu' ? host : null;
  app.renderCallMenu = () => {};
  app.callMenuOpen = true;
  app.callMembersCache = [{ code: 'b', connected: true, sharing: true, shareId: 'screen' }];
  app.callWatchedShareCodes.add('b');
  h.context.document.exitFullscreen = async () => { exits++; h.context.document.fullscreenElement = null; };
  const request = app.callFullscreenShare('b');
  app.callWatchedShareCodes.delete('b');
  app.callExitScreenFullscreen();
  h.context.document.fullscreenElement = host;
  grant(); await request;
  assert.equal(exits, 1);
  assert.equal(h.context.document.fullscreenElement, null);
  assert.equal(app.callFullscreenCode, '');
  assert.equal(app.callScreenZoom, 100);
});
