"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const short = (hash, length = 9) => hash ? String(hash).slice(0, length) : "—";
const externalPeer = id => state.external_peers.find(peer => peer.id === id);
const nameOf = id => state.nodes.find(node => node.id === id)?.name || externalPeer(id)?.address || id || "peer";
const networkName = () => state.session.network || "regtest";
const monitoring = () => networkName() === "testnet4";
const supports = capability => state.session.capabilities?.[capability] ?? (["mining", "forks", "bootstrap"].includes(capability) ? !monitoring() : monitoring());
const percent = value => `${(Math.min(1, Math.max(0, Number(value) || 0)) * 100).toFixed(2)}%`;
const storageSize = value => Number.isFinite(value) ? `${(value / 1073741824).toFixed(2)} GiB` : "—";
const modeLabel = mode => ({none: "Disabled", headers: "Headers", blocks: "Blocks"}[mode] || mode || "—");
const prefLabel = value => value === true ? "Blocks preferred" : value === false ? "Headers preferred" : "Not observed";
const isPresent = value => value === true || value === false;
const kindClass = kind => /^[a-z]+$/.test(kind || "") ? kind : "action";
const activeJobs = () => state.jobs.filter(job => ["queued", "running"].includes(job.status));
const outsideWindow = (node, block) => block && Number.isFinite(block.height) && block.height < Math.max(0, Number(node.height || 0) - Number(state.session.window_blocks || 80) + 1);
const modes = '<option value="headers">Headers · relay without fetching</option><option value="blocks">Blocks · relay and fetch</option><option value="none">None · feature disabled</option>';

let state = {session: {}, nodes: [], external_peers: [], blocks: [], links: [], events: [], jobs: []};
let selected = {type: "node", id: null};
let selectedNode = null;
let selectedHash = null;
let zoom = 1;
let pausedEvents = null;
let newPackets = [];
let formHandler = null;
let knownJobIds = new Set();
let dismissedJob = null;
let receivedState = false;
let stream;

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = "toast" + (error ? " error" : "");
  node.textContent = message;
  $("#toasts").append(node);
  setTimeout(() => node.remove(), error ? 9000 : 4500);
}

function connection(online) {
  const status = $("#connectionStatus");
  status.className = "connection-state " + (online ? "online" : "offline");
  status.innerHTML = `<i></i>${online ? "Live" : "Reconnecting"}`;
}

async function action(actionName, params = {}) {
  const response = await fetch("/api/action", {
    method: "POST", headers: {"Content-Type": "application/json", "X-Lab-Request": "1"},
    body: JSON.stringify({action: actionName, ...params})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || "The action could not be started.");
  toast("Action queued. Progress will appear above the workspace.");
  return result;
}

function safeAction(actionName, params) {
  return action(actionName, params).catch(error => toast(error.message, true));
}

function update(snapshot) {
  const changedSession = receivedState && (state.session.run_dir !== snapshot.session?.run_dir || state.session.observation_id !== snapshot.session?.observation_id);
  if (changedSession) {
    selected = {type: "node", id: null}; selectedNode = null; selectedHash = null;
    pausedEvents = null; newPackets = []; zoom = 1; receivedState = false;
    knownJobIds.clear(); dismissedJob = null;
    $("#eventSearch").value = ""; $("#eventKind").value = "all"; $("#eventNode").value = "all";
    $("#modal").close();
  }
  const oldEvents = new Set(state.events.map(event => String(event.id)));
  state = {session: {}, nodes: [], external_peers: [], blocks: [], links: [], events: [], jobs: [], ...snapshot};
  state.nodes ||= []; state.external_peers ||= []; state.blocks ||= []; state.links ||= []; state.events ||= []; state.jobs ||= [];
  newPackets = receivedState ? state.events.filter(event => !oldEvents.has(String(event.id)) && event.direction === "recv" && event.details?.observation !== "feature-support" && event.source && event.target && ["staletip", "block", "getdata", "feature"].includes(event.kind)).slice(-8) : [];
  receivedState = true;
  if (!state.nodes.some(node => node.id === selectedNode)) selectedNode = state.nodes[0]?.id || null;
  if (selected.type === "node" && !state.nodes.some(node => node.id === selected.id)) selected.id = selectedNode;
  for (const job of state.jobs) {
    if (!knownJobIds.has(`${job.id}:${job.status}`)) {
      knownJobIds.add(`${job.id}:${job.status}`);
      if (job.status === "error") toast(job.error || job.message || "The action failed.", true);
    }
  }
  render();
}

function render() {
  const focused = document.activeElement;
  const focusRoot = focused?.closest("#networkCanvas, #chainCanvas, #inspector, #eventList, #nodeList");
  const focusAttribute = ["data-node", "data-peer", "data-link", "data-block", "data-event", "data-mine", "data-lifecycle", "data-connection", "data-action"].find(attribute => focused?.hasAttribute(attribute));
  const focusValue = focusAttribute ? focused.getAttribute(focusAttribute) : null;
  const focusId = focused?.getAttribute("data-id");
  const focusOwner = focused?.getAttribute("data-owner");
  $("#networkBadge").textContent = (state.session.network || "regtest").toUpperCase();
  $("#workspaceTitle").textContent = monitoring() ? "Testnet4 monitor" : "Regtest workspace";
  $("#workspaceDescription").textContent = monitoring() ? "Follow synchronization, peer negotiation, and observed stale-tip relay." : "Follow a fork, from the first header to the last relay.";
  $("#welcomeEyebrow").textContent = monitoring() ? "PUBLIC NETWORK · LOCAL OBSERVATION" : "YOUR FIRST EXPERIMENT";
  $("#welcomeTitle").textContent = monitoring() ? "Your window into testnet4." : "Three nodes. One shared chain.";
  $("#welcomeDescription").textContent = monitoring() ? "Start a node from your BIP332 branch, discover public peers, and watch it synchronize. Its downloaded chain is retained between visits." : "Start A → B → C with five common blocks. Create a fork on A, then watch its announcement reach B and C.";
  $("#chainDescription").textContent = monitoring() ? "Managed nodes only. Gaps between displayed heights are compressed." : "The same block has the same position in every row.";
  $("#workspaceFooter").textContent = monitoring() ? "Testnet4 · Persistent monitoring · Mining and forks available on regtest" : "Local experiment · Regtest";
  $("#forkButton").hidden = !supports("forks");
  $("#nodeCount").textContent = state.nodes.length;
  $("#welcome").hidden = state.nodes.length > 0;
  $("#liveWorkspace").hidden = state.nodes.length === 0;
  $("#forkButton").disabled = !state.nodes.some(node => node.running);
  document.querySelectorAll('[data-action="stop-all"]').forEach(button => { button.disabled = !state.nodes.some(node => node.running); });
  document.querySelectorAll('[data-action="reset"]').forEach(button => {
    button.hidden = monitoring();
    button.disabled = !state.session.reset_supported || !state.nodes.length || activeJobs().length > 0;
    button.title = state.session.reset_supported ? "Start again with an empty workspace" : "Restart the lab server to enable reset";
  });
  document.querySelectorAll('[data-action="bootstrap"]').forEach(button => { button.hidden = !supports("bootstrap"); button.disabled = activeJobs().length > 0; });
  document.querySelectorAll('[data-action="monitor"]').forEach(button => { button.hidden = !monitoring(); button.disabled = activeJobs().length > 0; });
  document.querySelectorAll('[data-action="clear-events"]').forEach(button => { button.hidden = !monitoring(); button.disabled = !state.events.length || activeJobs().length > 0; });
  renderJobs();
  renderNodes();
  if (state.nodes.length) {
    renderNetwork(); renderInspector(); renderChains(); renderEvents();
  }
  // Live snapshots replace SVG and panel contents. Preserve the current
  // keyboard target so a refresh does not interrupt navigation or activation.
  if (focusRoot && focusAttribute && !focused.isConnected) {
    const selector = `[${focusAttribute}="${CSS.escape(focusValue)}"]${focusId ? `[data-id="${CSS.escape(focusId)}"]` : ""}${focusOwner ? `[data-owner="${CSS.escape(focusOwner)}"]` : ""}`;
    document.getElementById(focusRoot.id)?.querySelector(selector)?.focus({preventScroll: true});
  }
}

function renderJobs() {
  const job = activeJobs()[0] || [...state.jobs].reverse().find(item => item.status === "error" && item.id !== dismissedJob);
  const bar = $("#jobBar");
  bar.hidden = !job;
  if (!job) return;
  bar.className = "job-bar" + (job.status === "error" ? " error" : "");
  bar.innerHTML = `<span class="job-dot"></span><span>${escape(job.message || job.error || job.action.replaceAll("_", " "))}${job.status === "queued" ? " · Queued" : ""}</span>${job.status === "error" ? `<button class="job-dismiss" data-dismiss-job="${escape(job.id)}">Dismiss</button>` : ""}`;
}

function renderNodes() {
  $("#nodeList").innerHTML = state.nodes.length ? state.nodes.map((node, index) => `<button class="node-card ${selectedNode === node.id ? "selected" : ""}" data-node="${escape(node.id)}" aria-pressed="${selectedNode === node.id}"><span class="node-card-head"><span class="node-monogram">${escape(node.name?.slice(0, 1) || String(index + 1))}</span><strong>${escape(node.name)}</strong><span class="node-dot ${node.running ? "running" : ""}" aria-label="${node.running ? "Running" : "Stopped"}"></span></span><span class="node-card-meta"><span>${escape(modeLabel(node.mode))}</span><span>${node.running ? `Height ${Number(node.height ?? 0)}` : "Stopped"}</span></span>${monitoring() && node.running ? `<span class="node-card-sync">${node.ibd ? `Syncing · ${percent(node.verification_progress)}` : "Synchronized"}</span>` : ""}${supports("mining") && node.mining?.enabled ? `<span class="node-card-mining">Mining every ${Number(node.mining.interval)}s</span>` : ""}</button>`).join("") : '<p class="empty-sidebar">No nodes yet.<br>Add your first node to begin.</p>';
  const filter = $("#eventNode");
  const previous = filter.value;
  const options = '<option value="all">All nodes</option>' + state.nodes.map(node => `<option value="${escape(node.id)}">${escape(node.name)}</option>`).join("");
  if (filter.innerHTML !== options) {
    filter.innerHTML = options;
    filter.value = [...filter.options].some(option => option.value === previous) ? previous : "all";
  }
}

function networkPositions() {
  const columns = Math.min(4, Math.max(1, state.nodes.length));
  const rows = Math.ceil(state.nodes.length / columns);
  const width = Math.max(state.external_peers.length ? 720 : 520, columns * 180 + 50);
  const externalTop = Math.max(200, rows * 150 + 40);
  const height = Math.max(245, rows * 150 + 20, state.external_peers.length ? externalTop + Math.ceil(state.external_peers.length / 5) * 90 + 25 : 0);
  const positions = {};
  state.nodes.forEach((node, index) => { positions[node.id] = {x: 105 + (index % columns) * ((width - 210) / Math.max(1, columns - 1)), y: 112 + Math.floor(index / columns) * 145}; });
  if (state.nodes.length === 1) positions[state.nodes[0].id].x = width / 2;
  state.external_peers.forEach((peer, index) => { positions[peer.id] = {x: 85 + (index % 5) * ((width - 170) / 4), y: externalTop + 45 + Math.floor(index / 5) * 90}; });
  return {positions, width, height};
}

function renderNetwork() {
  const {positions, width, height} = networkPositions();
  $("#peerCount").textContent = `${state.links.filter(link => link.connected).length} connections`;
  const edges = state.links.map(link => {
    const a = positions[link.a], b = positions[link.b];
    if (!a || !b) return "";
    const external = externalPeer(link.a) || externalPeer(link.b);
    const received = Object.values(link.negotiation || {}).some(value => isPresent(value.received));
    const observed = isPresent(link.negotiation?.[link.a]?.advertised) && isPresent(link.negotiation?.[link.b]?.advertised);
    return `<g data-link="${escape(link.id)}" role="button" tabindex="0" aria-label="Inspect ${escape(nameOf(link.a))} to ${escape(nameOf(link.b))}"><path class="link-line ${external ? "external-link" : ""} ${link.connected ? "" : "disconnected"} ${selected.type === "link" && selected.id === link.id ? "selected" : ""}" d="M${a.x},${a.y} L${b.x},${b.y}"/><path class="link-hit" d="M${a.x},${a.y} L${b.x},${b.y}"/>${external ? "" : `<text class="link-label" text-anchor="middle" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 15}">${link.connected ? observed ? "BIP332 ↔" : received ? "BIP332 OBSERVED" : "CONNECTED" : "DISCONNECTED"}</text>`}</g>`;
  }).join("");
  const externalNodes = state.external_peers.map(peer => {
    const {x, y} = positions[peer.id];
    const link = state.links.find(item => item.a === peer.id || item.b === peer.id);
    const negotiation = link?.negotiation?.[peer.node] || {};
    return `<g class="node-visual external-peer ${selected.type === "peer" && selected.id === peer.id ? "selected" : ""}" data-peer="${escape(peer.id)}" role="button" tabindex="0" aria-label="Inspect external peer ${escape(peer.address)}"><rect class="node-box" x="${x - 62}" y="${y - 29}" width="124" height="58" rx="10"/><text class="node-label" x="${x - 52}" y="${y - 9}">${escape(short(peer.address, 17))}</text><text class="node-subtitle" x="${x - 52}" y="${y + 6}">${isPresent(negotiation.received) ? "BIP332 advertised" : "External peer"}</text><text class="node-subtitle" x="${x - 52}" y="${y + 20}">${peer.inbound ? "Inbound" : "Outbound"} · ${escape(nameOf(peer.node))}</text></g>`;
  }).join("");
  const nodes = state.nodes.map(node => {
    const {x, y} = positions[node.id];
    return `<g class="node-visual ${selectedNode === node.id ? "selected" : ""} ${node.running ? "" : "stopped"}" data-node="${escape(node.id)}" role="button" tabindex="0" aria-label="Inspect node ${escape(node.name)}"><rect class="node-box" x="${x - 62}" y="${y - 42}" width="124" height="84" rx="10"/><circle cx="${x - 45}" cy="${y - 21}" r="3" fill="${node.running ? "#4a9169" : "#b8c0b2"}"/><text class="node-label" x="${x - 35}" y="${y - 17}">${escape(String(node.name).slice(0, 13))}</text><text class="node-subtitle" x="${x - 45}" y="${y + 2}">${escape(modeLabel(node.mode))}${node.mining?.enabled ? " · mining" : ""}</text><text class="node-height" x="${x - 45}" y="${y + 23}">${node.running ? `#${Number(node.height ?? 0)} · ${escape(short(node.best_hash, 6))}` : "STOPPED"}</text></g>`;
  }).join("");
  const packets = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "" : newPackets.map((event, i) => {
    const a = positions[event.source], b = positions[event.target];
    if (!a || !b) return "";
    return `<circle class="packet" r="4"><animateMotion path="M${a.x},${a.y} L${b.x},${b.y}" dur="1.4s" begin="${i * .12}s" repeatCount="1"/><set attributeName="visibility" to="hidden" begin="${1.4 + i * .12}s"/></circle>`;
  }).join("");
  $("#networkCanvas").classList.toggle("monitoring", monitoring());
  $("#networkCanvas").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Live network topology">${edges}${nodes}${externalNodes}${packets}</svg>`;
  newPackets = [];
}

const metric = (label, value) => `<div class="metric-row"><span>${escape(label)}</span><span>${value}</span></div>`;
const pill = (text, type = "") => `<span class="status-pill ${type}">${escape(text)}</span>`;
const inspectorHead = (eyebrow, title, subtitle = "") => `<div class="inspector-header"><div class="eyebrow">${escape(eyebrow)}</div><h2>${escape(title)}</h2>${subtitle ? `<p>${escape(subtitle)}</p>` : ""}</div>`;

function receivedPreference(negotiation, peer) {
  if (isPresent(negotiation.received)) return prefLabel(negotiation.received);
  if (peer?.version && peer.version < 70017) return "Protocol predates BIP434";
  return negotiation.version && negotiation.verack ? "Not advertised in observed handshake" : "Not yet observed";
}

function externalDetails(peer) {
  const link = state.links.find(item => item.a === peer.id || item.b === peer.id);
  const negotiation = link?.negotiation?.[peer.node] || {};
  return `${metric("Observed at", escape(nameOf(peer.node)))}${metric("Connection", peer.inbound ? "Inbound" : "Outbound")}${metric("Protocol", escape(peer.version || "Not reported"))}${metric("Software", escape(peer.subver || "Not reported"))}${metric("BIP332 received", escape(receivedPreference(negotiation, peer)))}<p class="help-text">This is an external peer. Its complete block tree and onward connections are not visible from this node.</p><button class="button full" data-action="peers" data-id="${escape(peer.node)}">Connection settings for ${escape(nameOf(peer.node))}</button>`;
}

function renderInspector() {
  let html = "";
  if (selected.type === "peer") {
    const peer = externalPeer(selected.id);
    if (peer) html = inspectorHead("EXTERNAL PEER", peer.address, "Observed from a managed node") + `<div class="inspector-body">${externalDetails(peer)}</div>`;
    else html = inspectorHead("EXTERNAL PEER", "Connection ended", "This peer is no longer connected") + '<div class="inspector-body"><p class="help-text">Previously observed messages remain in the timeline.</p></div>';
  } else if (selected.type === "link") {
    const link = state.links.find(item => item.id === selected.id);
    if (link) {
      html = inspectorHead("CONNECTION", `${nameOf(link.a)} ↔ ${nameOf(link.b)}`, link.connected ? "Inspect the observed handshake" : "This link is disconnected") + '<div class="inspector-body">';
      for (const id of [link.a, link.b]) {
        const peer = state.nodes.find(node => node.id === id);
        if (!peer) continue;
        const negotiation = link.negotiation?.[id] || {};
        const remote = externalPeer(id === link.a ? link.b : link.a);
        html += `<div class="handshake-node"><h3>${escape(nameOf(id))}</h3>${metric("Configured mode", pill(modeLabel(peer.mode), "neutral"))}<div class="handshake-steps"><span class="${negotiation.version ? "seen" : ""}">version</span><span class="${isPresent(negotiation.advertised) || isPresent(negotiation.received) ? "seen" : ""}">BIP332</span><span class="${negotiation.verack ? "seen" : ""}">verack</span></div>${metric("Local preference observed", escape(prefLabel(negotiation.advertised)))}${metric("Peer preference received", escape(receivedPreference(negotiation, remote)))}</div>`;
      }
      const remote = externalPeer(link.a) || externalPeer(link.b);
      html += `<p class="help-text">${monitoring() ? "Core logs report received feature preferences. Outgoing feature payloads are not decoded, so a configured mode is not proof of an observed advertisement." : "These are captured messages on this connection. Configuration and advertised preference are shown separately."}</p>${remote ? externalDetails(remote) : `<div class="inspector-actions"><button class="button full" data-connection="${escape(link.id)}">${link.connected ? "Disconnect" : "Reconnect"}</button></div>`}</div>`;
    }
  } else if (selected.type === "block") {
    const block = state.blocks.find(item => item.hash === selected.id);
    html = inspectorHead("BLOCK KNOWLEDGE", block ? `Block ${block.height}` : "Selected block", "Availability and validation are separate") + `<div class="inspector-body"><div class="hash-box">${escape(selected.id)}</div>`;
    for (const node of state.nodes) {
      const known = node.blocks?.[selected.id];
      const cached = node.staletips?.some(tip => tip.hash === selected.id);
      html += `<div class="knowledge-row"><strong>${escape(node.name)}</strong><div class="knowledge-tags">${!known ? pill(outsideWindow(node, block) ? "Outside displayed window" : "Unknown", "neutral") : `${pill(known.active ? "Active" : "Stale", known.active ? "" : "amber")}${pill(known.have_data ? "Block data" : "Header only", known.have_data ? "" : "amber")}${cached ? pill("In relay cache", "amber") : ""}`}</div>${known ? `<p>Validation: ${escape(known.validity || "not reported")}${!node.running ? " · last state before stop" : ""}</p>` : ""}</div>`;
    }
    html += `${supports("forks") ? `<button class="button full" data-action="fork" data-parent="${escape(selected.id)}" ${!state.nodes.some(node => node.blocks?.[selected.id]?.have_data && node.running) ? "disabled" : ""}>Fork from this block</button>` : ""}</div>`;
  } else if (selected.type === "event") {
    const event = [...(pausedEvents || []), ...state.events].find(item => String(item.id) === String(selected.id));
    if (event) {
      const route = event.source && event.target ? `${nameOf(event.source)} → ${nameOf(event.target)}` : `${nameOf(event.node)} · ${event.direction || "lab"}`;
      const logged = event.evidence === "debug-log";
      html = inspectorHead(logged ? "LOG OBSERVATION" : "CAPTURED EVENT", event.kind, route) + `<div class="inspector-body">${metric("Observation", escape(observationOf(event)))}${metric("Evidence", logged ? "Bitcoin Core network log" : event.direction === "local" ? "Lab activity" : "P2P message capture")}${metric("Time", escape(timeOf(event, true)))}${metric(logged ? "Message size reported" : "Payload", event.size == null ? "Not reported" : `${Number(event.size)} bytes`)}${event.details?.tip ? `<button class="button full" data-block="${escape(event.details.tip)}">Inspect announced tip</button>` : ""}${event.details?.observation === "feature-support" ? '<p class="help-text">Core parsed this preference from a received feature message. This observation does not represent an additional transmission.</p>' : ""}<pre>${escape(JSON.stringify(event.details || {message: event.summary}, null, 2))}</pre><p class="help-text">${logged ? "This event comes from Core’s network log. The message payload is not captured. Receipt alone does not establish acceptance or onward relay." : "One transmission can produce a sent capture and a received capture. Receive timestamps show when Core processes the message; receipt alone does not establish validation or relay."}</p></div>`;
    }
  }
  if (!html) {
    const node = state.nodes.find(item => item.id === selectedNode) || state.nodes[0];
    if (!node) return;
    const peers = node.peers?.length || 0;
    const sync = monitoring() ? `<div class="sync-status">${metric("Chain state", node.running ? node.ibd ? pill("Initial synchronization", "amber") : pill("Synchronized") : pill("Stopped", "neutral"))}<progress max="1" value="${Math.min(1, Math.max(0, Number(node.verification_progress) || 0))}" aria-label="Chain verification progress"></progress>${metric("Verification progress", percent(node.verification_progress))}${metric("Headers known", escape(node.headers ?? "—"))}${metric("Block storage", `${storageSize(node.size_on_disk)}${node.pruned ? " · pruned" : ""}`)}</div>` : "";
    html = inspectorHead("NODE INSPECTOR", node.name, node.running ? `Running on ${networkName()}` : "Stopped · data retained") + `<div class="inspector-body">${metric("Stale-tip mode", pill(modeLabel(node.mode)))}${metric("Downloaded blocks", escape(node.height ?? "—"))}${sync}${metric("Peers / stale tips", `${peers} / ${node.staletips?.length || 0}`)}${supports("mining") ? metric("Miner", node.mining?.enabled ? `<span class="running-miner">Every ${Number(node.mining.interval)}s</span>` : "Paused") : ""}<div class="hash-box" title="Active tip">${escape(node.best_hash || "Waiting for chain state…")}</div>${node.error ? `<p class="form-error">${escape(node.error)}</p>` : ""}${monitoring() && node.ibd ? '<p class="help-text">Stale-tip announcements are paused during initial synchronization.</p>' : ""}<div class="inspector-actions">${supports("mining") ? `<button class="button primary" data-mine="${escape(node.id)}" ${node.running ? "" : "disabled"}>Mine 1 block</button><button class="button" data-action="miner" data-id="${escape(node.id)}">Miner settings</button>` : ""}<button class="button" data-action="mode" data-id="${escape(node.id)}">Change mode</button><button class="button" data-lifecycle="${escape(node.id)}">${node.running ? "Stop node" : "Start node"}</button>${supports("public_peers") ? `<button class="button full" data-action="peers" data-id="${escape(node.id)}">Connection settings</button>` : ""}</div><p class="help-text">Changing mode restarts the node and reconnects its peers. Select a connection to see negotiation.</p></div>`;
  }
  $("#inspector").innerHTML = html;
}

function blockLayout() {
  const blocks = [...state.blocks].filter(block => Number.isFinite(block.height)).sort((a, b) => a.height - b.height || a.hash.localeCompare(b.hash));
  const positions = new Map(), childCounts = new Map();
  let nextLane = 0;
  for (const block of blocks) {
    const parent = positions.get(block.parent);
    const sibling = childCounts.get(block.parent) || 0;
    let lane;
    if (!parent) lane = sibling === 0 && positions.size === 0 ? 0 : nextLane++;
    else lane = sibling === 0 ? parent.lane : nextLane++;
    nextLane = Math.max(nextLane, lane + 1);
    positions.set(block.hash, {lane});
    childCounts.set(block.parent, sibling + 1);
  }
  return {blocks, positions, lanes: Math.max(1, nextLane)};
}

function renderChains() {
  const {blocks, positions, lanes} = blockLayout();
  if (!blocks.length) { $("#chainCanvas").innerHTML = `<p class="empty-message">${monitoring() ? "Waiting for chain state from your nodes. Synchronization may take time." : "Waiting for block headers. Mine a block to begin."}</p>`; return; }
  const heights = [...new Set(blocks.map(block => block.height))];
  const columns = new Map(heights.map((height, index) => [height, index]));
  const step = monitoring() ? Math.max(54, 66 * zoom) : 58 * zoom;
  const halfBlock = monitoring() ? 24 : 18;
  const rowHeight = Math.max(88, lanes * 36 + 40);
  const width = Math.max(650, 155 + heights.length * step);
  const height = state.nodes.length * rowHeight;
  let html = "";
  state.nodes.forEach((node, index) => {
    const top = index * rowHeight;
    html += `<line class="chain-divider" x1="0" y1="${top}" x2="${width}" y2="${top}"/><text class="chain-node-label" x="20" y="${top + 35}">${escape(String(node.name).slice(0, 14))}</text><text class="chain-node-sub" x="20" y="${top + 51}">${node.running ? `${escape(modeLabel(node.mode))} · #${Number(node.height ?? 0)}` : "Stopped · saved view"}</text>`;
    for (const block of blocks) {
      const point = positions.get(block.hash);
      const x = 145 + columns.get(block.height) * step, y = top + 33 + point.lane * 36;
      const known = node.blocks?.[block.hash];
      const parent = blocks.find(item => item.hash === block.parent);
      if (parent) {
        const px = 145 + columns.get(parent.height) * step, py = top + 33 + positions.get(parent.hash).lane * 36;
        html += `<path class="chain-edge ${known ? "" : "unknown"}" d="M${px + halfBlock},${py} C${px + step / 2},${py} ${x - step / 2},${y} ${x - halfBlock},${y}"/>`;
      }
    }
    for (const block of blocks) {
      const x = 145 + columns.get(block.height) * step, y = top + 33 + positions.get(block.hash).lane * 36;
      const known = node.blocks?.[block.hash];
      const status = !known ? "unknown" : known.validity === "invalid" ? "invalid" : known.active ? "active" : known.have_data ? "data" : "headers";
      const statusLabel = !known && outsideWindow(node, block) ? "outside displayed window" : status;
      html += `<g class="block ${status} ${selectedHash === block.hash ? "selected" : ""}" data-block="${escape(block.hash)}" data-owner="${escape(node.id)}" role="button" tabindex="0" aria-label="${escape(node.name)} block ${block.height}: ${statusLabel}"><title>${escape(block.hash)} · ${statusLabel}${known?.validity ? ` · ${escape(known.validity)}` : ""}</title><rect x="${x - halfBlock}" y="${y - 12}" width="${halfBlock * 2}" height="24" rx="5"/><text x="${x}" y="${y}">${block.height}</text></g>`;
    }
  });
  $("#chainCanvas").innerHTML = `<svg width="${width}" height="${height}" role="group" aria-label="Aligned block trees for every node">${html}</svg>`;
  $("#zoomLabel").textContent = `${Math.round(zoom * 100)}%`;
}

function timeOf(event, full = false) {
  const date = new Date(Number(event.time) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return full ? date.toLocaleString() + "." + String(date.getMilliseconds()).padStart(3, "0") : date.toLocaleTimeString([], {hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"}) + "." + String(date.getMilliseconds()).padStart(3, "0");
}

function eventDescription(event) {
  const d = event.details || {};
  if (event.kind === "staletip") return event.evidence === "debug-log" && !d.tip ? event.summary || "staletip observed · payload not captured" : `${d.header_count ?? d.headers?.length ?? "?"} headers · have_block=${d.have_block} · tip ${short(d.tip)}`;
  if (event.kind === "feature") return event.evidence === "debug-log" && !isPresent(d.prefers_blocks) ? d.log || event.summary || "Feature message observed" : `${d.feature || "feature"} · ${prefLabel(d.prefers_blocks)}`;
  if (event.kind === "version") return event.evidence === "debug-log" && d.version == null ? d.log || event.summary || "Version message observed" : `Protocol ${d.version ?? "—"}`;
  if (d.hash) return short(d.hash, 19);
  if (d.hashes?.length) return `${d.hashes.length} ${d.hashes.length === 1 ? "hash" : "hashes"} · ${short(d.hashes[0], 14)}`;
  return event.summary || (event.size ? `${event.size} bytes` : "");
}

function observationOf(event) {
  if (event.evidence === "debug-log" && event.details?.observation === "feature-support") return `Peer preference at ${nameOf(event.node)}`;
  if (event.direction === "sent") return `Sent at ${nameOf(event.node)}`;
  if (event.direction === "recv") return `Received at ${nameOf(event.node)}`;
  return event.node ? `Lab event at ${nameOf(event.node)}` : "Lab event";
}

function renderEvents() {
  const source = pausedEvents || state.events;
  const search = $("#eventSearch").value.toLowerCase().trim();
  const kind = $("#eventKind").value, node = $("#eventNode").value;
  const filtered = source.filter(event => {
    if (node !== "all" && ![event.node, event.source, event.target, event.peer].includes(node)) return false;
    if (kind === "relay" && !["staletip", "getdata", "block", "notfound"].includes(event.kind)) return false;
    if (kind === "handshake" && !["version", "verack", "feature"].includes(event.kind)) return false;
    if (kind === "action" && !["action", "lab", "error", "mined", "mining", "fork", "node", "connection", "scenario"].includes(event.kind)) return false;
    if (!["all", "relay", "handshake", "action"].includes(kind) && event.kind !== kind) return false;
    return !search || `${JSON.stringify(event)} ${nameOf(event.source)} ${nameOf(event.target)} ${nameOf(event.node)}`.toLowerCase().includes(search);
  });
  $("#eventCount").textContent = source.length;
  const pending = pausedEvents ? state.events.filter(event => !pausedEvents.some(old => old.id === event.id)).length : 0;
  $("#pauseButton").textContent = pausedEvents ? `Resume${pending ? ` · ${pending} new` : ""}` : "Pause timeline";
  $("#timelineCaption").textContent = pausedEvents ? `Timeline paused for inspection. Nodes${supports("mining") ? " and miners" : ""} continue running.` : monitoring() ? "Observed in Core network logs. Payloads are not captured; arrival does not imply acceptance." : "Captured at application processing time. Arrival does not imply acceptance.";
  const rows = filtered.slice(-150).reverse();
  $("#eventList").innerHTML = rows.length ? rows.map(event => {
    const route = event.source && event.target ? `${escape(nameOf(event.source))}<b>→</b>${escape(nameOf(event.target))}` : `${escape(nameOf(event.node))}<b>·</b>${escape(event.direction || "lab")}`;
    return `<button class="event-row ${selected.type === "event" && String(selected.id) === String(event.id) ? "selected" : ""}" data-event="${escape(event.id)}"><span class="event-time">${escape(timeOf(event))}</span><span class="event-route"><span>${route}</span><small class="event-observation">${escape(observationOf(event))}</small></span><span class="message-badge ${kindClass(event.kind)}">${escape(event.kind)}</span><span class="event-description">${escape(eventDescription(event))}</span></button>`;
  }).join("") : `<p class="empty-message">No matching messages yet.<br>${monitoring() ? "Connect to peers to observe network activity. BIP332 requires support from the peer." : "Connect nodes or create a fork to watch the exchange."}</p>`;
  $("#timelineLimit").textContent = filtered.length > 150 ? `Showing the latest 150 of ${filtered.length} matching events. Narrow the filters or export the session for all retained events.` : `${filtered.length} matching events · newest first · select a row for ${monitoring() ? "observed details" : "its payload"}`;
}

function openDialog(title, body, submitText, handler) {
  $("#modal").setAttribute("role", "dialog");
  $("#modal").removeAttribute("aria-describedby");
  $("#modalSubmit").classList.remove("danger");
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = body;
  $("#modalSubmit").textContent = submitText;
  $("#modalSubmit").hidden = !handler;
  $("#modalError").hidden = true;
  formHandler = handler;
  $("#modal").showModal();
}

function nodeOptions(nodes = state.nodes, selectedId = selectedNode) {
  return nodes.map(node => `<option value="${escape(node.id)}" ${node.id === selectedId ? "selected" : ""}>${escape(node.name)}${node.running ? "" : " · stopped"}</option>`).join("");
}

function addNodeDialog() {
  openDialog("Add a node", `<p>${monitoring() ? "Start a local testnet4 node. Each node downloads and verifies its own chain, which is retained when the monitor restarts." : "Launch an isolated Bitcoin Core process. Connect it to peers after it starts."}</p><label class="field">Name<input name="name" maxlength="24" required value="${escape(String.fromCharCode(65 + state.nodes.length % 26))}" autocomplete="off"></label><label class="field">Stale-tip mode<select name="mode">${modes}</select></label>${monitoring() ? peerFields() : state.nodes.some(node => node.running) ? `<label class="field">Start with the chain from<select name="seed_from">${nodeOptions(state.nodes.filter(node => node.running))}</select><small>Only the active chain is copied. Stale branches must arrive over P2P.</small></label>` : ""}`, "Start node", values => action("add_node", {name: values.get("name"), mode: values.get("mode"), ...(monitoring() ? peerValues(values) : values.get("seed_from") ? {seed_from: values.get("seed_from")} : {})}));
}

function peerFields(node = {}) {
  return `<label class="check-label peer-discovery"><input type="checkbox" name="public_network" ${node.public_network !== false ? "checked" : ""}> Discover public testnet4 peers automatically</label><label class="field">Additional peers<textarea name="peers" rows="3" spellcheck="false" placeholder="host:48333">${escape((node.configured_peers || []).join("\n"))}</textarea><small>One host:port per line, or separated by commas. IPv6 addresses use [address]:port. With discovery off and this field empty, only connections you create between lab nodes are used.</small></label>`;
}

function peerValues(values) {
  return {public_network: values.get("public_network") === "on", peers: String(values.get("peers") || "").split(/[\s,]+/).filter(Boolean)};
}

function peersDialog(id) {
  const node = state.nodes.find(item => item.id === id);
  if (!node || !supports("public_peers")) return;
  openDialog(`Connections for ${node.name}`, `<p>Changing these settings restarts a running node and retains its downloaded chain. Connections to other managed nodes are restored.</p>${peerFields(node)}`, "Apply connections", values => action("set_peers", {id, ...peerValues(values)}));
}

function modeDialog(id) {
  const node = state.nodes.find(item => item.id === id);
  if (!node) return;
  openDialog(`Mode for ${node.name}`, '<p>The node restarts and reconnects its peers so the new preference is negotiated. Its chain data is retained.</p><label class="field">Stale-tip mode<select name="mode">' + modes + '</select></label>', "Apply mode", values => action("set_mode", {id, mode: values.get("mode")}));
  $('#modalBody [name="mode"]').value = node.mode;
}

function minerDialog(id) {
  if (!supports("mining")) return;
  const node = state.nodes.find(item => item.id === id);
  if (!node) return;
  openDialog(`Miner for ${node.name}`, `<p>Mine on this node’s active tip. Automatic mining produces one block per interval while the node is running.</p><label class="field">Automatic mining<select name="enabled"><option value="false">Paused</option><option value="true">Running</option></select></label><label class="field">Interval, seconds<input name="interval" type="number" min="2" max="3600" value="${Number(node.mining?.interval || 10)}" required></label>`, "Save miner", values => action("miner", {id, enabled: values.get("enabled") === "true", interval: Number(values.get("interval"))}));
  $('#modalBody [name="enabled"]').value = node.mining?.enabled ? "true" : "false";
}

function connectionsDialog() {
  const running = state.nodes.filter(node => node.running);
  const links = state.links.filter(link => link.connected && !externalPeer(link.a) && !externalPeer(link.b));
  openDialog(monitoring() ? "Managed node connections" : "Connections", `${monitoring() ? "<p>To choose public network peers, select a node and open its Connection settings.</p>" : ""}${links.length ? `<div class="connection-list">${links.map(link => `<div class="connection-item"><span>${escape(nameOf(link.a))} ↔ ${escape(nameOf(link.b))}</span><button type="button" class="button compact" data-connection="${escape(link.id)}">Disconnect</button></div>`).join("")}</div><br>` : ""}${running.length < 2 ? '<p>Start at least two nodes to create a connection between them.</p>' : `<p>Connections are bidirectional. An arrow in the timeline shows the direction of a specific message.</p><div class="field-row"><label class="field">From<select name="a">${nodeOptions(running)}</select></label><label class="field">To<select name="b">${nodeOptions(running, running.find(node => node.id !== selectedNode)?.id)}</select></label></div>`}`, "Connect nodes", running.length < 2 ? null : values => {
    if (values.get("a") === values.get("b")) throw new Error("Choose two different nodes.");
    return action("connect", {a: values.get("a"), b: values.get("b")});
  });
}

function forkDialog(parentHash) {
  if (!supports("forks")) return;
  const running = state.nodes.filter(node => node.running);
  if (!running.length) return;
  let source = running.find(node => node.id === selectedNode) || running[0];
  if (parentHash) source = running.find(node => node.blocks?.[parentHash]?.have_data) || source;
  const blocksFor = node => Object.values(node.blocks || {}).filter(block => block.have_data).sort((a, b) => b.height - a.height || a.hash.localeCompare(b.hash));
  const blocks = blocksFor(source);
  if (!blocks.length) { toast("The source node needs block data before it can create a fork.", true); return; }
  const defaultParent = parentHash || blocks.find(block => block.active && block.height <= Number(source.height) - 2)?.hash || blocks.at(-1).hash;
  const blockOptions = (list, chosen) => list.map(block => `<option value="${escape(block.hash)}" ${block.hash === chosen ? "selected" : ""}>Height ${block.height} · ${short(block.hash, 12)}${block.active ? " · active" : " · stale"}</option>`).join("");
  openDialog("Create a fork", `<p>An isolated helper mines a valid branch from your chosen parent, then publishes it only to the selected nodes.</p><label class="field">Source of ancestor blocks<select name="source">${nodeOptions(running, source.id)}</select></label><label class="field">Fork after this block<select name="parent">${blockOptions(blocks, defaultParent)}</select></label><label class="field">New blocks<input type="number" name="length" min="1" max="20" value="1" required><small>Up to 20 blocks. Other nodes learn the branch through their existing peer connections.</small></label><fieldset><legend>Publish initially to</legend><div class="check-list">${running.map(node => `<label class="check-label"><input type="checkbox" name="recipients" value="${escape(node.id)}" ${node.id === source.id ? "checked" : ""}>${escape(node.name)}</label>`).join("")}</div></fieldset><p id="forkWarning" class="notice"></p>`, "Mine & publish fork", values => {
    const recipients = values.getAll("recipients");
    if (!recipients.length) throw new Error("Choose at least one initial recipient.");
    return action("fork", {source: values.get("source"), parent: values.get("parent"), length: Number(values.get("length")), recipients});
  });
  const warning = () => {
    const node = state.nodes.find(item => item.id === $('#modalBody [name="source"]').value);
    const parent = node?.blocks?.[$('#modalBody [name="parent"]').value];
    const tipHeight = (parent?.height || 0) + Number($('#modalBody [name="length"]').value);
    const recipients = [...document.querySelectorAll('#modalBody [name="recipients"]:checked')].map(input => state.nodes.find(item => item.id === input.value));
    const overtaken = recipients.filter(item => item && tipHeight > item.height);
    $("#forkWarning").textContent = `New tip: height ${tipHeight}. ${overtaken.length ? `This branch is longer than ${overtaken.map(item => item.name).join(", ")}’s active chain and may cause a reorg.` : "Keep it shorter than the active chain to observe stale-tip relay."}`;
  };
  $('#modalBody [name="source"]').addEventListener("change", event => {
    const node = state.nodes.find(item => item.id === event.target.value);
    const list = blocksFor(node);
    $('#modalBody [name="parent"]').innerHTML = blockOptions(list, list.find(block => block.active && block.height <= node.height - 2)?.hash);
    warning();
  });
  $("#modalBody").addEventListener("input", warning, {signal: dialogSignal()});
  warning();
}

let dialogAbort;
function dialogSignal() {
  dialogAbort?.abort();
  dialogAbort = new AbortController();
  return dialogAbort.signal;
}

function sessionDialog() {
  openDialog("Session details", `<p>${monitoring() ? "Managed nodes run locally and connect to testnet4. Node settings and downloaded chains are retained in this persistent profile when the server restarts." : "All nodes run locally. Captures and node data are retained in this session’s directory."}</p><label class="field">Network<div class="hash-box">${escape(networkName())}</div></label><label class="field">Bitcoin Core binary<div class="hash-box session-path">${escape(state.session.binary || "Not reported")}</div></label><label class="field">${monitoring() ? "Persistent profile" : "Session directory"}<div class="hash-box session-path">${escape(state.session.run_dir || "Not reported")}</div></label><p>Block trees display the most recent ${Number(state.session.window_blocks || 80)} heights per managed node.${monitoring() ? " External peers’ complete block trees are not available. Gaps between displayed heights are compressed." : ""}</p><p>${monitoring() ? "Message events come from bounded Bitcoin Core network logs. Full P2P payloads are not captured, so initial synchronization does not duplicate the downloaded chain in capture files. Received BIP332 preferences are shown when Core logs them; outgoing feature payloads remain unobserved." : "The timeline keeps the latest captured events in memory; the complete capture files remain on disk."}</p><p>${monitoring() ? "Clear timeline preserves node data and connections. Mining and fork creation are available only in the regtest lab." : "Custom signet is reserved for a later network adapter."}</p><a class="button full" href="/api/export" download>Export current session as JSON</a>`, "", null);
}

function resetDialog() {
  const session = state.session.run_dir;
  const miners = state.nodes.filter(node => node.mining?.enabled).length;
  openDialog("Reset the entire lab?", `<p>This will stop all <strong>${state.nodes.length} nodes</strong>${miners ? ` and ${miners} automatic miner${miners === 1 ? "" : "s"}` : ""} and clear the nodes, connections, block trees, and timeline from this workspace.</p><p>You will return to an <strong>empty lab</strong>, ready to create a new experiment.</p><p>Previous node data, logs, and captures will remain on disk in the old session directory.</p>`, "Reset lab", () => action("reset", {confirmed: true, session}));
  $("#modal").setAttribute("role", "alertdialog");
  $("#modal").setAttribute("aria-describedby", "modalBody");
  $("#modalSubmit").classList.add("danger");
  $('#modal .dialog-footer [data-action="close-dialog"]').focus();
}

document.addEventListener("click", event => {
  const control = event.target.closest("[data-action], [data-node], [data-peer], [data-link], [data-block], [data-event], [data-mine], [data-lifecycle], [data-connection], [data-dismiss-job]");
  if (!control || control.disabled) return;
  if (control.dataset.node !== undefined) {
    selectedNode = control.dataset.node; selected = {type: "node", id: selectedNode}; render();
  } else if (control.dataset.peer !== undefined) {
    selected = {type: "peer", id: control.dataset.peer}; render();
  } else if (control.dataset.link !== undefined) {
    selected = {type: "link", id: control.dataset.link}; render();
  } else if (control.dataset.block !== undefined) {
    selectedHash = control.dataset.block; selected = {type: "block", id: selectedHash}; render();
  } else if (control.dataset.event !== undefined) {
    selected = {type: "event", id: control.dataset.event};
    const entry = [...state.events, ...(pausedEvents || [])].find(item => String(item.id) === String(selected.id));
    selectedHash = entry?.details?.tip || entry?.details?.hash || entry?.details?.hashes?.[0] || selectedHash;
    renderInspector(); renderChains(); renderEvents();
  } else if (control.dataset.mine !== undefined && supports("mining")) safeAction("mine", {id: control.dataset.mine, count: 1});
  else if (control.dataset.lifecycle !== undefined) {
    const node = state.nodes.find(item => item.id === control.dataset.lifecycle);
    if (node) safeAction(node.running ? "stop_node" : "start_node", {id: node.id});
  } else if (control.dataset.connection !== undefined) {
    const link = state.links.find(item => item.id === control.dataset.connection);
    if (link && !externalPeer(link.a) && !externalPeer(link.b)) safeAction(link.connected ? "disconnect" : "connect", {a: link.a, b: link.b});
    $("#modal").close();
  } else if (control.dataset.dismissJob !== undefined) { dismissedJob = control.dataset.dismissJob; renderJobs(); }
  else {
    switch (control.dataset.action) {
      case "add-node": addNodeDialog(); break;
      case "bootstrap": if (supports("bootstrap")) safeAction("bootstrap", {count: 3, mode: "headers"}); break;
      case "monitor": if (monitoring()) safeAction("add_node", {name: "A", mode: "headers", public_network: true, peers: []}); break;
      case "connections": connectionsDialog(); break;
      case "mode": modeDialog(control.dataset.id || selectedNode); break;
      case "peers": peersDialog(control.dataset.id || selectedNode); break;
      case "miner": minerDialog(control.dataset.id || selectedNode); break;
      case "fork": forkDialog(control.dataset.parent); break;
      case "session-info": sessionDialog(); break;
      case "close-dialog": $("#modal").close(); break;
      case "stop-all": openDialog("Stop all nodes?", `<p>${monitoring() ? "All managed nodes shut down. Their downloaded chains and connection settings are retained." : "Mining stops and all node processes shut down. Their blocks and captures are retained."} You can start the nodes again individually.</p>`, "Stop all nodes", () => action("stop_all")); break;
      case "reset": resetDialog(); break;
      case "clear-events": openDialog("Clear the message timeline?", "<p>The current timeline is cleared. Nodes keep running, and their downloaded chains and connection settings are retained.</p>", "Clear timeline", () => action("clear_events")); break;
      case "pause": pausedEvents = pausedEvents ? null : [...state.events]; renderEvents(); break;
      case "zoom-in": zoom = Math.min(1.8, zoom + .2); renderChains(); break;
      case "zoom-out": zoom = Math.max(.6, zoom - .2); renderChains(); break;
    }
  }
});

document.addEventListener("keydown", event => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches('svg [role="button"]')) {
    event.preventDefault(); event.target.dispatchEvent(new MouseEvent("click", {bubbles: true}));
  }
});
$("#modalForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!formHandler) return;
  const button = $("#modalSubmit");
  button.disabled = true;
  $("#modalError").hidden = true;
  try {
    await formHandler(new FormData(event.currentTarget));
    $("#modal").close();
  } catch (error) {
    $("#modalError").textContent = error.message;
    $("#modalError").hidden = false;
  } finally { button.disabled = false; }
});
$("#modal").addEventListener("close", () => { dialogAbort?.abort(); });
$("#eventSearch").addEventListener("input", renderEvents);
$("#eventKind").addEventListener("change", renderEvents);
$("#eventNode").addEventListener("change", renderEvents);

async function initialState() {
  try {
    const response = await fetch("/api/state", {cache: "no-store"});
    if (!response.ok) throw new Error("Cannot read the lab state.");
    update(await response.json());
  } catch (error) { connection(false); toast(error.message, true); }
}

render();
initialState();
stream = new EventSource("/api/stream");
stream.addEventListener("state", event => {
  try { update(JSON.parse(event.data)); connection(true); }
  catch (error) { console.error("Invalid state update", error); connection(false); }
});
stream.addEventListener("error", () => connection(false));
window.addEventListener("beforeunload", () => stream.close());
