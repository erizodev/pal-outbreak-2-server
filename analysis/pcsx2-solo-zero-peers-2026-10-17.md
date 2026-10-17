# PCSX2 solo reproduction: empty host roster, zero game peers

Owner test: PAL File #2, SLES-53319 / CRC A8505479, Wild Things, Alyssa.
Files supplied on 2026-10-17:

- `outbreak-pcsx2-solo.log`, 180,232 bytes, from the owner's Pi share.
- `outbreak-pcsx2-solo.pcap`, 46,541 bytes, from the owner's Pi share.
- `SLES-53319 (A8505479).01.p2s`, 7,594,601 bytes: pre-Start room.
- `SLES-53319 (A8505479).02.p2s`, 7,678,117 bytes: black/loading screen.

Raw captures, BIOS data and savestates are NOT added to the repository.
SHA256 for state 01: `1f66b71ff3fed60fd374a94c61473726d02066ebaabb9d1d88dd8ae641907ba8`.
SHA256 for state 02: `033e0a753d11b17dd8dbf63891cb7fa6832c36ff669c5bcb166dcd8f5b956f95`.

## Method

Read the ZIP central directory in each p2s and decompressed `eeMemory.bin` using
Node 24's zstd support (ZIP method 93). Each EE image is exactly 32 MiB.
Screenshots were extracted and viewed to establish phase: state 01 shows the
in-room screen, state 02 is black. Analysis tooling ran in a temporary folder;
the production change uses no zstd API and remains compatible with Node 22.

Decoded SN@P packets, including aggregates, with the repository codec. Pcap link
type is Linux cooked v2 (276). The first capture packet is 06:22:49.002Z; the
last is 06:25:59.073Z. Times here are UTC (03:xx in Argentina).

## Observed client memory

State 01 (lobby overlay is loaded, so lobby addresses are meaningful):

| Field | Value |
| --- | --- |
| Screen `0x6c4b90` | 4, in room |
| Host flag `ctx+0x97e` | 1 |
| Four seat ID/name pairs, base `0x6c7c2c`, stride `0x3b0` | ALL EMPTY |
| Four candidate ID/name pairs at `0x6ff2bd`, stride `0x114` | ALL EMPTY (before start) |

Do not interpret pre-start `0x6ff2b3` in isolation: it is 1 while all seat entries
are empty; the state-0 start pass has not rebuilt that count yet.

State 02 (game module loaded):

| Field | Value |
| --- | --- |
| Game peer count `0x35b720` | **0** |
| Game own index `0x35b721` | 0 |
| Network peer count `0x3540a5` | **0** |
| Network own index `0x3540a4` | 0 |
| Network state `0x3540a6` | 5 |
| Network error fields `0x3541f4/f8/fc` | all zero |
| Game own ID string `0x874fa0` | empty |

The lobby overlay has been replaced in state 02. Its old screen/roster addresses
contain repurposed bytes; they are NOT a second lobby-state observation.
Network state 5 alone does not prove a valid game: here its peer count is zero.

## Packet evidence

| UTC time | Frame | Event |
| --- | --- | --- |
| 06:23:00.479 | 12 | Client op-0c, 240 bytes, character ID 5 at +0xc8 |
| 06:23:00.613 | 18 | Latest op-0c, again character ID 5 |
| 06:23:00.680 | 23 | Create request |
| 06:23:00.683 | 25 | Server create accept, sequence 51, room handle 2 |
| 06:23:00.683 | 26 | Host member-JOIN op-06, sequence 52, same character ID 5 |
| 06:23:00.747 | 29 | Client's first op-0a room-member query, handle 2 |
| 06:23:00.752 | 32 | Server answers direct op-0a, twelve zero bytes |
| 06:23:24.436 | 54 | Client STAT, with no preceding client op-0x10 START |
| 06:23:24.703 | 58 | Client op-0d/body 1 |
| 06:23:24.705 | 60 | Server barrier completion, sequence 58 |
| 06:23:32.745 | -- | First unreliable op-0f/body 0000 |
| 06:25:32.096 | -- | Last such keepalive (120 total, including bundled messages) |
| 06:25:44.176 | -- | Log records post-game reentry |

Zero reliable op-0f game frames were captured. The server emitted no op-0f echo.
The correct captured character data reached the initial member-JOIN, so this is
not simply a disabled CHARSTATS_SEED flag or an invented character ID.

## Diagnosis, with evidence grades

**Confirmed:** the host is not seated before Start; the game initializes with
zero peers and no own ID. This explains why the server's internal party snapshot
is insufficient evidence that the CLIENT has a valid game party.

**Leading causal explanation, not yet runtime-proven:** the initial self-member
push arrives while the create screen is still active and is ignored by the
screen-dependent seating handler. `FUN_005c3a40` sets a create-success flag;
`FUN_005c3490` consumes it in a pump. `FUN_005b5ac0` seats only on screens 4/0xe.
The later first room query is emitted by `FUN_005fe500` AFTER it sets screen=4.
The capture's ~64 ms gap is consistent with this ordering but does not record the
screen at the instant frame 26 was processed. A later roster clear is another
possible mechanism; the snapshots alone do not show the exact losing instruction.

This also accounts for why a joining second client can repair the symptom:
the existing HOST_RESEAT join path supplies the host record again in the room.

## Minimal repair prepared locally

Under the existing `SNAP_HOST_RESEAT` flag, replay the host member record once
after successfully answering its first matching in-room member-list query.
Restrict to the creator's current room, consume the pending replay only after
the member record is sent, and clear pending state on host leave. Further polls
do not replay it. Keep the initial create pushes and the count-zero reply.

This uses the existing op-06 serializer and captured charstats, not a new packet
shape, fake peer, delay, beacon echo or op-0x29. The existing client dedup handler
returns for an already-seated matching character/class, so a host whose original
seat did succeed is not intended to gain a duplicate seat. That behavior still
needs client validation with this timing change.

Regression test `server-v2/test/snap-lobby-host-seat-on-query.test.js` was added
before the production edit: 2 failures on the original code, then all 5 tests
passed after the repair. Full V2 `node --test --test-reporter=dot` passed on
Node 24.16.0 / Windows. Actual gameplay remains UNVERIFIED with the repair.

## Next run

Copy the updated `server-v2/src/udp/snap-lobby-session.js` into the corresponding
Pi checkout file (preserve a copy of the previous file), then rebuild/recreate
the owner's existing Compose service BETWEEN runs:

```sh
docker compose up -d --build --force-recreate outbreak
```

No env change is required: HOST_RESEAT is already true. Expected new log event:
`udp9090 lobby-host-seat-on-query`, once for the host's first room query.
Repeat the same single-client test and save a fresh pre-Start state. Falsifier:
the host seat is still empty. If it seats, check that the game peer count becomes
1 and own ID is nonempty, then verify actual gameplay. Do not declare the bug
fixed from a send log or passing unit test alone.

Rollback: restore the previous session source and rebuild. Setting HOST_RESEAT
false also suppresses the new replay but additionally disables the older peer-
join reseating, so source rollback is preferable for multiplayer comparisons.
