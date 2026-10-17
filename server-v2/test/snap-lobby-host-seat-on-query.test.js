import assert from 'node:assert/strict';
import test from 'node:test';

import { TimingWheel } from '../src/transport/timing-wheel.js';
import { createV1ObservedAreaDirectory } from '../src/udp/area-directory.js';
import { LOBBY_OPCODE } from '../src/udp/snap-lobby-codec.js';
import { SnapLobbySessions } from '../src/udp/snap-lobby-sessions.js';

// 2026-10-17 PCSX2 capture: create acceptance and host op-06 arrived together;
// the room query followed ~64 ms later. The before-Start savestate has NO seats,
// and the loading savestate has peerCount=0. FUN_005b5ac0 seats only on 4/0xe;
// FUN_005fe500 sets screen=4 before emitting the first op-0a room query.
const TOKEN = 0x02f807d0;

function harness(t, { hostReseat = true } = {}) {
  const wheel = new TimingWheel({
    tickMs: 100, clock: () => 1_000,
    setInterval: () => ({ unref() {} }), clearInterval: () => {}, onError: () => {}
  });
  wheel.start();
  const table = new SnapLobbySessions({
    wheel, areaDirectory: createV1ObservedAreaDirectory(), keepaliveKey: 'SNAP-SWAN',
    hostReseat, charstatsSeed: true, op0aCount0: true
  });
  t.after(() => { table.closeAll(); wheel.stop(); });
  const sent = [];
  const session = table.open({
    routingKey: '192.0.2.76:2000', loginIdentity: 'host', endpointToken: TOKEN,
    outboundSequence: 1, inboundReceiveBase: 0, latencyTicks: 1600,
    transmit: (datagram, context) => sent.push({ datagram, ...context })
  });
  let sequence = 0;
  function receive(opcode, payload = Buffer.alloc(0), flags = 0xa000) {
    const inner = 16 + payload.length;
    const d = Buffer.alloc(inner + 4);
    d.writeUInt16BE(flags | inner);
    d[3] = opcode;
    d.writeUInt32BE(TOKEN, 4);
    d.writeUInt32BE(sequence++, 8);
    payload.copy(d, 16);
    Buffer.from('ba476611', 'hex').copy(d, inner);
    return session.accept(d);
  }
  const area = Buffer.alloc(4); area.writeUInt32BE(5);
  receive(LOBBY_OPCODE.AREA_ENTER, area, 0xb000);
  const stats = Buffer.alloc(0xf0);
  stats.writeUInt16LE(5, 0xc8); // Alyssa, as captured (not a synthetic seat key).
  stats.writeUInt16LE(0x1234, 0);
  receive(LOBBY_OPCODE.ROOM_QUERY, stats);
  const create = Buffer.alloc(0x2c); create.write('solo');
  const result = receive(LOBBY_OPCODE.CREATE_ROOM, create).handled[0];
  const handle = result.handle;
  assert.ok(handle > 0);
  const query = (value = handle) => {
    const body = Buffer.alloc(4); body.writeUInt32BE(value);
    return receive(LOBBY_OPCODE.MEMBER_LIST, body);
  };
  const memberJoins = (list) => list.filter(e =>
    e.datagram[3] === LOBBY_OPCODE.MEMBER_JOIN && e.datagram.length === 16 + 0x108 + 4);
  return { sent, receive, query, memberJoins, stats, handle };
}

test('host self-seat is supplied after its first in-room query, with real character data', (t) => {
  const rig = harness(t);
  assert.equal(rig.memberJoins(rig.sent).length, 0, 'host member delta waits for screen 4');

  // The actual client may still be screen 3 during the initial push; only the
  // records sent after this in-room query can populate its screen-4 roster.
  const before = rig.sent.length;
  rig.query();
  const after = rig.sent.slice(before);
  const joins = rig.memberJoins(after);
  assert.equal(joins.length, 1, 'one host record arrives after the screen-4 query');
  const d = joins[0].datagram;
  assert.equal(d.readUInt16BE(0) & 0xfc00, 0xa000, 'member-JOIN stays on the room channel');
  assert.equal(d.subarray(16, 32).toString('latin1').split('\0')[0], 'host');
  assert.equal(d.readUInt32BE(16 + 0x10), rig.handle, 'the original host seat identity');
  assert.deepEqual(d.subarray(16 + 0x18, 16 + 0x108), rig.stats, 'full captured stats preserved');

  const reply = after.find(e => e.datagram[3] === LOBBY_OPCODE.MEMBER_LIST);
  assert.ok(reply);
  assert.deepEqual(reply.datagram.subarray(16, -4), Buffer.alloc(12), 'count-zero reply untouched');
  assert.ok(reply.datagram.readUInt32BE(8) < d.readUInt32BE(8), 'query response precedes the seat');
});

test('solo creation supplies exactly one host JOIN delta, including after repeated polls', (t) => {
  const rig = harness(t);
  rig.query();
  rig.query();
  // FUN_005bb4d0 increments the display count unconditionally, even if the
  // seating event ignored an early record or deduplicated a repeated one.
  assert.equal(rig.memberJoins(rig.sent).length, 1, 'one real member produces one JOIN delta');
});

test('a new member-list poll does not repeatedly push the host seat', (t) => {
  const rig = harness(t);
  rig.query();
  const before = rig.sent.length;
  rig.query();
  assert.equal(rig.memberJoins(rig.sent.slice(before)).length, 0);
});

test('an unrelated room query does not consume the host seat replay', (t) => {
  const rig = harness(t);
  const before = rig.sent.length;
  rig.query(0xdeadbeef);
  assert.equal(rig.memberJoins(rig.sent.slice(before)).length, 0);
  const atValidQuery = rig.sent.length;
  rig.query();
  assert.equal(rig.memberJoins(rig.sent.slice(atValidQuery)).length, 1);
});

test('SNAP_HOST_RESEAT off keeps the original create/query wire behavior', (t) => {
  const rig = harness(t, { hostReseat: false });
  assert.equal(rig.memberJoins(rig.sent).length, 1, 'flag off retains the create-time delta');
  const before = rig.sent.length;
  rig.query();
  assert.equal(rig.memberJoins(rig.sent.slice(before)).length, 0);
});

test('a host that already left cannot replay its seat by querying the old room', (t) => {
  const rig = harness(t);
  rig.receive(LOBBY_OPCODE.AREA_LEAVE);
  const before = rig.sent.length;
  rig.query();
  assert.equal(rig.memberJoins(rig.sent.slice(before)).length, 0);
});
