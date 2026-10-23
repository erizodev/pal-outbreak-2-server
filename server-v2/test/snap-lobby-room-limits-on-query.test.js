import assert from 'node:assert/strict';
import test from 'node:test';

import { TimingWheel } from '../src/transport/timing-wheel.js';
import { createV1ObservedAreaDirectory } from '../src/udp/area-directory.js';
import { LOBBY_OPCODE, ROOM_STATE_SUB } from '../src/udp/snap-lobby-codec.js';
import { SnapLobbySessions } from '../src/udp/snap-lobby-sessions.js';

/**
 * SNAP_ROOM_LIMITS_ON_QUERY. Owner run 2026-10-22: the in-room header read
 * "1 of 0" solo and "3 of 0" with two players. The op-0x10 sub-5 header is
 * absolute (FUN_005bc0e0 copies max/current into 0x6ff2b4/0x6ff2b3), taken only
 * in-room, and 0x6ff2b4 is zeroed on every screen rebuild - so the create-time
 * push is lost. The in-room op-0a query follows the screen-4 rebuild, so the
 * header is re-asserted there, from presence.
 */

const HEADER = 0x10;
const HOST_TOKEN = 0x02f807d0;
const JOINER_TOKEN = 0x028107d0;

function reliableDatagram({ opcode, sequence, payload = Buffer.alloc(0), who = 0xb000, token }) {
  const inner = HEADER + payload.length;
  const d = Buffer.alloc(inner + 4);
  d.writeUInt16BE(who | inner, 0);
  d.writeUInt8(opcode, 3);
  d.writeUInt32BE(token, 4);
  d.writeUInt32BE(sequence, 8);
  payload.copy(d, HEADER);
  Buffer.from([0xba, 0x47, 0x66, 0x11]).copy(d, inner);
  return d;
}

function boxKeyOf(boxId) {
  const { records } = createV1ObservedAreaDirectory().records(() => 0);
  return records.find((e) => e.name.endsWith(String(boxId).padStart(2, '0'))).key;
}

function harness(t, extra = {}) {
  const wheel = new TimingWheel({
    tickMs: 100, clock: () => 1_000,
    setInterval: () => ({ unref() {} }), clearInterval: () => {}, onError: () => {}
  });
  wheel.start();
  const table = new SnapLobbySessions({
    wheel, areaDirectory: createV1ObservedAreaDirectory(), keepaliveKey: 'SNAP-SWAN',
    joinLadder: true, rosterToJoiner: true, memberIdToken: true, hostReseat: true,
    charstatsSeed: true, op0aCount0: true, roomLimitsOnQuery: true, ...extra
  });
  t.after(() => { table.closeAll(); wheel.stop(); });
  const open = (routingKey, identity, token) => {
    const sent = [];
    const session = table.open({
      routingKey, loginIdentity: identity, endpointToken: token,
      outboundSequence: 1, inboundReceiveBase: 0, latencyTicks: 1600,
      transmit: (d, ctx) => sent.push({ datagram: d, ...ctx })
    });
    let seq = 0;
    const send = (opcode, payload, who = 0xb000) =>
      session.accept(reliableDatagram({ opcode, sequence: seq++, payload, who, token }));
    return { session, sent, send };
  };
  return { open };
}

function enter(c, boxId = 1) {
  const key = Buffer.alloc(4); key.writeUInt32BE(boxKeyOf(boxId));
  c.send(LOBBY_OPCODE.AREA_ENTER, key);
}
function createRoom(c) {
  const result = c.send(LOBBY_OPCODE.CREATE_ROOM, Buffer.alloc(0x2c)).handled[0];
  assert.ok(result.handle > 0);
  return result.handle;
}
function joinRoom(c, handle) {
  const body = Buffer.alloc(0x18); body.writeUInt32LE(handle, 0);
  c.send(LOBBY_OPCODE.AREA_ENTER, body, 0xa000);
}
function queryMembers(c, handle) {
  const body = Buffer.alloc(4); body.writeUInt32BE(handle);
  c.send(LOBBY_OPCODE.MEMBER_LIST, body, 0xa000);
}

/** The sub-5 MAX / CURRENT headers in a sent list, as { max, current, sequence }. */
function roomLimits(sent, since = 0) {
  return sent.slice(since).filter((e) =>
    e.datagram[3] === LOBBY_OPCODE.ROOM_STATE &&
    e.datagram.length === HEADER + 0x10 + 4 &&
    e.datagram[HEADER + 0x08] === ROOM_STATE_SUB.ROOM_LIMITS)
    .map((e) => ({
      max: e.datagram[HEADER + 0x0c],
      current: e.datagram[HEADER + 0x0d],
      sequence: e.datagram.readUInt32BE(8),
      who: e.datagram.readUInt16BE(0) & 0xfc00
    }));
}

test('solo host: the in-room member query re-asserts "1 of 4" after the member-list reply', (t) => {
  const rig = harness(t);
  const host = rig.open('192.0.2.76:2000', 'host', HOST_TOKEN);
  enter(host);
  const handle = createRoom(host);
  const before = host.sent.length;
  queryMembers(host, handle);
  const after = host.sent.slice(before);
  const limits = roomLimits(after);
  assert.equal(limits.length, 1, 'one header per in-room query');
  assert.deepEqual({ max: limits[0].max, current: limits[0].current }, { max: 4, current: 1 });
  assert.equal(limits[0].who, 0xa000, 'room channel, DATA clear - the create-time header shape');
  const reply = after.find((e) => e.datagram[3] === LOBBY_OPCODE.MEMBER_LIST);
  assert.ok(reply.datagram.readUInt32BE(8) < limits[0].sequence, 'query reply first');
});

test('the header is absolute: repeated polls keep re-asserting the same count', (t) => {
  const rig = harness(t);
  const host = rig.open('192.0.2.76:2000', 'host', HOST_TOKEN);
  enter(host);
  const handle = createRoom(host);
  const before = host.sent.length;
  queryMembers(host, handle);
  queryMembers(host, handle);
  queryMembers(host, handle);
  const limits = roomLimits(host.sent, before);
  assert.equal(limits.length, 3);
  assert.ok(limits.every((l) => l.max === 4 && l.current === 1), 'never accumulates');
});

test('two players: both consoles get "2 of 4" from presence on their in-room query', (t) => {
  const rig = harness(t);
  const host = rig.open('192.0.2.76:2000', 'host', HOST_TOKEN);
  const joiner = rig.open('192.0.2.77:2000', 'joiner', JOINER_TOKEN);
  enter(host);
  const handle = createRoom(host);
  queryMembers(host, handle);
  enter(joiner);
  joinRoom(joiner, handle);

  const atHost = host.sent.length;
  queryMembers(host, handle);
  assert.deepEqual(roomLimits(host.sent, atHost).map((l) => [l.current, l.max]), [[2, 4]]);

  const atJoiner = joiner.sent.length;
  queryMembers(joiner, handle);
  assert.deepEqual(roomLimits(joiner.sent, atJoiner).map((l) => [l.current, l.max]), [[2, 4]]);
});

test('a selection query from outside the room gets no header', (t) => {
  const rig = harness(t);
  const host = rig.open('192.0.2.76:2000', 'host', HOST_TOKEN);
  const browser = rig.open('192.0.2.77:2000', 'browser', JOINER_TOKEN);
  enter(host);
  const handle = createRoom(host);
  enter(browser);
  const before = browser.sent.length;
  queryMembers(browser, handle);
  assert.equal(roomLimits(browser.sent, before).length, 0);
});

test('a query for an unrelated handle gets no header', (t) => {
  const rig = harness(t);
  const host = rig.open('192.0.2.76:2000', 'host', HOST_TOKEN);
  enter(host);
  createRoom(host);
  const before = host.sent.length;
  queryMembers(host, 0xdeadbeef);
  assert.equal(roomLimits(host.sent, before).length, 0);
});

test('SNAP_ROOM_LIMITS_ON_QUERY off keeps the query reply byte-identical (no header)', (t) => {
  const rig = harness(t, { roomLimitsOnQuery: false });
  const host = rig.open('192.0.2.76:2000', 'host', HOST_TOKEN);
  enter(host);
  const handle = createRoom(host);
  const before = host.sent.length;
  queryMembers(host, handle);
  assert.equal(roomLimits(host.sent, before).length, 0);
});
