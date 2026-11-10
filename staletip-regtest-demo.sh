#!/usr/bin/env bash
# Exercise BIP332 using three real regtest nodes and an actual competing branch.
# Execute this file directly from Bash or fish; do not source it or run `fish FILE`.
# Requires Bash 3.2+, jq, and bitcoind/bitcoin-cli built from the stale-tip branch.
# No wallet, funded address, Python, or existing datadir is needed.

set -euo pipefail

BIN_DIR=${BITCOIN_BIN_DIR:-}
PORT_BASE=$((20000 + RANDOM % 30000))
TIMEOUT=60
KEEP_RUNNING=0

usage() {
    cat <<EOF
Usage: $0 [options]

  --bin-dir DIR     Directory containing bitcoind and bitcoin-cli.
                    Default: BITCOIN_BIN_DIR, then the bitcoind directory on PATH.
  --port-base N     Use N..N+2 for P2P, N+10..N+12 for RPC.
                    Default: a random base between 20000 and 49999.
  --timeout N       Seconds to wait for each asynchronous check (default: 60).
  --keep-running    Leave all three nodes running after a successful demo.
  -h, --help        Show this help.

The script uses fresh temporary datadirs and loopback connections only. Logs and
datadirs are retained after every run. Normally all nodes stop when the script
exits; on failure or interruption they stop even with --keep-running.

All stale blocks reach receiving nodes over P2P. RPC is used to prepare the
common/winning chain and to inspect results, never to give them the stale branch.
EOF
}

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
phase() { printf '\n========== %s ==========\n\n' "$*"; }

while (($#)); do
    case "$1" in
        --bin-dir|--port-base|--timeout)
            (($# >= 2)) || die "$1 requires a value."
            case "$1" in
                --bin-dir) BIN_DIR=$2 ;;
                --port-base) PORT_BASE=$2 ;;
                --timeout) TIMEOUT=$2 ;;
            esac
            shift 2
            ;;
        --keep-running) KEEP_RUNNING=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown argument: $1 (use --help)." ;;
    esac
done

[[ "$PORT_BASE" =~ ^[1-9][0-9]{3,4}$ ]] || die "Port base must be an integer from 1024 to 65523."
((PORT_BASE >= 1024 && PORT_BASE <= 65523)) || die "Port base must be from 1024 to 65523."
[[ "$TIMEOUT" =~ ^[1-9][0-9]{0,3}$ ]] || die "Timeout must be an integer from 1 to 9999."
command -v jq >/dev/null || die "jq is required."
if [[ -z "$BIN_DIR" ]]; then
    BITCOIND_PATH=$(command -v bitcoind) || die "Choose the BIP332 build with --bin-dir or BITCOIN_BIN_DIR, or put its binaries on PATH."
    BIN_DIR=$(dirname "$BITCOIND_PATH")
fi
[[ -x "$BIN_DIR/bitcoind" && -x "$BIN_DIR/bitcoin-cli" ]] || die "Build bitcoind and bitcoin-cli first, or pass --bin-dir DIR. Tried: $BIN_DIR"
BIN_DIR=$(cd "$BIN_DIR" && pwd)
BITCOIND="$BIN_DIR/bitcoind"
CLI="$BIN_DIR/bitcoin-cli"

# Separate datadirs, cookies, and ports prevent the demo from touching a running
# development node. Restrictive permissions also protect the generated cookies.
umask 077
TEMP_ROOT=${TMPDIR:-/tmp}
RUN_DIR=$(mktemp -d "${TEMP_ROOT%/}/bip332-demo.XXXXXX")
NAMES=("A: source" "B: middle" "C: downstream")
PIDS=("" "" "")
MODES=(headers headers headers)
STALE_BLOCKS=("" "")

rpc() {
    local node=$1
    shift
    "$CLI" -regtest -datadir="$RUN_DIR/node$node" \
        -rpcport="$((PORT_BASE + 10 + node))" -rpcclienttimeout=5 "$@"
}

# Foreground child processes give the script ownership of their PIDs. This lets
# cleanup wait for shutdown, including before restarting a node in another mode.
stop_node() {
    local node=$1 pid=${PIDS[$1]} deadline
    [[ -n "$pid" ]] || return 0
    if kill -0 "$pid" 2>/dev/null; then
        log "Stopping ${NAMES[$node]} (PID $pid)."
        rpc "$node" stop >/dev/null 2>&1 || kill -TERM "$pid" 2>/dev/null || true
        deadline=$((SECONDS + 20))
        while kill -0 "$pid" 2>/dev/null; do
            if ((SECONDS >= deadline)); then
                log "Shutdown exceeded 20 seconds; killing this demo's child PID $pid."
                kill -KILL "$pid" 2>/dev/null || true
                break
            fi
            sleep 0.2
        done
    fi
    wait "$pid" 2>/dev/null || true
    PIDS[$node]=""
}

print_commands() {
    local node
    printf '\nCommands for inspecting each node (usable from Bash or fish):\n'
    for node in 0 1 2; do
        printf '\n  # %s, mode=%s\n' "${NAMES[$node]}" "${MODES[$node]}"
        printf '  %q -regtest -datadir=%q -rpcport=%s getchaintips 1000 true\n' \
            "$CLI" "$RUN_DIR/node$node" "$((PORT_BASE + 10 + node))"
        printf '  %q -regtest -datadir=%q -rpcport=%s stop\n' \
            "$CLI" "$RUN_DIR/node$node" "$((PORT_BASE + 10 + node))"
    done
}

cleanup() {
    local status=$? node file
    trap - EXIT INT TERM
    set +e
    if ((status != 0)); then
        printf '\nDemo failed or was interrupted (exit %s). Recent logs follow.\n' "$status" >&2
        for node in 0 1 2; do
            for file in "$RUN_DIR/node$node/console.log" "$RUN_DIR/node$node/regtest/debug.log"; do
                if [[ -f "$file" ]]; then
                    printf '\n--- %s ---\n' "$file" >&2
                    tail -n 15 "$file" >&2
                fi
            done
        done
    fi
    if ((status == 0 && KEEP_RUNNING == 1)); then
        log "Leaving all three nodes running as requested."
        print_commands
    else
        for node in 2 1 0; do stop_node "$node"; done
        log "All demo nodes have stopped."
    fi
    printf '\nDatadirs, console output, and debug logs retained at:\n  %s\n' "$RUN_DIR"
    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Wait for observable state instead of assuming mining, handshakes, validation
# callbacks, or downloads finish within an arbitrary fixed sleep. Print progress
# every three seconds so a slow machine does not look like a hung script.
wait_for() {
    local description=$1 deadline=$((SECONDS + TIMEOUT)) next_report=$SECONDS
    shift
    log "Waiting: $description"
    while ! "$@" >/dev/null 2>&1; do
        ((SECONDS < deadline)) || die "Timed out after ${TIMEOUT}s: $description"
        if ((SECONDS >= next_report)); then
            log "  Still waiting: $description"
            next_report=$((SECONDS + 3))
        fi
        sleep 0.2
    done
    log "PASS: $description"
}

start_node() {
    local node=$1 mode=$2 p2p=$((PORT_BASE + $1)) deadline
    mkdir -p "$RUN_DIR/node$node"
    MODES[$node]=$mode
    log "Starting ${NAMES[$node]}: -staletips=$mode, P2P=$p2p, RPC=$((p2p + 10))."
    # connect=0 suppresses automatic outbound peers. Every connection below is
    # explicit; bind/rpcbind keep the listeners on this computer's loopback.
    "$BITCOIND" -regtest -datadir="$RUN_DIR/node$node" -daemon=0 -server=1 \
        -port="$p2p" -bind="127.0.0.1:$p2p" -listen=1 \
        -rpcport="$((p2p + 10))" -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 \
        -connect=0 -dnsseed=0 -discover=0 -listenonion=0 -natpmp=0 \
        -staletips="$mode" -debug=net >>"$RUN_DIR/node$node/console.log" 2>&1 &
    PIDS[$node]=$!
    deadline=$((SECONDS + TIMEOUT))
    until rpc "$node" getblockcount >/dev/null 2>&1; do
        kill -0 "${PIDS[$node]}" 2>/dev/null || die "${NAMES[$node]} exited during startup. Check its console.log; use another --port-base if a port is occupied."
        ((SECONDS < deadline)) || die "${NAMES[$node]} did not become RPC-ready."
        sleep 0.2
    done
    log "${NAMES[$node]} is ready (PID ${PIDS[$node]})."
}

copy_block() {
    local source=$1 destination=$2 hash=$3 result
    log "Submitting common/winning block $hash from ${NAMES[$source]} to ${NAMES[$destination]}."
    result=$(rpc "$destination" submitblock "$(rpc "$source" getblock "$hash" 0)")
    # The first competing blocks can be stored without activating their branch;
    # submitblock then returns inconclusive. The later winning-tip checks prove
    # that the complete branch was accepted and became active on every node.
    case "$result" in
        ""|null) ;;
        inconclusive) log "  Stored competing block; full validation waits for its branch to win." ;;
        *) die "submitblock rejected $hash: $result" ;;
    esac
}

stale_entry() {
    local result
    rpc "$1" getchaintips 1000 true | jq -e --arg hash "$STALE" --arg fork "$COMMON" \
        'any(.[]; .hash == $hash and .fork_point == $fork and .height == 3 and .branchlen == 2)' || return 1
    if result=$(rpc "$1" getblock "$STALE" 0 2>&1); then
        [[ "$2" == true ]]
    else
        [[ "$2" == false && "$result" == *"not fully downloaded"* ]]
    fi
}

show_tips() {
    local node
    for node in 0 1 2; do
        rpc "$node" getchaintips 1000 true | jq --arg node "${NAMES[$node]}" --arg mode "${MODES[$node]}" \
            '{node: $node, mode: $mode, relayable_stale_tips: .}'
        rpc "$node" getnetworkinfo | jq '{localfeatures}'
    done
}

on_winning_chain() {
    rpc "$1" getblockchaininfo | jq -e --arg tip "$WINNER" \
        '.bestblockhash == $tip and .blocks == 4 and .initialblockdownload == false'
}

# Check exact peer counts and outbound destinations. In particular C has only
# one peer, B, so C cannot learn the stale headers or blocks directly from A.
linear_topology() {
    rpc 0 getpeerinfo | jq -e 'length == 1 and all(.[]; .version > 0 and .inbound)' || return 1
    rpc 1 getpeerinfo | jq -e --arg source "127.0.0.1:$PORT_BASE" \
        'length == 2 and all(.[]; .version > 0) and any(.[]; .addr == $source and .inbound == false) and any(.[]; .inbound)' || return 1
    rpc 2 getpeerinfo | jq -e --arg middle "127.0.0.1:$((PORT_BASE + 1))" \
        'length == 1 and all(.[]; .version > 0 and .addr == $middle and .inbound == false)'
}

expect_headers_only() {
    local node=$1 hash result
    for hash in "${STALE_BLOCKS[@]}"; do
        rpc "$node" getblockheader "$hash" | jq -e --arg hash "$hash" '.hash == $hash' >/dev/null
        if result=$(rpc "$node" getblock "$hash" 0 2>&1); then
            die "${NAMES[$node]} unexpectedly has stale block data for $hash in headers mode."
        fi
        [[ "$result" == *"not fully downloaded"* ]] || die "Unexpected getblock failure: $result"
        log "PASS: ${NAMES[$node]} knows header $hash, but getblock reports 'not fully downloaded'."
    done
}

has_all_stale_blocks() {
    local node=$1 hash
    stale_entry "$node" true || return 1
    for hash in "${STALE_BLOCKS[@]}"; do
        rpc "$node" getblock "$hash" 0 >/dev/null || return 1
    done
}

verify_downloads() {
    local node=$1 hash expected actual
    for hash in "${STALE_BLOCKS[@]}"; do
        expected=$(rpc 0 getblock "$hash" 0)
        actual=$(rpc "$node" getblock "$hash" 0)
        [[ "$actual" == "$expected" ]] || die "Downloaded block bytes differ on ${NAMES[$node]}: $hash"
        rpc "$node" getblock "$hash" | jq -e '.confirmations == -1' >/dev/null
        log "PASS: ${NAMES[$node]} downloaded $hash ($(( ${#actual} / 2 )) bytes), identical to A; confirmations=-1."
    done
}

phase "1/6: Start three isolated nodes in headers mode"
log "Binaries: $BIN_DIR"
log "Artifacts: $RUN_DIR"
log "Port base: $PORT_BASE; timeout per check: ${TIMEOUT}s."
log "A will retain the stale blocks; B will learn from A; C will learn only from B."
for node in 0 1 2; do start_node "$node" headers; done

phase "2/6: Create a shared block, then competing branches"
# Different raw output scripts make the competing blocks distinct even if they
# are mined in the same second. These test coinbase outputs need no wallet, and
# the demo never spends them, so mining 100 maturity blocks is unnecessary.
COMMON=$(rpc 0 generatetodescriptor 1 'raw(51)' | jq -er '.[0]')
copy_block 0 1 "$COMMON"
copy_block 0 2 "$COMMON"
STALE_JSON=$(rpc 0 generatetodescriptor 2 'raw(51)')
STALE_BLOCKS[0]=$(jq -er '.[0]' <<<"$STALE_JSON")
STALE_BLOCKS[1]=$(jq -er '.[1]' <<<"$STALE_JSON")
STALE=${STALE_BLOCKS[1]}
WINNING_JSON=$(rpc 1 generatetodescriptor 3 'raw(52)')
WINNER=$(jq -er '.[-1]' <<<"$WINNING_JSON")
log "Common block at height 1: $COMMON"
log "A's two-block branch ends at height 3: $STALE"
log "B's three-block branch wins at height 4: $WINNER"

# Only the winning branch is transferred via RPC. A reorgs and caches its old
# tip; B and C must have no knowledge of the stale branch until P2P relay starts.
for height in 2 3 4; do
    block=$(rpc 1 getblockhash "$height")
    copy_block 1 0 "$block"
    copy_block 1 2 "$block"
done
for node in 0 1 2; do wait_for "${NAMES[$node]} is on the winning chain and outside IBD" on_winning_chain "$node"; done
wait_for "A locally tracks its reorged-out tip with block data" stale_entry 0 true
for node in 1 2; do
    rpc "$node" getchaintips 1000 true | jq -e 'length == 0' >/dev/null
    if result=$(rpc "$node" getblockheader "$STALE" 2>&1); then
        die "${NAMES[$node]} already knows the stale header before P2P relay."
    fi
    [[ "$result" == *"Block not found"* ]] || die "Unexpected getblockheader failure: $result"
    log "PASS: ${NAMES[$node]} has no relayable stale tips and does not know the stale header."
done
show_tips

phase "3/6: Prove header relay along A -> B -> C"
# Establish C--B first, while B's cache is empty. Once B connects to A, the only
# possible path for C to learn the new stale branch is A -> B -> C.
log "Connecting C to B, then B to A. A and C never connect."
rpc 2 addnode "127.0.0.1:$((PORT_BASE + 1))" onetry
rpc 1 addnode "127.0.0.1:$PORT_BASE" onetry
wait_for "the peer graph is exactly A -- B -- C" linear_topology
wait_for "B learns the stale tip from A, without block data" stale_entry 1 false
wait_for "C learns the stale tip through B, without block data" stale_entry 2 false
expect_headers_only 1
expect_headers_only 2
show_tips

phase "4/6: Switch B to blocks mode and fetch from A"
# Stopping both recipients removes old connections and renegotiates BIP332 on
# reconnect. C stays offline until B has the blocks, making the serving path
# deterministic. A stays in headers mode, which can still serve stored blocks.
log "Stopping C and B. A remains running in headers mode with the original blocks."
stop_node 2
stop_node 1
start_node 1 blocks
rpc 1 addnode "127.0.0.1:$PORT_BASE" onetry
wait_for "B has fetched both stale-branch blocks from A" has_all_stale_blocks 1
verify_downloads 1

phase "5/6: Fetch the stale blocks onward from B to C"
start_node 2 blocks
log "Connecting C only to B. C must obtain its stale blocks from B."
rpc 2 addnode "127.0.0.1:$((PORT_BASE + 1))" onetry
wait_for "the peer graph is again exactly A -- B -- C" linear_topology
wait_for "C has fetched both stale-branch blocks from B" has_all_stale_blocks 2
verify_downloads 2
show_tips

phase "6/6: Check the winning chain and show relay evidence"
for node in 0 1 2; do
    wait_for "${NAMES[$node]} still has the original winning tip at height 4" on_winning_chain "$node"
    printf '\nPeers for %s:\n' "${NAMES[$node]}"
    rpc "$node" getpeerinfo | jq '[.[] | {id, addr, inbound, connection_type, version, features}]'
    printf '\nRecent stale-tip messages for %s:\n' "${NAMES[$node]}"
    grep -E 'staletip|stale-tip' "$RUN_DIR/node$node/regtest/debug.log" | tail -n 16 || true
done

printf '\nALL CHECKS PASSED\n'
printf '  Local tracking: A retained the tip disconnected by a real reorg.\n'
printf '  Headers: B learned from A, and C learned onward from B.\n'
printf '  Headers mode: both recipients had headers but neither had block data.\n'
printf '  Blocks: B fetched from A, then C fetched onward from B.\n'
printf '  Integrity: both stale blocks matched A byte for byte on both recipients.\n'
printf '  Chain selection: all three nodes kept the same winning chain.\n'
printf '  Scope: this demonstrates a two-block stale branch, not all BIP332 edge cases.\n'
printf '\nRun again with --keep-running to inspect the final nodes interactively.\n'
