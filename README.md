# Staletip Lab

A local web interface for experimenting with [BIP332](https://github.com/bitcoin/bips/blob/master/bip-0332.md) on regtest and monitoring
testnet4 and Signet using real Bitcoin Core nodes. Start and stop nodes, choose their
stale-tip mode, inspect block trees, and follow negotiation and relay messages.
Mining and on-demand fork creation are available only on regtest.

## Start

Requires macOS or Linux and Python 3.9 or newer. Managed-node experiments also
require `bitcoind`/`bitcoin-cli` built from the `bip332-staletip-relay` branch.
Observer mode connects to existing nodes and needs no Bitcoin binaries locally. There are no Python packages, JavaScript packages,
CDNs, wallets, or frontend build steps to install.

From the repository root, in Bash or fish:

```sh
./run-lab.py --bin-dir /path/to/bitcoin/build/bin
```

Open **http://127.0.0.1:8765**. Both executables must come from a build with
`-staletips` and BIP434 negotiation support; a standard release without the
stale-tip implementation cannot run the experiments.

Binary selection uses `--bin-dir` first, then `BITCOIN_BIN_DIR`, then the directory
containing `bitcoind` on `PATH`. That directory must also contain `bitcoin-cli`.
For example, to use an environment variable and a different web port:

```sh
env BITCOIN_BIN_DIR=/path/to/bitcoin/build/bin ./run-lab.py --port 8767
```

The server and RPC listen on loopback only. Each node gets its own datadir,
cookie, and ports. Regtest disables automatic peer discovery and uses only the
connections you establish in the lab. Testnet4 can discover public peers or use
only the peers you explicitly configure. Automatic port mapping remains disabled.

Press **Ctrl+C** in the terminal to stop the server, automated miners, and all
nodes it owns. Session files remain under `runs/`; `--data-dir DIR` changes that
parent directory. Regtest starts a new session on each server launch. Testnet4
reuses a persistent profile, including its node data and connection settings.

On regtest, **Reset lab** asks for confirmation, stops all nodes and miners, and opens a
fresh empty workspace with a new session directory. Previous files are retained,
including a `final-state.json` snapshot. Canceling the dialog changes nothing.
Reset is unavailable while another operation is running; an old confirmation
from another browser tab cannot reset a newer session.

On testnet4, **Clear timeline** clears the displayed event history while keeping
the nodes, connections, and downloaded chain. It does not restart initial sync
or delete node data.

## Monitor testnet4

Start the testnet4 interface alongside the regtest lab:

```sh
./run-lab.py --bin-dir /path/to/bitcoin/build/bin --network testnet4
```

Open **http://127.0.0.1:8766** and choose **Monitor testnet4**. The testnet4
default port is 8766, while regtest uses 8765; `--port` overrides either default.
Adding a node starts the branch's actual `bitcoind` and may begin downloading
the public testnet4 blockchain. No wallet or test coins are required.

- **Public peer discovery** lets the node find testnet4 peers automatically.
  You can also enter specific `host:port` peers; the usual testnet4 P2P port is
  `48333`. Use `[IPv6]:port` for IPv6 addresses.
- **Discovery off** restricts connections to configured peers and connections
  established between your lab nodes. With no peers it stays isolated. This
  supports a controlled topology such as public peers → A → B → C, with only A
  using public discovery.
- **Sync progress** shows downloaded blocks, known headers, and Core's estimated
  verification progress. Being connected does not mean initial sync is finished.
  This branch does not send stale-tip announcements during initial block download.
- **External peers** show their address, direction, version, and negotiation
  observed by your node. Their complete block trees and connections to other
  peers are not available. Block trees describe the nodes managed by this lab.
- **BIP332 negotiation** depends on the peer advertising support. A public peer
  can relay ordinary blocks without supporting stale-tip relay. The absence of
  stale-tip events does not by itself indicate a problem, and there may be no
  recent stale branches for compatible peers to announce.
- **Testnet4 relay policy** excludes minimum-difficulty stale tips and may impose
  a higher difficulty cutoff. A known fork can appear in the block tree without
  qualifying for the stale-tip cache or relay, even after both nodes finish sync.

Testnet4 stores its persistent profile at `runs/testnet4/`. On restart, the lab
restores the same node definitions, stale-tip modes, peer settings, ports, local
connection intent, and downloaded chain. Nodes that were running resume;
explicitly stopped nodes stay stopped. Only one server can own a profile at a
time. To use a separate profile, pass a different `--data-dir` parent.

Testnet4 uses Core's live network debug log for message observations rather than
capturing every block payload during sync. Events identify the observed message
type, direction, time, and peer. A logged BIP332 support announcement supplies the
peer's advertised preference; an unobserved outgoing preference is not inferred
from the configured mode. These events are labeled as log observations and do
not contain full P2P payloads. Regtest retains its decoded raw message captures.

The monitor reads logs incrementally with a bounded amount of work per poll.
Debug logs rotate at approximately 16 MiB and retain one previous file, for about
32 MiB per node plus data written between checks. The lab's event archive rotates
at 8 MiB and retains one previous file. Downloaded blockchain data is separate
and is not capped by those log limits.

Mining, automatic miners, starter-chain creation, and publishing forks are
unavailable on testnet4 in both the interface and the backend API. Use regtest
for repeatable fork experiments.

## Observe existing nodes

Observer mode attaches to nodes that you already operate, including nodes managed
by systemd or another container. It never starts, stops, restarts, mines on, or
changes peers or stale-tip settings on those nodes. Those actions are rejected
by the backend as well as hidden in the interface. Closing the observer only
closes the visualizer. The observer never rotates or writes Bitcoin debug logs.

Copy an example JSON configuration and set the RPC endpoint and authentication:

```sh
./run-lab.py --observe /path/to/testnet4-nodes.json --network testnet4
./run-lab.py --observe /path/to/signet-nodes.json --network signet --port 8767
```

Run these in separate terminals. Each observer handles one network and checks
that the RPC node reports that network. Multiple nodes on the same network can
be listed in the configuration's `nodes` array. Examples are in
[`examples/observer-testnet4.json`](examples/observer-testnet4.json) and
[`examples/observer-signet.json`](examples/observer-signet.json).

Each node requires `name`, `rpc_url`, and either `cookie_file` or both
`rpc_user_env` and `rpc_password_env`. The latter name environment variables
containing your RPC username and password; their values are not stored in the
JSON configuration. Optional `log_file` enables message observations.
`p2p_address` is an optional endpoint used to match connections between observed
nodes; set it to the address peers actually report for that node.

RPC supplies chain state, block trees, peer state, and the stale-tip cache.
Message arrivals and feature negotiation require network debug logging on the
node and read access to its log. The observer does not turn logging on for you.
If you omit the log, RPC monitoring still works. Negotiation that happened before
observation began may remain unobserved; no negotiation state is inferred from
the configured stale-tip mode. Missing or unreadable logs do not imply missing
P2P traffic. Existing nodes remain responsible for their own log rotation.

Signet observation uses the node's existing chain and settings. A custom Signet
needs no signing key or challenge configuration in the observer; the node does
validation. Put nodes from different custom Signet networks in separate observer
instances, since the RPC chain name alone does not distinguish their challenges.

## Docker Compose on a VPS

The included Compose file runs two observers: Testnet4 at **127.0.0.1:8766** and
Signet at **127.0.0.1:8767**. It is intended for Docker Engine on a **Linux VPS**
with the existing nodes' RPC services reachable from the host, either on loopback
or at a private Docker address. Host networking lets the observers reach those
RPC ports without publishing additional ports. The observer image contains no
Bitcoin binaries or blockchain data. An optional, separate Bitcoin peer image is
described below.

1. Run `cp examples/observer.env.example .env` and edit its paths and numeric
   UID/GID values. `TESTNET4_DATADIR` and `SIGNET_DATADIR` must point to the
   existing **network chain directories** containing `.cookie` and `debug.log`.
   If your nodes use custom RPC ports or log locations, update the example JSON
   configurations and mounts accordingly.
2. Create the two `*_LAB_DATA` directories. Give each directory write access for
   its configured container UID/GID. These separate directories store only the
   observer's state and event archive. Do not use a Bitcoin datadir here.
3. Choose a non-root UID/GID that can read each node's RPC cookie and log, often
   the UID/GID of its Bitcoin service. The container's read-only mounts prevent
   writes to those directories. Mount the **directory**, not just the cookie
   file, so cookie replacement on node restart remains visible.
4. Build and start the observers:

```sh
docker compose config
docker compose up --build -d
```

The containers use a non-root user, a read-only application filesystem, and
separate writable observer-data mounts. All capabilities are dropped. Image
builds use an allowlist in `.dockerignore`, so `runs/`, `.git/`, configuration
files, and credentials are excluded from the build context. The examples use
cookie authentication; to use environment-based RPC credentials instead, pass
the variables named by your JSON configuration into the corresponding Compose
service (for example with a private `env_file`). Compose's `.env` interpolation
file does not automatically export arbitrary variables to containers.

Access the interfaces from your own machine through SSH; substitute your VPS
login below:

```sh
ssh -N -L 8766:127.0.0.1:8766 -L 8767:127.0.0.1:8767 user@your-vps
```

Then open **http://127.0.0.1:8766** or **http://127.0.0.1:8767** locally. Keep the
local and remote forwarded ports identical because the app validates the HTTP
Host and Origin against its listening port. There is no web login; these
examples keep the web server on loopback. A public web deployment requires an
authenticated reverse proxy and corresponding host/origin configuration.

Use `docker compose logs -f` for diagnostics and `docker compose down` to stop
the observers. Neither command changes or stops your existing Bitcoin nodes.
A node restart or temporary RPC outage is reflected in the interface, and the
observer retries without restarting that node. The image's HTTP health check
checks the visualizer, not the availability of the independently managed nodes.

## Optional Testnet4 relay peer

The `testnet4-relay-peer` service adds a real BIP332 node **B** alongside the
observers through `compose.relay-test.yaml`. Include that file and select the
`relay-test` profile (or explicitly request the service) to enable B. Ordinary
`docker compose up -d` still starts only the observers. The lab UI observes B; Docker Compose manages its lifecycle.
Your existing node **A** remains outside this Compose project.

B uses Linux host networking and makes its sole automatic P2P connection to
the endpoint in `TESTNET4_RELAY_PEER`. A must already accept P2P connections
there and have the historical blocks needed for B's initial sync. Disabling pruning on A
does not restore previously deleted blocks. The service does not change A's
listener, whitelist, firewall, or container configuration.

B runs with `staletips=blocks`, `prune=10000`, no inbound P2P listener, and RPC on
**127.0.0.1:49332**. The pruning target is 10,000 MiB of block/undo files; chain
state and logs require additional space. It still downloads and validates the
active chain. `connect` restricts automatic outbound connections to A; turning
off address discovery alone would not do that. No `noban` whitelist is required.

### Prepare and build

1. Complete the observer `.env` setup above. Set `TESTNET4_RELAY_DATA` to a new,
   dedicated **root datadir** for B (default `./relay-peer-data`). Never use A's
   datadir. B uses the observer's `TESTNET4_UID` and `TESTNET4_GID` so the observer
   can read its authentication cookie without making it readable by everyone.
   Create the directory, substituting the numeric IDs from `.env`:

```sh
sudo install -d -m 0700 -o 1000 -g 1000 ./relay-peer-data
```

2. Copy the two-node observer example to an ignored local configuration:

```sh
mkdir -p observer-config
cp examples/observer-testnet4-relay.json observer-config/testnet4-relay.json
```

   Set these lines in `.env`, replacing the documentation address with A's
   reachable P2P endpoint. The relay setup requires `TESTNET4_RELAY_PEER`; the
   monitoring-only Compose file does not. Keep deployment addresses in ignored
   `.env` and `observer-config/` files, not in the tracked examples.

```ini
TESTNET4_RELAY_PEER=192.0.2.10:48333
TESTNET4_RELAY_OBSERVER_CONFIG=./observer-config/testnet4-relay.json
```

   Edit A's entry to match the RPC endpoint and authentication already working
   in your observer. The example uses `192.0.2.10`, a documentation-only
   placeholder, and the existing `/bitcoin` cookie/log mount. Replace A's
   `rpc_url` and `p2p_address` in your local JSON; JSON does not expand `.env`
   variables. Use A's P2P address as reported by B's `getpeerinfo` so the graph
   can identify their connection. If A uses environment-based credentials,
   preserve those environment variables on the
   observer service. B's entry uses `/relay-peer/testnet4/.cookie` and
   `/relay-peer/testnet4/debug.log`, both mounted read-only. B has no listening
   P2P address; its outbound connection identifies the edge.

3. Validate the combined configuration and build the separate Bitcoin image:

```sh
docker compose -f compose.yaml -f compose.relay-test.yaml --profile relay-test config --quiet
docker compose -f compose.yaml -f compose.relay-test.yaml --profile relay-test build testnet4-relay-peer
```

The image builds `bitcoind` and `bitcoin-cli` from the published
`pseudoramdom/bitcoin` BIP332 branch, pinned by default to commit
`073a114dde430cc783564b35cae4e232e8a6aeb4`. `BITCOIN_REVISION` can select another
full 40-character commit hash available in that repository. The build verifies
the checked-out hash and requires `-staletips` support. It uses a separate,
allowlisted build context; local runs, node data, and credentials are never sent
to the builder. Wallet, GUI, and IPC support are omitted.

Compilation can take a while and needs several GiB of memory. The default is
two compilation jobs; set `BITCOIN_BUILD_JOBS=1` in `.env` for a smaller VPS.

### Start and verify

Start the observer before B so it can watch B's new log from the beginning:

```sh
docker compose -f compose.yaml -f compose.relay-test.yaml up --build -d testnet4
docker compose -f compose.yaml -f compose.relay-test.yaml --profile relay-test up -d testnet4-relay-peer
```

The first command may recreate the Testnet4 **observer** to add B's read-only
mount and configuration. Neither command restarts A or the Signet node. Open the
usual Testnet4 interface through your SSH tunnel. Use both `-f` arguments for
subsequent Testnet4 observer updates so its two-node configuration is retained.

Check B's RPC health, initial sync, and peer list:

```sh
docker compose -f compose.yaml -f compose.relay-test.yaml --profile relay-test ps testnet4-relay-peer
docker compose -f compose.yaml -f compose.relay-test.yaml exec testnet4-relay-peer bitcoin-cli -datadir=/data -testnet4 -rpcport=49332 getblockchaininfo
docker compose -f compose.yaml -f compose.relay-test.yaml exec testnet4-relay-peer bitcoin-cli -datadir=/data -testnet4 -rpcport=49332 getpeerinfo
```

The peer address should match A's configured endpoint (its resolved IP if you
used a hostname). A healthy container means RPC is
responding, not that IBD has finished or that A is connected. After sync, inspect
B's retained stale tips and per-connection message counters (requires `jq`):

```sh
docker compose -f compose.yaml -f compose.relay-test.yaml exec -T testnet4-relay-peer bitcoin-cli -datadir=/data -testnet4 -rpcport=49332 getnetworkinfo | jq '.staletips'
docker compose -f compose.yaml -f compose.relay-test.yaml exec -T testnet4-relay-peer bitcoin-cli -datadir=/data -testnet4 -rpcport=49332 getpeerinfo | jq '.[] | {addr, received_staletip_bytes: (.bytesrecv_per_msg.staletip // 0)}'
```

A must be out of IBD, have an eligible stale tip, and know that B has its fork
point before it announces the branch. Difficulty-1 stale tips are filtered by
this implementation. B requests eligible missing stale blocks when the sender
advertises availability. A zero message count or empty stale-tip cache can be
normal; Testnet4 does not guarantee a qualifying fork on demand. Use regtest for
repeatable fork experiments.

The observer reads live `debug=net` logs; it does not reconstruct negotiation
that occurred before observation began. If necessary, restart **only B** while
the observer is running to observe a fresh handshake:

```sh
docker compose -f compose.yaml -f compose.relay-test.yaml restart testnet4-relay-peer
```

### Storage and shutdown

B's chain data survives container recreation in `TESTNET4_RELAY_DATA`. The
default local directory is ignored by Git. Docker's console logs are bounded to
three 10 MiB files, but B's separate `testnet4/debug.log` needs host-side log
rotation during long runs. The observer never rotates external-node logs. When
using rename-based rotation, signal B to reopen its log:

```sh
docker compose -f compose.yaml -f compose.relay-test.yaml kill -s SIGHUP testnet4-relay-peer
```

Stop only B with:

```sh
docker compose -f compose.yaml -f compose.relay-test.yaml stop testnet4-relay-peer
```

To stop both observers and B, while retaining B's files:

```sh
docker compose -f compose.yaml -f compose.relay-test.yaml --profile relay-test down
```

A is not a service in this project and remains running. B has a five-minute
shutdown grace period to flush its chain state before Docker would force a stop.

## First experiment

1. Create the three-node starter network. A, B, and C start in headers mode,
   share a short active chain, and connect in a line: **A — B — C**.
2. Select a connection to inspect each endpoint's BIP434 advertisement. On
   regtest, headers mode advertises `prefers_blocks=false` and blocks mode
   advertises `true`. None mode does not advertise BIP332.
3. Create a fork using A as the source, a parent a few blocks behind its tip,
   and a length that keeps the new branch below the active chain. Publish it
   only to A. A temporary isolated miner creates genuine blocks on the chosen
   parent; no existing node's chain is invalidated to manufacture the fork.
4. Watch `staletip` messages travel A → B → C. Select a message to inspect the
   decoded fork point, compressed-header reconstruction, and availability flag.
   The block trees show the same hashes in each node's view. B and C should have
   the stale headers without their full block data.
5. Change B to blocks mode, then C. A mode change restarts the node and
   reconnects its links to negotiate the new preference. Watch `getdata` and
   `block` messages as the recipients fetch the stale branch.
6. Mine on any node, or start its interval miner. Disconnect an edge to create
   a partition, mine on both sides, and reconnect it to observe a natural reorg.

Choose a longer fork to let it win instead. Chain selection is performed by
Bitcoin Core; the GUI does not force a particular outcome.

## What the display means

- **Node state** comes from RPC. Active chain, header knowledge, block data,
  validation status, and stale-tip cache membership are separate observations.
  A stored block is not necessarily fully validated. The cache is a bounded
  policy view, not an exhaustive list of all known forks.
- **Regtest message events** come from Core's `-capturemessages` files, not from
  inferred arrows. `feature`, `staletip`, inventory, headers, requests, and block
  messages are decoded by the server. **Testnet4 events** come from Core's live
  network log, without decoded payloads. These timestamps describe local
  processing, not exact wire arrival. A received message is not proof that its
  contents were accepted.
- **Negotiation** displays captured advertisements and handshake messages. A
  configured local mode and a peer's advertised preference are different facts.
- **Timeline pause** pauses the display; it does not freeze nodes or mining.
- **Export** downloads the current bounded snapshot and event history. Regtest
  retains complete raw captures and debug logs in its session directory. Long
  regtest experiments accumulate files there; stopped sessions can be removed
  when no longer needed. Testnet4 debug logs rotate as described above.

Invalid operations and node failures appear as job errors. Actions run in order
so that a restart cannot race a fork being constructed. The web interface stays
responsive while actions finish.

## Saved runs

`runs/` contains node data, the persistent testnet4 profile, logs, captures, and
session snapshots. It is excluded from Git, along with Python caches and local
virtual environments. Downloaded chains can occupy many gigabytes per node.

Stop the server before copying or moving the repository and its `runs/` directory.
The testnet4 profile stores node IDs and settings; datadir paths are reconstructed
under the new location on startup. Historical snapshots and logs retain the paths
recorded when they were created. Regtest starts a fresh session on launch, while
its previous runs remain available on disk.

## Implementation

```text
run-lab.py                Entry point
relay_lab/app.py          Loopback HTTP API, SSE, static assets
relay_lab/config.py       Bitcoin Core binary selection
relay_lab/core.py         Owned node processes, jobs, RPC state, capture ingestion
relay_lab/networks.py     Network arguments and mining adapter
relay_lab/wire.py         Incremental capture reader and message decoding
relay_lab/logs.py         Bounded testnet4 network-log observations
relay_lab/static/         Browser interface; no build tooling
tests/                   Protocol, HTTP boundary, optional real-node tests
```

The network adapters implement **regtest experiments**, **testnet4 monitoring**,
and **Signet observation**. Signet is supported by attaching to an existing node,
including a custom Signet node. Creating Signet networks, signing blocks, and
mining on Signet are not implemented.

The older `staletip-regtest-demo.sh` remains available as a verbose terminal-only
three-node smoke test. It additionally requires Bash 3.2 or newer and `jq`:

```sh
./staletip-regtest-demo.sh --bin-dir /path/to/bitcoin/build/bin
```

## Tests

```sh
python3 -B -m unittest discover -s tests -v
```

The optional integration tests launch temporary real nodes and verify regtest
onward header relay, block fetching, mining, and lifecycle operations, plus
testnet4 log observations, peer negotiation, and persistent profile restarts:

```sh
env STALETIP_INTEGRATION=1 BITCOIN_BIN_DIR=/path/to/bitcoin/build/bin python3 -B -m unittest discover -s tests -v
```

The automated testnet4 test uses only local peers, with public discovery disabled.
It neither contacts the public network nor downloads its chain.

Set `BITCOIN_BIN_DIR` through `env BITCOIN_BIN_DIR=/absolute/path/to/build/bin`
when testing another build. These commands work from Bash or fish.

The GitHub Actions workflow runs the default tests on Linux and macOS. Real-node
integration tests require a local BIP332 build and are run separately.

## License

[MIT](LICENSE).
