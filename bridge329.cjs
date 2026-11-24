'use strict';
/**
 * Terraria329 (user-captured 1.4.6) compatibility experiment.
 * The ReScript codec below targets Terraria326, NOT 329. Decoding samples with it
 * proves structural plausibility only, and NEVER proves 329 semantic equivalence.
 * Do not invent new fields for WorldInfo, TileSection, or NPC Update.
 */
const codec = require('./vendor/terraria-packet.cjs');

const INTERESTING_C2S = new Set([4, 5, 12, 16, 17, 19, 21, 27, 28, 29, 36, 39, 40, 50, 65, 82, 92, 117, 134, 138, 147, 151, 164]);
const INTERESTING_S2C = new Set([7, 20, 21, 22, 23, 27, 28, 29, 32, 54, 56, 60, 65, 82, 86, 88, 91, 92, 97, 107, 129, 136, 139, 151, 155, 162, 163]);
const TILE_EDIT = 17;
const TILE_SQUARE = 20;
const NPC_UPDATE = 23;
const NPC_STRIKE = 28;
const WORLD_INFO = 7;
const MAX_STATS_ENTRIES = 512;

function validateFrame(packet) {
  if (!packet || !Buffer.isBuffer(packet.data) || packet.data.length < 3 || packet.data.length > 65535)
    return {ok:false,reason:'invalid-buffer-or-size'};
  const b=packet.data;
  if (b.readUInt16LE(0)!==b.length || b[2]!==packet.packetType)
    return {ok:false,reason:'invalid-frame-header'};
  return {ok:true};
}

function analyze326Codec(packet, fromServer) {
  const frame = validateFrame(packet);
  if (!frame.ok) return {ok:false,reason:frame.reason};
  let decoded;
  try { decoded=codec.Parser.parseLazy(packet.data,fromServer); }
  catch (e) { return {ok:false,reason:'codec-exception:'+String(e?.message||e).slice(0,80)}; }
  if (decoded?.TAG!=='Ok') return {ok:false,reason:'unknown-to-326:'+String(decoded?._0?.TAG||decoded?._0).slice(0,60)};
  try {
    const content=decoded._0._0.VAL();
    if (content?.TAG==='Ok') return {ok:true,tag:decoded._0.TAG};
    return {ok:false,reason:'invalid-326-layout:'+String(content?._0?.context||'unknown').slice(0,80)};
  } catch (e) {return {ok:false,reason:'layout-exception:'+String(e?.message||e).slice(0,80)};}
}

/** Verify the complete WorldInfo payload can round-trip through the 326 codec,
 * including its tail and dynamic world-name length. No fabricated fields.
 * Must run on actual backend packets, NOT on a guessed 326 sample.
 */
function validateWorldInfoWireCompatibility(packet) {
  const frame=validateFrame(packet);
  if(!frame.ok)return frame;
  if(packet.packetType!==WORLD_INFO)return {ok:false,reason:'not-world-info'};
  if(packet.data.length>4096)return {ok:false,reason:'oversized-world-info'};
  let decoded;
  try { decoded=codec.Parser.parseLazy(packet.data,true); }
  catch(e) {return {ok:false,reason:'decode-exception'};}
  if(decoded?.TAG!=='Ok'||decoded?._0?.TAG!=='WorldInfo')return {ok:false,reason:'decode-failed'};
  let value;
  try {value=decoded._0._0.VAL();}
  catch(e){return {ok:false,reason:'payload-exception'};}
  if(value?.TAG!=='Ok'||!value._0)return {ok:false,reason:'payload-invalid'};
  const world=value._0;
  if(!Number.isInteger(world.maxTilesX)||world.maxTilesX<100||world.maxTilesX>32000||
     !Number.isInteger(world.maxTilesY)||world.maxTilesY<100||world.maxTilesY>32000||
     typeof world.worldName!=='string'||world.worldName.length>128)
    return {ok:false,reason:'world-fields-out-of-range'};
  let encoded;
  try { encoded=codec.WorldInfoPacket.toBuffer(world); }
  catch(e) {return {ok:false,reason:'encode-exception'};}
  if(encoded?.TAG!=='Ok'||!Buffer.isBuffer(encoded._0)||!encoded._0.equals(packet.data))
    return {ok:false,reason:'wire-roundtrip-differs'};
  return {ok:true,reason:'byte-exact-326-codec-roundtrip',worldName:world.worldName};
}

function createCounters() {
 return {tileEditsFrom329:0,tileSquaresTo329:0,npcUpdatesTo329:0,npcStrikesFrom329:0,
  npcDamageAcksTo329:0,worldInfo326To329:0,worldInfoValidated:0,worldInfoRejected:0,layoutSamplesMatched:0,layoutSamplesFailed:0,
  unsafeWorldInfoPassThrough:0,blockedBecauseNoWorldInfoTranslator:0,unsupportedPackets:0};
}

/** Packet data is NEVER modified here. The caller owns the handshake rewrite. */
function observe329({packet,fromServer,state,options,disconnect,warn}) {
  const counters=state.bridge329||(state.bridge329=createCounters());
  const b=validateFrame(packet);
  if(!b.ok){
    counters.layoutSamplesFailed++;
    return {drop:!!options.dropMalformedPackets,reason:b.reason};
  }
  const id=packet.packetType;
  if(!fromServer && id===TILE_EDIT)counters.tileEditsFrom329++;
  if(!fromServer && id===NPC_STRIKE)counters.npcStrikesFrom329++;
  if(fromServer && id===TILE_SQUARE)counters.tileSquaresTo329++;
  if(fromServer && id===NPC_UPDATE)counters.npcUpdatesTo329++;
  if(fromServer && id===162)counters.npcDamageAcksTo329++;

  if(fromServer && id===WORLD_INFO) {
    counters.worldInfo326To329++;
    if(options.mode==='probe' || (options.mode!=='bridge' && options.experimentalHandshakeRewrite && !options.unsafeAllow326WorldInfoTo329)){
      counters.blockedBecauseNoWorldInfoTranslator++;
      const reason='Terraria 1.4.6 (329) WorldInfo is not yet compatible with this Terraria 1.4.5.8 (326) server.';
      if(!state.warnedWorldInfo){state.warnedWorldInfo=true;warn?.('WorldInfo 326 -> 329 translation unavailable; safe disconnect (no fabricated data)');}
      disconnect?.(reason);
      return {drop:true,reason:'WorldInfo-329-translator-missing'};
    }
    if(options.mode==='bridge' && options.experimentalHandshakeRewrite){
      // Verified property of four 329 WorldInfo frames: the 326 codec can decode
      // and re-encode them byte-for-byte. Check EVERY 326 backend WorldInfo too.
      // This is a structural compatibility test, not semantic proof that the
      // Terraria 1.4.6 client renders all game objects correctly.
      let checked;
      try { checked=validateWorldInfoWireCompatibility(packet); }
      catch(error) { checked={ok:false,reason:'validation-exception:'+String(error?.message||error).slice(0,100)}; }
      if(!checked.ok){
        counters.worldInfoRejected++;
        const reason='WorldInfo wire format is not compatible with Terraria 1.4.6 ('+checked.reason+').';
        warn?.('329 WorldInfo blocked: '+checked.reason);
        disconnect?.(reason);
        return {drop:true,reason:'WorldInfo-incompatible-'+checked.reason};
      }
      counters.worldInfoValidated++;
      if(!state.warnedWorldInfo){
        state.warnedWorldInfo=true;
        warn?.('329 WorldInfo structurally validated and passed through unchanged; live gameplay still experimental.');
      }
    }
    if(options.mode==='passthrough-test' && options.experimentalHandshakeRewrite){
      counters.unsafeWorldInfoPassThrough++;
      if(!state.warnedWorldInfo){state.warnedWorldInfo=true;warn?.('329 test-only passthrough: 326 WorldInfo sent unchanged; this is NOT compatibility translation and client may reject it.');}
    }
  }
  // Sampling reduces cost during busy NPC fights. Every frame still goes through the actual Dimensions core.
  const isInteresting=(fromServer?INTERESTING_S2C:INTERESTING_C2S).has(id);
  if(!isInteresting) {counters.unsupportedPackets++;return {drop:false,reason:'not-in-audit-profile'};}
  const sampleEvery = Math.max(1,Math.min(10000,Math.trunc(Number(options.sampleEvery)||40)));
  const always = id===TILE_EDIT || id===NPC_STRIKE || id===WORLD_INFO;
  if(!always){const n=(state.auditSampleCount=(state.auditSampleCount||0)+1);if(n%sampleEvery!==0)return {drop:false,reason:'sample-skip'};}
  const audited=analyze326Codec(packet,fromServer);
  if(audited.ok)counters.layoutSamplesMatched++;
  else {
    counters.layoutSamplesFailed++;
    if((state.auditWarnings||0)<6){state.auditWarnings=(state.auditWarnings||0)+1;warn?.(`329 packet id=${id} dir=${fromServer?'S2C':'C2S'} cannot be parsed by 326 codec: ${audited.reason}`);}
  }
  // This is explicitly OBSERVATION, not a wire-format converter. Leave payload unchanged.
  // An unknown 329 packet must not be silently changed or guessed.
  return {drop:false,reason:audited.ok?'decoded-as-326-layout':'unverified-329-layout'};
}

module.exports={validateFrame,analyze326Codec,validateWorldInfoWireCompatibility,createCounters,observe329,INTERESTING_C2S,INTERESTING_S2C};
