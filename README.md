# Staletip Lab

A local web interface for experimenting with [BIP332](https://github.com/bitcoin/bips/blob/master/bip-0332.md) on regtest and monitoring
testnet4 using real Bitcoin Core nodes. Start and stop nodes, choose their
stale-tip mode, inspect block trees, and follow negotiation and relay messages.
Mining and on-demand fork creation are available only on regtest.

## Start

Requires macOS or Linux, Python 3.9 or newer, and `bitcoind`/`bitcoin-cli` built from the
`bip332-staletip-relay` branch. There are no Python packages, JavaScript packages,
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

The network adapters implement **regtest experiments** and **testnet4 monitoring**.
Custom signet can
provide its challenge arguments, chain directory, and a signing/grinding miner
through the same interface. It is intentionally not presented as working
signet support. A signet adapter must also account for initial chain setup and
signature-dependent stale-tip eligibility.

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
