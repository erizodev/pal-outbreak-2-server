# Real PAL PS2 solo start: capture analysis, 2026-10-16

Sources supplied by the owner: `outbreak-solo-start.pcap` (55,101 bytes) and
`outbreak-solo-start.log` (141,849 bytes). Originals remain on the owner's Pi
share; neither raw artifact is added to the repository. Times below are UTC;
the run occurred on October 16 in Argentina (UTC-3).

## Observations

The pcap is little-endian classic pcap, Linux cooked v2 (link type 276).
It contains 402 captured IPv4 UDP/TCP packets, spanning
2026-10-17 02:25:52.410Z through 02:28:45.938Z. The capture starts after login.
SN@P messages were decoded with `server-v2/src/protocol/snap-codec.js`, including
aggregate datagrams. Ethernet padding after the fixed trailer was excluded.
Every captured SN@P datagram decoded successfully.

| UTC time | Frame | Evidence |
| --- | --- | --- |
| 02:26:10.307 | 108 | PS2 sends STAT, reliable op-0x08, sequence 100. |
| 02:26:10.310 | 110 | Server sends op-0x28 selector 8/status 0, sequence 97. |
| 02:26:10.356 | 111 | PS2 acknowledges sequence 97. |
| 02:26:10.570 | 112 | PS2 sends op-0x0d/body `00000001`, sequence 101. |
| 02:26:10.577 | 114 | Server sends op-0x28/body `0000000d00000000`, sequence 98, flags/length `b018`. |
| 02:26:10.620 | 115 | PS2 acknowledges sequence 98. |
| 02:26:19.429 | 122 | First unreliable op-0x0f/body `0000`, sequence 1. |
| 02:28:19.424 | 316 | Last such keepalive, sequence 117, about 120 seconds after the first. |
| 02:28:30.889 | 323 | PS2 opens TCP 10127 from port 2013. |
| 02:28:31.090 | 332 | PS2 resets that TCP connection. |
| 02:28:31.930 | 336 | PS2 sends op-0x0d/body `f7e00001`: post-game reentry on the same UDP session. |
| 02:28:31.931 | 338 | Server answers reentry, sequence 103. |
| 02:28:31.979 | 339 | PS2 sends op-0x14 with acknowledgment 103. |

During the interval from the barrier until the TCP recovery attempt:

- Exactly 117 game-channel op-0x0f messages, all unreliable, all body `0000`.
- Zero reliable op-0x0f messages, including inside aggregate datagrams.
- Client reliable sequence 101..129 is continuous: barrier followed by
  op-0x41 transport-keepalive responses.
- Server reliable sequences 98..102 are the barrier completion and four
  op-0x10/sub-0 application keepalives. All five are acknowledged by the PS2.
- All captured UDP traffic uses PS2 port 2000 and Pi port 9090; no alternate
  UDP game endpoint appears.
- Logs report `echoed:false`, `relayed:0` for the keepalives. With one room
  member and except-sender relay, zero recipients is expected.
- No send-refusal or transport-dead event is logged. The supplied log has no
  `lobby-session-closed` event; this run recovers through post-game reentry,
  then logs room/area leave operations and later room-list polling.

## Interpretation and limits

This reproduces the older B1/T37 solo symptom with the validated SNAP flags
loaded and beacon echo disabled. The barrier response is demonstrably delivered
and transport-acknowledged. Subsequent game-module traffic supports progression
beyond the lobby download state; an ACK alone does not prove callback execution.

The capture does not establish a missing server packet or justify sending
op-0x29. It shows a game-module stall followed by recovery consistent with a
roughly 120-second timeout. It does not reveal the client's internal wait condition.

G13 supersedes B1's unknown-beacon interpretation: `0000` is a peer-0,
zero-length keepalive. Relaying it to other room members cannot change this
single-member run. Echoing it remains refuted by RS1-A.

The next unresolved trace is early game initialization: game-side peer count
`0x35b720`, own index `0x35b721`, initialized peer count/index `0x3540a5/a4`,
network state `0x3540a6`, and error fields `0x3541f4/f8/fc`. G13 section 7
explicitly leaves state-handler arguments at `0x001be070..0x001be150` unresolved.
An emulator reproduction with memory inspection, or further disassembly of
that path and its caller gates, can distinguish initialization failure from a
missing peer handshake. Do not infer the state value from keepalives alone.

No production behavior was changed for this analysis.

## Follow-up hypothesis, 2026-10-17: host seat/start roster missing

A broader documentation review suggests an earlier possible cause of the later
game-module stall. This is a hypothesis, not a confirmed diagnosis.

Update: the subsequent PCSX2 reproduction confirms an empty host roster BEFORE
Start and zero peers during the black screen. See
[`pcsx2-solo-zero-peers-2026-10-17.md`](pcsx2-solo-zero-peers-2026-10-17.md).
The precise point where seating is lost still needs runtime verification; a
one-time host replay after the in-room query is prepared locally for that test.

The report `analysis/solo-start-refuse-RE-2026-08-26.md` concerns a TWO-player
start accidentally falling back to solo. Its named fix does not establish that a
genuinely one-player start succeeds. The August 26 close-off also narrows the
self-targeted drop to sub-3 only, superseding that analysis file's earlier wider
set; current production code correctly uses `{0x03}`.

The supplied capture has no client op-0x10 START/sub-3 before STAT. This deserves
attention because the checked-in client code has the following chain:

1. `FUN_00616d30` passes four ID/name/stats pointer sets from screen context
   `+0x309c/+0x30ac/+0x30c0` into `FUN_005c6210`.
2. `FUN_005c6210` copies them into candidate records at `0x6ff2bd`.
3. `FUN_005c6500` state 0 counts candidates with nonzero ID first bytes and calls
   `FUN_005c5bb0` for each, INCLUDING a populated host slot, before sending STAT.
4. `FUN_005c5bb0` attempts a reliable targeted op-0x10/sub-3. Its transport
   wrapper `FUN_001df380` has failure paths, so absence on the wire alone does
   NOT prove zero candidates. No special self-target suppression is visible in
   the inspected wrapper.
5. With zero candidates, the later accepted count can remain zero despite the
   host accept byte being pre-set to 1: the count loop iterates only over
   candidates. The barrier can still be reached.

A plausible server-side cause is premature host self-seating:

- `#onCreateRoom` immediately sends its op-0x06 host member record after the
  create completion through `#sendCreateFollowUps`.
- The capture records the host member record at 02:26:07.020Z (frame 95).
- `FUN_005c3a40` records create success in a flag; `FUN_005c3490` consumes it in
  a later pump and invokes the completion callback. It does not itself force
  the in-room screen from the receive callback.
- `FUN_005b5ac0`, the member seating event handler, seats only on screens 4/0xe.
  A member record delivered while still on create screen 3 would not seat.
- `SNAP_HOST_RESEAT` repairs host seating when a JOINER arrives, through
  `#sendJoinFollowUps`. It does not automatically repair an otherwise solo host.

This would reconcile working two-player runs with a failing one-player start:
the join event repairs the host seat, while a solo room receives no such repair.
It also reconciles server-side `party:["Erizo"]` with an empty client roster:
those are independent state stores. Transport acknowledgment of the member
record does not prove the screen-specific seating event accepted it.

The live screen at frame 95 is UNKNOWN. Candidate emptiness and a failed
targeted send are competing explanations for the absent sub-3. Do not add a
delay, resend the seat at the barrier, change the count-0 op-0x0a response, or
manufacture a peer on the strength of this hypothesis alone.

The discriminator is a client-memory read BEFORE Start: screen `0x6c4b90`,
first seat ID/name at `0x6c7c2c/0x6c7c3c`, and the candidate/accepted count
`0x6ff2b3` during start. Inspect all four seats and the post-snapshot candidate
records, not just a single count. If the host seat/candidate is valid, inspect
the targeted send's failure conditions and the game-module initialization next.
