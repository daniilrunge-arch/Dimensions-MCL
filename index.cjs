'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {readVersion,classify,isFrameValid,STAGE_C2S,STAGE_S2C,readPlatformInfo,rewriteConnectVersion}=require('./protocol.cjs');
const {TransportFlow}=require('./transport.cjs');
const {translatePacket}=require('./translator.cjs');
const {observe329}=require('./bridge329.cjs');
const ORIGINAL_PROTOCOL=Symbol.for('rext.dimensions-mcl.original-terraria-protocol');
const DEFAULT={enabled:true,mode:'handshake-compatibility',expectedProtocol:'Terraria326',logConnections:true,logPlatformInfo:true,logStageChanges:false,logWarnings:true,logDisconnects:true,logWorldSwitches:true,rejectUnsupportedOnConnect:true,unsupportedMessage:'This 329 client requires an experimental protocol bridge; use the test-only profile on a separate server.',npcRateWarningPerSecond:450,warnAfterSecondsWithoutWorldInfo:25,summaryIntervalSeconds:60,showIP:false,showPlayerName:false,statsFile:{enabled:false,path:'./logs/dimensions-mcl-stats.json'},worldInfoCapture:{enabled:false,path:'./logs/mcl-worldinfo-326.ndjson',maxSamplesPerSession:4},transport:{},performance:{highConcurrency:false},compatibility:{enabled:true,targetProtocol:'Terraria326',allowedClientVersions:['Terraria329'],handshakeOnly:false,fullTranslation:true,logRewrites:true},protocol329:{mode:'reject',enabled:false,experimentalHandshakeRewrite:false,unsafeAllow326WorldInfoTo329:false,sampleEvery:40,dropMalformedPackets:true}};
const safeInt=(v,min,max,fallback)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Math.trunc(Number(v)))):fallback;
function loadConfig(file=path.join(__dirname,'config.json')) {
  const input=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const c={...DEFAULT,...input,statsFile:{...DEFAULT.statsFile,...input.statsFile},worldInfoCapture:{...DEFAULT.worldInfoCapture,...input.worldInfoCapture},transport:input.transport||{},performance:{...DEFAULT.performance,...input.performance},compatibility:{...DEFAULT.compatibility,...input.compatibility},protocol329:{...DEFAULT.protocol329,...input.protocol329}};
  if(!['same-protocol-passthrough','handshake-compatibility'].includes(c.mode)) throw new Error('Unknown MobileCLP mode');
  if(c.compatibility.targetProtocol!=='Terraria326') throw new Error('Only Terraria326 backend supported');
  // Fixed allowlist: 325 is a PROTOCOL CANDIDATE inferred from world revision, not verified handshake.
  if(!Array.isArray(c.compatibility.allowedClientVersions) || c.compatibility.allowedClientVersions.some(v=>!['Terraria319','Terraria325','Terraria329'].includes(v))) throw new Error('Only Terraria319, Terraria325, Terraria329 are supported by this adapter');
  if(c.compatibility.fullTranslation!==true && c.compatibility.handshakeOnly!==true) throw new Error('Select fullTranslation or handshakeOnly');
  // 329 has NO verified WorldInfo converter; keep this strictly opt-in.
  const mode=c.protocol329.mode;
  if(!['reject','probe','passthrough-test','bridge'].includes(mode)) throw new Error('protocol329.mode must be reject, probe, passthrough-test or bridge');
  const testing=mode!=='reject';
  if(testing && (!c.protocol329.enabled || !c.protocol329.experimentalHandshakeRewrite || !c.compatibility.allowedClientVersions.includes('Terraria329')))
    throw new Error('329 probe requires enabled=true, experimentalHandshakeRewrite=true and Terraria329 in allowlist');
  if(mode==='reject' && (c.protocol329.enabled || c.protocol329.experimentalHandshakeRewrite || c.protocol329.unsafeAllow326WorldInfoTo329 || c.compatibility.allowedClientVersions.includes('Terraria329')))
    throw new Error('329 reject profile must not enable handshake translation');
  if(mode==='probe' && c.protocol329.unsafeAllow326WorldInfoTo329) throw new Error('329 probe must reject incompatible WorldInfo');
  if(mode==='passthrough-test' && !c.protocol329.unsafeAllow326WorldInfoTo329) throw new Error('329 passthrough-test requires explicit unsafeAllow326WorldInfoTo329=true');
  if(mode==='bridge' && c.protocol329.unsafeAllow326WorldInfoTo329) throw new Error('329 bridge validates WorldInfo; unsafeAllow326WorldInfoTo329 must remain false');
  c.summaryIntervalSeconds=safeInt(c.summaryIntervalSeconds,10,3600,60);
  c.npcRateWarningPerSecond=safeInt(c.npcRateWarningPerSecond,100,10000,450);
  c.warnAfterSecondsWithoutWorldInfo=safeInt(c.warnAfterSecondsWithoutWorldInfo,5,300,25);
  return c;
}
class DimensionsMCL {
  constructor(logging) {
    this.name='Dimensions-MCL';
    this.version='v3.7.0-326-native-329-mobile-bridge';
    this.author='Custom';
    this.reloadable=false;
    this.logging=logging||console;
    this.config=loadConfig();
    this.fastPath=this.config.performance.highConcurrency === true;
    this.flow=new TransportFlow(this.logging,{...this.config.transport,enabled:this.config.enabled&&this.config.transport.enabled!==false},'S2C','Dimensions-MCL');
    this.sessions=new Map();
    this.nextId=1;
    this.counters={connections:0,modern326:0,legacy:0,unverified:0,finished:0,worldSwitches:0,npcUpdates:0,npcRateWarnings:0,disconnects:0,malformedFrames:0,platformInfoPackets:0,handshakesRewritten:0,legacyPassThrough:0,legacy319Rewritten:0,candidate325Rewritten:0,packetsConverted:0,packetsDiscarded:0,translationErrors:0,observed329:0,experimental329Rewrites:0};
    this.priorPacketHandlers={
      clientHandler:{handlePacket:(client,packet)=>this.onClientPacket(client,packet)},
      serverHandler:{handlePacket:(server,packet,source)=>this.onServerPacket(server,packet,source)}
    };
    this.postPacketHandlers={serverHandler:{handlePacket:(server,packet,source)=>this.onServerTranslate(server,packet,source)}};
    if(this.config.enabled){
      this.log(`loaded: Terraria326 native unchanged; Terraria329 per-session wire bridge=${this.config.protocol329.mode} (experimental); legacy conversion opt-in; fakeVersion MUST be disabled; core world-switch cleanup preserved.`);
      this.lastStatsWriteAt=0;
      this.timer=setInterval(()=>this.maintenance(),5000);
      this.timer.unref?.();
    }
  }
  log(str){try{const message='[Dimensions-MCL] '+str; if(typeof this.logging.info==='function')this.logging.info(message); else console.log(message);}catch{}}
  get(client){
    let s=this.sessions.get(client);
    if(!s){s={id:this.nextId++,createdAt:Date.now(),worldStartedAt:Date.now(),worldIndex:0,lastBackendSocket:null,lastBackendName:null,version:null,classification:'unknown',stage:'connected',lastStageChange:Date.now(),seenWorldInfo:false,seenFinish:false,platform:'unreported',platformPlayerId:null,originalClientVersion:null,handshakeRewritten:false,receivedSections:0,receivedPackets:0,sentPackets:0,npcSecond:0,npcCount:0,npcWarnedSecond:-1,unverifiedWarnings:0,timeoutWarned:false,malformedWarned:false};this.sessions.set(client,s);}
    return s;
  }
  show(client,s){let txt=`session=${s.id}`;if(this.config.showIP&&client?.ip)txt+=' ip='+String(client.ip).slice(0,64);if(this.config.showPlayerName&&typeof client?.player?.name==='string')txt+=' name='+JSON.stringify(client.player.name.slice(0,32));return txt;}
  warn(msg){if(this.config.logWarnings)this.log('WARNING '+msg);}
  updateStage(client,s,stage){
    if(s.stage===stage)return;
    s.stage=stage;s.lastStageChange=Date.now();
    if(this.config.logStageChanges)this.log(`stage ${this.show(client,s)} ${stage}`);
  }
  observeBackend(client,s){
    const socket=client?.server?.socket;
    if(!socket)return;
    if(s.lastBackendSocket===socket)return;
    const previous=s.lastBackendName;
    const current=String(client?.server?.name||'unknown');
    if(s.lastBackendSocket){
      this.counters.worldSwitches++;s.worldIndex++;
      s.worldStartedAt=Date.now();s.seenWorldInfo=false;s.seenFinish=false;
      s.receivedSections=0;s.timeoutWarned=false;s.malformedWarned=false;
      s.stage='backend-switched';s.lastStageChange=Date.now();
      s.npcCount=0;s.npcSecond=0;
      if(this.config.logWorldSwitches)this.log(`switch ${this.show(client,s)} ${previous}->${current} world=${s.worldIndex} version=${s.version||'?'} proxyVersion=${client.version||'?'}`);
      if(s.originalClientVersion && !this.config.compatibility.fullTranslation)
        this.warn(`legacy version ${s.originalClientVersion}: fullTranslation disabled; world/NPC mismatch may break switch`);
    }
    s.lastBackendSocket=socket;s.lastBackendName=current;
  }
  onClientPacket(client,packet){
    if(!this.config.enabled||!client||!packet)return false;
    // Process only handshake, platform info and connection finish during peak load.
    // Per-packet counts are intentionally sampled/incomplete in this profile.
    if(this.fastPath && packet.packetType!==1 && packet.packetType!==163 && packet.packetType!==49){
      return this.translateClient(client,packet);
    }
    const s=this.get(client);this.observeBackend(client,s);s.sentPackets++;
    if(!isFrameValid(packet)){
      this.counters.malformedFrames++;
      if(!s.malformedWarned){s.malformedWarned=true;this.warn(`invalid-frame ${this.show(client,s)}; not modified`);}
      return false;
    }
    const id=packet.packetType;
    if(id===1){
      const version=readVersion(packet.data);
      if(client?.options?.fakeVersion?.enabled === true && !s.warnedGlobalFakeVersion){
        s.warnedGlobalFakeVersion=true;
        this.warn('Dimensions options.fakeVersion.enabled=true overrides ALL client versions. Set options.fakeVersion.enabled=false for PC326 + mobile329 mixed sessions.');
      }
      // Dimensions synthesizes a Terraria326 ConnectRequest on every backend
      // switch. Do not treat that as a new physical client or lose its real
      // 319/325 protocol identity, otherwise later translations stop working.
      const isSyntheticReconnect = s.handshakeRewritten && version==='Terraria326';
      if(version&&version!==s.version&&!isSyntheticReconnect){
        s.version=version;s.classification=classify(version);this.counters.connections++;
        client[ORIGINAL_PROTOCOL]=version;
        if(s.classification==='same-protocol-326')this.counters.modern326++;
        if(version==='Terraria329')this.counters.observed329++;
        else if(s.classification==='legacy-mcl-incompatible')this.counters.legacy++;
        else this.counters.unverified++;
        if(this.config.logConnections)this.log(`connect ${this.show(client,s)} version=${version} classification=${s.classification}`);
        if(version==='Terraria329') this.warn(`Terraria329 (1.4.6): bridge mode=${this.config.protocol329.mode}. Wire-compatibility based on fully decoded captured packets. Requires game test on isolated TLS/TShock.`);
        if(s.classification!=='same-protocol-326' && version!=='Terraria319' && version!=='Terraria325' && version!=='Terraria329')
          this.warn(`unsupported/unverified handshake ${this.show(client,s)} ${version}: no translation; original Dimensions decides connection`);
      }
    }
    // Production guard. Experimental 329 connects only with explicit per-client opt-in.
    if(id===1 && s.version==='Terraria329' && this.config.protocol329.mode==='reject'){
      if(!s.rejectedUnsupported){
        s.rejectedUnsupported=true;
        if(typeof client.disconnect==='function' && !client.disconnecting){
          client.disconnect(String(this.config.unsupportedMessage||DEFAULT.unsupportedMessage).slice(0,240));
        }
      }
      return true;
    }
    // This runs before Dimensions parses and forwards the first packet.
    // On successful rewrite, Dimensions records client.version = Terraria326,
    // which it also uses for newly created backend connections after /dim switch.
    if(id===1 && (s.version==='Terraria319'||s.version==='Terraria325'||s.version==='Terraria329') && !s.handshakeRewritten){
      if(this.config.mode==='handshake-compatibility' && this.config.compatibility.enabled===true &&
         this.config.compatibility.allowedClientVersions.includes(s.version) && client.version==='unknown' &&
         (s.version!=='Terraria329' || (this.config.protocol329.enabled && this.config.protocol329.experimentalHandshakeRewrite))){
        const patched=rewriteConnectVersion(packet.data,s.version,this.config.compatibility.targetProtocol);
        if(patched){
          packet.data=patched;
          s.originalClientVersion=s.version;
          s.handshakeRewritten=true;
          this.counters.handshakesRewritten++;
          if(s.version==='Terraria329'){this.counters.experimental329Rewrites++;this.log('329 handshake rewritten per-client; gameplay packets remain byte-identical; WorldInfo has structural validation before forwarding.');}
          if(s.version==='Terraria319')this.counters.legacy319Rewritten++;
          if(s.version==='Terraria325')this.counters.candidate325Rewritten++;
          if(this.config.compatibility.logRewrites) this.log(`compat-handshake ${this.show(client,s)} ${s.version} -> Terraria326 (wireLayoutValidation=${s.version==='Terraria329'}; 329 gameplay remains experimental)`);
        }
      }else this.counters.legacyPassThrough++;
    }
    if(id===163){
      const info=readPlatformInfo(packet);
      if(info){
        this.counters.platformInfoPackets++;
        if(s.platform!==info.platform || s.platformPlayerId!==info.playerId){
          s.platform=info.platform;s.platformPlayerId=info.playerId;
          if(this.config.logPlatformInfo)this.log(`platform-info ${this.show(client,s)} platform=${info.platform} (protocol service ID, not device OS)`);
        }
      } else this.warn(`invalid-platform-info ${this.show(client,s)}; ignored; original packet unmodified`);
    }
    if(STAGE_C2S[id])this.updateStage(client,s,STAGE_C2S[id]);
    // All frames, even unsupported versions, continue to ORIGINAL Dimensions handlers unchanged.
    return this.translateClient(client,packet);
  }
  translateClient(client,packet){
    if(!this.config.compatibility.enabled||!this.config.compatibility.fullTranslation||packet?.packetType===1)return false;
    const s=this.sessions.get(client);
    if(!s?.handshakeRewritten||!s.originalClientVersion)return false;
    if(s.originalClientVersion==='Terraria329'){
      const result=observe329({packet,fromServer:false,state:s,options:this.config.protocol329,warn:(m)=>this.warn(m)});
      return !!result.drop;
    }
    return this.translateWithResults(s.originalClientVersion,packet,false,client);
  }
  onServerTranslate(server,packet,_source){
    if(!this.config.enabled||!this.config.compatibility.enabled||!this.config.compatibility.fullTranslation||!server?.client)return false;
    const s=this.sessions.get(server.client);
    if(!s?.handshakeRewritten||!s.originalClientVersion)return false;
    if(s.originalClientVersion==='Terraria329')return false; // handled in pre-hook; do not mutate twice
    return this.translateWithResults(s.originalClientVersion,packet,true,server.client);
  }
  translateWithResults(version,packet,fromServer,client){
    const result=translatePacket(version,packet,fromServer);
    if(result.action==='converted'){this.counters.packetsConverted++;return false;}
    if(result.action==='drop'){
      this.counters.packetsDiscarded++;
      if(result.reason!=='not-in-destination-protocol'){
        this.counters.translationErrors++;
        if(this.counters.translationErrors<=12)this.warn(`conversion-error ${this.show(client,this.get(client))} direction=${fromServer?'S2C':'C2S'} packet=${packet?.packetType} reason=${result.reason}`);
      }
      return true;
    }
    return false;
  }
  captureWorldInfo(client,s,packet){
    const cfg=this.config.worldInfoCapture;
    if(!cfg?.enabled||packet.packetType!==7||!isFrameValid(packet))return;
    const n=s.worldInfoDumpCount||0;
    const limit=safeInt(cfg.maxSamplesPerSession,1,32,4);
    if(n>=limit)return;
    s.worldInfoDumpCount=n+1;
    try{
      const target=path.resolve(process.cwd(),cfg.path||'./logs/mcl-worldinfo-326.ndjson');
      fs.mkdirSync(path.dirname(target),{recursive:true});
      const entry={date:new Date().toISOString(),session:s.id,version:s.originalClientVersion||s.version||null,
        backend:s.lastBackendName||null,packetId:7,length:packet.data.length,hex:packet.data.toString('hex')};
      fs.appendFileSync(target,JSON.stringify(entry)+'\n',{mode:0o600});
      this.log(`WorldInfo capture session=${s.id} backend=${s.lastBackendName||'?'} len=${packet.data.length} saved=${target}`);
    }catch(error){if(n===0)this.warn(`WorldInfo capture failed: ${String(error?.message||error)}`);}
  }
  onServerPacket(server,packet,source){
    if(!this.config.enabled||!server?.client||!packet)return false;
    if(source===1)return false; // Ignore synthetic packets generated by Dimensions.
    // No per-movement session lookups or frame validation in the fast profile.
    if(this.fastPath && packet.packetType!==3 && packet.packetType!==7 && packet.packetType!==9 && packet.packetType!==10 && packet.packetType!==129)return false;
    const client=server.client,s=this.get(client);this.observeBackend(client,s);s.receivedPackets++;
    // Capture BEFORE experimental 329 safety gate rejects the incompatible 326 packet.
    if(packet.packetType===7)this.captureWorldInfo(client,s,packet);
    // Do this BEFORE core Dimensions parses or forwards the backend frame.
    if(s.handshakeRewritten && s.originalClientVersion==='Terraria329'){
      const result=observe329({packet,fromServer:true,state:s,options:this.config.protocol329,
        disconnect:(reason)=>{if(typeof client.disconnect==='function'&&!client.disconnecting)client.disconnect(reason);},
        warn:(m)=>this.warn(m)});
      if(result.drop)return true;
    }
    if(!isFrameValid(packet)){
      this.counters.malformedFrames++;
      if(!s.malformedWarned){s.malformedWarned=true;this.warn(`invalid-server-frame ${this.show(client,s)}; not modified`);}
      return false;
    }
    if(packet.packetType===7)s.seenWorldInfo=true;
    if(packet.packetType===10)s.receivedSections++;
    if(packet.packetType===23){
      this.counters.npcUpdates++;
      const second=Math.floor(Date.now()/1000);
      if(second!==s.npcSecond){s.npcSecond=second;s.npcCount=0;}
      s.npcCount++;
      if(s.npcCount>=this.config.npcRateWarningPerSecond&&s.npcWarnedSecond!==second){
        s.npcWarnedSecond=second;this.counters.npcRateWarnings++;
        this.warn(`npc-update-rate ${this.show(client,s)} backend=${s.lastBackendName} updates/s>=${s.npcCount}; packets left intact`);
      }
    }
    if(packet.packetType===129&&!s.seenFinish){s.seenFinish=true;this.counters.finished++;}
    if(STAGE_S2C[packet.packetType])this.updateStage(client,s,STAGE_S2C[packet.packetType]);
    return false;
  }
  socketConnectPostHandler(socket){this.flow.socketConnect(socket);}
  clientConnectEvent(client){this.flow.clientConnect(client);}
  clientDisconnectEvent(client){this.flow.disconnect(client);}
  sendPacketToClientEvent(client,buf){this.flow.toClient(client,buf);}
  socketClosePostHandler(_socket,client){
    this.flow.socketClose(_socket,client);
    const s=this.sessions.get(client);if(!s)return;
    this.counters.disconnects++;
    if(this.config.logDisconnects)this.log(`disconnect ${this.show(client,s)} version=${s.version||'?'} lastStage=${s.stage} platform=${s.platform} worldInfo=${s.seenWorldInfo} sections=${s.receivedSections} packetsIn=${s.sentPackets} packetsOut=${s.receivedPackets}`);
    this.sessions.delete(client);
  }
  snapshot(){
    return {extension:this.name,version:this.version,mode:this.config.mode,highConcurrency:this.fastPath,packetCountsComplete:!this.fastPath,deviceIdentification:'platform-service-packet-163-when-present-not-device-OS',legacyTranslation:this.config.compatibility.allowedClientVersions.some(v=>v==='Terraria319'||v==='Terraria325')?'optional 1456/1457 converters':'disabled by default',protocol329:{...this.config.protocol329,supportedWorldInfoTranslation:false,observedWireCompatibleWorldInfo:this.config.protocol329.mode==='bridge'},handshakesRewritten:this.counters.handshakesRewritten,expectedProtocol:this.config.expectedProtocol,transport:this.flow.snapshot(),generatedAt:new Date().toISOString(),active:this.sessions.size,counters:{...this.counters},sessions:[...this.sessions.values()].map(s=>({id:s.id,version:s.version,worldIndex:s.worldIndex,backend:s.lastBackendName,handshakeRewritten:s.handshakeRewritten,classification:s.classification,stage:s.stage,platform:s.platform,seenWorldInfo:s.seenWorldInfo,seenFinish:s.seenFinish,receivedSections:s.receivedSections,sentPackets:s.sentPackets,receivedPackets:s.receivedPackets,bridge329:s.bridge329||null}))};
  }
  maintenance(){
    const now=Date.now();
    for(const [client,s] of this.sessions){
      this.observeBackend(client,s);
      if(s.version&& !s.seenWorldInfo && !s.timeoutWarned && now-s.worldStartedAt>this.config.warnAfterSecondsWithoutWorldInfo*1000){
        s.timeoutWarned=true;this.warn(`no-WorldInfo-after-${this.config.warnAfterSecondsWithoutWorldInfo}s ${this.show(client,s)} version=${s.version} lastStage=${s.stage}`);
      }
    }
    if(!this.config.statsFile.enabled || (now-this.lastStatsWriteAt < this.config.summaryIntervalSeconds*1000))return;
    this.lastStatsWriteAt=now;
    try{
      const target=path.resolve(process.cwd(),this.config.statsFile.path),temp=target+'.tmp';
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(temp,JSON.stringify(this.snapshot(),null,2)+'\n',{mode:0o600});fs.renameSync(temp,target);
    }catch(e){this.warn(`failed to write stats: ${e.message}`);}
  }
  load(_storage){}
  unload(){this.flow.unload();if(this.timer)clearInterval(this.timer);this.sessions.clear();}
}
module.exports.default=DimensionsMCL;
module.exports.DimensionsMCL=DimensionsMCL;
module.exports.loadConfig=loadConfig;
