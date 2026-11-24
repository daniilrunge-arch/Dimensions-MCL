'use strict';

// Vendored converter bundle from the user-supplied rescript-terrariapacket archive.
// The result is always either a modified valid packet, the original unchanged
// packet, or an explicit drop for packets that do not exist in the target.
const codecs = require('./vendor/terraria-packet.cjs');
const LEGACY = Object.freeze({
  Terraria319: { converter: codecs.ParserConverterV1456, packet: codecs.PacketV1456 },
  Terraria325: { converter: codecs.ParserConverterV1457, packet: codecs.PacketV1457 }
});

function translatePacket(version, packet, fromServer) {
  const legacy = LEGACY[version];
  if (!legacy) return { action: 'passthrough', reason: 'not-legacy' };
  if (!packet || !Buffer.isBuffer(packet.data) || packet.data.length < 3 ||
      packet.data.readUInt16LE(0) !== packet.data.length || packet.data[2] !== packet.packetType)
    return { action: 'drop', reason: 'invalid-frame' };
  const convert = fromServer ? legacy.converter.convertFromLatestIfNeeded : legacy.converter.convertToLatestIfNeeded;
  let result;
  try { result = convert(packet.data, fromServer); }
  catch (error) { return { action: 'drop', reason: `converter-threw: ${error.message}` }; }
  if (!result || result.TAG !== 'Ok') return { action: 'drop', reason: `converter-error: ${String(result?._0?.TAG || result?._0 || 'unknown')}` };
  const decision = result._0;
  if (decision === 'PacketStructureIsSame') return { action: 'passthrough' };
  if (decision === 'DiscardAsNotExists') return { action: 'drop', reason: 'not-in-destination-protocol' };
  if (!decision || (decision.TAG !== 'ConvertedToLatest' && decision.TAG !== 'ConvertedFromLatest'))
    return { action: 'drop', reason: 'unknown-converter-result' };
  let serialized;
  try {
    serialized = fromServer
      ? legacy.packet.toBuffer(decision._0, true)
      : codecs.Packet.toBuffer(decision._0, false);
  } catch (error) { return { action: 'drop', reason: `serializer-threw: ${error.message}` }; }
  if (serialized?.TAG !== 'Ok' || !Buffer.isBuffer(serialized._0))
    return { action: 'drop', reason: `serializer-error: ${String(serialized?._0?.TAG || serialized?._0 || 'unknown')}` };
  const data = serialized._0;
  if (data.length < 3 || data.readUInt16LE(0) !== data.length)
    return { action: 'drop', reason: 'invalid-serialized-frame' };
  packet.data = data;
  packet.packetType = data[2];
  return { action: 'converted', type: packet.packetType };
}

module.exports = { translatePacket, LEGACY };
