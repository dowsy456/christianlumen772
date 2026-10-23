(() => {
    "use strict";

    const hostWindow = window.parent !== window ? window.parent : (window.opener || window);
    const launch = hostWindow.__mergePartyLaunchConfig || {
      roomId:"LOCAL",
      activityId:"merge-party",
      activityVersion:"local",
      user:{code:"local-player",username:"Player",displayName:"Player"}
    };
    const $ = (id) => document.getElementById(id);
    const canvas = $("gameCanvas");
    const ctx = canvas.getContext("2d");
    const W = 1080;
    const H = 1920;
    const HELD_Y = 315;
    const FAIL_Y = 1660;
    const TAU = Math.PI * 2;
    const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
    const lerp = (a,b,t) => a + (b-a) * t;
    const ease = (t) => t*t*(3-2*t);
    const fmt = (n) => Math.max(0,Math.round(Number(n)||0)).toLocaleString("en-US");
    let userCode = String(launch.user?.code || "local-player").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,64) || "local-player";
    let bestKey = "merge_party_best_" + userCode;
    let discoveryKey = "merge_party_discoveries_" + userCode;
    const statsKey = "merge_party_daily_best_" + userCode;

    const CONFIG = Object.freeze({
      fixedStep:1/60,
      substeps:2,
      velocityIterations:12,
      positionIterations:6,
      // Measured from the supplied 30 fps drop sequences, normalized to W=1080.
      gravity:650,
      ballFriction:.48,
      wallFriction:.48,
      railRadius:29,
      supportRollingDrag:6,
      restitutionThreshold:140,
      contactSlop:.25,
      maxPositionCorrection:12,
      rollingResistance:.028,
      linearDrag:.012,
      maxSpeed:1450,
      maxOmega:14,
      continuousCollisionDetection:true,
      placementCooldownMs:550,
      mergeContactMs:180,
      sleepAfter:.8,
      comboCloseMs:800,
      wallsDurationMs:30000,
      quakeDurationMs:15000,
      quakePulseMs:1800,
      weights:[.40,.30,.20,.10]
    });

    const TIERS = [
      {id:"blue",name:"Blue",diameter:115.2,color:"#4CCAF7",direct:true,restitution:.025,squish:.34},
      {id:"green",name:"Green",diameter:140.8,color:"#86F875",direct:true,restitution:.024,squish:.33},
      {id:"pink",name:"Pink",diameter:171.2,color:"#DD5EE2",direct:true,restitution:.022,squish:.32},
      {id:"red",name:"Red",diameter:209.6,color:"#FF354C",direct:true,restitution:.02,squish:.31},
      {id:"orange",name:"Orange",diameter:256,color:"#FF9D70",direct:false,restitution:.018,squish:.28},
      {id:"yellow",name:"Yellow",diameter:244,color:"#FFF65A",direct:false,restitution:.018,squish:.29},
      {id:"white",name:"White",diameter:292,color:"#FFFFFF",direct:false,restitution:.015,squish:.26},
      {id:"rainbow",name:"Rainbow",diameter:344,color:"rainbow",direct:false,restitution:.012,squish:.22},
      {id:"double-rainbow",name:"Double Rainbow",diameter:248,color:"double",direct:false,restitution:.018,squish:.29},
      {id:"planet",name:"Planet",diameter:260,color:"planet",direct:false,restitution:.016,squish:.28},
      {id:"animal",name:"Animal",diameter:300,color:"animal",direct:false,restitution:.015,squish:.25},
      {id:"aqua",name:"Aqua",diameter:320,color:"aqua",direct:false,restitution:.014,squish:.24}
    ];
    // Inner tangents, excluding the solid rails. The supplied still's outer
    // cup spans ~65% of its width; including rail thickness here twice used
    // to make the cup roughly 20% too large relative to the characters.
    const BASE_CUP=Object.freeze({topWidth:590,floorWidth:430,wallHeight:380,floorY:1460});
    const BASE_POINTS = [10,20,40,80,160,320,640,1280,2560,5120,10240,20480];
    const COLORS = ["#ef565b","#ff9149","#f7dc49","#60ce6d","#4dbde9","#a56be4"];
    const DOUBLE_VARIANTS = ["heart-blend","jade-hero","aqua-small"];
    const COMBO_LABELS = ["Good!","Great!","Insane!","Supreme!","Wild!","Awesome!","Unreal!","Epic!","Brutal!","Amazing!","Immortal!","Mythical!","Savage!","Monster!","Unreal!","Godlike!"];
    const PLANETS = ["earth","saturn","magma","galaxy"];
    const ANIMALS = ["panda","elephant","lion"];
    const AQUAS = ["shark","octopus","orange-fish"];

    let rngState = ((Date.now() >>> 0) ^ hashText(userCode) ^ 0x9e3779b9) >>> 0;
    function hashText(text){
      let h=2166136261;
      for(let i=0;i<String(text).length;i++){h^=String(text).charCodeAt(i);h=Math.imul(h,16777619)}
      return h>>>0;
    }
    function random(){
      rngState ^= rngState << 13;
      rngState ^= rngState >>> 17;
      rngState ^= rngState << 5;
      return (rngState>>>0)/4294967296;
    }
    function randomBetween(a,b){return a+(b-a)*random()}
    function pick(list){return list[Math.floor(random()*list.length)]}
    function tierOutline(tier){
      return clamp(TIERS[tier].diameter*.065,8,19);
    }
    function physicalRadius(tier){
      return TIERS[tier].diameter/2;
    }
    function tierMass(tier){
      const r=physicalRadius(tier);
      return (r*r)/(physicalRadius(0)*physicalRadius(0));
    }
    function directTier(){
      const r=random();
      let sum=0;
      for(let i=0;i<CONFIG.weights.length;i++){sum+=CONFIG.weights[i];if(r<sum)return i}
      return 3;
    }
    function directTierExcept(excludedTier){
      const excluded=clamp(Number(excludedTier)||0,0,3);
      const total=CONFIG.weights.reduce((sum,weight,index)=>sum+(index===excluded?0:weight),0);
      let r=random()*total;
      for(let i=0;i<CONFIG.weights.length;i++){
        if(i===excluded)continue;
        r-=CONFIG.weights[i];
        if(r<0)return i;
      }
      return excluded===3?2:3;
    }

    let lastDoubleVariant = "";
    function variantForTier(tier){
      if(tier===8){
        const choices=DOUBLE_VARIANTS.filter((value)=>value!==lastDoubleVariant);
        const value=pick(choices);
        lastDoubleVariant=value;
        return value;
      }
      if(tier===9)return pick(PLANETS);
      if(tier===10)return pick(ANIMALS);
      if(tier===11)return pick(AQUAS);
      return TIERS[tier].id;
    }

    let nextEntryId=1;
    let nextBodyId=1;
    let nextMergeId=1;
    let nextActionId=1;
    let nextReservationId=1;
    function makeEntry(tier=directTier()){
      return {
        entryId:nextEntryId++,
        logicalTier:tier,
        visualFamily:TIERS[tier].id,
        cosmeticVariant:variantForTier(tier),
        baseColor:TIERS[tier].color,
        shiny:false,
        shinyReservationId:null,
        shinyReservationIds:[],
        reservationResolved:false,
        faceSeed:Math.floor(random()*1000000)
      };
    }

    function makeBody(entry,x,y,options={}){
      const tier=entry.logicalTier;
      const r=physicalRadius(tier);
      const mass=Number(options.mass)>0?Number(options.mass):tierMass(tier);
      return {
        rigidbodyId:nextBodyId++,
        logicalTier:tier,
        visualFamily:entry.visualFamily,
        cosmeticVariant:entry.cosmeticVariant,
        baseColor:entry.baseColor,
        shiny:!!entry.shiny,
        shinyReservationId:entry.shinyReservationId,
        shinyReservationIds:Array.isArray(entry.shinyReservationIds)?[...entry.shinyReservationIds]:(entry.shinyReservationId?[entry.shinyReservationId]:[]),
        shinyConsumed:false,
        x,y,px:x,py:y,
        vx:Number(options.vx)||0,
        vy:Number(options.vy)||0,
        angle:Number(options.angle)||0,
        omega:Number(options.omega)||0,
        radius:r,
        visibleRadius:(TIERS[tier].diameter-tierOutline(tier))/2,
        outline:tierOutline(tier),
        mass,
        inertia:.5*mass*r*r,
        comboActionId:Number(options.comboActionId)||0,
        mergeTransactionId:null,
        mergeImmuneUntil:Number(options.mergeImmuneUntil)||0,
        colliderEnableAt:Number(options.colliderEnableAt)||0,
        collisionEnabled:!Number(options.colliderEnableAt),
        dead:false,
        destroyAt:0,
        age:0,
        enteredCup:false,
        wallAttachment:null,
        wallReleaseUntil:0,
        outCandidate:false,
        outCandidateAt:0,
        impact:0,
        impactAxis:"y",
        impactUntil:0,
        squeeze:0,
        squeezeX:0,squeezeY:0,impactX:0,impactY:0,shapeSpeed:0,
        bondPartnerId:null,
        squeezeTarget:0,
        squeezeAxis:"y",
        contactCount:0,
        firstContact:false,
        lastAx:0,
        lastAy:0,
        pupilX:0,
        pupilY:0,
        pupilVX:0,
        pupilVY:0,
        blinkAt:simTime+randomBetween(4000,9000),
        blinkStarted:-1,
        sleepTimer:0,
        sleeping:false,
        touched:false,
        onSurface:false,
        bornAt:Number(options.bornAt)||0,
        faceSeed:entry.faceSeed||Math.floor(random()*1000000),
        renderScale:options.renderScale==null?1:Number(options.renderScale)
      };
    }

    function readPersistedBest(){
      try{return Math.max(0,Number(hostWindow.localStorage?.getItem(bestKey))||0)}catch{return 0}
    }
    let bestScore=readPersistedBest();
    let discovered=new Set(["blue","green","pink","red"]);
    try{
      const stored=JSON.parse(hostWindow.localStorage?.getItem(discoveryKey)||"[]");
      if(Array.isArray(stored))stored.forEach((id)=>discovered.add(String(id)));
    }catch{}
    function saveDiscoveries(){
      try{hostWindow.localStorage?.setItem(discoveryKey,JSON.stringify([...discovered]))}catch{}
    }
    function updateAccountPassword(password){
      const next=String(password||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,64);
      if(!next||next===userCode)return;
      const previousBest=bestKey,previousDiscoveries=discoveryKey;
      bestScore=Math.max(bestScore,readPersistedBest());userCode=next;
      bestKey='merge_party_best_'+next;discoveryKey='merge_party_discoveries_'+next;
      if(launch.user)launch.user.code=String(password);
      try{
        hostWindow.localStorage?.setItem(bestKey,String(bestScore));
        hostWindow.localStorage?.setItem(discoveryKey,JSON.stringify([...discovered]));
        hostWindow.localStorage?.removeItem(previousBest);hostWindow.localStorage?.removeItem(previousDiscoveries);
      }catch{}
    }

    let runState="playing";
    let runScore=0;
    let scoreDisplay=0;
    let scorePulse=0;
    let pendingScoreTransfers=0;
    let currentEntry=null;
    let futureQueue=[];
    let shinyReservations=new Map();
    let balls=[];
    let contacts=new Map();
    const impulseCache=new Map();
    let quietTime=0;
    let mergeTransactions=[];
    let effects=[];
    let activeCombo=null;
    let highestRunTier=3;
    let newestDiscovery={tier:-1,until:0};
    let terminalAquaDiscovered=false;
    let currentActionId=0;
    let lastDroppedId=0;
    let revealAfterBodyId=0;
    let queueRevealPending=false;
    let cooldownUntil=0;
    let aimX=540;
    let targetAimX=540;
    let pointerDown=false;
    let activePointerId=null;
    let pointerStartX=0;
    let pointerStartY=0;
    let pointerLastX=0;
    let pointerLastY=0;
    let snipeMode=false;
    let snipeX=540;
    let snipeY=900;
    let snipeTargetId=0;
    let pendingCheckout=false;
    let modalPaused=false;
    // The live run stays in this iframe. The host retains it only in this tab.
    let activityPaused=false;
    let warningPulse=0;
    let cameraBump=0;
    let lastFrame=performance.now();
    let accumulator=0;
    let simTime=0;
    // Combo deadlines use elapsed play time, independent of Snipe slow-motion
    // and the physics catch-up cap. Explicit activity/modal pauses freeze it.
    let comboTime=0;
    let destroyed=false;
    let audioCtx=null;
    let lastImpactAudio=-1000;
    let lastRollAudio=-1000;
    let lastSlideAudio=-1000;
    let announced="";
    let abilityCounts={swap:2,quake:2,walls:2,snipe:2};
    let swapAnimation=null;
    let gameOverAt=0;
    let gameOverBallId=0;

    const cup={
      ...BASE_CUP,
      growth:null,
      growthCount:0,
      pendingGrowths:0,
      growthMilestones:new Set(),
      wallsActive:false,
      wallsProgress:0,
      wallsAnimation:null,
      wallsEndsAt:0,
      quake:null,
      pose:{x:0,angle:0},
      priorSegments:[]
    };

    function announce(text){
      if(text===announced)return;
      announced=text;
      $("liveStatus").textContent=text;
    }
    function persistBest(value){
      try{
        const stored=Math.max(0,Number(hostWindow.localStorage?.getItem(bestKey))||0);
        if(stored>=Number(value))return stored===Number(value);
        hostWindow.localStorage?.setItem(bestKey,String(value));
        return Number(hostWindow.localStorage?.getItem(bestKey))===Number(value);
      }catch{return false}
    }
    function ensureQueue(length=1){
      while(futureQueue.length<length)futureQueue.push(makeEntry());
    }
    function resolveShinyEntry(entry){
      if(!entry?.shiny||entry.reservationResolved)return;
      entry.reservationResolved=true;
      const ids=Array.isArray(entry.shinyReservationIds)&&entry.shinyReservationIds.length?entry.shinyReservationIds:[entry.shinyReservationId];
      ids.filter(Boolean).forEach((id)=>shinyReservations.delete(id));
      showBanner("SHINY!",900,"#fff08a");
      sfx("shiny",1);
    }
    function promoteNext(){
      ensureQueue(1);
      currentEntry=futureQueue.shift();
      resolveShinyEntry(currentEntry);
      ensureQueue(1);
      aimX=clampAim(targetAimX);
    }
    function scheduleShiny(milestoneId){
      ensureQueue(10);
      const free=[];
      for(let idx=0;idx<10;idx++)if(!futureQueue[idx].shiny)free.push(idx);
      const chosen=free.length?free[Math.floor(random()*free.length)]:Math.floor(random()*10);
      const reservationId=nextReservationId++;
      const entry=futureQueue[chosen];
      entry.shiny=true;
      entry.shinyReservationIds=Array.isArray(entry.shinyReservationIds)?entry.shinyReservationIds:[];
      entry.shinyReservationIds.push(reservationId);
      entry.shinyReservationId=entry.shinyReservationIds[0];
      shinyReservations.set(reservationId,{reservationId,milestoneId,entryId:entry.entryId,position:chosen+1});
      return reservationId;
    }

    function discoverTier(tier){
      highestRunTier=Math.max(highestRunTier,tier);
      const id=TIERS[tier].id;
      if(discovered.has(id))return;
      discovered.add(id);
      newestDiscovery={tier,until:simTime+2600};
      saveDiscoveries();
      showBanner("NEW! "+TIERS[tier].name.toUpperCase(),1800,"#7cf0de");
      announce(TIERS[tier].name+" discovered");
    }

    function rawCupGeometry(){
      const halfTop=cup.topWidth/2;
      const halfFloor=cup.floorWidth/2;
      const rimY=cup.floorY-cup.wallHeight;
      const extension=175*cup.wallsProgress;
      const dxPerY=(halfTop-halfFloor)/cup.wallHeight;
      return {
        leftRim:{x:540-halfTop,y:rimY},
        rightRim:{x:540+halfTop,y:rimY},
        leftFloor:{x:540-halfFloor,y:cup.floorY},
        rightFloor:{x:540+halfFloor,y:cup.floorY},
        leftTop:{x:540-halfTop-dxPerY*extension,y:rimY-extension},
        rightTop:{x:540+halfTop+dxPerY*extension,y:rimY-extension}
      };
    }
    function quakePulsePhase(){
      if(!cup.quake)return null;
      const elapsed=simTime-cup.quake.started;
      if(elapsed<0||elapsed>=CONFIG.quakeDurationMs)return null;
      const p=(elapsed%CONFIG.quakePulseMs)/CONFIG.quakePulseMs;
      // A smooth start/end envelope has zero velocity at the boundaries.
      const envelope=ease(clamp(elapsed/900,0,1))*ease(clamp((CONFIG.quakeDurationMs-elapsed)/1200,0,1));
      return{p,envelope,wave:Math.sin(TAU*p),index:Math.floor(elapsed/CONFIG.quakePulseMs)};
    }
    function applyQuakeForces(dt){
      const pulse=quakePulsePhase();
      if(!pulse)return;
      const rimY=cup.floorY-cup.wallHeight-175*cup.wallsProgress;
      for(const body of balls){
        if(body.dead||!body.collisionEnabled||body.outCandidate||body.wallAttachment||body.y+body.radius<rimY)continue;
        if(!body.quakeSupported||body.quakeEpoch!==cup.quake.started)continue;
        const mobility=Math.pow(Math.max(1,body.mass),-.28);
        const centering=clamp((540-body.x)/300,-1,1)*36;
        body.vx+=(pulse.wave*130+centering)*pulse.envelope*mobility*dt;
        if(body.quakeAwaitingLanding||body.quakeGroundedTime<.065||simTime<body.quakeNextJumpAt||pulse.envelope<.2)continue;
        // Each hop spends a real supporting contact. An airborne ball cannot
        // receive another kick, even if it brushes a side rail or its neighbour.
        // Specify hop height, so the slower reference gravity cannot turn
        // an ability impulse into a prolonged launch out of the cup.
        const lift=Math.sqrt(2*CONFIG.gravity*randomBetween(48,72))*mobility*(.65+.35*pulse.envelope);
        body.vy=Math.min(body.vy,(body.quakeSupportVY||0)-lift);
        body.vx=clamp(body.vx*.55+randomBetween(-150,150)*mobility,-245*mobility,245*mobility);
        body.omega=clamp(body.omega+randomBetween(-1.8,1.8)*mobility,-CONFIG.maxOmega,CONFIG.maxOmega);
        body.quakeAwaitingLanding=true;body.quakeLeftSupport=false;
        body.quakeLastJumpAt=simTime;body.quakeJumpCount++;
        body.quakeNextJumpAt=simTime+randomBetween(1450,2050);
        body.quakeSupported=false;body.quakeGroundedTime=0;
        wakeBody(body);
      }
    }
    function updateQuakeContacts(constraints,dt){
      if(!cup.quake)return;
      for(const body of balls){
        if(body.quakeEpoch!==cup.quake.started){
          body.quakeEpoch=cup.quake.started;body.quakeAwaitingLanding=false;
          body.quakeLeftSupport=false;body.quakeGroundedTime=0;
          body.quakeNextJumpAt=simTime+randomBetween(120,650);
          body.quakeLastJumpAt=-Infinity;body.quakeJumpCount=0;body.quakeLandingCount=0;
        }
        body.quakeSupported=false;body.quakeSupportVY=0;
      }
      const support=(body,vy)=>{
        if(body.dead||body.wallAttachment||body.outCandidate)return;
        body.quakeSupported=true;body.quakeSupportVY=vy;
      };
      for(const contact of constraints){
        if(contact.bonded||contact.normalImpulse<=.00001)continue;
        if(!contact.a){
          if(contact.segment?.id==="floor"&&contact.ny<-.55)support(contact.b,contact.svy);
        }else if(contact.ny>.55)support(contact.a,contact.b.vy);
        else if(contact.ny<-.55)support(contact.b,contact.a.vy);
      }
      for(const body of balls){
        if(body.quakeSupported)body.quakeGroundedTime+=dt;
        else{
          body.quakeGroundedTime=0;
          if(body.quakeAwaitingLanding)body.quakeLeftSupport=true;
        }
        if(body.quakeAwaitingLanding&&body.quakeGroundedTime>=.065){
          const landed=body.quakeLeftSupport&&simTime-body.quakeLastJumpAt>100;
          // A tightly packed ball may never lift off; let it try again only
          // after it has stopped pushing upward against its actual support.
          const blocked=simTime-body.quakeLastJumpAt>650&&body.vy>=body.quakeSupportVY-15;
          if(landed||blocked){body.quakeAwaitingLanding=false;body.quakeLandingCount++}
        }
      }
    }
    function cupPose(){
      const pulse=quakePulsePhase();
      if(!pulse)return{x:0,angle:0};
      const motion=pulse.envelope*pulse.wave;
      return{x:3.5*motion,angle:(.12*Math.PI/180)*motion};
    }
    function transformCupPoint(point,pose){
      const ox=540,oy=cup.floorY;
      const x=point.x-ox,y=point.y-oy;
      const c=Math.cos(pose.angle),s=Math.sin(pose.angle);
      return{x:ox+pose.x+x*c-y*s,y:oy+x*s+y*c};
    }
    function cupSegments(){
      const g=rawCupGeometry();
      const pose=cupPose();
      cup.pose=pose;
      const lt=transformCupPoint(g.leftTop,pose);
      const lf=transformCupPoint(g.leftFloor,pose);
      const rf=transformCupPoint(g.rightFloor,pose);
      const rt=transformCupPoint(g.rightTop,pose);
      return[
        {id:"left",a:lt,b:lf},
        {id:"floor",a:lf,b:rf},
        {id:"right",a:rf,b:rt}
      ];
    }
    function worldViewTransform(){
      const segments=cup.priorSegments.length?cup.priorSegments:cupSegments();
      const points=segments.flatMap((segment)=>[segment.a,segment.b]);
      const pivotX=540,pivotY=cup.floorY,railExtent=CONFIG.railRadius*2,margin=30;
      let scale=1;
      for(const point of points){
        const dx=Math.abs(point.x-pivotX)+railExtent;
        if(dx>0)scale=Math.min(scale,(W/2-margin)/dx);
        if(point.y<pivotY)scale=Math.min(scale,(pivotY-margin)/(pivotY-point.y+railExtent));
        if(point.y>pivotY)scale=Math.min(scale,(H-margin-pivotY)/(point.y-pivotY+railExtent));
      }
      return{scale:clamp(scale,.42,1),pivotX,pivotY};
    }
    function applyWorldView(context,view=worldViewTransform()){
      context.translate(view.pivotX,view.pivotY);
      context.scale(view.scale,view.scale);
      context.translate(-view.pivotX,-view.pivotY);
    }
    function worldToScreenPoint(point,view=worldViewTransform()){
      return{x:view.pivotX+(point.x-view.pivotX)*view.scale,y:view.pivotY+(point.y-view.pivotY)*view.scale};
    }
    function screenToWorldPoint(point,view=worldViewTransform()){
      return{x:view.pivotX+(point.x-view.pivotX)/view.scale,y:view.pivotY+(point.y-view.pivotY)/view.scale};
    }
    function updateCup(){
      let controlsChanged=false;
      if(cup.quake){
        const elapsed=simTime-cup.quake.started;
        if(elapsed>=CONFIG.quakeDurationMs){cup.quake=null;cup.pose={x:0,angle:0};controlsChanged=true}
        else{
          const pulseIndex=Math.floor(Math.max(0,elapsed)/CONFIG.quakePulseMs);
          if(pulseIndex>cup.quake.lastPulse){
            cup.quake.lastPulse=pulseIndex;
            sfx("quake",.22);haptic("light");
          }
        }
      }
      if(cup.growth){
        const p=clamp((simTime-cup.growth.started)/450,0,1);
        const e=ease(p);
        cup.topWidth=lerp(cup.growth.from.topWidth,cup.growth.to.topWidth,e);
        cup.floorWidth=lerp(cup.growth.from.floorWidth,cup.growth.to.floorWidth,e);
        cup.wallHeight=lerp(cup.growth.from.wallHeight,cup.growth.to.wallHeight,e);
        cup.floorY=lerp(cup.growth.from.floorY,cup.growth.to.floorY,e);
        if(p>=1){
          cup.growth=null;
          if(cup.pendingGrowths>0){cup.pendingGrowths--;startCupGrowthAnimation()}
        }
      }
      if(cup.wallsActive&&cup.wallsEndsAt&&simTime>=cup.wallsEndsAt&&!cup.wallsAnimation){
        cup.wallsActive=false;
        cup.wallsAnimation={started:simTime,from:cup.wallsProgress,to:0};
        controlsChanged=true;
      }
      if(cup.wallsAnimation){
        const p=clamp((simTime-cup.wallsAnimation.started)/350,0,1);
        cup.wallsProgress=lerp(cup.wallsAnimation.from,cup.wallsAnimation.to,ease(p));
        if(cup.wallsAnimation.to===1)captureRisingWallBalls();
        if(p>=1){cup.wallsProgress=cup.wallsAnimation.to;cup.wallsAnimation=null;controlsChanged=true}
      }
      if(controlsChanged)updateControls();
    }
    function startCupGrowthAnimation(){
      const from={topWidth:cup.topWidth,floorWidth:cup.floorWidth,wallHeight:cup.wallHeight,floorY:cup.floorY};
      cup.growth={
        started:simTime,
        from,
        to:{
          topWidth:from.topWidth*1.035,
          floorWidth:from.floorWidth*1.035,
          wallHeight:from.wallHeight*1.025,
          floorY:from.floorY+2
        }
      };
      cup.growthCount++;
      showBanner("CUP SIZE UP!",1450,"#8ff6f2");
      addBurst(540,cup.floorY-390,"paper",34,"#85f3ef");
      sfx("cup",1);
      haptic("strong");
    }
    function beginCupGrowth(milestoneId){
      if(cup.growthMilestones.has(milestoneId))return;
      cup.growthMilestones.add(milestoneId);
      if(cup.growth)cup.pendingGrowths++;
      else startCupGrowthAnimation();
    }
    function placementLocked(){
      if(runState!=="playing"||modalPaused||activityPaused||pendingCheckout||snipeMode||!currentEntry)return true;
      if(cup.growth||cup.wallsAnimation||swapAnimation)return true;
      if(mergeTransactions.some((tx)=>tx.sourceTier>=7&&!tx.finished))return true;
      if(balls.some((b)=>b.outCandidate&&!b.dead))return true;
      if(simTime<cooldownUntil)return true;
      const heldRadius=physicalRadius(currentEntry.logicalTier);
      // A tall centred pile may reach the release height while another lane is
      // clear. Only the actual aimed spawn volume blocks this placement.
      const held={x:aimX,y:HELD_Y,radius:heldRadius};
      if(balls.some((body)=>!body.dead&&body.collisionEnabled&&pairGeometry(held,body).separation<2))return true;
      return false;
    }
    function extrapolatedWallsAt(y){
      const g=rawCupGeometry();
      const leftDx=g.leftFloor.x-g.leftTop.x;
      const leftDy=g.leftFloor.y-g.leftTop.y||1;
      const rightDx=g.rightFloor.x-g.rightTop.x;
      const rightDy=g.rightFloor.y-g.rightTop.y||1;
      return{
        left:g.leftTop.x+(y-g.leftTop.y)*leftDx/leftDy,
        right:g.rightTop.x+(y-g.rightTop.y)*rightDx/rightDy
      };
    }
    function clampAim(value){
      const segments=cupSegments();
      const left=cupRail(segments[0]).a,right=cupRail(segments[2]).b;
      const r=physicalRadius((currentEntry||futureQueue[0])?.logicalTier||0);
      // The centre can reach the inner part of either rounded wall cap. A
      // small tier-dependent margin keeps the outermost edge out of the lane.
      const margin=clamp(r*.12,7,14);
      return clamp(value,left.x+margin,right.x-margin);
    }

    function beginAction(){
      currentActionId=nextActionId++;
      return currentActionId;
    }
    function tagAllBodies(actionId){
      balls.forEach((b)=>{if(!b.dead)b.comboActionId=actionId});
    }
    function revealQueueOnContact(body){
      if(!body)return;
      body.enteredCup=true;
      if(body.firstContact)return;
      body.firstContact=true;
      if(queueRevealPending&&body.rigidbodyId===revealAfterBodyId){
        queueRevealPending=false;
        revealAfterBodyId=0;
        promoteNext();
        updateControls();
        announce("Next ball ready");
      }
    }
    function dropCurrent(){
      aimX=clampAim(targetAimX);
      if(placementLocked())return false;
      ensureAudio();
      const actionId=beginAction();
      const body=makeBody(currentEntry,aimX,HELD_Y,{comboActionId:actionId});
      body.vx=0;body.omega=0;
      balls.push(body);
      lastDroppedId=body.rigidbodyId;
      cooldownUntil=simTime+CONFIG.placementCooldownMs;
      currentEntry=null;
      queueRevealPending=true;
      revealAfterBodyId=body.rigidbodyId;
      sfx("drop",.7);
      updateControls();
      return true;
    }

    function pairKey(a,b){
      return a.rigidbodyId<b.rigidbodyId?a.rigidbodyId+":"+b.rigidbodyId:b.rigidbodyId+":"+a.rigidbodyId;
    }
    function closestPoint(px,py,a,b){
      const dx=b.x-a.x,dy=b.y-a.y;
      const len2=dx*dx+dy*dy||1;
      const t=clamp(((px-a.x)*dx+(py-a.y)*dy)/len2,0,1);
      return{x:a.x+dx*t,y:a.y+dy*t,t};
    }
    function segmentAtT(segment,t){
      return{x:lerp(segment.a.x,segment.b.x,t),y:lerp(segment.a.y,segment.b.y,t)};
    }
    function segmentBetween(prior,current,t){
      return{
        a:{x:lerp(prior.a.x,current.a.x,t),y:lerp(prior.a.y,current.a.y,t)},
        b:{x:lerp(prior.b.x,current.b.x,t),y:lerp(prior.b.y,current.b.y,t)}
      };
    }
    function bodyShape(body){
      const x=clamp(body.squeezeX||0,0,.55),y=clamp(body.squeezeY||0,0,.55);
      const growth=body.bornAt ? .82+.18*ease(clamp((simTime-body.bornAt)/180,0,1)) : 1;
      // Gel spreads sideways instead of losing area. The supplied Blue landing
      // reaches ~1.45 width / .70 height; the same outline supports collisions.
      const aspect=(1-x)/(1-y);
      return{x:aspect*growth,y:growth/aspect};
    }
    function effectiveRadius(body,nx=0,ny=-1){
      const shape=bodyShape(body);
      return body.radius*Math.hypot(shape.x*nx,shape.y*ny);
    }
    function pairGeometry(a,b){
      const dx=b.x-a.x,dy=b.y-a.y;
      let angle=Math.atan2(dy,dx);
      const sa=bodyShape(a),sb=bodyShape(b);
      if(Math.abs(sa.x-sa.y)<.00001&&Math.abs(sb.x-sb.y)<.00001){
        const distance=Math.hypot(dx,dy),radius=a.radius*sa.x+b.radius*sb.x;
        return{nx:distance?dx/distance:1,ny:distance?dy/distance:0,radius,distance,separation:distance-radius};
      }
      const ax2=(a.radius*sa.x)**2,ay2=(a.radius*sa.y)**2,bx2=(b.radius*sb.x)**2,by2=(b.radius*sb.y)**2;
      // Maximize the separating-axis distance for these world-aligned ellipses.
      // This matches their painted outlines even on a glancing, squashed edge.
      for(let i=0;i<5;i++){
        const c=Math.cos(angle),s=Math.sin(angle);
        let first=-dx*s+dy*c,second=-dx*c-dy*s;
        const ha=Math.sqrt(ax2*c*c+ay2*s*s),hb=Math.sqrt(bx2*c*c+by2*s*s);
        const da=(ay2-ax2)*s*c/ha,db=(by2-bx2)*s*c/hb;
        first-=da+db;second-=(ay2-ax2)*(c*c-s*s)/ha-da*da/ha+(by2-bx2)*(c*c-s*s)/hb-db*db/hb;
        if(second>=-.0001)break;
        const change=clamp(first/second,-.35,.35);angle-=change;
        if(Math.abs(change)<.0001)break;
      }
      const nx=Math.cos(angle),ny=Math.sin(angle);
      const radius=Math.sqrt(ax2*nx*nx+ay2*ny*ny)+Math.sqrt(bx2*nx*nx+by2*ny*ny);
      return{nx,ny,radius,distance:dx*nx+dy*ny,separation:dx*nx+dy*ny-radius};
    }
    function noteCompression(body,key,nx,ny,strength=0,penetration=0){
      if(!body.compressionContacts)body.compressionContacts=new Set();
      const isNew=!body.compressionContacts.has(key);
      if(isNew){body.compressionContacts.add(key);body.contactCount++}
      if(strength>90){
        const compression=TIERS[body.logicalTier].squish*clamp(strength/650,0,1);
        body.impactX=Math.max(body.impactX,compression*nx*nx);
        body.impactY=Math.max(body.impactY,compression*ny*ny);
        if(compression>.10)body.compressionHoldUntil=simTime+100;
      }
    }
    function updateCompression(body,dt){
      if(body.sleeping)return;
      const capacity=TIERS[body.logicalTier].squish;
      body.pressureX=lerp(body.pressureX||0,body.loadX||0,1-Math.exp(-12*dt));
      body.pressureY=lerp(body.pressureY||0,body.loadY||0,1-Math.exp(-12*dt));
      // Ordinary self-weight leaves a round ball. Additional opposing load
      // from other balls creates physical compression. Pointer input never
      // enters this calculation or applies a force to an existing body.
      const loadX=Math.max(0,body.pressureX-.9),loadY=Math.max(0,body.pressureY-1.12);
      const targetX=Math.min(capacity,Math.max(body.impactX,capacity*(1-Math.exp(-loadX/1.8))));
      const targetY=Math.min(capacity,Math.max(body.impactY,capacity*(1-Math.exp(-loadY/1.8))));
      const oldX=body.squeezeX,oldY=body.squeezeY;
      // Damped springs preserve an impact's elastic recovery. The same shape
      // is used for drawing and collision support, including sideways bulge.
      const spring=(value,target,velocity)=>{
        const frequency=target>value?24:16;
        velocity+=(frequency*frequency*(target-value)-1.65*frequency*velocity)*dt;
        const next=clamp(value+velocity*dt,0,capacity);
        return[next,next===0||next===capacity?0:velocity];
      };
      [body.squeezeX,body.squeezeVX]=spring(oldX,targetX,body.squeezeVX||0);
      [body.squeezeY,body.squeezeVY]=spring(oldY,targetY,body.squeezeVY||0);
      body.shapeSpeed=Math.max(Math.abs(oldX-body.squeezeX),Math.abs(oldY-body.squeezeY))/dt;
      body.squeeze=Math.max(body.squeezeX,body.squeezeY);
      body.squeezeAxis=body.squeezeX>body.squeezeY?"x":"y";
      if(simTime>=(body.compressionHoldUntil||0)){
        body.impactX=Math.max(0,body.impactX-dt*capacity/.42);
        body.impactY=Math.max(0,body.impactY-dt*capacity/.42);
      }
    }
    function sweptWallContact(body,current,prior,radius=effectiveRadius(body)){
      if(!CONFIG.continuousCollisionDetection||!prior)return null;
      const travel=Math.hypot(body.x-body.px,body.y-body.py)+Math.max(Math.hypot(current.a.x-prior.a.x,current.a.y-prior.a.y),Math.hypot(current.b.x-prior.b.x,current.b.y-prior.b.y));
      const steps=clamp(Math.ceil(travel/Math.max(2,radius*.3)),4,24);
      const distanceAt=(t)=>{
        const segment=cupRail(segmentBetween(prior,current,t));
        const x=lerp(body.px,body.x,t),y=lerp(body.py,body.y,t);
        const point=closestPoint(x,y,segment.a,segment.b);
        return{distance:Math.hypot(x-point.x,y-point.y)-CONFIG.railRadius,x,y,segment};
      };
      let previousT=0,previous=distanceAt(0);
      if(previous.distance<=radius+.4)return null;
      for(let i=1;i<=steps;i++){
        const t=i/steps,sample=distanceAt(t);
        if(sample.distance<=radius+.4){
          let lo=previousT,hi=t,hit=sample;
          for(let pass=0;pass<8;pass++){
            const mid=(lo+hi)/2,test=distanceAt(mid);
            if(test.distance<=radius+.4){hi=mid;hit=test}else lo=mid;
          }
          return hit;
        }
        previousT=t;previous=sample;
      }
      return null;
    }
    function restitutionFor(body){return TIERS[body.logicalTier].restitution}
    function wakeBody(body){
      body.sleeping=false;
      body.sleepTimer=0;
    }
    function wakeAllBodies(){
      quietTime=0;
      for(const body of balls)wakeBody(body);
    }
    function canMerge(a,b){
      return a!==b&&!a.dead&&!b.dead&&a.logicalTier===b.logicalTier&&a.logicalTier<11;
    }
    // Painting, CCD, containment and aiming share the same solid capsules.
    // Raw segments describe the inner tangent, so the playable floor stays put.
    function cupRail(segment){
      const dx=segment.b.x-segment.a.x,dy=segment.b.y-segment.a.y,len=Math.hypot(dx,dy)||1;
      const outward={x:-dy/len,y:dx/len},r=CONFIG.railRadius;
      return{id:segment.id,a:{x:segment.a.x+outward.x*r,y:segment.a.y+outward.y*r},
        b:{x:segment.b.x+outward.x*r,y:segment.b.y+outward.y*r},outward};
    }
    function wallGeometry(body,segment){
      const rail=cupRail(segment);
      const point=closestPoint(body.x,body.y,rail.a,rail.b);
      const sx=segment.b.x-segment.a.x,sy=segment.b.y-segment.a.y,length=Math.hypot(sx,sy)||1;
      const ix=sy/length,iy=-sx/length;
      const dx=body.x-point.x,dy=body.y-point.y;
      const priorSide=(body.px-point.x)*ix+(body.py-point.y)*iy;
      const interior=point.t>0&&point.t<1&&!body.outCandidate&&
        (dx*ix+dy*iy>=0||priorSide>=CONFIG.railRadius-.5||segment.id==="floor"&&body.enteredCup);
      const lengthFromRail=Math.hypot(dx,dy);
      const distance=(interior?dx*ix+dy*iy:lengthFromRail)-CONFIG.railRadius;
      return{point,distance,nx:interior?ix:lengthFromRail>.0001?dx/lengthFromRail:ix,
        ny:interior?iy:lengthFromRail>.0001?dy/lengthFromRail:iy};
    }
    function wallInverseMass(body){return body&&!body.wallAttachment?1/body.mass:0}
    function wallInverseInertia(body){return body&&!body.wallAttachment?1/body.inertia:0}
    function wallFrame(side,segments=cupSegments()){
      const segment=segments.find((item)=>item.id===side);
      if(!segment)return null;
      const rail=cupRail(segment),floor=side==="left"?rail.b:rail.a,top=side==="left"?rail.a:rail.b;
      const length=Math.hypot(top.x-floor.x,top.y-floor.y)||1;
      return{segment,floor,ux:(top.x-floor.x)/length,uy:(top.y-floor.y)/length,
        nx:-rail.outward.x,ny:-rail.outward.y,length};
    }
    function attachToWall(body,side,segments=cupSegments(),inheritedDepth=0){
      const frame=wallFrame(side,segments);
      if(!frame)return;
      const dx=body.x-frame.floor.x,dy=body.y-frame.floor.y;
      const normalOffset=dx*frame.nx+dy*frame.ny;
      const radius=effectiveRadius(body,frame.nx,frame.ny);
      body.wallAttachment={side,alongDistance:dx*frame.ux+dy*frame.uy,normalOffset,
        depth:clamp((radius+CONFIG.railRadius-normalOffset)/(2*radius),0,1),inheritedDepth};
      body.wallReleaseUntil=0;
      body.outCandidate=false;body.outCandidateAt=0;
      body.vx=body.vy=body.omega=0;
      body.px=body.x;body.py=body.y;
      wakeBody(body);revealQueueOnContact(body);
    }
    function captureRisingWallBalls(){
      if(!cup.wallsActive)return;
      const geometry=rawCupGeometry(),pose=cupPose(),segments=cupSegments();
      const rise=175,dxPerY=(cup.topWidth-cup.floorWidth)/2/cup.wallHeight;
      // Test only the added rail. Its full swept volume is known at activation,
      // so a falling ball is caught at its current position, never catapulted
      // by a rapidly travelling rounded cap.
      const extensions=[
        {id:"left",a:{x:geometry.leftRim.x-dxPerY*rise,y:geometry.leftRim.y-rise},b:geometry.leftRim},
        {id:"right",a:geometry.rightRim,b:{x:geometry.rightRim.x+dxPerY*rise,y:geometry.rightRim.y-rise}}
      ].map((segment)=>({id:segment.id,a:transformCupPoint(segment.a,pose),b:transformCupPoint(segment.b,pose)}));
      for(const body of balls){
        if(body.dead||!body.collisionEnabled||body.wallAttachment||body.mergeTransactionId)continue;
        for(const extension of extensions){
          const rail=cupRail(extension),point=closestPoint(body.x,body.y,rail.a,rail.b);
          // The bottom cap belongs to the original cup and must remain an
          // ordinary soft support; only material above the old rim can pierce.
          const aboveRim=extension.id==="left"?point.t<.999:point.t>.001;
          const dx=body.x-point.x,dy=body.y-point.y,distance=Math.hypot(dx,dy);
          const radius=effectiveRadius(body,distance?dx/distance:1,distance?dy/distance:0);
          if(aboveRim&&distance<radius+CONFIG.railRadius-.2){
            attachToWall(body,extension.id,segments);
            break;
          }
        }
      }
    }
    function releaseWallAttachment(body){
      const attachment=body.wallAttachment;
      if(!attachment)return;
      body.wallAttachment=null;
      body.wallReleaseUntil=simTime+160;
      body.vx=body.vy=body.omega=0;
      body.px=body.x;body.py=body.y;
      // A released outside ball resumes its fall. It is never silently shoved
      // back through a retracting wall or charged with its animation velocity.
      body.outCandidate=attachment.normalOffset<CONFIG.railRadius;
      body.outCandidateAt=body.outCandidate?simTime:0;
      wakeBody(body);impulseCache.clear();
    }
    function syncWallAttachment(body,segments){
      const attachment=body.wallAttachment;
      if(!attachment)return false;
      const frame=wallFrame(attachment.side,segments);
      if(!frame)return false;
      const radius=effectiveRadius(body,frame.nx,frame.ny);
      if(!cup.wallsActive&&attachment.alongDistance>frame.length+radius+CONFIG.railRadius){
        releaseWallAttachment(body);return false;
      }
      if(!cup.wallsActive&&cup.wallsProgress<=.001){releaseWallAttachment(body);return false}
      body.x=frame.floor.x+frame.ux*attachment.alongDistance+frame.nx*attachment.normalOffset;
      body.y=frame.floor.y+frame.uy*attachment.alongDistance+frame.ny*attachment.normalOffset;
      body.px=body.x;body.py=body.y;
      body.vx=body.vy=body.omega=0;
      body.touched=true;body.onSurface=true;
      body.loadX=Math.max(body.loadX||0,2+attachment.depth*6);
      body.impactX=Math.max(body.impactX,TIERS[body.logicalTier].squish*.2);
      body.outCandidate=false;body.outCandidateAt=0;
      return true;
    }
    function inheritWallAttachment(result,a,b){
      const parents=[a,b].filter((body)=>body.wallAttachment);
      if(!parents.length||(!cup.wallsActive&&cup.wallsProgress<=.001))return;
      const source=parents.sort((first,second)=>second.wallAttachment.depth-first.wallAttachment.depth)[0];
      const attachment=source.wallAttachment,segments=cupSegments(),frame=wallFrame(attachment.side,segments);
      const depth=Math.max(...parents.map((body)=>body.wallAttachment.depth));
      const offset=(result.x-frame.floor.x)*frame.nx+(result.y-frame.floor.y)*frame.ny;
      const clearance=effectiveRadius(result,frame.nx,frame.ny)+CONFIG.railRadius-offset+.5;
      // A merge well inside the cup naturally pulls the new centre clear.
      // Shallow embedding permits a little release, deep embedding much less;
      // occupied space can prevent rescue even when the merge is close enough.
      const allowance=result.radius*(.10+.45*(1-depth));
      const oldX=result.x,oldY=result.y;
      let rescued=false;
      if(clearance<=allowance){
        const inward=Math.max(0,clearance);
        for(const along of [0,-result.radius*.12,result.radius*.12]){
          result.x=oldX+frame.nx*inward+frame.ux*along;
          result.y=oldY+frame.ny*inward+frame.uy*along;
          const clearWalls=segments.every((segment)=>{
            const hit=wallGeometry(result,segment);
            return hit.distance>=effectiveRadius(result,hit.nx,hit.ny)-CONFIG.contactSlop;
          });
          const clearBalls=balls.every((body)=>body===result||body===a||body===b||body.dead||!body.collisionEnabled||pairGeometry(result,body).separation>=-CONFIG.contactSlop);
          if(clearWalls&&clearBalls){rescued=true;break}
        }
      }
      result.outCandidate=false;result.outCandidateAt=0;
      if(rescued){
        result.enteredCup=true;
        const outward=result.vx*frame.nx+result.vy*frame.ny;
        if(outward<0){result.vx-=frame.nx*outward;result.vy-=frame.ny*outward}
      }else{
        result.x=oldX;result.y=oldY;
        attachToWall(result,attachment.side,segments,depth);
      }
    }
    function containInCup(body,segments){
      if(body.dead||!body.collisionEnabled||body.outCandidate||body.wallAttachment||simTime<body.wallReleaseUntil)return;
      for(let pass=0;pass<3;pass++){
        let corrected=false;
        for(const segment of segments){
        const hit=wallGeometry(body,segment);
        // Include both end caps: the visible lip is a support surface too.
        const radius=effectiveRadius(body,hit.nx,hit.ny);
        if(hit.distance<radius-CONFIG.contactSlop-.0001){
          const depth=radius-CONFIG.contactSlop-hit.distance;
          corrected=true;
          body.x+=hit.nx*depth;body.y+=hit.ny*depth;
          const inward=body.vx*hit.nx+body.vy*hit.ny;
          if(inward<0){body.vx-=hit.nx*inward;body.vy-=hit.ny*inward}
        }
        }
        if(!corrected)break;
      }
    }
    function impactBall(body,strength,axis){
      if(strength>15)wakeBody(body);
      if(strength<45)return;
      body.impact=Math.max(body.impact,clamp(strength/700,0,.08)*12.5);
      body.impactAxis=axis;
      body.impactUntil=simTime+clamp(100+strength*.08,100,180);
      if(strength>175&&axis==="y"&&simTime-(body.lastLandingFxAt||-100000)>260){
        body.lastLandingFxAt=simTime;
        addVariantLandingFx(body);
      }
      if(strength>175&&simTime-lastImpactAudio>90){
        lastImpactAudio=simTime;
        sfx("impact",clamp(strength/850,.18,.65));
        haptic("light");
        addImpactPuff(body.x,body.y,TIERS[body.logicalTier].color);
      }
    }
    // A contact carries accumulated normal/tangential impulses for the entire
    // substep. Restitution is chosen once, so solver iterations do not bounce a
    // resting stack repeatedly. Friction includes the contact point's spin.
    function makeContact(a,b,nx,ny,options={}){
      const svx=options.svx||0,svy=options.svy||0;
      const rvx=b.vx-(a?a.vx:svx),rvy=b.vy-(a?a.vy:svy);
      const vn=rvx*nx+rvy*ny;
      const restitution=a?Math.min(restitutionFor(a),restitutionFor(b)):restitutionFor(b);
      const key=a?pairKey(a,b):b.rigidbodyId+":"+options.segment.id;
      const cached=impulseCache.get(key);
      return {a,b,nx,ny,...options,key,svx,svy,ra:a?effectiveRadius(a,nx,ny):0,rb:effectiveRadius(b,nx,ny),normalImpulse:0,tangentImpulse:0,cached,
        bounce:vn < -CONFIG.restitutionThreshold?-restitution*vn:0,
        friction:(a?CONFIG.ballFriction:CONFIG.wallFriction)*(1-.8*(cup.agitation||0))};
    }
    function resolveWall(body,segment,prior,dt){
      if(!body.collisionEnabled||body.dead||body.wallAttachment||simTime<body.wallReleaseUntil)return null;
      let geometry=wallGeometry(body,segment),hit=geometry.point;
      const radius=effectiveRadius(body,geometry.nx,geometry.ny);
      let dist=geometry.distance;
      const swept=dist>radius+.5?sweptWallContact(body,segment,prior,radius):null;
      if(swept){
        body.x=swept.x;body.y=swept.y;
        geometry=wallGeometry(body,segment);hit=geometry.point;dist=geometry.distance;
      }else if(dist>radius+.5)return null;
      const nx=geometry.nx,ny=geometry.ny;
      const oldPoint=prior?segmentAtT(cupRail(prior),hit.t):hit,currentPoint=segmentAtT(cupRail(segment),hit.t);
      let svx=(currentPoint.x-oldPoint.x)/dt,svy=(currentPoint.y-oldPoint.y)/dt;
      const speed=Math.hypot(svx,svy);
      if(speed>280){svx=svx/speed*280;svy=svy/speed*280}
      const rimCap=segment.id==="left"?hit.t<.001:segment.id==="right"?hit.t>.999:false;
      const contact=makeContact(null,body,nx,ny,{segment,svx,svy,rimCap});
      const approach=Math.max(0,-((body.vx-svx)*nx+(body.vy-svy)*ny));
      noteCompression(body,"wall:"+segment.id,nx,ny,approach,Math.max(0,radius-dist));
      impactBall(body,approach,Math.abs(nx)>.62?"x":"y");
      body.touched=true;
      if(ny<-.15)body.onSurface=true;
      revealQueueOnContact(body);
      return contact;
    }
    function resolvePair(a,b){
      if(a.dead||b.dead||!a.collisionEnabled||!b.collisionEnabled)return null;
      const key=pairKey(a,b);
      let bond=contacts.get(key);
      const travel=Math.hypot(a.x-a.px,a.y-a.py)+Math.hypot(b.x-b.px,b.y-b.py);
      const shapeA=bodyShape(a),shapeB=bodyShape(b);
      const reach=a.radius*Math.max(shapeA.x,shapeA.y)+b.radius*Math.max(shapeB.x,shapeB.y);
      if(!bond&&Math.hypot(b.x-a.x,b.y-a.y)>reach+travel+1)return null;
      let geometry=pairGeometry(a,b);
      if(!bond&&geometry.separation>.5&&CONFIG.continuousCollisionDetection&&travel>.0001){
        const endA={x:a.x,y:a.y},endB={x:b.x,y:b.y};
        let t=0,hit=false;
        // Conservative advancement tests the deformed outlines along the whole
        // motion segment, including a brief grazing contact between substeps.
        for(let step=0;step<16&&t<=1;step++){
          a.x=lerp(a.px,endA.x,t);a.y=lerp(a.py,endA.y,t);
          b.x=lerp(b.px,endB.x,t);b.y=lerp(b.py,endB.y,t);
          geometry=pairGeometry(a,b);
          if(t===0&&geometry.separation<=.5&&!(runState==="playing"&&canMerge(a,b)&&!a.bondPartnerId&&!b.bondPartnerId)){
            // A resting, unrelated pair moving apart has no entering hit.
            // Rewinding it to its old contact traps positions while spin grows.
            a.x=endA.x;a.y=endA.y;b.x=endB.x;b.y=endB.y;return null;
          }
          if(geometry.separation<=.5){hit=true;break}
          t+=Math.max(.0001,(geometry.separation-.45)/travel);
        }
        if(!hit){a.x=endA.x;a.y=endA.y;b.x=endB.x;b.y=endB.y;return null}
      }
      if(!bond&&geometry.separation>.5)return null;
      const {nx,ny}=geometry,contact=makeContact(a,b,nx,ny);
      const approach=Math.max(0,-((b.vx-a.vx)*nx+(b.vy-a.vy)*ny));
      // A small incoming ball yields more than its heavier support. Matching
      // bodies still share a single weld and cannot rebound apart.
      noteCompression(a,"ball:"+b.rigidbodyId,nx,ny,approach*b.mass/(a.mass+b.mass),Math.max(0,-geometry.separation));
      noteCompression(b,"ball:"+a.rigidbodyId,-nx,-ny,approach*a.mass/(a.mass+b.mass),Math.max(0,-geometry.separation));
      impactBall(a,approach,Math.abs(nx)>.62?"x":"y");
      impactBall(b,approach,Math.abs(nx)>.62?"x":"y");
      a.touched=b.touched=true;
      if(ny>.15)a.onSurface=true;
      if(ny<-.15)b.onSurface=true;
      revealQueueOnContact(a);revealQueueOnContact(b);
      if((a.sleeping||b.sleeping)&&(!a.sleeping||!b.sleeping)&&(approach>2||geometry.separation<-1))wakeAllBodies();
      if(!bond&&runState==="playing"&&canMerge(a,b)&&!a.bondPartnerId&&!b.bondPartnerId){
        bond={key,aId:a.rigidbodyId,bId:b.rigidbodyId,started:simTime,dx:b.x-a.x,dy:b.y-a.y};
        contacts.set(key,bond);a.bondPartnerId=b.rigidbodyId;b.bondPartnerId=a.rigidbodyId;
        wakeAllBodies();
      }
      if(bond){contact.bonded=true;contact.bond=bond;contact.bounce=0}
      return contact;
    }
    function applyContactImpulse(contact,normal,tangent){
      const {a,b,nx,ny}=contact,tx=-ny,ty=nx;
      const ix=nx*normal+tx*tangent,iy=ny*normal+ty*tangent;
      if(a){a.vx-=ix*wallInverseMass(a);a.vy-=iy*wallInverseMass(a);a.omega-=contact.ra*tangent*wallInverseInertia(a)}
      b.vx+=ix*wallInverseMass(b);b.vy+=iy*wallInverseMass(b);b.omega-=contact.rb*tangent*wallInverseInertia(b);
    }
    function solveContactVelocity(contact){
      const {a,b,nx,ny,svx,svy}=contact;
      const invA=a?wallInverseMass(a):0,invB=wallInverseMass(b),invMass=invA+invB;
      if(!invMass)return;
      if(contact.bonded){
        // A weld locks the relative centre velocity in BOTH axes at first
        // touch. Ordinary rolling friction permits orbital sliding and is
        // not a weld. The shared centre still falls and collides normally.
        const ix=(a.vx-b.vx)/invMass,iy=(a.vy-b.vy)/invMass;
        a.vx-=ix*invA;a.vy-=iy*invA;b.vx+=ix*invB;b.vy+=iy*invB;
        contact.normalImpulse+=ix*nx+iy*ny;
        a.omega=b.omega=0;
        return;
      }
      const vn=(b.vx-(a?a.vx:svx))*nx+(b.vy-(a?a.vy:svy))*ny;
      const oldNormal=contact.normalImpulse;
      const normal=oldNormal+(contact.bounce-vn)/invMass;
      contact.normalImpulse=contact.bonded?normal:Math.max(0,normal);
      applyContactImpulse(contact,contact.normalImpulse-oldNormal,0);
      const tx=-ny,ty=nx;
      const vt=(b.vx-(a?a.vx:svx))*tx+(b.vy-(a?a.vy:svy))*ty-(a?a.omega*contact.ra:0)-b.omega*contact.rb;
      const tangentMass=invMass+(a?contact.ra*contact.ra*wallInverseInertia(a):0)+contact.rb*contact.rb*wallInverseInertia(b);
      const limit=contact.bonded?Infinity:contact.friction*Math.max(0,contact.normalImpulse),oldTangent=contact.tangentImpulse;
      contact.tangentImpulse=clamp(oldTangent-vt/tangentMass,-limit,limit);
      applyContactImpulse(contact,0,contact.tangentImpulse-oldTangent);
      // A yielding contact has a finite patch, so it can resist a small
      // rolling torque. A shallow perch holds; a steep/off-centre one slips.
      const invIA=a?wallInverseInertia(a):0,invIB=wallInverseInertia(b);
      const patch=(a?.wallAttachment||b.wallAttachment)?0:(a?.radius||b.radius);
      const soft=Math.min(TIERS[b.logicalTier].squish,a?TIERS[a.logicalTier].squish:1);
      const rocking=1-.88*(cup.agitation||0);
      const rollingPatch=a ? .04+soft*.11 : contact.segment?.id==="floor" ? .018 : 0;
      const rollingLimit=contact.normalImpulse*Math.min(patch,b.radius)*rollingPatch*rocking;
      const oldRolling=contact.rollingImpulse||0;
      const relative=b.omega-(a?a.omega:0);
      contact.rollingImpulse=clamp(oldRolling-relative/(invIA+invIB),-rollingLimit,rollingLimit);
      const torque=contact.rollingImpulse-oldRolling;
      b.omega+=torque*invIB;if(a)a.omega-=torque*invIA;
    }
    function solveContactPosition(contact){
      const {a,b,segment}=contact;
      if(contact.bonded){
        const invA=wallInverseMass(a),invB=wallInverseMass(b),invMass=invA+invB;
        if(!invMass)return;
        const dx=(b.x-a.x-contact.bond.dx)/invMass,dy=(b.y-a.y-contact.bond.dy)/invMass;
        a.x+=dx*invA;a.y+=dy*invA;b.x-=dx*invB;b.y-=dy*invB;
        return;
      }
      const wall=a?null:wallGeometry(b,segment);
      const geometry=a?pairGeometry(a,b):wall;
      const nx=geometry.nx,ny=geometry.ny;
      const penetration=a?-geometry.separation:effectiveRadius(b,nx,ny)-wall.distance;
      // An impact's contracting surface stays on its supporting contact;
      // otherwise a squashed ball hovers, falls again, and squashes twice.
      if(!contact.bonded&&penetration<=CONFIG.contactSlop&&!(contact.followSurface&&penetration<0))return;
      const invA=a?wallInverseMass(a):0,invB=wallInverseMass(b);
      if(!(invA+invB))return;
      const correction=clamp((penetration-(contact.bonded?0:CONFIG.contactSlop))*.6,-CONFIG.maxPositionCorrection,CONFIG.maxPositionCorrection)/(invA+invB);
      if(a){a.x-=nx*correction*invA;a.y-=ny*correction*invA}
      b.x+=nx*correction*invB;b.y+=ny*correction*invB;
    }
    function reconcileContacts(){
      const ready=[...contacts.values()].sort((a,b)=>a.aId-b.aId||a.bId-b.bId);
      for(const contact of ready){
        const a=balls.find((body)=>body.rigidbodyId===contact.aId&&!body.dead);
        const b=balls.find((body)=>body.rigidbodyId===contact.bId&&!body.dead);
        if(!a||!b||!canMerge(a,b)||!a.collisionEnabled||!b.collisionEnabled){clearContactsFor([contact.aId,contact.bId]);continue}
        // Fresh results can glue on first touch, but their birth/growth has a
        // short protected interval before the next contact countdown runs.
        const readyFrom=Math.max(contact.started,a.mergeImmuneUntil||0,b.mergeImmuneUntil||0);
        if(simTime-readyFrom>=CONFIG.mergeContactMs&&!a.mergeTransactionId&&!b.mergeTransactionId)startMerge(a,b);
      }
    }
    function clearContactsFor(ids){
      const set=new Set(ids);
      for(const [key,c] of contacts)if(set.has(c.aId)||set.has(c.bId)){
        contacts.delete(key);
        for(const body of balls)if(body.rigidbodyId===c.aId||body.rigidbodyId===c.bId)body.bondPartnerId=null;
      }
    }
    function startMerge(a,b){
      if(!canMerge(a,b)||a.mergeTransactionId||b.mergeTransactionId)return;
      wakeAllBodies();
      const id=nextMergeId++;
      const totalMass=a.mass+b.mass;
      const center={x:(a.x*a.mass+b.x*b.mass)/totalMass,y:(a.y*a.mass+b.y*b.mass)/totalMass};
      const velocity={x:(a.vx*a.mass+b.vx*b.mass)/totalMass,y:(a.vy*a.mass+b.vy*b.mass)/totalMass};
      const momentum={x:velocity.x*totalMass,y:velocity.y*totalMass};
      const angularMomentum=a.inertia*a.omega+b.inertia*b.omega+
        a.mass*((a.x-center.x)*a.vy-(a.y-center.y)*a.vx)+
        b.mass*((b.x-center.x)*b.vy-(b.y-center.y)*b.vx);
      const actionId=Math.max(a.comboActionId,b.comboActionId,currentActionId)||beginAction();
      a.mergeTransactionId=b.mergeTransactionId=id;
      a.collisionEnabled=b.collisionEnabled=false;
      a.comboActionId=b.comboActionId=actionId;
      const tx={
        id,
        sourceTier:a.logicalTier,
        aId:a.rigidbodyId,
        bId:b.rigidbodyId,
        started:simTime,
        center,
        velocity,
        momentum,
        mass:totalMass,
        angularMomentum,
        actionId,
        shiny:(!a.shinyConsumed&&a.shiny)||(!b.shinyConsumed&&b.shiny),
        sources:[{...a,mergeTransactionId:null,bornAt:0},{...b,mergeTransactionId:null,bornAt:0}],
        created:false,
        sourcesDisabled:false,
        finished:false
      };
      mergeTransactions.push(tx);
      clearContactsFor([a.rigidbodyId,b.rigidbodyId]);
      // Replace both parents with the live result in this same substep. The
      // visual burst/growth may continue, but there is never a collider gap.
      createMergeResult(tx);
      sfx("merge-rise",.45);
    }
    function comboForAction(actionId){
      // A new successful merge can extend a live combo, never revive one whose
      // deadline has passed (including merges committed during checkout).
      finalizeCombo();
      if(!activeCombo){
        activeCombo={actionId,ordinal:0,total:0,shinySteps:0,lastMergeAt:simTime,lastMergeClock:comboTime};
      }
      return activeCombo;
    }
    function comboLabel(ordinal){
      return COMBO_LABELS[Math.min(COMBO_LABELS.length,Math.max(1,ordinal))-1];
    }
    function registerMerge(tx,x,y){
      const combo=comboForAction(tx.actionId);
      const firstOrdinal=combo.ordinal+1;
      const extraStep=tx.shiny?1:0;
      combo.ordinal=firstOrdinal+extraStep;
      combo.lastMergeAt=simTime;
      combo.lastMergeClock=comboTime;
      const points=BASE_POINTS[tx.sourceTier]*combo.ordinal;
      combo.total+=points;
      combo.x=x;combo.y=y;
      showCombo(firstOrdinal,0,x,y);
      if(tx.shiny){
        combo.shinySteps++;
        showCombo(combo.ordinal,105,x,y);
        showBanner("SHINY COMBO +1",950,"#fff089");
        addStarRings(x,y);
        sfx("shiny",1);
      }
      addTextEffect(x,y+22,"+"+fmt(points),Math.min(combo.ordinal,5),tx.shiny?115:0);
      sfx(tx.sourceTier>=7?"high-merge":"merge",clamp(.45+combo.ordinal*.1,.45,1));
      if(tx.sourceTier===11)haptic("strong");else haptic(tx.sourceTier===7?"strong":"medium");
    }
    function showCombo(ordinal,delay=0,x=540,y=cup.floorY-cup.wallHeight){
      effects=effects.filter((effect)=>effect.type!=="combo-label");
      effects.push({type:"combo-label",ordinal,label:comboLabel(ordinal),x,y,started:simTime+delay,life:950});
      announce(comboLabel(ordinal)+" Combo "+ordinal);
    }
    function finalizeCombo(force=false){
      if(!activeCombo)return;
      // Only successful merges reset this play-time deadline. Drops,
      // contacts, rolling and abilities cannot keep it alive; pause freezes it.
      // The tiny tolerance prevents fractional physics steps delaying 800 ms
      // expiry by an extra substep through floating-point rounding.
      if(!force&&comboTime-activeCombo.lastMergeClock+1e-7<CONFIG.comboCloseMs)return;
      const total=activeCombo.total;
      effects=effects.filter((effect)=>effect.type!=="combo-label");
      if(total>0){
        runScore+=total;
        effects=effects.filter((effect)=>effect.type!=="text");
        pendingScoreTransfers++;
        effects.push({type:"combo-total",amount:total,ordinal:activeCombo.ordinal,x:activeCombo.x,y:activeCombo.y,shinySteps:activeCombo.shinySteps,scoreAfter:runScore,started:simTime,life:900,arrived:false});
      }
      activeCombo=null;
    }
    function createMergeResult(tx){
      const a=balls.find((b)=>b.rigidbodyId===tx.aId);
      const b=balls.find((body)=>body.rigidbodyId===tx.bId);
      if(!a||!b||!canMerge(a,b)||tx.created||tx.sourceTier>=11)return;
      a.collisionEnabled=b.collisionEnabled=false;
      a.dead=b.dead=true;
      a.shinyConsumed=b.shinyConsumed=true;
      registerMerge(tx,tx.center.x,tx.center.y);
      addMergeFlourish(tx.center.x,tx.center.y,tx.sourceTier,[...new Set([a.cosmeticVariant,b.cosmeticVariant])]);
      {
        const resultTier=tx.sourceTier+1;
        const entry=makeEntry(resultTier);
        const result=makeBody(entry,tx.center.x,tx.center.y,{
          mass:tierMass(resultTier),
          vx:tx.momentum.x/tx.mass,
          vy:tx.momentum.y/tx.mass,
          comboActionId:tx.actionId,
          mergeImmuneUntil:simTime+120,
          bornAt:simTime,
          renderScale:1
        });
        result.omega=clamp((a.inertia*a.omega+b.inertia*b.omega)/(a.inertia+b.inertia),-CONFIG.maxOmega,CONFIG.maxOmega);
        result.impactY=TIERS[resultTier].squish*.65;
        capVelocity(result);
        result.enteredCup=a.enteredCup||b.enteredCup;
        result.outCandidate=a.outCandidate||b.outCandidate;
        balls.push(result);
        tx.resultId=result.rigidbodyId;
        inheritWallAttachment(result,a,b);
        // Growth can initially overlap a wall/neighbour. Separate positions
        // gently without inventing an explosion impulse or waiting to activate.
        separateMergeResult(result);
        if(resultTier===11)terminalAquaDiscovered=true;
        discoverTier(resultTier);
        if(tx.sourceTier===7){
          beginCupGrowth(tx.id);
          scheduleShiny(tx.id);
          addDoubleRainbowFlourish(tx.center.x,tx.center.y);
          showBanner("DOUBLE RAINBOW!",1700,"#fff08a");
        }
      }
      tx.created=true;
    }
    function updateMergeTransactions(){
      for(const tx of mergeTransactions)if(simTime-tx.started>=260)tx.finished=true;
      mergeTransactions=mergeTransactions.filter((tx)=>!tx.finished);
      balls=balls.filter((b)=>!b.dead);
    }
    function separateMergeResult(result){
      const segments=cup.priorSegments.length?cup.priorSegments:cupSegments();
      for(let pass=0;pass<CONFIG.positionIterations;pass++){
        for(const body of balls){
          if(body.dead||!body.collisionEnabled)continue;
          for(const segment of segments){
            if(body.wallAttachment||simTime<body.wallReleaseUntil)continue;
            const hit=wallGeometry(body,segment);
            if(hit.distance<effectiveRadius(body,hit.nx,hit.ny))solveContactPosition({a:null,b:body,segment,nx:hit.nx,ny:hit.ny});
          }
          if(body===result)continue;
          const dx=body.x-result.x,dy=body.y-result.y,dist=Math.hypot(dx,dy);
          if(pairGeometry(result,body).separation<0)solveContactPosition({a:result,b:body,nx:dist>.0001?dx/dist:1,ny:dist>.0001?dy/dist:0});
        }
      }
      result.px=result.x;result.py=result.y;
      for(const body of balls)containInCup(body,segments);
    }

    function updateExpression(body,dt){
      const ax=(body.vx-body.lastAx)/Math.max(dt,.0001);
      const ay=(body.vy-body.lastAy)/Math.max(dt,.0001);
      body.lastAx=body.vx;body.lastAy=body.vy;
      const c=Math.cos(-body.angle),s=Math.sin(-body.angle);
      const localVx=body.vx*c-body.vy*s;
      const localVy=body.vx*s+body.vy*c;
      const localAx=ax*c-ay*s;
      const localAy=ax*s+ay*c;
      let targetX=clamp(localVx/900,-.22,.22)-clamp(localAx/9000,-.12,.12)-clamp(body.omega/45,-.10,.10);
      let targetY=clamp(localVy/1100,-.13,.18)-clamp(localAy/11000,-.10,.10);
      // Keep the character alive without deforming an unloaded circular body.
      targetX+=Math.sin(simTime*.0012+body.faceSeed)*.025;
      targetY+=Math.cos(simTime*.0016+body.faceSeed)*.012;
      if(body.outCandidate)targetY=.35;
      if(simTime<body.impactUntil)targetY-=.18*body.impact;
      const max=simTime<body.impactUntil?.48:.35;
      const len=Math.hypot(targetX,targetY)||1;
      if(len>max){targetX=targetX/len*max;targetY=targetY/len*max}
      const natural=TAU*10;
      const damping=2*.75*natural;
      body.pupilVX+=(natural*natural*(targetX-body.pupilX)-damping*body.pupilVX)*dt;
      body.pupilVY+=(natural*natural*(targetY-body.pupilY)-damping*body.pupilVY)*dt;
      body.pupilX+=body.pupilVX*dt;
      body.pupilY+=body.pupilVY*dt;
      if(body.blinkStarted<0&&simTime>=body.blinkAt&&!body.mergeTransactionId)body.blinkStarted=simTime;
      if(body.blinkStarted>=0&&simTime-body.blinkStarted>210){
        body.blinkStarted=-1;
        body.blinkAt=simTime+randomBetween(4000,9000);
      }
    }
    function blinkScale(body){
      if(!body||body.mergeTransactionId||body.blinkStarted<0)return 1;
      const t=simTime-body.blinkStarted;
      if(t<70)return lerp(1,.08,t/70);
      if(t<115)return .08;
      if(t<210)return lerp(.08,1,(t-115)/95);
      return 1;
    }
    function capVelocity(body){
      const speed=Math.hypot(body.vx,body.vy);
      if(speed>CONFIG.maxSpeed){body.vx=body.vx/speed*CONFIG.maxSpeed;body.vy=body.vy/speed*CONFIG.maxSpeed}
      body.omega=clamp(body.omega,-CONFIG.maxOmega,CONFIG.maxOmega);
    }
    function updateOutCandidates(){
      const segments=cup.priorSegments.length?cup.priorSegments:cupSegments();
      const tops=[segments[0].a,segments[2].b].sort((a,b)=>a.x-b.x);
      const leftTop=tops[0],rightTop=tops[1];
      const leftCap=cupRail(segments[0]).a,rightCap=cupRail(segments[2]).b;
      const openingYAt=(x)=>lerp(leftTop.y,rightTop.y,clamp((x-leftTop.x)/Math.max(1,rightTop.x-leftTop.x),0,1));
      for(const body of balls){
        if(body.dead||body.mergeTransactionId||body.wallAttachment)continue;
        const openingY=openingYAt(body.x);
        const insideOpening=body.x>leftTop.x+body.radius*.12&&body.x<rightTop.x-body.radius*.12;
        if(!body.enteredCup&&insideOpening&&body.y>openingY+body.radius*.12)body.enteredCup=true;
        const clearedTop=body.y<openingY+body.radius*.58;
        const outside=body.x<leftCap.x-body.radius*.25||body.x>rightCap.x+body.radius*.25;
        const rimSupport=[segments[0],segments[2]].some((segment)=>{
          const hit=wallGeometry(body,segment);
          return hit.ny<-.15&&hit.distance<=effectiveRadius(body,hit.nx,hit.ny)+2;
        });
        if(clearedTop&&outside&&!rimSupport&&!body.outCandidate){
          body.outCandidate=true;
          body.outCandidateAt=simTime;
          showBanner("DON'T DROP IT!",900,"#ff777d");
          sfx("fall",.8);
        }
        if(body.outCandidate&&(rimSupport||body.y<openingY+body.radius&&body.x>leftTop.x+body.radius*.08&&body.x<rightTop.x-body.radius*.08)){
          body.outCandidate=false;body.outCandidateAt=0;
        }
        if(body.outCandidate&&simTime-body.outCandidateAt>80&&body.y+effectiveRadius(body)>=FAIL_Y){
          triggerGameOver(body);
          return;
        }
      }
      warningPulse=balls.some((b)=>b.outCandidate)?1:Math.max(0,warningPulse-.06);
    }
    function physicsStep(dt,advanceComboTime=true){
      if(activityPaused||destroyed)return;
      for(const body of balls)body.renderPrevious={x:body.x,y:body.y,angle:body.angle};
      const subDt=dt/CONFIG.substeps;
      for(let sub=0;sub<CONFIG.substeps;sub++){
        simTime+=subDt*1000;
        if(advanceComboTime)comboTime+=subDt*1000;
        finalizeCombo();
        if(balls.some((body)=>body.dead||body.destroyAt&&simTime>=body.destroyAt)||cup.growth||cup.wallsAnimation||cup.quake)wakeAllBodies();
        updateCup();
        cup.agitation=quakePulsePhase()?.envelope||0;
        if(balls.length&&!contacts.size&&!mergeTransactions.length&&!cup.growth&&!cup.wallsAnimation&&!cup.quake&&balls.every(body=>body.sleeping&&!body.dead&&!body.destroyAt&&!body.wallAttachment)){
          for(const body of balls){body.age+=subDt;updateExpression(body,subDt)}
          continue;
        }
        const prior=cup.priorSegments.length?cup.priorSegments:cupSegments();
        const currentSegments=cupSegments();
        cup.priorSegments=currentSegments.map((s)=>({id:s.id,a:{...s.a},b:{...s.b}}));
        const constraints=[];
        applyQuakeForces(subDt);
        for(const body of balls){
          if(body.destroyAt&&simTime>=body.destroyAt)body.dead=true;
          if(!body.collisionEnabled&&body.colliderEnableAt&&simTime>=body.colliderEnableAt){body.collisionEnabled=true;body.colliderEnableAt=0}
          if(body.dead||!body.collisionEnabled)continue;
          body.touched=false;body.onSurface=false;body.contactCount=0;body.squeezeTarget=0;body.loadX=body.loadY=0;
          if(!body.compressionContacts)body.compressionContacts=new Set();else body.compressionContacts.clear();
          body.px=body.x;body.py=body.y;
          body.age+=subDt;
          if(syncWallAttachment(body,currentSegments))continue;
          if(body.sleeping)continue;
          const beforeVX=body.vx,beforeVY=body.vy;
          body.vy+=CONFIG.gravity*subDt;
          const drag=Math.max(0,1-CONFIG.linearDrag*subDt);
          body.vx*=drag;body.vy*=drag;
          capVelocity(body);
          body.x+=(beforeVX+body.vx)*.5*subDt;
          body.y+=(beforeVY+body.vy)*.5*subDt;
          body.angle+=body.omega*subDt;
        }
        for(const body of balls){
          if(body.dead||!body.collisionEnabled)continue;
          for(let s=0;s<currentSegments.length;s++){
            const contact=resolveWall(body,currentSegments[s],prior[s],subDt);
            if(contact)constraints.push(contact);
          }
        }
        for(const [a,b] of broadphasePairs()){
          const contact=resolvePair(a,b);
          if(contact)constraints.push(contact);
        }
        const activeConstraints=constraints.filter((contact)=>!contact.b.sleeping||(contact.a&&!contact.a.sleeping));
        for(const contact of activeConstraints){
          const cached=contact.cached;
          if(!contact.bonded&&cached&&simTime-cached.at<12&&cached.nx*contact.nx+cached.ny*contact.ny>.98){
            contact.normalImpulse=contact.bonded?cached.normal:Math.max(0,cached.normal);
            contact.tangentImpulse=cached.tangent;
            applyContactImpulse(contact,contact.normalImpulse,contact.tangentImpulse);
          }
        }
        for(let iteration=0;iteration<CONFIG.velocityIterations;iteration++){
          for(const contact of activeConstraints)solveContactVelocity(contact);
        }
        // Soft contacts resist rolling, especially for a small ball perched
        // accurately on a crown. Viscous torque slows drift without pinning a
        // centre or suppressing gravity; a poor placement can still roll off.
        for(const contact of activeConstraints){
          if(contact.bonded||!contact.a)continue;
          const {a,b}=contact;
          if(Math.abs(contact.ny)<.45)continue;
          const invInertia=(a?wallInverseInertia(a):0)+wallInverseInertia(b);
          if(!invInertia)continue;
          const relative=b.omega-(a?a.omega:0);
          const size=clamp(75/Math.min(a?a.radius:b.radius,b.radius),.5,1.3);
          const damping=1-Math.exp(-CONFIG.supportRollingDrag*size*subDt);
          const limit=Math.max(0,contact.normalImpulse)*Math.min(contact.ra||contact.rb,contact.rb)*.16;
          const torque=clamp(-relative*damping/invInertia,-limit,limit);
          b.omega+=torque*wallInverseInertia(b);if(a)a.omega-=torque*wallInverseInertia(a);
        }
        for(const contact of activeConstraints){
          const force=Math.max(0,contact.normalImpulse)/(CONFIG.gravity*subDt);
          for(const body of [contact.a,contact.b])if(body){body.loadX+=force*contact.nx*contact.nx/body.mass;body.loadY+=force*contact.ny*contact.ny/body.mass}
        }
        for(const body of balls)if(!body.dead&&body.collisionEnabled)updateCompression(body,subDt);
        for(const contact of activeConstraints){
          // Preserve a substantial free rebound; only soft landings follow
          // their contracting support patch. bounce is post-restitution speed.
          if(contact.bonded||contact.bounce>45)continue;
          const oldSupport=contact.ra+contact.rb;
          const newSupport=(contact.a?effectiveRadius(contact.a,contact.nx,contact.ny):0)+effectiveRadius(contact.b,contact.nx,contact.ny);
          contact.followSurface=oldSupport-newSupport>.001;
        }
        for(let iteration=0;iteration<CONFIG.positionIterations;iteration++){
          for(const contact of activeConstraints)solveContactPosition(contact);
          // Pair separation can introduce a new wall overlap this iteration.
          for(const body of balls)if(!body.sleeping)containInCup(body,currentSegments);
        }
        impulseCache.clear();
        for(const contact of activeConstraints)impulseCache.set(contact.key,{at:simTime,nx:contact.nx,ny:contact.ny,normal:contact.normalImpulse,tangent:contact.tangentImpulse});
        updateQuakeContacts(constraints,subDt);
        reconcileContacts();
        for(const body of balls){
          if(body.dead)continue;
          if(body.onSurface){
            body.omega*=Math.max(0,1-CONFIG.rollingResistance*subDt*10);
            const floorContact=constraints.find((contact)=>contact.b===body&&!contact.a&&contact.segment?.id==="floor");
            if(floorContact&&!body.sleeping){
              const tx=-floorContact.ny,ty=floorContact.nx;
              const tangent=(body.vx-floorContact.svx)*tx+(body.vy-floorContact.svy)*ty;
              const reduction=Math.sign(tangent)*Math.min(Math.abs(tangent),CONFIG.rollingResistance*CONFIG.gravity*subDt);
              body.vx-=tx*reduction;body.vy-=ty*reduction;
              body.omega-=reduction/floorContact.rb;
            }
            if(Math.abs(body.vx)>55&&simTime-lastRollAudio>270){lastRollAudio=simTime;sfx("roll",.10)}
          }
          updateExpression(body,subDt);
          body.impact=Math.max(0,body.impact-subDt/0.38);
          if(body.bornAt){
            const age=simTime-body.bornAt;
            if(age>=300)body.bornAt=0;
          }
        }
        const living=balls.filter((body)=>!body.dead&&body.collisionEnabled);
        const quiet=living.length>0&&!contacts.size&&!cup.growth&&!cup.wallsAnimation&&!cup.quake&&living.every((body)=>{
          if(!body.touched||Math.hypot(body.vx,body.vy)>2||Math.abs(body.omega)>.035||body.shapeSpeed>.003)return false;
          const supports=constraints.filter((c)=>c.b===body&&c.ny<-.15||c.a===body&&c.ny>.15);
          // Only a shallow slope inside the soft contact patch can rest.
          // Unsupported and steep placements keep simulating their fall.
          return supports.filter(c=>!c.rimCap).length>1||supports.some((c)=>!c.a&&c.segment?.id==="floor")||supports.some((c)=>c.a&&Math.abs(c.nx)<.065);
        });
        quietTime=quiet?quietTime+subDt:0;
        if(quietTime>=CONFIG.sleepAfter){
          for(const body of living){body.sleeping=true;body.vx=body.vy=body.omega=0;body.sleepTimer=quietTime}
          impulseCache.clear();
        }
      }
      updateMergeTransactions();
      aimX=clampAim(targetAimX);
      updateOutCandidates();
      updateEffects(dt);
    }

    function broadphasePairs(){
      // Sweep conservative motion bounds before the expensive ellipse/CCD
      // narrow phase. Keep original body order for deterministic merge ties.
      const bounds=[];
      for(let index=0;index<balls.length;index++){
        const body=balls[index];if(body.dead||!body.collisionEnabled)continue;
        const shape=bodyShape(body),reachX=body.radius*shape.x+1,reachY=body.radius*shape.y+1;
        bounds.push({body,index,minX:Math.min(body.x,body.px)-reachX,maxX:Math.max(body.x,body.px)+reachX,minY:Math.min(body.y,body.py)-reachY,maxY:Math.max(body.y,body.py)+reachY});
      }
      bounds.sort((a,b)=>a.minX-b.minX);
      const pairs=[];
      for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++){
        const a=bounds[i],b=bounds[j];if(b.minX>a.maxX)break;
        if(a.maxY<b.minY||b.maxY<a.minY)continue;
        pairs.push(a.index<b.index?[a,b]:[b,a]);
      }
      pairs.sort((a,b)=>a[0].index-b[0].index||a[1].index-b[1].index);
      return pairs.map(([a,b])=>[a.body,b.body]);
    }

    function triggerGameOver(body){
      if(runState!=="playing")return;
      releasePointer();
      finalizeCombo(true);
      runState="game-over-impact";
      pendingCheckout=false;
      snipeMode=false;
      gameOverAt=simTime;
      gameOverBallId=body.rigidbodyId;
      body.impact=1;body.impactAxis="y";body.impactUntil=simTime+180;body.vy=-Math.abs(body.vy)*.18;
      clearContactsFor(balls.map((ball)=>ball.rigidbodyId));
      for(const tx of mergeTransactions){
        const a=balls.find((item)=>item.rigidbodyId===tx.aId),b=balls.find((item)=>item.rigidbodyId===tx.bId);
        if(a){a.mergeTransactionId=null;a.collisionEnabled=true}
        if(b){b.mergeTransactionId=null;b.collisionEnabled=true}
      }
      mergeTransactions=[];
      cameraBump=28;
      addBurst(body.x,FAIL_Y,"game-over",44,"#ef5360");
      sfx("game-over",1);
      haptic("strong");
      updateControls();
      window.setTimeout(()=>{
        if(runState==="game-over-impact"){runState="game-over";modalPaused=true;showResult("game-over");updateControls()}
      },190);
    }

    function showBanner(text,duration=1200,color="#fff"){
      effects=effects.filter((e)=>e.type!=="banner");
      effects.push({type:"banner",text,color,started:simTime,life:duration});
      announce(text);
    }
    function addTextEffect(x,y,text,level=1,delay=0){
      effects.push({type:"text",x,y,text,level,started:simTime+Math.max(0,Number(delay)||0),life:1000});
      if(level>=4)cameraBump=Math.max(cameraBump,level*2.5);
    }
    function addBurst(x,y,type,count,color){
      for(let i=0;i<count;i++){
        const angle=random()*TAU;
        const speed=randomBetween(90,type==="game-over"?620:430);
        effects.push({type:"particle",kind:type,x,y,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-randomBetween(20,150),size:randomBetween(4,12),rotation:random()*TAU,spin:randomBetween(-7,7),color:i%4===0?"#fff":i%5===0?"#111":color,started:simTime,life:randomBetween(500,1050)});
      }
    }
    function addImpactPuff(x,y,color){
      for(let i=0;i<5;i++)effects.push({type:"particle",kind:"puff",x:x+randomBetween(-10,10),y:y+randomBetween(-5,5),vx:randomBetween(-70,70),vy:randomBetween(-80,-25),size:randomBetween(3,7),rotation:0,spin:0,color:color.startsWith("#")?color:"#fff",started:simTime,life:320});
    }
    function addDoodle(shape,x,y,options={}){
      effects.push({type:"doodle",shape,x,y,vx:Number(options.vx)||0,vy:Number(options.vy)||0,size:Number(options.size)||24,rotation:Number(options.rotation)||0,spin:Number(options.spin)||0,color:options.color||"#fff",accent:options.accent||"#121515",started:simTime+(Number(options.delay)||0),life:Number(options.life)||650});
    }
    function addVariantLandingFx(body){
      const x=body.x,y=body.y+body.radius*.72,v=body.cosmeticVariant;
      if(v==="earth")for(let i=0;i<3;i++)addDoodle("cloud",x+(i-1)*30,y+randomBetween(-8,5),{size:16+4*i,color:"#fff",vx:(i-1)*18,vy:-35,life:480});
      else if(v==="magma")effects.push({type:"ring",x,y,color:"#ff7b32",aspect:.28,started:simTime,life:420,maxRadius:115,line:9});
      else if(v==="panda")for(const side of [-1,1])addDoodle(side<0?"leaf":"paw",x+side*26,y,{size:18,color:side<0?"#70b95a":"#161919",vx:side*30,vy:-50,rotation:side*.5});
      else if(v==="elephant")effects.push({type:"ring",x,y,color:"#d6d9d1",aspect:.25,started:simTime,life:430,maxRadius:125,line:10});
      else if(v==="lion")for(let i=0;i<8;i++){const a=i/8*TAU;effects.push({type:"ink-stroke",x,y,angle:a,color:"#b86b2f",started:simTime,life:430,length:55})}
      else if(v==="shark"){effects.push({type:"ring",x,y,color:"#dffcff",aspect:.32,started:simTime,life:470,maxRadius:135,line:11});for(let i=-1;i<=1;i++)addDoodle("fin",x+i*34,y-4,{size:21,color:i?"#73dcea":"#fff",vx:i*36,vy:-55,rotation:i*.3})}
      else if(v==="octopus"){addDoodle("ink",x,y,{size:35,color:"#5d237f",life:560});for(let i=0;i<4;i++)effects.push({type:"bubble",x:x+randomBetween(-38,38),y:y+randomBetween(-15,10),vx:randomBetween(-40,40),vy:randomBetween(-120,-60),size:randomBetween(7,15),started:simTime,life:600})}
      else if(v==="orange-fish")for(let i=0;i<4;i++)addDoodle("spark",x+(i-1.5)*24,y-randomBetween(0,18),{size:12,color:i%2?"#fff":"#ff9a3d",vx:(i-1.5)*24,vy:-70,life:480});
    }
    function addVariantMergeFx(tier,variant,x,y){
      if(tier===9){
        if(variant==="earth"){for(const color of ["#42cde4","#65d779"])effects.push({type:"ring",x,y,color,started:simTime,life:650,maxRadius:210,line:10})}
        else if(variant==="saturn")effects.push({type:"ring",x,y,color:"#f1c55b",aspect:.35,rotation:-.34,started:simTime,life:720,maxRadius:245,line:14});
        else if(variant==="magma"){effects.push({type:"flash",x,y,started:simTime,life:250});for(let i=0;i<12;i++)effects.push({type:"ink-stroke",x,y,angle:i/12*TAU,color:i%2?"#fff16a":"#ff7138",started:simTime,life:560,length:105})}
        else if(variant==="galaxy"){addDoodle("spiral",x,y,{size:105,color:"#48e4ed",accent:"#eb63dc",life:720});addDoodle("spark",x,y,{size:48,color:"#fff",life:460})}
      }else if(tier===10){
        if(variant==="panda"){addBurst(x,y,"merge",9,"#101313");addBurst(x,y,"merge",8,"#fff");for(let i=0;i<6;i++)addDoodle("leaf",x,y,{size:18,color:"#6fbd58",vx:randomBetween(-150,150),vy:randomBetween(-180,-70),rotation:random()*TAU,spin:randomBetween(-5,5)});tone(185,132,.13,"triangle",.026)}
        else if(variant==="elephant"){effects.push({type:"ring",x,y,color:"#d5d2c7",aspect:.7,started:simTime,life:650,maxRadius:220,line:15});addDoodle("trunk",x,y,{size:100,color:"#8eafbd",life:650});tone(118,78,.22,"sine",.03)}
        else if(variant==="lion"){effects.push({type:"ring",x,y,color:"#d78a34",started:simTime,life:680,maxRadius:250,line:17});for(let i=0;i<11;i++){const a=i/11*TAU;addDoodle("spark",x+Math.cos(a)*55,y+Math.sin(a)*55,{size:15,color:"#f1ad42",vx:Math.cos(a)*120,vy:Math.sin(a)*120,life:560})}tone(102,58,.2,"sawtooth",.026)}
      }else if(tier===11){
        if(variant==="shark")for(let i=-1;i<=1;i++)addDoodle("fin",x,y,{size:55,color:i?"#6ce7ed":"#fff",vx:i*175,vy:-160-Math.abs(i)*35,rotation:i*.5,life:720});
        else if(variant==="octopus"){addDoodle("spiral",x,y,{size:125,color:"#55206f",accent:"#bd6ee7",life:850});for(let i=0;i<9;i++)effects.push({type:"bubble",x:x+randomBetween(-80,80),y:y+randomBetween(-25,35),vx:randomBetween(-90,90),vy:randomBetween(-220,-75),size:randomBetween(8,23),started:simTime,life:900})}
        else if(variant==="orange-fish")for(let i=-3;i<=3;i++)addDoodle("tail",x,y,{size:45,color:i%2?"#fff":"#ff953c",vx:Math.cos(i*.18)*210,vy:i*48-90,rotation:i*.18,life:700});
      }
    }
    function addMergeFlourish(x,y,sourceTier,variants=[]){
      const tier=TIERS[sourceTier+1],radius=tier.diameter/2;
      const color=tier.color.startsWith("#")?tier.color:"#77eadb";
      effects.push({type:"ring",x,y,color,started:simTime,life:340,maxRadius:radius*1.16,line:7});
      for(let i=0;i<6;i++){
        const angle=i*TAU/6;
        effects.push({type:"particle",kind:"merge",x:x+Math.cos(angle)*radius*.7,y:y+Math.sin(angle)*radius*.7,
          vx:Math.cos(angle)*90,vy:Math.sin(angle)*90-75,size:5+i%2*2,color:i%2?color:"#fff",
          rotation:angle,spin:(i%2?1:-1)*2,started:simTime,life:350});
      }
    }
    function addStarRings(x,y){
      for(let i=0;i<3;i++)effects.push({type:"ring",x,y,color:COLORS[i*2],started:simTime+i*70,life:650,maxRadius:180+i*45,line:10});
    }
    function addDoubleRainbowFlourish(x,y){
      effects.push({type:"flash",x,y,started:simTime,life:260});
      effects.push({type:"rainbow-ring",x,y,started:simTime,life:900,direction:1});
      effects.push({type:"rainbow-ring",x,y,started:simTime,life:900,direction:-1});
      for(let i=0;i<24;i++){
        const a=i/24*TAU+randomBetween(-.08,.08);
        effects.push({type:"ink-stroke",x,y,angle:a,color:COLORS[i%COLORS.length],started:simTime,life:720,length:randomBetween(70,165)});
      }
    }
    function updateEffects(dt){
      for(const effect of effects){
        if(effect.type==="particle"||effect.type==="bubble"||effect.type==="doodle"){
          effect.vy+=(effect.type==="particle"?620:-25)*dt;
          effect.x+=effect.vx*dt;effect.y+=effect.vy*dt;
          effect.rotation=(effect.rotation||0)+(effect.spin||0)*dt;
          effect.vx*=Math.pow(.985,dt*60);
        }
        if(effect.type==="combo-total"&&!effect.arrived&&simTime-effect.started>=740){
          effect.arrived=true;
          scoreDisplay=effect.scoreAfter;
          scorePulse=1;
          pendingScoreTransfers=Math.max(0,pendingScoreTransfers-1);
        }
      }
      effects=effects.filter((effect)=>simTime-effect.started<effect.life+150);
      cameraBump=Math.max(0,cameraBump-dt*70);
    }

    function ensureAudio(){
      if(activityPaused)return null;
      try{
        audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();
        if(audioCtx.state==="suspended")void audioCtx.resume();
      }catch{}
      return audioCtx;
    }
    function tone(from,to,duration,type="sine",gain=.035,delay=0){
      const ac=ensureAudio();if(!ac)return;
      const at=ac.currentTime+delay;
      const osc=ac.createOscillator(),amp=ac.createGain();
      osc.type=type;osc.frequency.setValueAtTime(Math.max(30,from),at);osc.frequency.exponentialRampToValueAtTime(Math.max(30,to),at+duration);
      amp.gain.setValueAtTime(.0001,at);amp.gain.exponentialRampToValueAtTime(gain,at+.008);amp.gain.exponentialRampToValueAtTime(.0001,at+duration);
      osc.connect(amp).connect(ac.destination);osc.start(at);osc.stop(at+duration+.02);
    }
    function sfx(name,strength=1){
      const g=.035*clamp(strength,.05,1.2);
      if(name==="slide")tone(150,125,.045,"sine",g*.18);
      else if(name==="drop")tone(410,170,.15,"sine",g);
      else if(name==="impact")tone(125,78,.07,"sine",g);
      else if(name==="roll")tone(310,270,.045,"triangle",g*.16);
      else if(name==="merge-rise")tone(290,470,.11,"sine",g*.65);
      else if(name==="merge"){tone(220,150,.09,"sine",g);tone(520,760,.14,"triangle",g*.72,.025)}
      else if(name==="high-merge"){tone(150,92,.14,"sine",g);tone(390,720,.25,"triangle",g,.015);tone(585,980,.25,"sine",g*.62,.04)}
      else if(name==="shiny"){tone(740,980,.14,"sine",g,0);tone(980,1320,.14,"sine",g,.09);tone(1320,1760,.18,"sine",g,.18)}
      else if(name==="cup"){tone(105,190,.26,"sawtooth",g*.55);tone(260,620,.22,"sine",g,.17)}
      else if(name==="quake"){tone(96,126,.11,"square",g*.28);tone(118,88,.10,"square",g*.22,.10)}
      else if(name==="walls"){tone(210,520,.32,"sawtooth",g*.48);tone(390,710,.16,"triangle",g,.24)}
      else if(name==="aim")tone(850,690,.05,"square",g*.35);
      else if(name==="snipe"){tone(1150,240,.11,"sawtooth",g);tone(220,105,.12,"square",g*.72,.07)}
      else if(name==="aqua"){tone(180,75,.38,"sine",g);tone(760,260,.32,"triangle",g*.65)}
      else if(name==="fall")tone(520,120,.55,"sine",g*.68);
      else if(name==="game-over"){tone(135,44,.48,"sawtooth",g*1.15);tone(80,38,.55,"sine",g,.05)}
      else if(name==="checkout"){tone(430,720,.18,"sine",g);tone(650,1040,.25,"triangle",g,.14)}
      else if(name==="fanfare"){[523,659,784,1047].forEach((f,i)=>tone(f,f*1.04,.24,"triangle",g,i*.16));tone(130,72,.38,"sine",g,.64)}
    }
    function haptic(level){
      try{
        const duration=level==="strong"?55:level==="medium"?28:12;
        navigator.vibrate?.(duration);
      }catch{}
    }

    function roundedRect(c,x,y,w,h,r){
      const rr=Math.min(r,w/2,h/2);
      c.beginPath();c.moveTo(x+rr,y);c.arcTo(x+w,y,x+w,y+h,rr);c.arcTo(x+w,y+h,x,y+h,rr);c.arcTo(x,y+h,x,y,rr);c.arcTo(x,y,x+w,y,rr);c.closePath();
    }
    function markerText(c,text,x,y,size,align="left",fill="#fff",stroke="#121515",line=8){
      c.save();c.font="900 "+size+"px 'Comic Sans MS','Arial Rounded MT Bold','Trebuchet MS',sans-serif";c.textAlign=align;c.textBaseline="middle";c.lineJoin="round";c.strokeStyle=stroke;c.lineWidth=line;c.strokeText(text,x,y);c.fillStyle=fill;c.fillText(text,x,y);c.restore();
    }
    function roughCircle(c,r,seed=1){
      // A stable hand-inked contour: the personality does not crawl while a
      // character rests. Contact deformation is supplied by bodyShape only.
      const phase=(Number(seed)||1)*.173;
      const points=[];
      for(let i=0;i<40;i++){
        const a=i/40*TAU;
        const radius=r*(.984+.010*Math.sin(a*3+phase)+.006*Math.sin(a*5-phase*.7));
        points.push({x:Math.cos(a)*radius,y:Math.sin(a)*radius});
      }
      c.beginPath();
      const last=points[points.length-1],first=points[0];
      c.moveTo((last.x+first.x)/2,(last.y+first.y)/2);
      for(let i=0;i<points.length;i++){
        const p=points[i],next=points[(i+1)%points.length];
        c.quadraticCurveTo(p.x,p.y,(p.x+next.x)/2,(p.y+next.y)/2);
      }
      c.closePath();
    }
    function drawFourPoint(c,x,y,size,color="#fff"){
      c.save();c.translate(x,y);c.fillStyle=color;c.strokeStyle="#121515";c.lineWidth=Math.max(1,size*.12);c.beginPath();c.moveTo(0,-size);c.lineTo(size*.22,-size*.22);c.lineTo(size,0);c.lineTo(size*.22,size*.22);c.lineTo(0,size);c.lineTo(-size*.22,size*.22);c.lineTo(-size,0);c.lineTo(-size*.22,-size*.22);c.closePath();c.fill();c.stroke();c.restore();
    }
    function drawRainbowBody(c,r,time){
      const hue=(time*118)%360;
      c.fillStyle="hsl("+hue+",92%,59%)";c.fillRect(-r,-r,r*2,r*2);
      const glow=c.createRadialGradient(-r*.34,-r*.42,r*.04,0,0,r*1.12);
      glow.addColorStop(0,"rgba(255,255,255,.52)");
      glow.addColorStop(.45,"rgba(255,255,255,.06)");
      glow.addColorStop(1,"rgba(18,21,21,.12)");
      c.fillStyle=glow;c.fillRect(-r,-r,r*2,r*2);
    }
    function drawDoubleRainbowBody(c,r,variant,time){
      const swing=Math.sin(time*1.35)*r*.45;
      let gradient;
      if(variant==="heart-blend"){
        gradient=c.createLinearGradient(-r+swing,-r,r-swing,r);
        gradient.addColorStop(0,"#ff73cf");gradient.addColorStop(.48,"#ca62ed");gradient.addColorStop(1,"#824fe5");
      }else if(variant==="jade-hero"){
        gradient=c.createLinearGradient(-r*.8,-r+swing*.25,r*.9,r-swing*.25);
        gradient.addColorStop(0,"#57df96");gradient.addColorStop(.82,"#46c99f");gradient.addColorStop(1,"#3aa8c8");
      }else{
        gradient=c.createLinearGradient(-r*.8+swing*.2,r,r*.8-swing*.2,-r);
        gradient.addColorStop(0,"#3d9fe5");gradient.addColorStop(.84,"#47c9dd");gradient.addColorStop(1,"#75dc9b");
      }
      c.fillStyle=gradient;c.fillRect(-r,-r,r*2,r*2);
      c.globalAlpha=.14+.06*Math.sin(time*2.4);
      c.fillStyle="#fff";c.beginPath();c.ellipse(swing*.16,-r*.26,r*.92,r*.38,-.35,0,TAU);c.fill();c.globalAlpha=1;
    }
    function drawPlanetBody(c,r,variant,time){
      if(variant==="earth"){
        c.fillStyle="#319ed7";c.fillRect(-r,-r,r*2,r*2);c.fillStyle="#54bb65";
        [[-.34,-.21,.36,.2,.3],[.25,.02,.3,.34,-.2],[-.08,.42,.24,.12,.1]].forEach((q)=>{c.beginPath();c.ellipse(q[0]*r,q[1]*r,q[2]*r,q[3]*r,q[4],0,TAU);c.fill()});
        c.strokeStyle="rgba(255,255,255,.64)";c.lineWidth=r*.055;for(let i=0;i<3;i++){c.beginPath();c.arc(0,0,r*(.62+i*.08),(.2+i*.45)*Math.PI,(.48+i*.45)*Math.PI);c.stroke()}
      }else if(variant==="saturn"){
        c.fillStyle="#dcae58";c.fillRect(-r,-r,r*2,r*2);c.strokeStyle="#f4d990";c.lineWidth=r*.13;
        for(let y=-r*.62;y<r*.7;y+=r*.32){c.beginPath();c.moveTo(-r,y);c.lineTo(r,y+r*.05);c.stroke()}
      }else if(variant==="magma"){
        c.fillStyle="#2d3032";c.fillRect(-r,-r,r*2,r*2);c.strokeStyle="#ff8b32";c.lineWidth=r*.055;c.shadowColor="#ffd052";c.shadowBlur=10+Math.sin(time*3)*4;
        [[-1,-.55,-.2,-.18,.1,.25],[.8,-.8,.2,-.18,.55,.7],[-.8,.68,-.15,.28,.35,1]].forEach((p)=>{c.beginPath();c.moveTo(p[0]*r,p[1]*r);c.lineTo(p[2]*r,p[3]*r);c.lineTo(p[4]*r,p[5]*r);c.stroke()});c.shadowBlur=0;
      }else{
        c.fillStyle="#25224f";c.fillRect(-r,-r,r*2,r*2);c.strokeStyle="#d367dc";c.lineWidth=r*.16;c.beginPath();c.ellipse(0,0,r*.78,r*.3,-.42,0,TAU);c.stroke();c.strokeStyle="#53d9ef";c.lineWidth=r*.07;c.beginPath();c.ellipse(0,0,r*.48,r*.15,-.42,0,TAU);c.stroke();c.fillStyle="#fff";for(let i=0;i<14;i++){const a=(i*2.399+time*.05),rr=r*(.2+(i%7)/9);c.fillRect(Math.cos(a)*rr,Math.sin(a)*rr,3+(i%3),3+(i%3))}
      }
    }
    function drawDecorBehind(c,body,r,time){
      const tier=body.logicalTier,v=body.cosmeticVariant,speed=Math.hypot(body.vx||0,body.vy||0);
      c.strokeStyle="#121515";c.lineWidth=body.outline*.85;c.fillStyle=body.baseColor.startsWith("#")?body.baseColor:"#fff";
      if(tier===9&&v==="saturn"){
        c.save();c.rotate(-.34+Math.sin(time*.35)*.04);c.strokeStyle="#121515";c.lineWidth=r*.23;c.beginPath();c.ellipse(0,0,r*1.28,r*.38,0,Math.PI,TAU);c.stroke();c.strokeStyle="#f4d78d";c.lineWidth=r*.13;c.stroke();c.restore();
      }
      if(tier===10&&v==="panda"){
        c.fillStyle="#171918";[-1,1].forEach((side)=>{c.beginPath();c.arc(side*r*.62,-r*.65,r*.29,0,TAU);c.fill();c.stroke()});
      }
      if(tier===10&&v==="elephant"){
        [-1,1].forEach((side)=>{c.save();c.translate(side*r*.72,-r*.04);c.rotate(side*clamp(body.vy/2400,-.18,.18));c.fillStyle="#8faeb8";c.beginPath();c.ellipse(0,0,r*.43,r*.55,0,0,TAU);c.fill();c.stroke();c.fillStyle="#dc9dab";c.beginPath();c.ellipse(0,0,r*.25,r*.36,0,0,TAU);c.fill();c.restore()});
      }
      if(tier===10&&v==="lion"){
        c.fillStyle="#a96531";for(let i=0;i<18;i++){const a=i/18*TAU,wiggle=Math.sin(time*7+i)*body.impact*r*.025;c.beginPath();c.arc(Math.cos(a)*(r*.86+wiggle),Math.sin(a)*(r*.86+wiggle),r*.25,0,TAU);c.fill();c.stroke()}
      }
      if(tier===11&&v==="shark"){
        c.fillStyle="#6da5b5";c.beginPath();c.moveTo(-r*.25,-r*.88);c.lineTo(0,-r*1.34-clamp(speed/30,0,r*.12));c.lineTo(r*.28,-r*.87);c.closePath();c.fill();c.stroke();
        [-1,1].forEach((side)=>{c.beginPath();c.moveTo(side*r*.66,r*.05);c.lineTo(side*r*1.22,r*.25);c.lineTo(side*r*.67,r*.39);c.closePath();c.fill();c.stroke()});
      }
      if(tier===11&&v==="octopus"){
        c.fillStyle="#b34cb3";for(let i=0;i<8;i++){const x=(i-3.5)*r*.2,lag=clamp(body.lastAx/14000,-.16,.16)*r;c.beginPath();c.ellipse(x-lag,r*.82+Math.abs(i-3.5)*r*.015,r*.18,r*.36,.05*(i-3.5),0,TAU);c.fill();c.stroke()}
      }
      if(tier===11&&v==="orange-fish"){
        const flap=Math.sin(time*(5+speed/100))*r*.16;c.fillStyle="#f17131";c.beginPath();c.moveTo(-r*.82,-r*.22);c.lineTo(-r*1.35,-r*.62+flap);c.lineTo(-r*1.24,0);c.lineTo(-r*1.35,r*.62-flap);c.lineTo(-r*.82,r*.22);c.closePath();c.fill();c.stroke();
      }
    }
    function drawDecorFront(c,body,r,time){
      const tier=body.logicalTier,v=body.cosmeticVariant;
      if(tier===9&&v==="saturn"){
        c.save();c.rotate(-.34+Math.sin(time*.35)*.04);c.strokeStyle="#121515";c.lineWidth=r*.23;c.beginPath();c.ellipse(0,0,r*1.28,r*.38,0,0,Math.PI);c.stroke();c.strokeStyle="#f4d78d";c.lineWidth=r*.13;c.stroke();c.restore();
      }
      if(tier===10&&v==="elephant"){
        c.strokeStyle="#121515";c.lineWidth=r*.21;c.lineCap="round";c.beginPath();c.moveTo(0,r*.12);c.quadraticCurveTo(r*.08,r*.62,-r*.08,r*.82-body.impact*r*.12);c.stroke();c.strokeStyle="#8faeb8";c.lineWidth=r*.13;c.stroke();
        c.fillStyle="#fff";[-1,1].forEach((side)=>{c.beginPath();c.moveTo(side*r*.14,r*.48);c.lineTo(side*r*.27,r*.68);c.lineTo(side*r*.04,r*.56);c.closePath();c.fill();c.strokeStyle="#121515";c.lineWidth=3;c.stroke()});
      }
      if(tier===10&&v==="lion"){
        c.fillStyle="#f5c56a";c.strokeStyle="#121515";c.lineWidth=4;c.beginPath();c.ellipse(0,r*.27,r*.36,r*.27,0,0,TAU);c.fill();c.stroke();c.fillStyle="#35251d";c.beginPath();c.moveTo(-r*.09,r*.14);c.lineTo(r*.09,r*.14);c.lineTo(0,r*.27);c.closePath();c.fill();
      }
      if(tier===11&&v==="orange-fish"){
        c.fillStyle="#ffd08a";c.beginPath();c.ellipse(0,r*.36,r*.7,r*.42,0,0,Math.PI);c.fill();c.strokeStyle="rgba(18,21,21,.45)";c.lineWidth=3;for(let i=0;i<4;i++){c.beginPath();c.arc((-1.5+i)*r*.26,-r*.18,r*.11,.2,2.8);c.stroke()}
      }
      if(tier===9&&v==="earth"){
        c.save();c.strokeStyle="rgba(88,229,244,.66)";c.lineWidth=5;c.beginPath();c.arc(0,0,r+3,0,TAU);c.stroke();c.fillStyle="rgba(255,255,255,.55)";
        for(let i=0;i<3;i++){const a=time*.16+i*TAU/3;c.beginPath();c.ellipse(Math.cos(a)*r*.53,Math.sin(a)*r*.25-r*.05,r*.24,r*.07,a*.15,0,TAU);c.fill()}c.restore();
      }
      if(tier===9&&v==="saturn"){
        for(let i=0;i<3;i++){const a=time*.42+i*TAU/3;drawFourPoint(c,Math.cos(a)*r*1.03,Math.sin(a)*r*.34,5,"#fff3ae")}
      }
      if(tier===9&&v==="magma"){
        c.fillStyle="#ff9a3c";for(let i=0;i<4;i++){const a=time*(.6+i*.07)+i*1.7;c.beginPath();c.arc(Math.cos(a)*r*.78,Math.sin(a)*r*.78,3+i%2,0,TAU);c.fill()}
      }
      if(tier===11&&Math.hypot(body.vx||0,body.vy||0)>360){
        c.strokeStyle="rgba(255,255,255,.78)";c.lineWidth=4;for(let i=0;i<3;i++){c.beginPath();c.arc(-r*(.78+i*.22),r*(.28-i*.17),6+i*3,0,TAU);c.stroke()}
      }
    }
    function drawBodyFill(c,body,r,time){
      const tier=body.logicalTier,v=body.cosmeticVariant;
      if(tier<=6){c.fillStyle=TIERS[tier].color;c.fillRect(-r,-r,r*2,r*2)}
      else if(tier===7)drawRainbowBody(c,r,time);
      else if(tier===8)drawDoubleRainbowBody(c,r,v,time);
      else if(tier===9)drawPlanetBody(c,r,v,time);
      else if(tier===10){
        c.fillStyle=v==="panda"?"#f7f6ef":v==="elephant"?"#8faeb8":"#e9a33d";c.fillRect(-r,-r,r*2,r*2);
        if(v==="panda"){c.fillStyle="#171918";[-1,1].forEach((side)=>{c.beginPath();c.ellipse(side*r*.28,-r*.15,r*.2,r*.3,side*.28,0,TAU);c.fill()})}
      }else{
        c.fillStyle=v==="shark"?"#67a2b5":v==="octopus"?"#b84caf":"#f47c32";c.fillRect(-r,-r,r*2,r*2);
        if(v==="shark"){c.fillStyle="#f7f6ef";c.beginPath();c.ellipse(0,r*.44,r*.78,r*.56,0,0,Math.PI);c.fill()}
        if(v==="orange-fish"){c.fillStyle="#ffc373";c.beginPath();c.ellipse(0,r*.4,r*.75,r*.46,0,0,Math.PI);c.fill()}
      }
      if(body.shiny){
        const sweep=((time%0.8)/0.8)*r*3-r*1.5;
        const grad=c.createLinearGradient(sweep-r*.38,-r,sweep+r*.38,r);
        grad.addColorStop(0,"rgba(255,255,255,0)");grad.addColorStop(.5,"rgba(255,255,255,.72)");grad.addColorStop(1,"rgba(255,255,255,0)");
        c.fillStyle=grad;c.fillRect(-r,-r,r*2,r*2);
      }
    }
    function faceSpec(body){
      const tier=body.logicalTier,v=body.cosmeticVariant;
      const spec={eyeX:.285,eyeY:-.205,eyeW:.235,eyeH:.335,mouth:"smile",pupilScale:1,brows:true};
      if(tier===0){spec.eyeW=.23;spec.eyeH=.34;spec.eyeY=-.20}
      else if(tier===1){spec.eyeX=.28;spec.eyeH=.35}
      else if(tier===2){spec.eyeY=-.18;spec.eyeH=.33}
      else if(tier===3){spec.eyeX=.29;spec.eyeH=.33}
      else if(tier===4){spec.eyeH=.35;spec.eyeY=-.22}
      else if(tier===5){spec.eyeH=.36;spec.eyeY=-.19}
      else if(tier===6){spec.eyeX=.30;spec.eyeW=.245;spec.eyeH=.36}
      else if(tier===7){spec.eyeH=.35}
      else if(tier===8){
        if(v==="heart-blend")spec.heartEyes=true;
        else if(v==="jade-hero"){spec.mouth="smirk";spec.angry=.09}
      }else if(tier===9){spec.mouth=v==="magma"?"open-smile":v==="galaxy"?"o":"smile"}
      else if(tier===10){spec.mouth=v==="lion"?"grin":"smile"}
      else if(tier===11){spec.mouth=v==="shark"?"teeth":v==="orange-fish"?"pucker":"smile"}
      return spec;
    }
    function drawFace(c,body,r,time){
      const spec=faceSpec(body);
      const blink=blinkScale(body);
      const eyeH=Math.max(2,r*spec.eyeH*blink);
      const eyeW=r*spec.eyeW;
      const eyeY=r*spec.eyeY;
      const eyeX=r*spec.eyeX;
      c.lineJoin="round";c.lineCap="round";
      for(const side of [-1,1]){
        c.save();c.translate(side*eyeX,eyeY);c.rotate(side*(spec.angry||0));
        c.fillStyle="#fff";c.strokeStyle="#08090b";c.lineWidth=Math.max(2.7,r*.036);
        if(blink<.24){
          c.beginPath();c.moveTo(-eyeW,eyeH*.3);c.quadraticCurveTo(0,-r*.07,eyeW,eyeH*.3);c.stroke();c.restore();continue;
        }
        c.beginPath();c.ellipse(0,0,eyeW,eyeH,side*.035,0,TAU);c.fill();c.stroke();
        c.save();c.clip();
        if(blink>.22){
          const px=clamp((body.pupilX||0)*eyeW*.75,-eyeW*.19,eyeW*.19)-eyeW*.025;
          const py=eyeH*.17+clamp((body.pupilY||0)*eyeH*.6,-eyeH*.18,eyeH*.13);
          if(spec.heartEyes){
            const size=Math.max(5,eyeW*.56);c.translate(px,py);c.fillStyle="#e93085";c.strokeStyle="#121515";c.lineWidth=Math.max(2,r*.025);c.beginPath();c.moveTo(0,size*.72);c.bezierCurveTo(-size*1.1,-size*.04,-size*.92,-size*.78,-size*.38,-size*.78);c.bezierCurveTo(-size*.1,-size*.78,0,-size*.56,0,-size*.42);c.bezierCurveTo(0,-size*.56,size*.1,-size*.78,size*.38,-size*.78);c.bezierCurveTo(size*.92,-size*.78,size*1.1,-size*.04,0,size*.72);c.closePath();c.fill();c.stroke();
          }else{
            const pupilW=eyeW*.68*spec.pupilScale,pupilH=eyeH*.72*spec.pupilScale;
            c.fillStyle="#08090b";c.beginPath();c.ellipse(px,py,pupilW,pupilH,-.045,0,TAU);c.fill();
            c.fillStyle="#fff";c.beginPath();c.ellipse(px-pupilW*.35,py-pupilH*.5,pupilW*.28,pupilH*.24,-.2,0,TAU);c.fill();
          }
        }
        c.restore();
        c.restore();
      }
      if(spec.brows){
        c.strokeStyle="#08090b";c.lineWidth=Math.max(2.5,r*.034);c.lineCap="round";
        for(const side of [-1,1]){c.beginPath();c.moveTo(side*eyeX-r*.065,-r*.67);c.quadraticCurveTo(side*eyeX,-r*.715,side*eyeX+r*.065,-r*.675);c.stroke()}
      }
      c.strokeStyle="#08090b";c.fillStyle="#08090b";c.lineWidth=Math.max(2.7,r*.035);
      const y=r*.41;
      c.beginPath();
      if(spec.mouth==="worried"){c.arc(0,y+r*.12,r*.18,1.15*Math.PI,1.85*Math.PI);c.stroke()}
      else if(spec.mouth==="smile"){c.moveTo(-r*.105,y);c.quadraticCurveTo(-r*.01,y+r*.055,r*.09,y+r*.012);c.stroke()}
      else if(spec.mouth==="open-smile"||spec.mouth==="wide"){c.fillStyle="#121515";c.beginPath();c.ellipse(0,y,r*(spec.mouth==="wide"?.28:.2),r*(spec.mouth==="wide"?.19:.15),0,0,Math.PI);c.fill();c.stroke();c.fillStyle="#f6909b";c.beginPath();c.ellipse(0,y+r*.08,r*.13,r*.06,0,0,Math.PI);c.fill()}
      else if(spec.mouth==="grin"){c.beginPath();c.arc(0,y-r*.04,r*.25,.04*Math.PI,.96*Math.PI);c.stroke();c.beginPath();c.moveTo(-r*.18,y+r*.08);c.lineTo(r*.18,y+r*.08);c.stroke()}
      else if(spec.mouth==="o"){c.beginPath();c.ellipse(0,y,r*.105,r*(.13+body.impact*.04),0,0,TAU);c.fill()}
      else if(spec.mouth==="wavy"){c.beginPath();c.moveTo(-r*.22,y);c.quadraticCurveTo(-r*.11,y-r*.08,0,y);c.quadraticCurveTo(r*.11,y+r*.08,r*.22,y);c.stroke()}
      else if(spec.mouth==="teeth"){c.fillStyle="#fff";c.beginPath();c.arc(0,y-r*.04,r*.32,0,Math.PI);c.closePath();c.fill();c.stroke();c.lineWidth=2;for(let i=-2;i<=2;i++){c.beginPath();c.moveTo(i*r*.1,y-r*.04);c.lineTo(i*r*.08,y+r*.15);c.stroke()}}
      else if(spec.mouth==="pucker"){c.beginPath();c.arc(0,y,r*.1,0,TAU);c.stroke();c.beginPath();c.moveTo(r*.08,y);c.lineTo(r*.18,y-r*.05);c.stroke()}
      else if(spec.mouth==="smirk"){c.beginPath();c.moveTo(-r*.19,y+r*.02);c.quadraticCurveTo(r*.03,y+r*.12,r*.23,y-r*.08);c.stroke()}
    }
    function mergeRenderScale(body){
      if(!body.mergeTransactionId)return 1;
      const tx=mergeTransactions.find((item)=>item.id===body.mergeTransactionId);
      if(!tx)return 1;
      const elapsed=simTime-tx.started;
      if(elapsed<24)return 1-.04*(elapsed/24);
      if(elapsed<72)return lerp(.96,.22,(elapsed-24)/48);
      return .12;
    }
    function drawBall(c,body,x=body.x,y=body.y,scale=1,preview=false){
      const time=simTime/1000;
      const r=body.visibleRadius;
      const snipeScale=body.destroyAt?clamp((body.destroyAt-simTime)/120,0,1):1;
      const renderScale=(body.renderScale||1)*mergeRenderScale(body)*snipeScale*scale;
      const shape=preview?{x:1,y:1}:bodyShape(body);
      c.save();c.translate(x,y);c.scale(renderScale*shape.x,renderScale*shape.y);c.rotate(body.angle||0);
      drawDecorBehind(c,body,r,time);
      c.save();roughCircle(c,r,body.faceSeed);c.clip();drawBodyFill(c,body,r,time);
      // The source characters have a narrow, colored lower-right cel shadow,
      // rather than a glossy spherical gradient or a second sketch outline.
      if(body.logicalTier<7){
        c.strokeStyle=body.logicalTier===6?"rgba(96,112,128,.12)":"rgba(127,22,61,.16)";
        c.lineWidth=r*.14;c.beginPath();c.arc(-r*.03,-r*.05,r*.955,-.38,Math.PI*.73);c.stroke();
      }
      c.restore();
      roughCircle(c,r,body.faceSeed);c.strokeStyle="#08090b";c.lineJoin="round";c.lineWidth=body.outline;c.stroke();
      if(body.shiny){
        c.strokeStyle="hsla("+((time*90)%360)+",95%,70%,.92)";c.lineWidth=Math.max(5,r*.035);c.beginPath();c.arc(0,0,r-body.outline*.8,0,TAU);c.stroke();
        for(let i=0;i<3;i++){const a=time*1.5+i*TAU/3+body.faceSeed*.01;drawFourPoint(c,Math.cos(a)*(r*.76),Math.sin(a)*(r*.76),r*.075,"#fff7b0")}
      }
      c.fillStyle="rgba(255,255,255,.91)";c.beginPath();c.ellipse(-r*.47,-r*.66,r*.10,r*.06,-.45,0,TAU);c.fill();
      c.globalAlpha*=.84;c.beginPath();c.ellipse(-r*.62,-r*.53,r*.043,r*.037,-.45,0,TAU);c.fill();c.globalAlpha/=.84;
      if(!preview)drawFace(c,body,r,time);
      drawDecorFront(c,body,r,time);
      if(body.logicalTier===8){
        const variantColor=body.cosmeticVariant==="heart-blend"?"#ffc0ed":body.cosmeticVariant==="jade-hero"?"#b8ffd0":"#bcecff";
        c.save();c.globalAlpha=.2+.08*Math.sin(time*3.4+body.faceSeed);c.strokeStyle=variantColor;c.lineWidth=5;c.beginPath();c.arc(0,0,r+3,0,TAU);c.stroke();c.restore();
        const interval=.2+(body.faceSeed%151)/1000,phase=((time+body.faceSeed*.001)%interval)/interval;
        if(phase<.48){const cycle=Math.floor((time+body.faceSeed*.001)/interval),a=((cycle*2.399+body.faceSeed*.01)%TAU);drawFourPoint(c,Math.cos(a)*r*.8,Math.sin(a)*r*.8,8*(1-phase/.48),variantColor)}
      }
      if(snipeMode&&body.logicalTier<=3&&!preview&&body.rigidbodyId===snipeTargetId){
        c.strokeStyle="#4ff9e6";c.lineWidth=12+Math.sin(time*9)*4;c.beginPath();c.arc(0,0,r+13,0,TAU);c.stroke();
      }
      c.restore();
    }

    const paperCanvas=document.createElement("canvas");
    paperCanvas.width=W;paperCanvas.height=H;
    const paperCtx=paperCanvas.getContext("2d");
    function buildPaper(){
      paperCtx.fillStyle="#e2e2d7";paperCtx.fillRect(0,0,W,H);
      for(let x=0,i=0;x<=W;x+=64,i++){paperCtx.strokeStyle="rgba(157,168,189,"+(.22+(i%4)*.018)+")";paperCtx.lineWidth=i%3===0?3.8:3;paperCtx.beginPath();paperCtx.moveTo(x+.5,0);paperCtx.lineTo(x+.5,H);paperCtx.stroke()}
      for(let y=0,i=0;y<=H;y+=64,i++){paperCtx.strokeStyle="rgba(157,168,189,"+(.21+(i%5)*.018)+")";paperCtx.lineWidth=i%4===0?3.8:3;paperCtx.beginPath();paperCtx.moveTo(0,y+.5);paperCtx.lineTo(W,y+.5);paperCtx.stroke()}
      let grain=0x4f1bbcdc;
      for(let i=0;i<1500;i++){grain^=grain<<13;grain^=grain>>>17;grain^=grain<<5;const x=(grain>>>0)%W;grain^=grain<<13;grain^=grain>>>17;grain^=grain<<5;const y=(grain>>>0)%H;paperCtx.fillStyle="rgba(45,49,47,"+(.012+((grain>>>8)%8)/1000)+")";paperCtx.fillRect(x,y,1+(i%2),1)}
    }
    buildPaper();
    let guideCache=null;
    function projectedCupY(x,r){
      const segments=cup.priorSegments.length?cup.priorSegments:cupSegments();
      const key=[x,r,cup.topWidth,cup.floorWidth,cup.wallHeight,cup.floorY,cup.wallsProgress,cup.pose.x,cup.pose.angle].join(":");
      if(guideCache?.key===key)return guideCache.y;
      for(let y=HELD_Y+r+15;y<=cup.floorY;y+=4){
        for(const segment of segments){
          const rail=cupRail(segment),point=closestPoint(x,y,rail.a,rail.b);
          if(Math.hypot(x-point.x,y-point.y)<=r+CONFIG.railRadius){guideCache={key,y};return y}
        }
      }
      guideCache={key,y:cup.floorY-r};return guideCache.y;
    }
    function drawGuide(){
      if(!currentEntry||runState!=="playing"||modalPaused||activityPaused||snipeMode)return;
      const r=physicalRadius(currentEntry.logicalTier);
      let targetY=projectedCupY(aimX,r);
      for(const body of balls){
        if(body.dead||!body.collisionEnabled)continue;
        const dx=aimX-body.x;
        const shape=bodyShape(body),rx=body.radius*shape.x+r,ry=body.radius*shape.y+r;
        if(Math.abs(dx)>=rx)continue;
        const y=body.y-ry*Math.sqrt(Math.max(0,1-dx*dx/(rx*rx)))-r*.05;
        if(y>HELD_Y+r&&y<targetY)targetY=y;
      }
      ctx.save();ctx.setLineDash([13,11]);ctx.lineCap="round";ctx.strokeStyle="rgba(87,91,93,.36)";ctx.lineWidth=4.5;ctx.beginPath();ctx.moveTo(aimX,HELD_Y+r+12);ctx.lineTo(aimX,targetY);ctx.stroke();ctx.strokeStyle="rgba(255,255,255,.93)";ctx.lineWidth=2.8;ctx.stroke();ctx.restore();
    }
    function drawCup(){
      const segments=cup.priorSegments.length?cup.priorSegments:cupSegments();
      const rails=segments.map(cupRail);
      // Join the offset rails before stroking: a single open cup has clean
      // corners, without three overlapping, separately outlined capsules.
      const join=(a,b)=>{
        const ax=a.b.x-a.a.x,ay=a.b.y-a.a.y,bx=b.b.x-b.a.x,by=b.b.y-b.a.y;
        const det=ax*by-ay*bx;
        if(Math.abs(det)<.001)return{x:(a.b.x+b.a.x)/2,y:(a.b.y+b.a.y)/2};
        const t=((b.a.x-a.a.x)*by-(b.a.y-a.a.y)*bx)/det;
        return{x:a.a.x+ax*t,y:a.a.y+ay*t};
      };
      const leftCorner=join(rails[0],rails[1]),rightCorner=join(rails[1],rails[2]);
      const points=[rails[0].a,leftCorner,rightCorner,rails[2].b];
      const trace=()=>{ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y)};
      ctx.save();ctx.lineCap="round";ctx.lineJoin="miter";ctx.miterLimit=3;
      trace();ctx.strokeStyle="#08090b";ctx.lineWidth=CONFIG.railRadius*2;ctx.stroke();
      trace();ctx.strokeStyle="#fffef8";ctx.lineWidth=CONFIG.railRadius*2-7;ctx.stroke();
      trace();ctx.strokeStyle="#08090b";ctx.lineWidth=CONFIG.railRadius*2-15;ctx.stroke();
      const paintedRails=[{a:points[0],b:points[1],outward:rails[0].outward},{a:points[1],b:points[2],outward:rails[1].outward},{a:points[2],b:points[3],outward:rails[2].outward}];
      for(const segment of paintedRails){
        const dx=segment.b.x-segment.a.x,dy=segment.b.y-segment.a.y,len=Math.hypot(dx,dy)||1;
        const nx=segment.outward.x,ny=segment.outward.y;
        const count=Math.floor(len/17);
        ctx.strokeStyle="#fffef8";ctx.lineCap="butt";
        for(let i=1;i<count;i++){
          const t=i/count;
          const x=lerp(segment.a.x,segment.b.x,t),y=lerp(segment.a.y,segment.b.y,t);
          const half=CONFIG.railRadius*.49,slant=8+(i%4)*1.5;
          ctx.lineWidth=3.5+(i%3);
          ctx.beginPath();ctx.moveTo(x-nx*half-dx/len*slant,y-ny*half-dy/len*slant);ctx.lineTo(x+nx*half+dx/len*slant,y+ny*half+dy/len*slant);ctx.stroke();
        }
      }
      if(quakePulsePhase()){
        ctx.strokeStyle="#121515";ctx.lineWidth=8;
        for(const side of [-1,1])for(let i=0;i<3;i++){const x=540+side*(430+i*34),y=950+i*95;ctx.beginPath();ctx.moveTo(x-side*18,y-18);ctx.quadraticCurveTo(x+side*20,y,x-side*10,y+20);ctx.stroke()}
      }
      ctx.restore();
    }
    function drawWallAttachments(){
      const segments=cup.priorSegments.length?cup.priorSegments:cupSegments();
      for(const body of balls){
        if(body.dead||!body.wallAttachment)continue;
        const attachment=body.wallAttachment,frame=wallFrame(attachment.side,segments);
        const shape=bodyShape(body),halfLength=Math.min(42,body.radius*.52);
        const low=Math.max(0,attachment.alongDistance-halfLength);
        const high=Math.min(frame.length,attachment.alongDistance+halfLength);
        if(high<=low)continue;
        // A slim hatched strand passes in front of the jelly at the embedded
        // rail, making the piercing readable without covering its expression.
        ctx.save();ctx.beginPath();ctx.ellipse(body.x,body.y,body.visibleRadius*shape.x,body.visibleRadius*shape.y,0,0,TAU);ctx.clip();
        ctx.lineCap="round";ctx.beginPath();
        ctx.moveTo(frame.floor.x+frame.ux*low,frame.floor.y+frame.uy*low);
        ctx.lineTo(frame.floor.x+frame.ux*high,frame.floor.y+frame.uy*high);
        ctx.strokeStyle="#fffef8";ctx.lineWidth=17;ctx.stroke();
        ctx.strokeStyle="#121515";ctx.lineWidth=11;ctx.stroke();
        ctx.strokeStyle="#fffef8";ctx.lineWidth=2;
        for(let distance=low+6;distance<high;distance+=12){
          const x=frame.floor.x+frame.ux*distance,y=frame.floor.y+frame.uy*distance;
          ctx.beginPath();ctx.moveTo(x-frame.nx*4-frame.ux*3,y-frame.ny*4-frame.uy*3);
          ctx.lineTo(x+frame.nx*4+frame.ux*3,y+frame.ny*4+frame.uy*3);ctx.stroke();
        }
        ctx.restore();
      }
    }
    function drawScore(){
      const pulse=1+scorePulse*.12;
      markerText(ctx,"SCORE",540,43,25,"center","#fff","#08090b",7);
      ctx.save();ctx.translate(540,95);ctx.scale(pulse,pulse);markerText(ctx,fmt(scoreDisplay),0,0,66,"center","#fff","#08090b",13);ctx.restore();
      markerText(ctx,"BEST "+fmt(bestScore),540,149,26,"center","#fff","#08090b",7);
      if(pendingScoreTransfers===0)scoreDisplay=lerp(scoreDisplay,runScore,scorePulse>.05?.22:.11);
      if(Math.abs(scoreDisplay-runScore)<.5)scoreDisplay=runScore;
      scorePulse*=.9;
    }
    function previewBody(entry){
      return{
        logicalTier:entry.logicalTier,visualFamily:entry.visualFamily,cosmeticVariant:entry.cosmeticVariant,baseColor:entry.baseColor,shiny:entry.shiny,shinyReservationId:entry.shinyReservationId,shinyConsumed:false,visibleRadius:(TIERS[entry.logicalTier].diameter-tierOutline(entry.logicalTier))/2,outline:tierOutline(entry.logicalTier),radius:physicalRadius(entry.logicalTier),faceSeed:entry.faceSeed,angle:0,vx:0,vy:0,omega:0,pupilX:0,pupilY:0,impact:0,impactAxis:"y",renderScale:1,blinkStarted:-1,mergeTransactionId:null
      };
    }
    function drawNextPanel(){
      const x=34,y=45,w=126,h=121;
      ctx.save();roundedRect(ctx,x,y,w,h,20);ctx.fillStyle="#25c9eb";ctx.fill();ctx.strokeStyle="#08090b";ctx.lineWidth=7;ctx.stroke();
      ctx.save();ctx.clip();ctx.strokeStyle="rgba(255,255,255,.14)";ctx.lineWidth=18;
      for(let i=-3;i<6;i++){ctx.beginPath();ctx.moveTo(x+i*43,y);ctx.lineTo(x+i*43+h,y+h);ctx.stroke()}ctx.restore();
      markerText(ctx,"Next Ball!",x+w/2,y+h+6,25,"center","#fff","#08090b",7);
      if(queueRevealPending){ctx.restore();return}
      ensureQueue(1);
      const entry=futureQueue[0];
      if(entry){
        const body=previewBody(entry);
        const scale=42/body.visibleRadius;
        drawBall(ctx,body,x+w/2,y+57,scale,true);
        if(entry.shiny)drawFourPoint(ctx,x+w-19,y+22,13,"#fff27d");
      }
      ctx.restore();
    }
    function drawHeld(){
      if(!currentEntry)return;
      const body=previewBody(currentEntry);
      body.angle=swapAnimation?0:Math.sin(simTime*.0012)*.025;
      if(currentEntry.logicalTier===0)body.pupilY=.08;
      drawBall(ctx,body,aimX,HELD_Y,1,true);
      if(placementLocked()&&runState==="playing"&&!snipeMode){
        const progress=clamp(1-(cooldownUntil-simTime)/CONFIG.placementCooldownMs,0,1);
        ctx.save();ctx.strokeStyle="rgba(255,255,255,.9)";ctx.lineWidth=4;ctx.beginPath();ctx.arc(aimX,HELD_Y,body.visibleRadius+15,-Math.PI/2,-Math.PI/2+TAU*progress);ctx.stroke();ctx.restore();
      }
    }
    function drawSwapAnimation(view=worldViewTransform()){
      if(!swapAnimation)return false;
      const p=clamp((simTime-swapAnimation.started)/340,0,1);
      if(p>=1){swapAnimation=null;updateControls();return false}
      const held=worldToScreenPoint({x:swapAnimation.heldX,y:HELD_Y},view);
      const oldBody=previewBody(swapAnimation.oldCurrent),newBody=previewBody(swapAnimation.newCurrent);
      const oldPhase=clamp(p/.52,0,1),newPhase=ease(clamp((p-.28)/.72,0,1));
      oldBody.angle=-TAU*oldPhase;newBody.angle=TAU*(1-newPhase)*.65;
      if(oldPhase<1)drawBall(ctx,oldBody,held.x,held.y,view.scale*(1-ease(oldPhase))*(1+.08*Math.sin(Math.PI*oldPhase)),true);
      if(newPhase>0)drawBall(ctx,newBody,held.x,held.y,view.scale*newPhase*(1+.13*Math.sin(Math.PI*newPhase)),true);
      ctx.save();ctx.globalAlpha=Math.sin(Math.PI*p);ctx.strokeStyle="#fff06b";ctx.lineWidth=12;ctx.setLineDash([18,13]);ctx.beginPath();ctx.arc(held.x,held.y,44+95*ease(p),-Math.PI*.8,Math.PI*1.2);ctx.stroke();ctx.restore();
      return true;
    }
    function drawProgression(){
      const baseline=1687;
      ctx.save();ctx.lineJoin="round";ctx.beginPath();ctx.moveTo(116,baseline-12);ctx.lineTo(961,baseline-12);ctx.lineTo(961,baseline-33);ctx.lineTo(1035,baseline+3);ctx.lineTo(961,baseline+32);ctx.lineTo(961,baseline+15);ctx.lineTo(116,baseline+15);ctx.quadraticCurveTo(100,baseline+15,100,baseline);ctx.quadraticCurveTo(100,baseline-12,116,baseline-12);ctx.closePath();ctx.fillStyle="#24c9ee";ctx.fill();ctx.strokeStyle="#08090b";ctx.lineWidth=6;ctx.stroke();
      const radii=[15,18,21,25,29,32,35,36,37,37,39,40];
      let cx=112;
      for(let tier=0;tier<TIERS.length;tier++){
        const displayRadius=radii[tier],cy=baseline-displayRadius-4;
        cx+=displayRadius;
        const known=discovered.has(TIERS[tier].id);
        if(known){
          if(newestDiscovery.tier===tier&&simTime<newestDiscovery.until){ctx.strokeStyle="#fff";ctx.lineWidth=4;ctx.beginPath();ctx.arc(cx,cy,displayRadius+4+Math.sin(simTime*.012)*2,0,TAU);ctx.stroke()}
          const entry={logicalTier:tier,visualFamily:TIERS[tier].id,cosmeticVariant:tier===8?"heart-blend":tier===9?"saturn":tier===10?"panda":tier===11?"orange-fish":TIERS[tier].id,baseColor:TIERS[tier].color,shiny:false,faceSeed:100+tier};
          const body=previewBody(entry);
          ctx.save();ctx.translate(cx,cy);ctx.scale(displayRadius/body.visibleRadius,displayRadius/body.visibleRadius);
          roughCircle(ctx,body.visibleRadius,100+tier);ctx.save();ctx.clip();
          if(tier===7){const r=body.visibleRadius;COLORS.forEach((color,index)=>{ctx.fillStyle=color;ctx.fillRect(-r,-r+index*r/3,r*2,r/3+1)})}
          else if(tier===8){ctx.fillStyle="#ffe158";ctx.fillRect(-body.visibleRadius,-body.visibleRadius,body.visibleRadius*2,body.visibleRadius*2)}
          else drawBodyFill(ctx,body,body.visibleRadius,0);
          ctx.restore();roughCircle(ctx,body.visibleRadius,100+tier);ctx.strokeStyle="#101516";ctx.lineWidth=5*body.visibleRadius/displayRadius;ctx.stroke();
          if(tier===10)drawFace(ctx,body,body.visibleRadius,0);
          ctx.restore();
          if(tier===11&&terminalAquaDiscovered)drawFourPoint(ctx,cx+20,cy-20,6+Math.sin(simTime*.008)*2,"#b9fbff");
        }else{
          ctx.fillStyle="#08090b";ctx.beginPath();ctx.arc(cx,cy,displayRadius,0,TAU);ctx.fill();
          if(tier===9){
            ctx.save();ctx.translate(cx,cy);ctx.rotate(-.43);ctx.strokeStyle="#fff";ctx.lineWidth=4;ctx.beginPath();ctx.ellipse(0,0,displayRadius*.85,displayRadius*.25,0,0,TAU);ctx.stroke();ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(0,0,displayRadius*.46,Math.PI,TAU);ctx.fill();ctx.restore();
          }else if(tier===10){
            ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(cx,cy,displayRadius*.68,0,TAU);ctx.fill();ctx.fillStyle="#08090b";ctx.beginPath();ctx.arc(cx-displayRadius*.26,cy-displayRadius*.3,displayRadius*.67,0,TAU);ctx.fill();
          }else if(tier===11){
            ctx.strokeStyle="#fff";ctx.lineWidth=3;ctx.lineCap="round";ctx.beginPath();ctx.moveTo(cx,cy+displayRadius*.69);ctx.lineTo(cx,cy-displayRadius*.7);ctx.moveTo(cx-displayRadius*.42,cy-displayRadius*.48);ctx.lineTo(cx-displayRadius*.42,cy);ctx.quadraticCurveTo(cx,cy+displayRadius*.3,cx+displayRadius*.42,cy);ctx.lineTo(cx+displayRadius*.42,cy-displayRadius*.48);ctx.stroke();
          }else markerText(ctx,"?",cx,cy+1,displayRadius*1.4,"center","#fff","#08090b",4);
        }
        cx+=displayRadius+6;
      }
      ctx.restore();
    }
    function drawEffects(){
      for(const e of effects){
        const age=simTime-e.started,p=clamp(age/e.life,0,1);
        if(age<0)continue;
        if(e.type==="combo-total"||e.type==="combo-label")continue;
        if(e.type==="banner"&&e.text.startsWith("NEW! "))continue;
        ctx.save();
        if(e.type==="particle"){
          ctx.globalAlpha=1-p;ctx.translate(e.x,e.y);ctx.rotate(e.rotation||0);ctx.fillStyle=e.color;ctx.strokeStyle="#121515";ctx.lineWidth=2;
          if(e.kind==="paper"){ctx.fillRect(-e.size,e.size*.2,e.size*2,e.size*.55)}
          else{ctx.beginPath();ctx.moveTo(0,-e.size);ctx.lineTo(e.size*.45,-e.size*.2);ctx.lineTo(e.size,0);ctx.lineTo(e.size*.42,e.size*.25);ctx.lineTo(0,e.size);ctx.lineTo(-e.size*.35,e.size*.25);ctx.lineTo(-e.size,0);ctx.lineTo(-e.size*.4,-e.size*.2);ctx.closePath();ctx.fill();ctx.stroke()}
        }else if(e.type==="bubble"){
          ctx.globalAlpha=1-p;ctx.strokeStyle="#fff";ctx.lineWidth=5;ctx.beginPath();ctx.arc(e.x,e.y,e.size*(.6+p*.5),0,TAU);ctx.stroke();
        }else if(e.type==="ring"){
          ctx.globalAlpha=1-p;ctx.strokeStyle=e.color;ctx.lineWidth=e.line*(1-p*.5);ctx.beginPath();ctx.ellipse(e.x,e.y,e.maxRadius*ease(p),e.maxRadius*ease(p)*(e.aspect||1),e.rotation||0,0,TAU);ctx.stroke();
        }else if(e.type==="text"){
          const up=94*ease(p);ctx.globalAlpha=clamp((1-p)*3,0,1);const size=32+Math.min(e.level,5)*3;ctx.translate(e.x,e.y-up);ctx.rotate(-.07);markerText(ctx,e.text,0,0,size,"center","#fff","#08090b",6);
        }else if(e.type==="banner"){
          const alpha=Math.min(1,age/120,(e.life-age)/180);ctx.globalAlpha=clamp(alpha,0,1);const scale=.72+.28*Math.min(1,age/150);ctx.translate(540,790);ctx.scale(scale,scale);roundedRect(ctx,-330,-55,660,110,25);ctx.fillStyle=e.color;ctx.fill();ctx.strokeStyle="#121515";ctx.lineWidth=13;ctx.stroke();markerText(ctx,e.text,0,3,44,"center","#fff","#121515",12);
        }else if(e.type==="flash"){
          ctx.globalAlpha=(1-p)*.9;ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(e.x,e.y,35+p*190,0,TAU);ctx.fill();
        }else if(e.type==="rainbow-ring"){
          ctx.globalAlpha=1-p;ctx.translate(e.x,e.y);ctx.rotate(e.direction*p*TAU);for(let i=0;i<COLORS.length;i++){ctx.strokeStyle=COLORS[i];ctx.lineWidth=9;ctx.beginPath();ctx.arc(0,0,55+p*175,-.35+i*.18,.35+i*.18);ctx.stroke()}
        }else if(e.type==="ink-stroke"){
          ctx.globalAlpha=1-p;ctx.translate(e.x,e.y);ctx.rotate(e.angle);ctx.strokeStyle=e.color;ctx.lineWidth=8;ctx.lineCap="round";ctx.beginPath();ctx.moveTo(40+p*45,0);ctx.lineTo(40+p*45+e.length*(1-p*.25),0);ctx.stroke();
        }else if(e.type==="beam"){
          ctx.globalAlpha=1-p;ctx.strokeStyle="#121515";ctx.lineWidth=20;ctx.beginPath();ctx.moveTo(e.fromX,e.fromY);ctx.lineTo(e.x,e.y);ctx.stroke();ctx.strokeStyle="#eaffff";ctx.lineWidth=10;ctx.stroke();
        }else if(e.type==="doodle"){
          const size=e.size*(.7+.3*ease(p));ctx.globalAlpha=1-p;ctx.translate(e.x,e.y);ctx.rotate((e.rotation||0)+(e.spin||0)*age/1000);ctx.strokeStyle=e.color;ctx.fillStyle=e.color;ctx.lineWidth=Math.max(4,size*.12);ctx.lineCap="round";ctx.lineJoin="round";
          if(e.shape==="cloud"){ctx.beginPath();ctx.arc(-size*.35,0,size*.28,.7*Math.PI,1.8*Math.PI);ctx.arc(0,-size*.18,size*.36,Math.PI,TAU);ctx.arc(size*.38,0,size*.27,1.2*Math.PI,.35*Math.PI);ctx.stroke()}
          else if(e.shape==="leaf"){ctx.beginPath();ctx.ellipse(0,0,size*.65,size*.28,-.45,0,TAU);ctx.stroke();ctx.beginPath();ctx.moveTo(-size*.5,size*.22);ctx.lineTo(size*.52,-size*.2);ctx.stroke()}
          else if(e.shape==="paw"){ctx.beginPath();ctx.arc(0,size*.12,size*.34,0,TAU);ctx.fill();for(let i=-1;i<=1;i++){ctx.beginPath();ctx.arc(i*size*.28,-size*.3,size*.14,0,TAU);ctx.fill()}}
          else if(e.shape==="ink"){ctx.beginPath();for(let i=0;i<10;i++){const a=i/10*TAU,r=size*(i%2?.72:1);const px=Math.cos(a)*r,py=Math.sin(a)*r;i?ctx.lineTo(px,py):ctx.moveTo(px,py)}ctx.closePath();ctx.fill()}
          else if(e.shape==="spark")drawFourPoint(ctx,0,0,size,e.color);
          else if(e.shape==="fin"){ctx.beginPath();ctx.moveTo(-size,0);ctx.quadraticCurveTo(0,-size*.92,size,0);ctx.quadraticCurveTo(0,-size*.16,-size,0);ctx.fill();ctx.stroke()}
          else if(e.shape==="tail"){ctx.beginPath();ctx.moveTo(-size*.85,-size*.55);ctx.lineTo(size,0);ctx.lineTo(-size*.85,size*.55);ctx.moveTo(-size*.55,0);ctx.lineTo(size*.8,0);ctx.stroke()}
          else if(e.shape==="trunk"){ctx.beginPath();ctx.moveTo(-size*.7,-size*.25);ctx.bezierCurveTo(-size*.15,size*.85,size*.2,-size*.75,size*.72,size*.1);ctx.stroke()}
          else if(e.shape==="spiral"){ctx.strokeStyle=e.color;ctx.beginPath();for(let i=0;i<=42;i++){const a=i/42*TAU*2.2,r=size*(1-i/48);const px=Math.cos(a)*r,py=Math.sin(a)*r;i?ctx.lineTo(px,py):ctx.moveTo(px,py)}ctx.stroke();ctx.strokeStyle=e.accent;ctx.lineWidth*=.55;ctx.stroke()}
        }
        ctx.restore();
      }
    }
    function drawUiEffects(){
      const discovery=effects.find(e=>e.type==="banner"&&e.text.startsWith("NEW! ")&&simTime>=e.started&&simTime<e.started+e.life);
      $("game").classList.toggle("discovery-active",!!discovery);
      // Discovery darkens the scene first; the active combo remains readable
      // over the celebration, as it does in the supplied gameplay clips.
      const uiEffects=discovery?[discovery,...effects.filter(e=>e!==discovery)]:effects;
      for(const e of uiEffects){
        if(e.type==="banner"&&e.text.startsWith("NEW! ")){
          const age=simTime-e.started;if(age<0)continue;
          const tier=TIERS.findIndex(item=>"NEW! "+item.name.toUpperCase()===e.text);
          if(tier<0)continue;
          const fade=clamp(Math.min(age/140,(e.life-age)/240),0,1),pop=.72+.28*ease(clamp(age/220,0,1));
          ctx.save();ctx.globalAlpha=fade;ctx.fillStyle="rgba(8,9,11,.5)";ctx.fillRect(0,0,W,H);
          markerText(ctx,"New Ball Discovered!",540,530,66,"center","#fff263","#08090b",14);
          const entry={logicalTier:tier,cosmeticVariant:tier===8?"heart-blend":tier===9?"saturn":tier===10?"panda":tier===11?"orange-fish":TIERS[tier].id,baseColor:TIERS[tier].color,shiny:false,faceSeed:100+tier};
          const body=previewBody(entry);body.angle=-.12+Math.sin(age*.005)*.035;
          drawBall(ctx,body,540,790,145/body.visibleRadius*pop);
          for(const [x,y,size,angle] of [[305,965,45,-.18],[792,711,37,.17]]){
            ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.scale(pop,pop);ctx.beginPath();
            for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,radius=size*(i%2?.47:1);const px=Math.cos(a)*radius,py=Math.sin(a)*radius;i?ctx.lineTo(px,py):ctx.moveTo(px,py)}
            ctx.closePath();ctx.fillStyle="#ffdb43";ctx.strokeStyle="#08090b";ctx.lineJoin="round";ctx.lineWidth=7;ctx.fill();ctx.stroke();ctx.restore();
          }
          ctx.restore();continue;
        }
        if(e.type==="combo-label"){
          const age=simTime-e.started;if(age<0)continue;
          const colors=["#4bccf4","#75f29a","#caff48","#ffe257","#ffd548","#f15bcf","#706dff","#f9415c"];
          const view=worldViewTransform(),origin=worldToScreenPoint({x:e.x??540,y:e.y??(cup.floorY-cup.wallHeight)},view);
          const pop=age<110?lerp(.62,1.12,ease(age/110)):age<210?lerp(1.12,1,(age-110)/100):1;
          const size=e.label.length>9?88:104,width=e.label.length*size*.59;
          const anchorX=clamp(origin.x,Math.max(260,width*.5+30),Math.min(755,W-width*.5-120));
          const anchorY=clamp(origin.y-165-85*ease(clamp(age/e.life,0,1)),440,1110);
          ctx.save();ctx.globalAlpha=clamp((e.life-age)/160,0,1);ctx.translate(anchorX,anchorY);ctx.scale(pop,pop);ctx.rotate(-.025);
          const color=colors[(e.ordinal-1)%colors.length];
          markerText(ctx,e.label,0,0,size,"center",color,"#08090b",21);
          markerText(ctx,"x"+e.ordinal,width*.48,98,82,"center",color,"#08090b",18);ctx.restore();continue;
        }
        if(e.type!=="combo-total")continue;
        const age=simTime-e.started,p=clamp(age/e.life,0,1);
        if(age<0)continue;
        const view=worldViewTransform(),origin=worldToScreenPoint({x:e.x??540,y:e.y??790},view);
        const flyPhase=ease(clamp(p/.72,0,1));
        const x=lerp(clamp(origin.x,240,840),540,flyPhase),y=lerp(clamp(origin.y-210,430,1050),91,flyPhase),scale=lerp(1,.92,flyPhase);
        const alpha=p<.86?1:clamp((1-p)/.14,0,1);
        const color=["#4bccf4","#75f29a","#caff48","#ffe257"][(Math.max(1,e.ordinal||1)-1)%4];
        ctx.save();ctx.globalAlpha=alpha;ctx.translate(x,y);ctx.scale(scale,scale);ctx.rotate(-.025*(1-flyPhase));
        markerText(ctx,"+"+fmt(e.amount),0,0,68,"center",e.shinySteps?"#fff06b":color,"#08090b",13);
        markerText(ctx,(e.ordinal||1)+"x Combo!",0,62,35,"center","#fff","#08090b",9);
        ctx.restore();
      }
    }
    function drawSnipe(view=worldViewTransform()){
      if(!snipeMode)return;
      ctx.save();ctx.fillStyle="rgba(10,15,17,.28)";ctx.fillRect(0,0,W,H);ctx.restore();
      ctx.save();applyWorldView(ctx,view);
      for(const body of balls)if(body.logicalTier<=3&&!body.dead&&!body.outCandidate)drawBall(ctx,body);
      ctx.translate(snipeX,snipeY);ctx.strokeStyle="#121515";ctx.lineWidth=14;ctx.beginPath();ctx.arc(0,0,40,0,TAU);ctx.moveTo(-66,0);ctx.lineTo(-20,0);ctx.moveTo(20,0);ctx.lineTo(66,0);ctx.moveTo(0,-66);ctx.lineTo(0,-20);ctx.moveTo(0,20);ctx.lineTo(0,66);ctx.stroke();ctx.strokeStyle="#fff";ctx.lineWidth=7;ctx.stroke();ctx.restore();
      markerText(ctx,"SELECT A BLUE–RED BALL · TAP SNIPE TO CANCEL",540,1545,27,"center","#fff","#121515",9);
    }
    function drawWarning(){
      if(!balls.some((b)=>b.outCandidate))return;
      const alpha=.15+.10*(.5+.5*Math.sin(simTime*.012));
      ctx.save();ctx.strokeStyle="rgba(225,42,55,"+alpha+")";ctx.lineWidth=34;ctx.strokeRect(17,17,W-34,H-34);ctx.restore();
    }
    function drawMergeSeams(){
      for(const tx of contacts.values()){
        const elapsed=simTime-tx.started;
        const sourceA=balls.find((body)=>body.rigidbodyId===tx.aId),sourceB=balls.find((body)=>body.rigidbodyId===tx.bId);if(!sourceA||!sourceB)continue;
        const a=renderBodyPose(sourceA),b=renderBodyPose(sourceB);
        const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,angle=Math.atan2(b.y-a.y,b.x-a.x)+Math.PI/2;
        const length=Math.min(a.visibleRadius,b.visibleRadius)*.42;
        const progress=clamp(elapsed/CONFIG.mergeContactMs,0,1),dx=b.x-a.x,dy=b.y-a.y,distance=Math.hypot(dx,dy)||1;
        ctx.save();ctx.lineCap="round";
        ctx.strokeStyle=TIERS[a.logicalTier].color.startsWith("#")?TIERS[a.logicalTier].color:"#b4f6e7";
        ctx.lineWidth=length*(.35+.55*Math.sin(progress*Math.PI));ctx.beginPath();ctx.moveTo(mx-dx/distance*9,my-dy/distance*9);ctx.lineTo(mx+dx/distance*9,my+dy/distance*9);ctx.stroke();
        ctx.globalAlpha=.3+.55*Math.sin(progress*Math.PI);ctx.strokeStyle="#fff";ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(mx-Math.cos(angle)*length*.55,my-Math.sin(angle)*length*.55);ctx.lineTo(mx+Math.cos(angle)*length*.55,my+Math.sin(angle)*length*.55);ctx.stroke();ctx.restore();
      }
    }
    function renderBodyPose(body){
      const previous=body.renderPrevious;
      if(!previous)return body;
      const alpha=clamp(accumulator/CONFIG.fixedStep,0,1);
      return{...body,x:lerp(previous.x,body.x,alpha),y:lerp(previous.y,body.y,alpha),angle:lerp(previous.angle,body.angle,alpha)};
    }
    function drawMergeTransitions(){
      for(const tx of mergeTransactions){
        const progress=clamp((simTime-tx.started+accumulator*1000)/150,0,1);
        if(progress>=1||!tx.sources)continue;
        const result=balls.find((body)=>body.rigidbodyId===tx.resultId&&!body.dead);
        const center=result?renderBodyPose(result):tx.center;
        const t=ease(progress);
        ctx.save();ctx.globalAlpha=(1-t)*.85;
        for(const source of tx.sources){
          const dx=source.x-tx.center.x,dy=source.y-tx.center.y;
          drawBall(ctx,source,center.x+dx*(1-t),center.y+dy*(1-t),1-t*.9);
        }
        ctx.restore();
      }
    }
    let renderSizeDirty=true,renderPixelRatio=0;
    function resizeGameCanvas(){
      const rect=canvas.getBoundingClientRect();
      renderPixelRatio=Math.min(1.5,Math.max(1,Number(window.devicePixelRatio)||1));
      if(rect.width<=0||rect.height<=0)return;
      // Keep physics and pointer coordinates at 1080×1920. Rasterize only the
      // pixels this device displays, with bounded supersampling on dense screens.
      const scale=Math.min(1,rect.width*renderPixelRatio/W,rect.height*renderPixelRatio/H);
      const width=Math.max(1,Math.round(W*scale)),height=Math.max(1,Math.round(H*scale));
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height}
      renderSizeDirty=false;
    }
    window.addEventListener("resize",()=>{renderSizeDirty=true});
    if(typeof window.ResizeObserver==="function"){
      const renderObserver=new window.ResizeObserver(()=>{renderSizeDirty=true});
      renderObserver.observe(canvas);
    }
    function render(){
      const pixelRatio=Math.min(1.5,Math.max(1,Number(window.devicePixelRatio)||1));
      if(renderSizeDirty||pixelRatio!==renderPixelRatio)resizeGameCanvas();
      ctx.setTransform(canvas.width/W,0,0,canvas.height/H,0,0);
      ctx.clearRect(0,0,W,H);ctx.drawImage(paperCanvas,0,0,W,H);
      const view=worldViewTransform();
      ctx.save();applyWorldView(ctx,view);
      drawGuide();
      ctx.save();
      if(cameraBump>0){const seed=Math.floor(simTime/16);ctx.translate(Math.sin(seed*12.7)*cameraBump,Math.cos(seed*7.3)*cameraBump*.55)}
      drawCup();
      drawMergeTransitions();
      for(const body of balls){
        const rendered=renderBodyPose(body);
        if(snipeMode&&body.logicalTier>3){ctx.save();ctx.globalAlpha=.34;drawBall(ctx,rendered);ctx.restore()}
        else drawBall(ctx,rendered);
      }
      drawWallAttachments();
      drawMergeSeams();
      drawEffects();
      ctx.restore();
      ctx.restore();
      drawScore();drawNextPanel();
      if(!drawSwapAnimation(view)){ctx.save();applyWorldView(ctx,view);drawHeld();ctx.restore()}
      drawProgression();drawUiEffects();drawSnipe(view);drawWarning();
    }

    function updateControls(){
      $("pauseBtn").disabled=destroyed||!["playing","game-over-impact"].includes(runState);
      $("pauseBtn").setAttribute("aria-pressed",String(activityPaused));
      $("pauseBtn").setAttribute("aria-label",activityPaused?"Resume run":"Pause run");
      $("pauseBtn").setAttribute("title",activityPaused?"Resume":"Pause");
      $("pauseLabel").textContent=activityPaused?"Resume":"Pause";
      $("pauseIcon").textContent=activityPaused?"▶":"Ⅱ";
      const map={swap:"swapBtn",quake:"quakeBtn",walls:"wallsBtn",snipe:"snipeBtn"};
      const animationLocked=!!(cup.growth||swapAnimation||pendingCheckout);
      const wallsRemaining=cup.wallsActive?Math.max(0,cup.wallsEndsAt-simTime):0;
      const quakeRemaining=cup.quake?Math.max(0,CONFIG.quakeDurationMs-(simTime-cup.quake.started)):0;
      for(const [type,id] of Object.entries(map)){
        const button=$(id),count=abilityCounts[type];
        button.querySelector(".ability-count").textContent=String(count);
        const chargeText=count+" charge"+(count===1?"":"s")+" remaining";
        button.setAttribute("aria-label",type.charAt(0).toUpperCase()+type.slice(1)+", "+chargeText);
        button.classList.toggle("spent",count===0);
        button.classList.toggle("targeting",type==="snipe"&&snipeMode);
        const running=(type==="walls"&&wallsRemaining>0)||(type==="quake"&&quakeRemaining>0);
        button.classList.toggle("running",running);
        const wallAnimationLocked=!!cup.wallsAnimation&&(type!=="walls"||cup.wallsAnimation.to===1);
        let disabled=runState!=="playing"||modalPaused||activityPaused||count===0||animationLocked||wallAnimationLocked||running;
        if(type==="swap")disabled=disabled||placementLocked()||!currentEntry;
        if(type==="snipe")disabled=disabled||queueRevealPending||!!cup.quake;
        if(type!=="snipe"&&type!=="walls"&&snipeMode)disabled=true;
        button.disabled=disabled;
      }
      const wallsTimer=$("wallsTimer"),quakeTimer=$("quakeTimer");
      wallsTimer.hidden=wallsRemaining<=0;quakeTimer.hidden=quakeRemaining<=0;
      if(wallsRemaining>0){wallsTimer.textContent=(wallsRemaining/1000).toFixed(1)+"s";$("wallsBtn").setAttribute("aria-label","Walls active, "+Math.ceil(wallsRemaining/1000)+" seconds remaining, "+abilityCounts.walls+" charge"+(abilityCounts.walls===1?"":"s")+" remaining")}
      if(quakeRemaining>0){quakeTimer.textContent=(quakeRemaining/1000).toFixed(1)+"s";$("quakeBtn").setAttribute("aria-label","Quake active, "+Math.ceil(quakeRemaining/1000)+" seconds remaining, "+abilityCounts.quake+" charge"+(abilityCounts.quake===1?"":"s")+" remaining")}
      $("checkoutBtn").disabled=runState!=="playing"||modalPaused||activityPaused||snipeMode;
    }
    function useSwap(){
      if(abilityCounts.swap<=0||placementLocked()||!currentEntry)return;
      ensureAudio();
      const oldCurrent=currentEntry;
      const replacement=makeEntry(directTierExcept(oldCurrent.logicalTier));
      replacement.shiny=!!oldCurrent.shiny;
      replacement.shinyReservationId=oldCurrent.shinyReservationId;
      replacement.shinyReservationIds=Array.isArray(oldCurrent.shinyReservationIds)?[...oldCurrent.shinyReservationIds]:[];
      replacement.reservationResolved=!!oldCurrent.reservationResolved;
      currentEntry=replacement;
      swapAnimation={started:simTime,oldCurrent,newCurrent:replacement,heldX:aimX};
      aimX=clampAim(targetAimX);
      abilityCounts.swap--;
      sfx("checkout",.42);
      updateControls();
    }
    function useQuake(){
      if(abilityCounts.quake<=0||runState!=="playing"||modalPaused||activityPaused||snipeMode||cup.quake||cup.growth||cup.wallsAnimation||swapAnimation)return;
      ensureAudio();const actionId=beginAction();tagAllBodies(actionId);
      cup.quake={started:simTime,lastPulse:-1};
      cup.priorSegments=cupSegments();
      abilityCounts.quake--;showBanner("QUAKE!",850,"#a2f7eb");updateControls();
    }
    function useWalls(){
      const stillActive=cup.wallsActive&&simTime<cup.wallsEndsAt;
      if(abilityCounts.walls<=0||runState!=="playing"||modalPaused||activityPaused||stillActive||cup.growth||cup.wallsAnimation?.to===1||swapAnimation||pendingCheckout)return;
      // Rescue is independent of drop restrictions, warning banners and aim
      // mode. A second charge reverses retraction from its current position.
      snipeMode=false;snipeTargetId=0;
      ensureAudio();const actionId=beginAction();tagAllBodies(actionId);
      cup.wallsActive=true;cup.wallsEndsAt=simTime+CONFIG.wallsDurationMs;cup.wallsAnimation={started:simTime,from:cup.wallsProgress,to:1};abilityCounts.walls--;
      captureRisingWallBalls();
      showBanner("WALLS UP!",1000,"#a2f7eb");addBurst(180,cup.floorY-cup.wallHeight,"paper",16,"#fff");addBurst(900,cup.floorY-cup.wallHeight,"paper",16,"#fff");sfx("walls",.9);updateControls();
    }
    function toggleSnipe(){
      if(snipeMode){snipeMode=false;snipeTargetId=0;announce("Snipe cancelled");updateControls();return}
      if(abilityCounts.snipe<=0||runState!=="playing"||modalPaused||activityPaused||queueRevealPending||cup.quake||cup.growth||cup.wallsAnimation||swapAnimation)return;
      snipeMode=!snipeMode;snipeTargetId=0;
      if(snipeMode){sfx("aim",.6);showBanner("SNIPE MODE",650,"#eefefe")}else announce("Snipe cancelled");
      updateControls();
    }
    function updateSnipeTarget(){
      let best=null,bestDist=Infinity;
      for(const body of balls){
        if(body.dead||body.outCandidate||body.logicalTier>3||(queueRevealPending&&body.rigidbodyId===revealAfterBodyId))continue;
        const d=Math.hypot(snipeX-body.x,snipeY-body.y);
        const shape=bodyShape(body);
        if(((snipeX-body.x)/(body.radius*shape.x))**2+((snipeY-body.y)/(body.radius*shape.y))**2<=1&&d<bestDist){best=body;bestDist=d}
      }
      snipeTargetId=best?.rigidbodyId||0;
    }
    function shootSnipe(){
      if(activityPaused||modalPaused)return;
      if(!snipeMode)return;
      const target=balls.find((b)=>b.rigidbodyId===snipeTargetId&&!b.dead&&!b.outCandidate&&b.logicalTier<=3);
      if(!target){
        showBanner("BLUE–RED ONLY",700,"#ff8b91");sfx("aim",.4);cameraBump=5;return;
      }
      const actionId=beginAction();tagAllBodies(actionId);
      abilityCounts.snipe--;snipeMode=false;
      target.collisionEnabled=false;clearContactsFor([target.rigidbodyId]);
      const cancelled=mergeTransactions.filter((tx)=>tx.aId===target.rigidbodyId||tx.bId===target.rigidbodyId);
      for(const tx of cancelled){
        const partnerId=tx.aId===target.rigidbodyId?tx.bId:tx.aId;
        const partner=balls.find((body)=>body.rigidbodyId===partnerId);
        if(partner){partner.mergeTransactionId=null;partner.collisionEnabled=true}
      }
      target.mergeTransactionId=null;
      wakeAllBodies();impulseCache.clear();
      mergeTransactions=mergeTransactions.filter((tx)=>tx.aId!==target.rigidbodyId&&tx.bId!==target.rigidbodyId);
      effects.push({type:"beam",fromX:snipeX-90,fromY:snipeY-90,x:target.x,y:target.y,started:simTime,life:180});
      addBurst(target.x,target.y,"snipe",20,"#66f3e5");
      sfx("snipe",.9);
      target.destroyAt=simTime+120;
      updateControls();
    }

    function requestCheckout(){
      if(runState!=="playing"||modalPaused||activityPaused||snipeMode)return;
      pendingCheckout=true;updateControls();
    }
    function settleCommittedMergesForCheckout(){
      // A first-contact bond is already committed. Banking a run must include
      // that merge even if its short animation has not finished yet.
      for(const contact of [...contacts.values()]){
        const a=balls.find((body)=>body.rigidbodyId===contact.aId);
        const b=balls.find((body)=>body.rigidbodyId===contact.bId);
        if(a&&b&&a.collisionEnabled&&b.collisionEnabled&&canMerge(a,b))startMerge(a,b);
      }
      const committed=[...mergeTransactions].sort((a,b)=>a.started-b.started||a.id-b.id);
      for(const tx of committed){
        if(!tx.created)createMergeResult(tx);
        tx.finished=true;
      }
      mergeTransactions=[];
      balls=balls.filter((body)=>!body.dead);
    }
    function openCheckout(){
      if(activityPaused)return;
      releasePointer();
      pendingCheckout=false;
      settleCommittedMergesForCheckout();
      finalizeCombo(true);
      modalPaused=true;
      $("confirmScore").textContent=fmt(runScore);
      $("confirmBest").textContent=fmt(bestScore);
      $("saveError").hidden=true;
      $("confirmModal").hidden=false;
      $("continueBtn").focus();
      updateControls();
    }
    function continueRun(){
      if(activityPaused)return;
      $("confirmModal").hidden=true;modalPaused=false;updateControls();canvas.focus?.();
    }
    function confirmCheckout(){
      if(activityPaused)return;
      finalizeCombo(true);
      const finalScore=runScore;
      bestScore=Math.max(bestScore,readPersistedBest());
      if(finalScore>bestScore){
        const oldBest=bestScore;
        if(!persistBest(finalScore)){$("saveError").hidden=false;return}
        bestScore=finalScore;
        $("confirmModal").hidden=true;
        runState="checked-out";
        modalPaused=true;
        showResult("high",oldBest);
      }else{
        $("confirmModal").hidden=true;
        runState="checked-out";
        modalPaused=true;
        showResult("standard");
      }
      recordDailyScore(finalScore);
      sfx("checkout",.85);updateControls();
    }
    function buildCelebration(){
      const layer=$("celebration");layer.textContent="";
      const wave=document.createElement("i");wave.className="rainbow-shockwave";layer.appendChild(wave);
      for(const side of ["left","right"]){const star=document.createElement("i");star.className="side-star "+side;star.style.setProperty("--delay",side==="left"?".42s":".5s");layer.appendChild(star)}
      for(let i=0;i<38;i++){
        const bit=document.createElement("i");bit.className="confetti";
        bit.style.setProperty("--x",(8+(i*83)%610)+"px");bit.style.setProperty("--drift",((i%2?1:-1)*(25+(i*17)%90))+"px");bit.style.setProperty("--r",((i*31)%180)+"deg");bit.style.setProperty("--spin",((i%2?1:-1)*(540+(i*47)%900))+"deg");bit.style.setProperty("--delay",((i%9)*.035)+"s");bit.style.setProperty("--c",COLORS[i%COLORS.length]);layer.appendChild(bit);
      }
      for(let i=0;i<6;i++){
        const ball=document.createElement("i");ball.className="orbit-ball";ball.style.setProperty("--a",(i*60)+"deg");ball.style.setProperty("--delay",(i*.035)+"s");ball.style.setProperty("--c",COLORS[i]);layer.appendChild(ball);
      }
    }
    function animateResultNumber(from,to,duration){
      const start=performance.now();
      function tick(now){
        const p=clamp((now-start)/duration,0,1),e=1-Math.pow(1-p,3);
        $("resultNumber").textContent=fmt(Math.round(lerp(from,to,e)));
        if(p<1)requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }
    function showResult(mode,oldBest=bestScore){
      const card=$("resultCard");card.className="card result-card";void card.offsetWidth;card.className="card result-card "+(mode==="game-over"?"game-over":mode);
      const edge=$("edgeGlow");edge.hidden=mode!=="high";edge.classList.remove("active");if(mode==="high"){void edge.offsetWidth;edge.classList.add("active")}
      $("resultStamp").hidden=mode!=="high";
      $("cupBounce").hidden=mode!=="high";
      $("oldBestGhost").hidden=mode!=="high";
      $("celebration").textContent="";
      if(mode==="game-over"){
        $("resultKicker").textContent="Run ended";
        $("resultTitle").textContent="Game Over";
        $("resultNumber").textContent=fmt(runScore);
        $("resultCopy").textContent="Your provisional Score was not saved. Best remains "+fmt(bestScore)+".";
      }else if(mode==="high"){
        $("resultKicker").textContent="Saved successfully";
        $("resultTitle").textContent="New High Score!";
        $("oldBestValue").textContent=fmt(oldBest);
        $("resultCopy").textContent="Old Best "+fmt(oldBest)+" · New Best locked in.";
        $("resultNumber").textContent=fmt(oldBest);
        buildCelebration();animateResultNumber(oldBest,runScore,1450);sfx("fanfare",1);haptic("strong");
      }else{
        $("resultKicker").textContent="Run complete";
        $("resultTitle").textContent="Checked Out";
        $("resultNumber").textContent=fmt(runScore);
        $("resultCopy").textContent="Best stays at "+fmt(bestScore)+".";
      }
      $("resultModal").hidden=false;
      $("restartBtn").focus();
      announce($("resultTitle").textContent+". Final score "+fmt(runScore));
    }
    function exitActivity(){
      if(hostWindow!==window){notifyHost("htmlhub:activity-close");return}
      if(!pauseActivity())showStartScreen();
    }
    function notifyHost(type,extra={}){
      try{if(hostWindow!==window)hostWindow.postMessage({type,activityId:"merge-party",...extra},"*")}catch{}
    }
    function releasePointer(){
      if(activePointerId!==null){try{canvas.releasePointerCapture(activePointerId)}catch{}}
      pointerDown=false;activePointerId=null;
    }
    function pauseActivity(){
      if(destroyed||!["playing","game-over-impact"].includes(runState))return false;
      activityPaused=true;releasePointer();accumulator=0;lastFrame=performance.now();
      $("pauseModal").hidden=false;
      try{audioCtx?.suspend?.()?.catch?.(()=>{})}catch{}
      updateControls();notifyHost("htmlhub:activity-pause",{paused:true});
      announce("Run paused. Resume here or close and return in this tab.");
      return true;
    }
    function resumeView(){
      // Opening the activity is not consent to restart its physics clock.
      if(activityPaused){$("pauseModal").hidden=false;lastFrame=performance.now();accumulator=0;updateControls();$("resumeBtn").focus()}
      return activityPaused;
    }
    function resumeActivity(){
      if(!activityPaused||destroyed)return false;
      activityPaused=false;$("pauseModal").hidden=true;lastFrame=performance.now();accumulator=0;
      ensureAudio();updateControls();notifyHost("htmlhub:activity-pause",{paused:false});
      announce("Run resumed");
      if(!$("confirmModal").hidden)$("continueBtn").focus();else canvas.focus?.();
      return true;
    }
    async function leaveActivity(){
      destroyed=true;
      try{audioCtx?.close?.()}catch{}
    }

    function resetRun(){
      activityPaused=false;$("pauseModal").hidden=true;
      runState="playing";runScore=0;scoreDisplay=0;scorePulse=0;pendingScoreTransfers=0;
      balls=[];contacts.clear();impulseCache.clear();quietTime=0;mergeTransactions=[];effects=[];activeCombo=null;
      currentActionId=0;lastDroppedId=0;revealAfterBodyId=0;queueRevealPending=false;cooldownUntil=0;aimX=540;targetAimX=540;pointerDown=false;activePointerId=null;pointerStartX=pointerStartY=pointerLastX=pointerLastY=0;
      snipeMode=false;snipeTargetId=0;pendingCheckout=false;modalPaused=false;warningPulse=0;cameraBump=0;
      abilityCounts={swap:2,quake:2,walls:2,snipe:2};swapAnimation=null;gameOverAt=0;gameOverBallId=0;
      highestRunTier=3;newestDiscovery={tier:-1,until:0};terminalAquaDiscovered=false;
      shinyReservations.clear();futureQueue=[];currentEntry=makeEntry();ensureQueue(1);
      Object.assign(cup,BASE_CUP);cup.growth=null;cup.growthCount=0;cup.pendingGrowths=0;cup.growthMilestones.clear();cup.wallsActive=false;cup.wallsProgress=0;cup.wallsAnimation=null;cup.wallsEndsAt=0;cup.quake=null;cup.pose={x:0,angle:0};cup.priorSegments=[];
      cup.priorSegments=cupSegments();
      $("startScreen").hidden=true;$("checkoutBtn").hidden=false;$("abilities").hidden=false;
      $("confirmModal").hidden=true;$("resultModal").hidden=true;$("edgeGlow").hidden=true;$("edgeGlow").classList.remove("active");$("resultCard").className="card result-card";
      updateControls();announce("New Merge Party run");
    }
    function dayKey(date=new Date()){
      return date.getFullYear()+"-"+String(date.getMonth()+1).padStart(2,"0")+"-"+String(date.getDate()).padStart(2,"0");
    }
    function dailyScores(){
      try{const value=JSON.parse(hostWindow.localStorage?.getItem(statsKey)||"{}");return value&&typeof value==="object"&&!Array.isArray(value)?value:{}}catch{return{}}
    }
    function recordDailyScore(score){
      try{
        const scores=dailyScores(),today=dayKey();scores[today]=Math.max(Number(scores[today])||0,score);
        const recent=Object.keys(scores).sort().slice(-35);
        hostWindow.localStorage?.setItem(statsKey,JSON.stringify(Object.fromEntries(recent.map((key)=>[key,scores[key]]))));
      }catch{}
    }
    function showStartScreen(){
      activityPaused=false;$("pauseModal").hidden=true;
      runState="menu";modalPaused=true;accumulator=0;
      $("startScreen").hidden=false;$("checkoutBtn").hidden=true;$("abilities").hidden=true;
      $("confirmModal").hidden=true;$("resultModal").hidden=true;
      const scores=dailyScores(),today=new Date(),monday=new Date(today);
      monday.setDate(today.getDate()-(today.getDay()+6)%7);
      $("todayBest").textContent=fmt(scores[dayKey(today)]||0);
      $("weekBest").textContent=fmt(Math.max(0,...Object.entries(scores).filter(([key])=>key>=dayKey(monday)&&key<=dayKey(today)).map(([,value])=>Number(value)||0)));
      $("menuBest").textContent=fmt(Math.max(bestScore,readPersistedBest()));
      announce("Merge Party. Select Play to start.");updateControls();
    }
    function startRun(){ensureAudio();resetRun();lastFrame=performance.now();accumulator=0;canvas.focus?.()}

    function canvasPoint(event){
      const rect=canvas.getBoundingClientRect();
      const screen={x:(event.clientX-rect.left)*W/rect.width,y:(event.clientY-rect.top)*H/rect.height};
      return screenToWorldPoint(screen);
    }
    function moveAim(point){
      // Keep the cursor's requested position even when this tier cannot fit
      // that close to a rim. A smaller next ball can then follow it immediately.
      targetAimX=point.x;
      aimX=clampAim(targetAimX);
      if(pointerDown&&simTime-lastSlideAudio>120){lastSlideAudio=simTime;sfx("slide",.2)}
    }
    function onPlayfieldPointerDown(event){
      if(activityPaused||modalPaused||runState!=="playing")return;
      if(event.isPrimary===false||event.button>0)return;
      ensureAudio();
      const point=canvasPoint(event);
      if(snipeMode){snipeX=point.x;snipeY=point.y;updateSnipeTarget();shootSnipe();return}
      moveAim(point);
      if(activePointerId!==null||placementLocked())return;
      // Every playfield gesture only positions the next drop. Placed balls
      // cannot be grabbed, stretched, resized, or pushed by a held pointer.
      activePointerId=event.pointerId;pointerDown=true;pointerStartX=pointerLastX=point.x;pointerStartY=pointerLastY=point.y;try{canvas.setPointerCapture(event.pointerId)}catch{}
    }
    function onPlayfieldPointerMove(event){
      if(activityPaused||modalPaused||runState!=="playing")return;
      const point=canvasPoint(event);
      if(event.isPrimary===false||(activePointerId!==null&&event.pointerId!==activePointerId))return;
      if(snipeMode){snipeX=point.x;snipeY=point.y;updateSnipeTarget();return}
      pointerLastX=point.x;pointerLastY=point.y;moveAim(point);
    }
    function onPlayfieldPointerUp(event){
      if(!pointerDown||event.pointerId!==activePointerId)return;
      const point=canvasPoint(event);pointerDown=false;activePointerId=null;pointerLastX=point.x;pointerLastY=point.y;moveAim(point);
      try{canvas.releasePointerCapture(event.pointerId)}catch{}
      // Pointer capture may deliver a release above a control to the canvas.
      // Releasing a drag there cancels the drop, just like clicking the control.
      const releaseTarget=document.elementFromPoint?.(event.clientX,event.clientY);
      if(releaseTarget?.closest?.("button,.modal,.start-screen,.activity-controls"))return;
      // Release always starts a gravity-driven fall. Gesture distance and
      // duration neither charge a throw nor change a ball's physical shape.
      dropCurrent();
    }
    canvas.addEventListener("pointerdown",onPlayfieldPointerDown);
    canvas.addEventListener("pointermove",onPlayfieldPointerMove);
    canvas.addEventListener("pointerup",onPlayfieldPointerUp);
    // The paper beyond the portrait playfield belongs to the same game. Keep
    // mapping against the canvas, so distant clicks clamp to the nearest rim.
    // Only direct sheet events are forwarded; controls and modal descendants
    // must not become placement input through bubbling.
    const gameSurface=$("gameSurface");
    for(const [type,handler] of [["pointerdown",onPlayfieldPointerDown],["pointermove",onPlayfieldPointerMove],["pointerup",onPlayfieldPointerUp]]){
      gameSurface.addEventListener(type,event=>{if(event.target===gameSurface)handler(event)});
    }
    canvas.addEventListener("pointercancel",releasePointer);
    canvas.addEventListener("lostpointercapture",()=>{pointerDown=false;activePointerId=null});
    function activateAbilityShortcut(key){
      if(runState!=="playing"||modalPaused||activityPaused)return;
      if(key==="1")useSwap();else if(key==="2")useQuake();else if(key==="3")useWalls();else if(key==="4"||key==="s")toggleSnipe();
    }
    window.addEventListener("keydown",(event)=>{
      if(event.ctrlKey||event.metaKey||event.altKey||event.target?.closest?.("input,textarea,select,[contenteditable=true]"))return;
      const key=String(event.key||"").toLowerCase();
      if(activityPaused){if((key==="escape"||key==="p")&&!event.repeat){event.preventDefault();resumeActivity()}return}
      if(key==="p"&&!event.repeat&&runState==="playing"){event.preventDefault();pauseActivity();return}
      if(key==="escape"&&snipeMode){toggleSnipe();return}
      if(key==="escape"&&!$("confirmModal").hidden){continueRun();return}
      if(runState!=="playing"||modalPaused||activityPaused)return;
      if(key==="arrowleft"||key==="a"){targetAimX=clampAim(aimX-26);aimX=targetAimX;event.preventDefault()}
      if(key==="arrowright"||key==="d"){targetAimX=clampAim(aimX+26);aimX=targetAimX;event.preventDefault()}
      if((key===" "||key==="arrowdown")&&!event.repeat){dropCurrent();event.preventDefault()}
      const abilityKey=/^(Digit|Numpad)[1-4]$/.test(event.code||"")?event.code.slice(-1):key;
      if(["1","2","3","4","s"].includes(abilityKey)){event.preventDefault();if(!event.repeat)activateAbilityShortcut(abilityKey)}
    });
    $("swapBtn").addEventListener("click",useSwap);
    $("quakeBtn").addEventListener("click",useQuake);
    $("wallsBtn").addEventListener("click",useWalls);
    $("snipeBtn").addEventListener("click",toggleSnipe);
    $("checkoutBtn").addEventListener("click",requestCheckout);
    $("continueBtn").addEventListener("click",continueRun);
    $("confirmCheckoutBtn").addEventListener("click",confirmCheckout);
    $("restartBtn").addEventListener("click",resetRun);
    $("exitBtn").addEventListener("click",exitActivity);
    $("playBtn").addEventListener("click",startRun);
    $("menuBtn").addEventListener("click",showStartScreen);
    $("activityChatBtn").addEventListener("click",()=>{releasePointer();notifyHost("htmlhub:activity-chat-toggle")});
    $("activityExitBtn").addEventListener("click",exitActivity);
    $("pauseBtn").addEventListener("click",()=>{if(activityPaused)resumeActivity();else pauseActivity()});
    $("resumeBtn").addEventListener("click",resumeActivity);
    $("pauseExitBtn").addEventListener("click",exitActivity);
    window.addEventListener("message",(event)=>{
      if(event.source!==hostWindow||!event.data||typeof event.data!=="object")return;
      if(event.data.type==="htmlhub:merge-ability")activateAbilityShortcut(String(event.data.key));
      if(event.data.type==="htmlhub:activity-pause-request")pauseActivity();
      if(event.data.type==="htmlhub:activity-resume-view")resumeView();
      if(event.data.type==="htmlhub:activity-chat-state"){
        const open=event.data.open===true;
        $("activityChatBtn").setAttribute("aria-pressed",String(open));
        $("activityChatBtn").setAttribute("aria-label",open?"Hide room chat":"Open room chat");
      }
    });

    let lastControlsPaint=-Infinity;
    let lastStaticView="";
    function loop(now){
      if(destroyed)return;
      // A retained, paused iframe needs no physics, drawing, or DOM churn.
      if(activityPaused){if(renderSizeDirty)render();lastFrame=now;requestAnimationFrame(loop);return}
      const elapsedMs=Math.max(0,now-lastFrame),elapsed=Math.min(.05,elapsedMs/1000);lastFrame=now;
      if(!activityPaused&&!modalPaused&&(runState==="playing"||runState==="game-over-impact")){
        comboTime+=elapsedMs;
        finalizeCombo();
        accumulator+=elapsed;
        let steps=0;
        const timeScale=snipeMode?.1:1;
        while(accumulator>=CONFIG.fixedStep&&steps<5){
          physicsStep(CONFIG.fixedStep*timeScale,false);
          accumulator-=CONFIG.fixedStep;steps++;
        }
      }
      aimX=clampAim(targetAimX);
      const staticView=modalPaused?"modal:"+runState:runState==="menu"?"menu":"";
      if(renderSizeDirty||!staticView||staticView!==lastStaticView)render();
      lastStaticView=staticView;
      // Ability timers display tenths. Avoid rewriting identical DOM state
      // sixty times a second; action handlers still refresh immediately.
      if(now-lastControlsPaint>=100){updateControls();lastControlsPaint=now}
      if(pendingCheckout&&!activityPaused)openCheckout();
      requestAnimationFrame(loop);
    }

    function invariantTests(){
      const original=rngState;
      const counts=[0,0,0,0];
      let valid=true;
      for(let i=0;i<100000;i++){const tier=directTier();if(tier<0||tier>3)valid=false;else counts[tier]++}
      rngState=original;
      const enlargedHigh=TIERS.slice(8).every((tier)=>tier.diameter>TIERS[3].diameter&&tier.diameter<TIERS[7].diameter);
      const outlineInset=TIERS.every((tier,index)=>physicalRadius(index)===tier.diameter/2);
      return{nextPoolOnlyBase:valid,nextPoolCounts:counts,enlargedHighTiers:enlargedHigh,outlineColliderInset:outlineInset,baseValues:[...BASE_POINTS],comboLabels:[...COMBO_LABELS]};
    }
    window.__mergeParty={
      leaveActivity,pauseActivity,resumeView,resumeActivity,isPaused:()=>activityPaused,updateAccountPassword,
      debug:{
        TIERS,CONFIG,BASE_CUP,render,bodyShape,effectiveRadius,pairGeometry,
        getState:()=>({simTime,comboTime,snipeMode,runState,activityPaused,modalPaused,aimX,targetAimX,pointerDown,runScore,bestScore,currentEntry,futureQueue:[...futureQueue],queueRevealPending,revealAfterBodyId,balls:balls.map((b)=>({...b})),abilityCounts:{...abilityCounts},cup:{topWidth:cup.topWidth,floorWidth:cup.floorWidth,wallHeight:cup.wallHeight,floorY:cup.floorY,wallsActive:cup.wallsActive,wallsProgress:cup.wallsProgress,wallsEndsAt:cup.wallsEndsAt,quake:cup.quake?{...cup.quake}:null,growthCount:cup.growthCount},shinyReservations:[...shinyReservations.values()],activeCombo,contacts:[...contacts.values()],mergeTransactions:[...mergeTransactions]}),
        reset:resetRun,start:startRun,showMenu:showStartScreen,
        drop:dropCurrent,
        step:(frames=1)=>{for(let i=0;i<frames;i++)physicsStep(CONFIG.fixedStep)},
        spawn:(tier,x=540,y=500,options={})=>{const entry=makeEntry(clamp(Number(tier)||0,0,11));Object.assign(entry,options.entry||{});const body=makeBody(entry,x,y,options);balls.push(body);return body},
        directTier,directTierExcept,comboLabel,
        scheduleShiny,
        useSwap,useQuake,useWalls,toggleSnipe,
        requestCheckout,openCheckout,confirmCheckout,continueRun,triggerGameOver,refreshControls:updateControls,
        invariantTests
      }
    };
    window.addEventListener("pagehide",()=>{void leaveActivity()},{capture:true});
    window.addEventListener("beforeunload",()=>{void leaveActivity()},{capture:true});
    resetRun();
    showStartScreen();
    requestAnimationFrame(loop);
  })();
