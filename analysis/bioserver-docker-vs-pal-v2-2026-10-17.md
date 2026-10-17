# Bioserver Docker versus PAL server-v2

Comparison performed on 2026-10-17 against public Bioserver Docker master at
commit `7e338258a8dacb73eee62f2e372b6681fa50f04e` and the current local PAL tree.
No server was deployed or hardware-tested for this comparison. The upstream
README's stability statement is a maintainer claim, not independent verification.

Upstream: https://github.com/panzer-punk/bioserver-docker

The File #2 implementation is `bioserv2`, not `bioserv1`. Eight relevant source
files were downloaded to a temporary folder and inspected directly. Deployment
Compose files and README were also inspected. No downloaded code was executed.

## Architecture

| Responsibility | Japanese Bioserver Docker | PAL server-v2 |
| --- | --- | --- |
| Game services | Java, separate lobby and game listeners | Node >=22.5, composed application |
| Supporting stack | MySQL, PHP web app, gateway and DNS containers | Built-in SQLite plus HTTP, DNS, DNAS and session services |
| Lobby framing | 12-byte header, TCP 8200 | 8-byte TCP 10127 header; interactive lobby also uses SN@P UDP 9090 |
| Gameplay transport | TCP 8590, separate connection | Reliable and unreliable SN@P UDP 9090 |
| Start coordinator | Server responds to game-detail queries | Host coordinates roster synchronization; server relays and answers completions |
| Gameplay audience | Same database-backed game number, excluding sender | Current presence room, excluding sender |
| Restart behavior | Published Compose sets `restart: unless-stopped` | Owner's Docker setup intentionally starts on demand |

The JP server Dockerfile uses `openjdk:17.0.2-jdk-slim-bullseye` and compiles Java
with a packaged MySQL connector. This comparison does not establish whether all
its image dependencies currently build on the owner's arm64 Pi. Do not import its
restart policy into the owner's deployment.

## Exact Japanese start path

`bioserv2/bioserver/PacketHandler.java`:

1. `STARTGAME` 0x6508 reaches `broadcastGetReady` (line 367; dispatch 2173).
2. Mint a slot game number once, assign it to slot clients, persist the mapping
   with `db.updateClientGame`.
3. Mark slot BUSY and broadcast its status.
4. Broadcast empty `GETREADY` 0x6910 to slot members.
5. Answer client queries through `sendPlayerCount` (1424), `sendPlayerNumber`
   (1435), `sendPlayerStat` (1442), `sendGameSession` (1484), `sendDifficulty`
   (1494), and `sendGSinfo` (1519).

The game-session reply contains a 15-digit decimal game number inside a 19-byte
payload. GSINFO supplies an IP and port 8590. These are JP wire contracts; they
are not established PAL messages.

`bioserv2/bioserver/GameServerPacketHandler.java`:

1. `GSsendLogin` (line 148) builds the server's GSLOGIN 0x1031 query.
2. Incoming GSLOGIN is handled in `processData` (line 90).
3. `check_session` (154) decodes the account session, resolves the user, loads
   the game number from the database, registers the client, and updates its
   origin to STATUS_GAME. This method does not enqueue an extra success packet.
4. Subsequent raw game buffers take the default branch of `processData`:
   enqueue the same bytes for clients sharing the game number, excluding the
   source socket. The handler does not simulate the game world.

There is no special solo branch in the inspected start/detail/relay methods
that creates a fake partner or echoes a client's game data to itself. That
source observation does not independently prove a successful solo hardware run.

Source links, pinned to the inspected revision:

- [Lobby/start handler](https://github.com/panzer-punk/bioserver-docker/blob/7e338258a8dacb73eee62f2e372b6681fa50f04e/bioserv2/bioserver/PacketHandler.java#L367)
- [Game handler](https://github.com/panzer-punk/bioserver-docker/blob/7e338258a8dacb73eee62f2e372b6681fa50f04e/bioserv2/bioserver/GameServerPacketHandler.java#L91)
- [Packet framing](https://github.com/panzer-punk/bioserver-docker/blob/7e338258a8dacb73eee62f2e372b6681fa50f04e/bioserv2/bioserver/Packet.java#L25)
- [Server Dockerfile](https://github.com/panzer-punk/bioserver-docker/blob/7e338258a8dacb73eee62f2e372b6681fa50f04e/docker/server.Dockerfile)

## PAL correspondence and differences

The correspondence is already partly documented by this repository in
`docs/design/v2-port/BIOSERVER-CONTRACT.md` and
`docs/design/v2-port/B1-GAME-START-MODEL.md`. `src/state/game-session.js` explicitly
cites the JP `broadcastGetReady` implementation.

| JP responsibility | PAL behavior supported by code/RE |
| --- | --- |
| GETREADY broadcast | Host's op-0x10/sub-3 starts joiners; server relays |
| Player number/count | Host's sub-5 carries assignment/count for multiplayer |
| Player details | Host's sub-6 IDs/names and sub-7 character chunks; local solo shortcut |
| End of detail transfer | Host's sub-8 releases a joiner download wait |
| Session start accounting | op-0x0d/body 1 invokes game-number/party/BUSY bookkeeping |
| Start completion | Server op-0x28 selector 0x0d/status 0 |
| Separate game login/address handoff | No corresponding new endpoint in the supplied PAL capture; game UDP continues on 9090 |
| Raw gameplay relay | op-0x0f reliable/unreliable relays, separately flag-controlled |

Do not read older documentation's phrase "only this layer differs" as literal
wire compatibility. Even the lobby header sizes differ, and some shared command
numbers have different PAL meanings. The older V1 mapping's completion markers
also do not describe current V2 status.

Two real implementation differences remain:

- JP persists game-number association and uses it to attach a new game TCP
  connection and select relay recipients. PAL `GameSessionRegistry` is in-memory;
  its `relayScope()` query is not used by the production game relay, which instead
  selects room presence in `snap-lobby-sessions.js` lines 549 and 582. This is a
  lifecycle/recovery and multiplayer-scope difference. It does not explain a
  one-member sender that never emits its first reliable game frame.
- JP delegates ordered delivery to TCP and enqueues outgoing game data. PAL must
  acknowledge, deduplicate and retransmit SN@P reliable traffic; a full reliable
  send window can refuse a peer relay. The owner's solo capture shows no send
  refusals and no reliable game data to relay, so this is not an explanation for
  that captured failure.

## Consequence for the captured solo failure

`analysis/solo-start-capture-2026-10-16.md` establishes a delivered and acknowledged
PAL barrier reply, 117 unreliable `0000` peer keepalives, no reliable game frame,
and eventual post-game reentry. The server therefore has no peer game data to
forward in this run. JP's except-sender rule provides no support for a self-echo.

JP's explicit GSLOGIN cannot simply be inserted into PAL; the PAL client must
have an independently identified receiver and state gate. Nothing inspected
connects JP GSLOGIN 0x1031 to PAL's experimental op-0x29, which remains unproven
at this point in the PAL lifecycle.

The next useful semantic comparison is the *client's initialized game-session
inputs*: actual player count, own player index, IDs, scenario/rules, then early
game-network state. Server-side `party:["Erizo"]` does not prove the PAL game's
peer count was initialized to one. G13 section 7 leaves early state-handler
arguments unresolved; the supplied capture does not reveal them.

Conclusion: Bioserver supplies a useful behavior reference and a JP deployment
option, but changing ports, DNS, locale, or .env cannot make its JP protocol serve
an unmodified PAL client. The comparison supports neither a new PAL start packet
nor a production patch without additional client-side evidence.
