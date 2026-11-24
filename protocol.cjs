'use strict';
// Minimal protocol observations for Dimensions' 1.4.5.8 protocol 326.
// Complete frame layout: [length LE uint16][packet ID uint8][payload...].
// Do not rewrite or forward private payloads to logs.
const SUPPORTED = new Set(['Terraria326']);
const NEXT_146_CAPTURED = new Set(['Terraria329']); // observed in user-supplied 2026-11-24 capture
const HISTORICAL_MOBILE = new Set(['Terraria155', 'Terraria156']);
const LEGACY_1456 = new Set(['Terraria319']); // Terraria 1.4.5.6, verified ConnectRequest
// 1.4.5.7 has world file revision 325; matching handshake code remains a candidate until captured.
const LEGACY_1457_CANDIDATE = new Set(['Terraria325']);
const STAGE_C2S = Object.freeze({1:'connect-request', 4:'player-info', 5:'inventory', 8:'request-world-sections',12:'spawn-request',13:'player-update',49:'connection-complete'});
const STAGE_S2C = Object.freeze({2:'disconnect',3:'assigned-player-id',6:'connection-accepted',7:'world-info',9:'status',10:'world-section',11:'tile-frame',12:'spawn',129:'connection-finished'});

function readVersion(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 5 || frame[2] !== 1) return null;
  // Some packet handlers attach the full frame; trust only complete frame lengths.
  if (frame.readUInt16LE(0) !== frame.length) return null;
  let pos=3, len=0, shift=0;
  for(let i=0;i<5;i++) {
    if(pos >= frame.length) return null;
    const v=frame[pos++];
    len |= (v & 127) << shift;
    if(!(v & 128)) {
      if(len < 1 || len > 64 || pos+len !== frame.length) return null;
      const version=frame.toString('utf8',pos,pos+len);
      return /^[A-Za-z0-9_.-]{1,64}$/.test(version) ? version : null;
    }
    shift+=7;
  }
  return null;
}
function classify(version) {
  if (SUPPORTED.has(version)) return 'same-protocol-326';
  if (NEXT_146_CAPTURED.has(version)) return 'new-1.4.6-protocol-329-experimental';
  if (LEGACY_1456.has(version)) return 'legacy-1.4.5.6-handshake-only';
  if (LEGACY_1457_CANDIDATE.has(version)) return 'legacy-1.4.5.7-candidate-handshake-only';
  if (HISTORICAL_MOBILE.has(version)) return 'legacy-mcl-incompatible';
  return version ? 'unverified-protocol' : 'unknown';
}
function isFrameValid(packet) {
  if (!packet || !Buffer.isBuffer(packet.data) || packet.data.length < 3) return false;
  const d=packet.data;
  return d.readUInt16LE(0) === d.length && d[2] === packet.packetType;
}

// Terraria 1.4.5.8 protocol packet 163 (PlayerPlatformInfo).
// Field layout checked against the uploaded rescript-terrariapacket source:
// [length uint16 LE=5][id=163][playerId byte][platformId byte].
// The values are service platform identifiers, NOT a reliable OS or mobile flag.
const PLATFORM_NAMES = Object.freeze([
  'None','Stadia','XBO','PSN','Editor','Nintendo','Steam','GameCenter'
]);
function readPlatformInfo(packet) {
  if(!isFrameValid(packet) || packet.packetType!==163 || packet.data.length!==5) return null;
  const playerId=packet.data[3], platformCode=packet.data[4];
  if(platformCode>=PLATFORM_NAMES.length) return null;
  return {playerId, platformCode, platform:PLATFORM_NAMES[platformCode]};
}
module.exports={SUPPORTED,NEXT_146_CAPTURED,HISTORICAL_MOBILE,LEGACY_1457_CANDIDATE,STAGE_C2S,STAGE_S2C,readVersion,classify,isFrameValid,PLATFORM_NAMES,readPlatformInfo};

// Opt-in, handshake-only compatibility: preserve packet format and all bytes except
// the version digits. This is NOT general packet translation. Never touch packets
// other than a valid 1/ConnectRequest frame with an explicitly allowed version.
function rewriteConnectVersion(frame, fromVersion, targetVersion = 'Terraria326') {
  if (!Buffer.isBuffer(frame) || readVersion(frame) !== fromVersion) return null;
  if (!/^Terraria\d{3}$/.test(fromVersion) || targetVersion !== 'Terraria326') return null;
  const from = Buffer.from(fromVersion, 'utf8');
  const to = Buffer.from(targetVersion, 'utf8');
  if (from.length !== to.length) return null; // no frame-size ambiguity
  const offset = frame.length - from.length;
  if (offset < 4 || frame[offset-1] !== from.length) return null;
  const copy = Buffer.from(frame);
  to.copy(copy, offset);
  if (copy.readUInt16LE(0) !== copy.length || readVersion(copy) !== targetVersion) return null;
  return copy;
}
module.exports.LEGACY_1456 = LEGACY_1456;
module.exports.rewriteConnectVersion = rewriteConnectVersion;
