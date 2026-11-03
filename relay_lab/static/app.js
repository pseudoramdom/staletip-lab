"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
// Block hashes on test networks and mainnet all begin with zeros, so the end
// is the part that tells them apart.
const short = (hash, length = 6) => hash ? `…${String(hash).slice(-length)}` : "—";
const externalPeer = id => state.external_peers.find(peer => peer.id === id);
const nameOf = id => state.nodes.find(node => node.id === id)?.name || externalPeer(id)?.address || id || "peer";
const networkName = () => state.session.network || "regtest";
const monitoring = () => ["testnet4", "signet"].includes(networkName());
const networkLabel = () => ({testnet4: "Testnet4", signet: "Signet", regtest: "Regtest"}[networkName()] || networkName());
const observing = () => state.session.observer === true;
const canManage = () => receivedState && !observing() && state.session.capabilities?.management !== false;
const managementControls = '[data-lifecycle], [data-connection], [data-mine], ' + ["add-node", "connections", "mode", "peers", "miner", "mine-selected", "fork", "bootstrap", "monitor", "stop-all", "reset"].map(name => `[data-action="${name}"]`).join(", ");
function hideManagementControls(root = document) {
  if (!canManage()) root.querySelectorAll(managementControls).forEach(control => { control.hidden = true; });
}
const supports = capability => (!observing() || !["management", "mining", "forks", "bootstrap", "public_peers"].includes(capability)) && (state.session.capabilities?.[capability] ?? (["mining", "forks", "bootstrap"].includes(capability) ? !monitoring() : monitoring()));
const percent = value => `${(Math.min(1, Math.max(0, Number(value) || 0)) * 100).toFixed(2)}%`;
const storageSize = value => Number.isFinite(value) ? `${(value / 1073741824).toFixed(2)} GiB` : "—";
const modeLabel = mode => ({none: "Disabled", headers: "Headers", blocks: "Blocks"}[mode] || mode || "—");
const prefLabel = value => value === true ? "Blocks preferred" : value === false ? "Headers preferred" : "Not observed";
const isPresent = value => value === true || value === false;
const kindClass = kind => /^[a-z]+$/.test(kind || "") ? kind : "action";
const activeJobs = () => state.jobs.filter(job => ["queued", "running"].includes(job.status));
const outsideWindow = (node, block) => block && Number.isFinite(block.height) && block.height < Math.max(0, Number(node.height || 0) - Number(state.session.window_blocks || 80) + 1);
const modes = '<option value="headers">Headers · relay without fetching</option><option value="blocks">Blocks · relay and fetch</option><option value="none">None · feature disabled</option>';
const isManaged = id => state.nodes.some(node => node.id === id);
const hashesOf = event => { const d = event.details || {}; return [...(d.hashes || []), d.tip, d.hash].filter(Boolean); };
const duration = ms => ms < 10 ? `${+ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
const bytes = value => value >= 10240 ? `${(value / 1024).toFixed(1)} KiB` : `${Math.round(value)} B`;
const RELAYED = ["staletip", "headers", "block", "cmpctblock"];
const STATUS_LABEL = {active: "Active chain", data: "Full block", headers: "Header only", invalid: "Invalid", unknown: "Not known"};
const TYPES = [
  ["all", "All", () => true],
  ["staletip", "Stale relay", event => event.kind === "staletip"],
  ["blocks", "Block relay", event => ["getdata", "block", "cmpctblock", "headers", "inv", "notfound"].includes(event.kind)],
  ["handshake", "Negotiation", event => ["version", "verack", "feature"].includes(event.kind)],
  ["action", "Lab activity", event => !["sent", "recv"].includes(event.direction)]
];
const icon = (path, extra = "") => `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" ${extra}>${path}</svg>`;
const CLOSE = icon('<path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5"/>');
const COPY = icon('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V3A1 1 0 0 0 9.5 2H3.5A1 1 0 0 0 2.5 3V9.5A1 1 0 0 0 3.5 10.5H4"/>');
const ARROW = icon('<path d="M3 8H12.5M9 4.5L12.5 8L9 11.5"/>');
const CHEVRON = icon('<path d="M4.5 6.5L8 10L11.5 6.5"/>');

let state = {session: {}, nodes: [], external_peers: [], blocks: [], links: [], events: [], jobs: []};
let selected = {type: "node", id: null};
let selectedNode = null;
let selectedHash = null;
let blockFilter = null;
let hoveredEvent = null;
let zoom = 1;
let pausedEvents = null;
let newPackets = [];
let formHandler = null;
let knownJobIds = new Set();
let dismissedJob = null;
let receivedState = false;
let stream;

// Live snapshots arrive about once a second. Replacing unchanged markup would
// swallow clicks that land between mousedown and mouseup.
function setHTML(element, html) {
  if (element._html !== html) {
    element.innerHTML = html;
    element._html = html;
  }
  hideManagementControls(element);
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = "toast" + (error ? " error" : "");
  node.textContent = message;
  $("#toasts").append(node);
  setTimeout(() => node.remove(), error ? 9000 : 4500);
}

function connection(online) {
  const status = $("#connectionStatus");
  status.className = "live-pill " + (online ? "online" : "offline");
  status.innerHTML = `<i></i>${online ? "Live" : "Reconnecting"}`;
}

async function action(actionName, params = {}) {
  if (!canManage() && actionName !== "clear_events") throw new Error("This observer only reads node state. Manage the node on its host.");
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
    selected = {type: "node", id: null}; selectedNode = null; selectedHash = null; blockFilter = null;
    pausedEvents = null; newPackets = []; zoom = 1; receivedState = false; hoveredEvent = null;
    knownJobIds.clear(); dismissedJob = null;
    $("#eventSearch").value = ""; $("#eventType").value = "all"; $("#eventNode").value = "all";
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
  const focusRoot = focused?.closest("#networkCanvas, #chainCanvas, #inspector, #eventList, #nodeList, #summary, #tracePanel, #blockFilter");
  const focusAttribute = ["data-node", "data-peer", "data-link", "data-block", "data-event", "data-mine", "data-lifecycle", "data-connection", "data-action"].find(attribute => focused?.hasAttribute(attribute));
  const focusValue = focusAttribute ? focused.getAttribute(focusAttribute) : null;
  const focusId = focused?.getAttribute("data-id");
  const focusOwner = focused?.getAttribute("data-owner");
  $("#networkCrumb").textContent = monitoring() ? `${networkLabel()} ${observing() ? "observer" : "monitor"}` : "Regtest lab";
  const started = new Date(Number(state.session.started_at) * 1000);
  $("#sessionCrumb").textContent = monitoring() ? "Persistent profile" : Number.isNaN(started.getTime()) ? "Session" : `Session ${started.toLocaleDateString([], {day: "numeric", month: "short"})}, ${started.toLocaleTimeString([], {hour12: false, hour: "2-digit", minute: "2-digit"})}`;
  $("#workspaceTitle").textContent = monitoring() ? `${networkLabel()} ${observing() ? "observer" : "monitor"}` : "Regtest workspace";
  $("#welcomeTitle").textContent = monitoring() ? `Your window into ${networkLabel()}.` : "Three nodes. One shared chain.";
  $("#welcomeDescription").textContent = observing() ? "Waiting for the nodes listed in the observer configuration. Node services are managed on their host." : monitoring() ? "Start a node from your BIP332 branch, discover public peers, and watch it synchronize. Its downloaded chain is retained between visits." : "Start A → B → C with five common blocks. Create a fork on A, then watch its announcement reach B and C.";
  $("#chainDescription").textContent = monitoring() ? `${observing() ? "Observed" : "Managed"} nodes only; gaps between heights are compressed` : "";
  $("#workspaceFooter").textContent = monitoring() ? `${networkLabel()} · ${observing() ? "Read-only observer · Node services managed on their host" : "Persistent monitoring · Mining and forks available on regtest"}` : "Local experiment · Regtest";
  $("#forkButton").hidden = !supports("forks");
  $("#forkButton").disabled = !state.nodes.some(node => node.running);
  $("#mineButton").hidden = !supports("mining");
  $("#mineButton").disabled = !state.nodes.find(node => node.id === selectedNode)?.running;
  $("#mineButton").textContent = selectedNode ? `Mine on ${nameOf(selectedNode)}` : "Mine block";
  $("#linkCount").textContent = state.links.filter(link => link.connected && !externalPeer(link.a) && !externalPeer(link.b)).length || "";
  $("#welcome").hidden = state.nodes.length > 0;
  $("#liveWorkspace").hidden = state.nodes.length === 0;
  $("#networkPanel").hidden = !monitoring();
  document.querySelectorAll('[data-action="add-node"], [data-action="connections"]').forEach(button => { button.hidden = !canManage(); });
  document.querySelectorAll('[data-action="stop-all"]').forEach(button => { button.hidden = !canManage(); button.disabled = !state.nodes.some(node => node.running); });
  document.querySelectorAll('[data-action="reset"]').forEach(button => {
    button.hidden = monitoring();
    button.disabled = !state.session.reset_supported || !state.nodes.length || activeJobs().length > 0;
    button.title = state.session.reset_supported ? "Start again with an empty workspace" : "Restart the lab server to enable reset";
  });
  document.querySelectorAll('[data-action="bootstrap"]').forEach(button => { button.hidden = !supports("bootstrap"); button.disabled = activeJobs().length > 0; });
  document.querySelectorAll('[data-action="monitor"]').forEach(button => { button.textContent = `Monitor ${networkLabel()}`; button.hidden = !monitoring() || !canManage(); button.disabled = activeJobs().length > 0; });
  document.querySelectorAll('[data-action="clear-events"]').forEach(button => { button.hidden = !monitoring(); button.disabled = !state.events.length || activeJobs().length > 0; });
  renderJobs();
  renderNodes();
  if (state.nodes.length) {
    renderSummary(); if (monitoring()) renderNetwork(); renderInspector(); renderChains(); renderTrace(); renderEvents();
  }
  applyLinks();
  hideManagementControls();
  $(".sidebar-footer p").textContent = observing() ? "Read-only RPC and optional network logs from existing nodes. Node services remain under your control." : "Each node is a real bitcoind process. Views come from RPC and captured P2P messages.";
  $(".workspace-footer > span:last-child").textContent = observing() ? "Node lifecycle controls disabled" : "Signet monitoring available in observer mode";
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
  setHTML($("#nodeList"), state.nodes.length ? state.nodes.map(node => {
    const detail = monitoring() && node.running ? (node.ibd ? `Syncing · ${percent(node.verification_progress)}` : "Synchronized") : supports("mining") && node.mining?.enabled ? `Mining every ${Number(node.mining.interval)}s` : "";
    return `<button class="node-row ${selectedNode === node.id ? "selected" : ""}" data-node="${escape(node.id)}" aria-pressed="${selectedNode === node.id}" aria-label="${escape(`${node.name}, ${node.running ? `running, ${modeLabel(node.mode)} mode, height ${Number(node.height ?? 0)}` : "stopped"}`)}"><span class="node-dot ${node.running ? "running" : ""}"></span><span class="node-name ${String(node.name).length > 2 ? "long" : ""}">${escape(node.name)}</span><span class="node-mode">${escape(modeLabel(node.mode))}${detail ? `<span class="node-sub">${escape(detail)}</span>` : ""}</span><span class="node-height">${node.running ? Number(node.height ?? 0) : "off"}</span></button>`;
  }).join("") : '<p class="empty-sidebar">No nodes yet.<br>Add your first node to begin.</p>');
  const filter = $("#eventNode");
  const previous = filter.value;
  const options = '<option value="all">All</option>' + state.nodes.map(node => `<option value="${escape(node.id)}">${escape(node.name)}</option>`).join("");
  if (filter.innerHTML !== options) {
    filter.innerHTML = options;
    filter.value = [...filter.options].some(option => option.value === previous) ? previous : "all";
  }
}

function staleTips() {
  const active = new Set(), children = new Set(state.blocks.map(block => block.parent));
  for (const node of state.nodes) for (const [hash, record] of Object.entries(node.blocks || {})) if (record.active) active.add(hash);
  return state.blocks.filter(block => !active.has(block.hash) && !children.has(block.hash));
}

function negotiated(link) {
  const values = Object.values(link.negotiation || {});
  return values.length > 1 && values.every(value => isPresent(value.advertised) || isPresent(value.received));
}

function renderSummary() {
  const running = state.nodes.filter(node => node.running);
  const best = running.reduce((top, node) => !top || Number(node.height) > Number(top.height) ? node : top, null);
  const stale = staleTips();
  const highest = stale.reduce((top, block) => Math.max(top, block.height), -1);
  const messages = state.events.length;
  const links = state.links.filter(link => !externalPeer(link.a) && !externalPeer(link.b));
  let topology = "", end = null;
  links.forEach((link, index) => {
    const linkButton = `<button class="topology-link ${link.connected ? "" : "down"} ${selected.type === "link" && selected.id === link.id ? "selected" : ""}" data-link="${escape(link.id)}" aria-label="Inspect ${escape(nameOf(link.a))} to ${escape(nameOf(link.b))}">${link.connected ? "⇄" : "⇹"}</button>`;
    if (end && (link.a === end || link.b === end)) {
      end = link.a === end ? link.b : link.a;
      topology += `${linkButton}<span class="topology-node">${escape(nameOf(end))}</span>`;
    } else {
      topology += `${index ? '<span class="topology-node">·</span>' : ""}<span class="topology-node">${escape(nameOf(link.a))}</span>${linkButton}<span class="topology-node">${escape(nameOf(link.b))}</span>`;
      end = link.b;
    }
  });
  const agreed = links.filter(negotiated).length;
  const note = links.length ? `BIP332 negotiated on ${agreed === links.length ? links.length === 1 ? "the link" : links.length === 2 ? "both links" : `all ${links.length} links` : `${agreed} of ${links.length} links`}` : "No connections between lab nodes";
  const external = state.external_peers.length ? ` · ${state.external_peers.length} external peer${state.external_peers.length === 1 ? "" : "s"}` : "";
  setHTML($("#summary"), `<span>Tip <b>${best ? Number(best.height ?? 0) : "—"}</b>${best ? ` · <span class="mono">${escape(short(best.best_hash))}</span>` : ""}</span><span class="${stale.length ? "amber" : ""}" title="${stale.length ? `Highest at height ${highest}` : ""}"><b>${stale.length}</b> stale tip${stale.length === 1 ? "" : "s"}</span><span><b>${messages}</b> ${messages === 1 ? "message" : "messages"}</span>${state.nodes.length ? `<span class="topology">${topology || `<span class="topology-node">${escape(state.nodes[0].name)}</span>`}<span>&nbsp;· ${escape(note + external)}</span></span>` : ""}`);
}

function networkPositions() {
  const columns = Math.min(4, Math.max(1, state.nodes.length));
  const rows = Math.ceil(state.nodes.length / columns);
  const width = Math.max(state.external_peers.length ? 720 : 520, columns * 180 + 50);
  const externalTop = Math.max(170, rows * 150 + 20);
  const height = Math.max(245, rows * 150 + 20, state.external_peers.length ? externalTop + Math.ceil(state.external_peers.length / 5) * 46 + 50 : 0);
  const positions = {};
  state.nodes.forEach((node, index) => { positions[node.id] = {x: 105 + (index % columns) * ((width - 210) / Math.max(1, columns - 1)), y: 112 + Math.floor(index / columns) * 145}; });
  if (state.nodes.length === 1) positions[state.nodes[0].id].x = width / 2;
  state.external_peers.forEach((peer, index) => { positions[peer.id] = {x: 85 + (index % 5) * ((width - 170) / 4), y: externalTop + 40 + Math.floor(index / 5) * 46}; });
  return {positions, width, height};
}

// Ports and long onion names do not fit the compact peer box; the full
// address stays in the tooltip and the detail panel.
function peerLabel(address) {
  const host = String(address).replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return host.length > 15 ? `${host.slice(0, 14)}…` : host;
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
    return `<g data-link="${escape(link.id)}" role="button" tabindex="0" aria-label="Inspect ${escape(nameOf(link.a))} to ${escape(nameOf(link.b))}"><path class="link-line ${external ? "external-link" : ""} ${link.connected ? "" : "disconnected"} ${selected.type === "link" && selected.id === link.id ? "selected" : ""}" d="M${a.x},${a.y} L${b.x},${b.y}"/><path class="link-hit" d="M${a.x},${a.y} L${b.x},${b.y}"/>${external ? "" : `<text class="link-label" text-anchor="middle" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 15}">${link.connected ? observed ? "BIP332 ↔" : received ? "BIP332 observed" : "Connected" : "Disconnected"}</text>`}</g>`;
  }).join("");
  const externalNodes = state.external_peers.map(peer => {
    const {x, y} = positions[peer.id];
    const link = state.links.find(item => item.a === peer.id || item.b === peer.id);
    const advertised = isPresent((link?.negotiation?.[peer.node] || {}).received);
    return `<g class="node-visual external-peer ${selected.type === "peer" && selected.id === peer.id ? "selected" : ""}" data-peer="${escape(peer.id)}" role="button" tabindex="0" aria-label="Inspect external peer ${escape(peer.address)}"><title>${escape(peer.address)} · ${peer.inbound ? "Inbound" : "Outbound"} · ${escape(nameOf(peer.node))}${advertised ? " · BIP332 advertised" : ""}</title><rect class="node-box" x="${x - 56}" y="${y - 15}" width="112" height="30" rx="6"/>${advertised ? `<circle cx="${x - 45}" cy="${y}" r="2.5" fill="#d9920b"/>` : ""}<text class="node-label peer-label" x="${x - 38}" y="${y}">${escape(peerLabel(peer.address))}</text></g>`;
  }).join("");
  const nodes = state.nodes.map(node => {
    const {x, y} = positions[node.id];
    return `<g class="node-visual ${selectedNode === node.id ? "selected" : ""} ${node.running ? "" : "stopped"}" data-node="${escape(node.id)}" role="button" tabindex="0" aria-label="Inspect node ${escape(node.name)}"><rect class="node-box" x="${x - 62}" y="${y - 42}" width="124" height="84" rx="8"/><circle cx="${x - 45}" cy="${y - 21}" r="3" fill="${node.running ? "#1a7f37" : "#8b919a"}"/><text class="node-label" x="${x - 35}" y="${y - 17}">${escape(String(node.name).slice(0, 13))}</text><text class="node-subtitle" x="${x - 45}" y="${y + 2}">${escape(modeLabel(node.mode))}${node.mining?.enabled ? " · mining" : ""}</text><text class="node-height" x="${x - 45}" y="${y + 23}">${node.running ? `#${Number(node.height ?? 0)} · ${escape(short(node.best_hash))}` : "Stopped"}</text></g>`;
  }).join("");
  const packets = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "" : newPackets.map((event, i) => {
    const a = positions[event.source], b = positions[event.target];
    if (!a || !b) return "";
    return `<circle class="packet" r="4"><animateMotion path="M${a.x},${a.y} L${b.x},${b.y}" dur="1.4s" begin="${i * .12}s" repeatCount="1"/><set attributeName="visibility" to="hidden" begin="${1.4 + i * .12}s"/></circle>`;
  }).join("");
  setHTML($("#networkCanvas"), `<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Live network topology">${edges}${nodes}${externalNodes}${packets}</svg>`);
  newPackets = [];
}

const metric = (label, value) => `<div class="metric-row"><span>${escape(label)}</span><span>${value}</span></div>`;
const pill = (text, type = "") => `<span class="badge ${type}">${type === "amber" || type === "green" ? "<i></i>" : ""}${escape(text)}</span>`;
const detailHead = (title, {meta = "", end = "", closable = false} = {}) => `<div class="panel-header"><h2>${escape(title)}</h2>${meta ? `<span class="panel-meta mono">${escape(meta)}</span>` : ""}<div class="header-end">${end}${closable ? `<span class="esc-hint">Esc</span><button class="icon-button quiet" data-action="clear-selection" aria-label="Clear selection">${CLOSE}</button>` : ""}</div></div>`;
const sectionHead = (title, action = "") => `<div class="section-head"><h3>${escape(title)}</h3>${action}</div>`;
const copyButton = value => `<button class="link-button" data-action="copy-hash" data-id="${escape(value)}">${COPY}Copy</button>`;

function receivedPreference(negotiation, peer) {
  if (isPresent(negotiation.received)) return prefLabel(negotiation.received);
  if (peer?.version && peer.version < 70017) return "Protocol predates BIP434";
  return negotiation.version && negotiation.verack ? "Not advertised in observed handshake" : "Not yet observed";
}

function externalDetails(peer) {
  const link = state.links.find(item => item.a === peer.id || item.b === peer.id);
  const negotiation = link?.negotiation?.[peer.node] || {};
  return `${metric("Observed at", escape(nameOf(peer.node)))}${metric("Connection", peer.inbound ? "Inbound" : "Outbound")}${metric("Protocol", escape(peer.version || "Not reported"))}${metric("Software", escape(peer.subver || "Not reported"))}${metric("BIP332 received", escape(receivedPreference(negotiation, peer)))}<p class="help-text">This is an external peer. Its complete block tree and onward connections are not visible from this node.</p><div class="detail-actions"><button class="button full" data-action="peers" data-id="${escape(peer.node)}">Connection settings for ${escape(nameOf(peer.node))}</button></div>`;
}

function blockStatus(node, hash) {
  const known = node.blocks?.[hash];
  if (!known) return "unknown";
  if (known.validity === "invalid") return "invalid";
  if (known.active) return "active";
  return known.have_data ? "data" : "headers";
}

// Reconstruct how each node learned a block from the captured messages and
// lab events that mention it. Times are absolute seconds.
function provenance(hash) {
  const nodes = {}, links = [];
  const events = [...state.events].sort((a, b) => a.time - b.time);
  const entry = id => nodes[id] ||= {time: null, how: null, fetched: null, reorg: null, bytes: 0, local: false};
  const learn = (id, time, how, local = false) => {
    if (!isManaged(id)) return;
    const item = entry(id);
    if (item.time === null) Object.assign(item, {time, how, local});
  };
  // The lab logs a fork after submitting it, so the relay it triggers can be
  // captured first. Origins come from the lab events regardless of order.
  const mentions = events.filter(event => hashesOf(event).includes(hash));
  for (const event of mentions) {
    const origin = event.kind === "fork" ? event.details?.recipients || [] : event.kind === "mining" ? [event.node] : [];
    for (const id of origin) {
      const sent = mentions.find(item => item.direction === "sent" && item.node === id);
      learn(id, Math.min(event.time, sent?.time ?? event.time), event.kind === "fork" ? "Published by lab" : "Mined here", true);
    }
  }
  for (const event of mentions) {
    if (event.kind === "reorg" && isManaged(event.node)) entry(event.node).reorg ??= event.time;
    else if (event.direction === "recv" && RELAYED.includes(event.kind) && isManaged(event.node)) {
      const from = nameOf(event.source);
      learn(event.node, event.time, event.kind === "staletip" ? `staletip from ${from}` : `${event.kind} from ${from}`);
      const item = entry(event.node);
      if (item.local) continue;
      item.bytes += Number(event.size) || 0;
      if (["block", "cmpctblock"].includes(event.kind) && item.fetched === null) {
        item.fetched = event.time;
        if (!item.how?.startsWith("block")) item.how += ` · block from ${from}`;
      }
      if (isManaged(event.source)) {
        const sent = events.filter(item => item.direction === "sent" && item.node === event.source && item.peer === event.node && item.kind === event.kind && item.time <= event.time && hashesOf(item).includes(hash)).at(-1);
        links.push({from: event.source, to: event.node, start: sent?.time ?? event.time, end: event.time, kind: event.kind});
      }
    }
  }
  const times = Object.values(nodes).flatMap(item => [item.time, item.fetched, item.reorg]).filter(time => time !== null);
  return {nodes, links, first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null};
}

function knowledgeText(node, status, item, first) {
  const parts = [];
  if (item?.how) parts.push(item.how);
  else if (status === "active") parts.push("On the active chain");
  else if (status !== "unknown") parts.push("Learned before the timeline began");
  if (status === "headers" && node.mode === "headers") parts.push("Headers mode, not fetched");
  if (item?.reorg && status !== "active") parts.push(item.time !== null ? `Active for ${duration((item.reorg - item.time) * 1000)}, then reorged` : "Left the active chain");
  if (status === "unknown" && !node.running) parts.push("Node stopped");
  const time = item?.time !== null && item?.time !== undefined && first !== null ? `+${duration((item.time - first) * 1000)}` : "";
  return {text: parts.join(" · "), time};
}

function difficultyText(value) {
  return value >= 1 ? value.toLocaleString("en-US", {maximumFractionDigits: 2}) : value.toPrecision(3);
}

function blockInspector() {
  const hash = selected.id;
  const block = state.blocks.find(item => item.hash === hash);
  const statuses = state.nodes.map(node => blockStatus(node, hash));
  const known = statuses.filter(status => status !== "unknown");
  const word = !known.length ? ["Not known", ""] : statuses.includes("active") ? known.every(status => status === "active") ? ["Active", "green"] : ["Mixed", ""] : ["Stale", "amber"];
  const size = Math.max(0, ...state.nodes.map(node => Number(node.blocks?.[hash]?.size) || 0));
  const difficulty = state.nodes.map(node => node.blocks?.[hash]?.difficulty).find(value => Number.isFinite(value));
  const parent = state.blocks.find(item => item.hash === block?.parent);
  const prime = blockLayout().positions.get(hash)?.lane > 0 ? "′" : "";
  const p = provenance(hash);
  const rows = state.nodes.map((node, index) => {
    const status = statuses[index];
    const {text, time} = knowledgeText(node, status, p.nodes[node.id], p.first);
    const label = status === "unknown" && outsideWindow(node, block) ? "Outside displayed window" : STATUS_LABEL[status];
    return `<div class="knowledge-row" data-link-node="${escape(node.id)}"><span class="node-name">${escape(node.name)}</span><i class="swatch ${status}"></i><div class="knowledge-text"><strong>${escape(label)}</strong>${text ? `<span>${escape(text)}</span>` : ""}</div><span class="knowledge-time">${escape(time)}</span></div>`;
  }).join("");
  const canFork = supports("forks") && state.nodes.some(node => node.blocks?.[hash]?.have_data && node.running);
  return detailHead(block ? `Block ${block.height}${prime}` : "Selected block", {meta: short(hash), closable: true}) +
    `<div class="detail-body">${metric("Status", pill(word[0], word[1]))}${difficulty !== undefined ? metric("Difficulty", `<span class="mono">${escape(difficultyText(difficulty))}</span>`) : ""}${block ? metric("Height", `<span class="mono">${block.height}${parent ? ` · child of ${parent.height}` : ""}</span>`) : ""}${size ? metric("Size", `<span class="mono">${bytes(size)}</span>`) : ""}${sectionHead("Known by")}<div class="knowledge">${rows}</div>${sectionHead("Hash", copyButton(hash))}<div class="hash-box">${escape(hash)}</div>${supports("forks") ? `<div class="detail-actions"><button class="button full" data-action="fork" data-parent="${escape(hash)}" ${canFork ? "" : "disabled"}>Fork from this block</button></div>` : ""}</div>`;
}

function renderInspector() {
  let html = "";
  if (selected.type === "peer") {
    const peer = externalPeer(selected.id);
    if (peer) html = detailHead(peer.address, {closable: true}) + `<div class="detail-body"><p>External peer observed from a managed node.</p>${externalDetails(peer)}</div>`;
    else html = detailHead("Connection ended", {closable: true}) + '<div class="detail-body"><p>This peer is no longer connected. Previously observed messages remain in the timeline.</p></div>';
  } else if (selected.type === "link") {
    const link = state.links.find(item => item.id === selected.id);
    if (link) {
      html = detailHead(`${nameOf(link.a)} ⇄ ${nameOf(link.b)}`, {end: pill(link.connected ? "Connected" : "Disconnected", link.connected ? "green" : ""), closable: true}) + '<div class="detail-body">';
      for (const id of [link.a, link.b]) {
        const peer = state.nodes.find(node => node.id === id);
        if (!peer) continue;
        const negotiation = link.negotiation?.[id] || {};
        const remote = externalPeer(id === link.a ? link.b : link.a);
        html += `<div class="handshake-node"><h3>${escape(nameOf(id))}</h3><div class="handshake-steps"><span class="${negotiation.version ? "seen" : ""}">version</span><span class="${isPresent(negotiation.advertised) || isPresent(negotiation.received) ? "seen" : ""}">BIP332</span><span class="${negotiation.verack ? "seen" : ""}">verack</span></div>${metric("Configured mode", escape(modeLabel(peer.mode)))}${metric("Local preference observed", escape(prefLabel(negotiation.advertised)))}${metric("Peer preference received", escape(receivedPreference(negotiation, remote)))}</div>`;
      }
      const remote = externalPeer(link.a) || externalPeer(link.b);
      html += `<p class="help-text">${monitoring() ? "Core logs report received feature preferences. Outgoing feature payloads are not decoded, so a configured mode is not proof of an observed advertisement." : "These are captured messages on this connection. Configuration and advertised preference are shown separately."}</p>${remote ? externalDetails(remote) : `<div class="detail-actions"><button class="button full ${link.connected ? "danger" : ""}" data-connection="${escape(link.id)}">${link.connected ? "Disconnect" : "Reconnect"}</button></div>`}</div>`;
    }
  } else if (selected.type === "block") {
    html = blockInspector();
  } else if (selected.type === "event") {
    const event = [...(pausedEvents || []), ...state.events].find(item => String(item.id) === String(selected.id));
    if (event) {
      const route = event.source && event.target ? `${nameOf(event.source)} → ${nameOf(event.target)}` : `${nameOf(event.node)} · ${event.direction || "lab"}`;
      const logged = event.evidence === "debug-log";
      const block = hashesOf(event).find(hash => state.blocks.some(item => item.hash === hash));
      html = detailHead(event.kind, {meta: route, closable: true}) + `<div class="detail-body">${metric("Observation", escape(observationOf(event)))}${metric("Evidence", logged ? "Bitcoin Core network log" : event.direction === "local" ? "Lab activity" : "P2P message capture")}${metric("Time", `<span class="mono">${escape(timeOf(event, true))}</span>`)}${metric(logged ? "Size reported" : "Payload", event.size == null ? "Not reported" : `<span class="mono">${bytes(Number(event.size))}</span>`)}${event.details?.observation === "feature-support" ? '<p class="help-text">Core parsed this preference from a received feature message. This observation does not represent an additional transmission.</p>' : ""}${sectionHead("Payload")}<pre>${escape(JSON.stringify(event.details || {message: event.summary}, null, 2))}</pre><p class="help-text">${logged ? "This event comes from Core’s network log. The message payload is not captured. Receipt alone does not establish acceptance or onward relay." : "One transmission can produce a sent capture and a received capture. Receive timestamps show when Core processes the message; receipt alone does not establish validation or relay."}</p>${block ? `<div class="detail-actions"><button class="button full" data-block="${escape(block)}">Inspect block ${escape(short(block))}</button></div>` : ""}</div>`;
    }
  }
  if (!html) {
    const node = state.nodes.find(item => item.id === selectedNode) || state.nodes[0];
    if (!node) return;
    const peers = node.peers?.length || 0;
    const sync = monitoring() ? `<div class="sync-status">${metric("Chain state", node.running ? node.ibd ? pill("Initial synchronization", "amber") : pill("Synchronized", "green") : pill(observing() ? "RPC unavailable" : "Stopped"))}<progress max="1" value="${Math.min(1, Math.max(0, Number(node.verification_progress) || 0))}" aria-label="Chain verification progress"></progress>${metric("Verification progress", `<span class="mono">${percent(node.verification_progress)}</span>`)}${metric("Headers known", `<span class="mono">${escape(node.headers ?? "—")}</span>`)}${metric("Block storage", `${storageSize(node.size_on_disk)}${node.pruned ? " · pruned" : ""}`)}</div>` : "";
    const status = node.running ? pill(monitoring() ? `Running on ${networkName()}` : "Running", "green") : pill(observing() ? "RPC unavailable" : "Stopped · data retained");
    const stale = node.staletips?.length || 0;
    html = detailHead(`Node ${node.name}`, {end: status}) + `<div class="detail-body">${metric("Stale-tip mode", observing() ? escape(modeLabel(node.mode)) : `<button class="inline-select" data-action="mode" data-id="${escape(node.id)}" aria-label="Change stale-tip mode">${escape(modeLabel(node.mode))}${CHEVRON}</button>`)}${metric("Height", `<span class="mono">${escape(node.height ?? "—")}</span>`)}${sync}${metric("Peers", `<span class="mono">${peers}</span>`)}${metric("Stale tips known", `<span class="mono" ${stale ? 'style="color:var(--amber-text)"' : ""}>${stale}</span>`)}${supports("mining") ? metric("Miner", node.mining?.enabled ? `<span class="running-miner">Every ${Number(node.mining.interval)}s</span>` : "Paused") : ""}${metric("P2P / RPC ports", `<span class="mono">${escape(node.p2p_port ?? "—")} / ${escape(node.rpc_port ?? "—")}</span>`)}${sectionHead("Tip hash", node.best_hash ? copyButton(node.best_hash) : "")}<div class="hash-box">${escape(node.best_hash || "Waiting for chain state…")}</div>${node.error ? `<p class="form-error">${escape(node.error)}</p>` : ""}${monitoring() && node.ibd ? '<p class="help-text">Stale-tip announcements are paused during initial synchronization.</p>' : ""}<div class="detail-actions">${supports("mining") ? `<button class="button" data-action="miner" data-id="${escape(node.id)}">Miner settings</button>` : ""}${supports("public_peers") ? `<button class="button" data-action="peers" data-id="${escape(node.id)}">Connection settings</button>` : ""}<button class="button ${node.running ? "danger" : ""}" data-lifecycle="${escape(node.id)}">${node.running ? "Stop node" : "Start node"}</button></div>${observing() ? '<p class="help-text">Read-only observer. Node settings and lifecycle are managed on the host.</p>' : '<p class="help-text">Changing mode restarts the node and reconnects its peers.</p>'}</div>`;
  }
  setHTML($("#inspector"), html);
}

function blockLayout() {
  const active = new Set(state.nodes.flatMap(node => Object.entries(node.blocks || {}).filter(([, record]) => record.active).map(([hash]) => hash)));
  // The active chain keeps the straight lane so forks branch away from it.
  const blocks = [...state.blocks].filter(block => Number.isFinite(block.height)).sort((a, b) => a.height - b.height || active.has(b.hash) - active.has(a.hash) || a.hash.localeCompare(b.hash));
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
  if (!blocks.length) { setHTML($("#chainCanvas"), `<p class="empty-message">${monitoring() ? "Waiting for chain state from your nodes. Synchronization may take time." : "Waiting for block headers. Mine a block to begin."}</p>`); return; }
  const heights = [...new Set(blocks.map(block => block.height))];
  const columns = new Map(heights.map((height, index) => [height, index]));
  // Size blocks to the longest height so six-digit testnet heights keep their padding.
  const chars = Math.max(...blocks.map(block => String(block.height).length + (positions.get(block.hash).lane > 0 ? 1 : 0)));
  const half = Math.max(26, Math.ceil(chars * 3.3) + 12), label = $("#chainCanvas").clientWidth < 500 ? 76 : 112, ruler = 28, lane = 38, trailing = 210;
  const available = $("#chainCanvas").clientWidth - 40 - label - 24 - trailing;
  const fitted = heights.length > 1 ? available / (heights.length - 1) : 88;
  const step = Math.max(half * 2 + 20, Math.min(half * 2 + (monitoring() ? 36 : 48), Math.max(half * 2 + 24, fitted)) * zoom);
  const rowHeight = Math.max(72, lanes * lane + 24);
  const width = label + 24 + (heights.length - 1) * step + trailing;
  const height = ruler + state.nodes.length * rowHeight;
  const focus = state.blocks.find(block => block.hash === (selected.type === "block" ? selected.id : blockFilter));
  const x = block => label + 24 + columns.get(block.height) * step;
  const y = (top, block) => top + 28 + positions.get(block.hash).lane * lane;
  let html = `<defs><pattern id="stripes" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fff8e6"/><line x1="0" y1="0" x2="0" y2="6" stroke="#e7b556" stroke-width="3"/></pattern></defs>`;
  let labels = `<span class="chain-ruler-label">Height</span>`;
  for (const value of heights) {
    const rx = label + 24 + columns.get(value) * step;
    html += `<text class="chain-ruler ${focus?.height === value ? "marked" : ""}" text-anchor="middle" x="${rx}" y="18">${value}</text>${focus?.height === value ? `<line class="chain-ruler-mark" x1="${rx - 12}" x2="${rx + 12}" y1="27" y2="27"/>` : ""}`;
  }
  state.nodes.forEach((node, index) => {
    const top = ruler + index * rowHeight;
    const known = blocks.filter(block => node.blocks?.[block.hash]);
    const parents = new Set(known.map(block => block.parent));
    html += `<line class="chain-divider" x1="${label}" y1="${top}" x2="${width}" y2="${top}"/>`;
    labels += `<div class="chain-label" style="top:${top}px"><strong>${escape(String(node.name).slice(0, 14))}</strong><span>${node.running ? `${escape(modeLabel(node.mode))} mode` : "Stopped · saved view"}</span></div>`;
    for (const block of known) {
      const parent = blocks.find(item => item.hash === block.parent);
      if (!parent || !node.blocks?.[parent.hash]) continue;
      const px = x(parent), py = y(top, parent), cx = x(block), cy = y(top, block);
      html += `<path class="chain-edge ${blockStatus(node, block.hash)}" d="M${px + half},${py} C${px + step / 2},${py} ${cx - step / 2},${cy} ${cx - half},${cy}"/>`;
    }
    for (const block of known) {
      const status = blockStatus(node, block.hash);
      const bx = x(block), by = y(top, block);
      const prime = positions.get(block.hash).lane > 0 ? "′" : "";
      html += `<g class="block ${status} ${focus?.hash === block.hash ? "selected" : ""}" data-block="${escape(block.hash)}" data-owner="${escape(node.id)}" role="button" tabindex="0" aria-label="${escape(node.name)} block ${block.height}: ${STATUS_LABEL[status]}"><title>${escape(block.hash)} · ${STATUS_LABEL[status]}</title><rect class="ring" x="${bx - half - 4}" y="${by - 17}" width="${half * 2 + 8}" height="34" rx="7"/><rect class="body" x="${bx - half}" y="${by - 13}" width="${half * 2}" height="26" rx="4"/><text x="${bx}" y="${by}">${block.height}${prime}</text></g>`;
      if (!parents.has(block.hash)) {
        const text = status === "active" ? `tip ${short(block.hash)}` : `stale ${short(block.hash)} · ${STATUS_LABEL[status].toLowerCase().replace("full ", "")}`;
        html += `<text class="tip-label ${status}" x="${bx + half + 12}" y="${by + 4}">${escape(text)}</text>`;
      }
    }
  });
  // Node names stay in a sticky column so a narrow panel can scroll the trees
  // sideways without losing which row belongs to which node.
  const canvas = $("#chainCanvas");
  const pinned = canvas._auto === undefined || Math.abs(canvas.scrollLeft - canvas._auto) < 4;
  setHTML(canvas, `<div class="chain-labels" style="width:${label}px;height:${height + 8}px">${labels}</div><svg width="${width - label}" height="${height + 8}" viewBox="${label} 0 ${width - label} ${height + 8}" role="group" aria-label="Aligned block trees for every node">${html}</svg>`);
  if (focus && canvas._focus !== focus.hash) {
    const visible = canvas.clientWidth - label - 40;
    const offset = x(focus) - label;
    if (offset < canvas.scrollLeft + 40 || offset > canvas.scrollLeft + visible - 160) canvas.scrollLeft = offset - 80;
  } else if (pinned) {
    const latest = label + 24 + (heights.length - 1) * step;
    canvas.scrollLeft = Math.max(0, latest + half + 120 - canvas.clientWidth + 20);
  }
  canvas._auto = canvas.scrollLeft;
  canvas._focus = focus?.hash;
  $("#zoomLabel").textContent = `${Math.round(zoom * 100)}%`;
}

function niceStep(span) {
  const raw = span / 4, power = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 5, 10].map(factor => factor * power).find(value => value >= raw) || power * 10;
}

function renderTrace() {
  const panel = $("#tracePanel");
  const hash = blockFilter;
  const p = hash ? provenance(hash) : null;
  if (!p || p.first === null) { panel.hidden = true; setHTML(panel, ""); return; }
  panel.hidden = false;
  const width = Math.max(180, panel.querySelector(".trace-canvas")?.clientWidth || panel.clientWidth - 40 - 84 - 96 - 2);
  const spanMs = Math.max((p.last - p.first) * 1000, 1) * 1.15;
  const tick = niceStep(spanMs);
  const x = time => 10 + ((time - p.first) * 1000) / spanMs * (width - 20);
  const rowY = index => 48 + index * 48;
  const index = new Map(state.nodes.map((node, i) => [node.id, i]));
  const height = 24 + state.nodes.length * 48;
  const end = x(p.first + spanMs / 1000);
  let svg = "";
  for (let ms = 0; ms <= spanMs; ms += tick) {
    const tx = x(p.first + ms / 1000);
    svg += `<path class="trace-grid" d="M${tx} 24V${height}"/><text class="trace-tick" x="${tx}" y="15">${ms === 0 ? "0 ms" : duration(ms).replace(" ms", "")}</text>`;
  }
  const statuses = state.nodes.map(node => blockStatus(node, hash));
  state.nodes.forEach((node, i) => {
    const item = p.nodes[node.id], status = statuses[i], y = rowY(i);
    let row = "";
    if (!item || item.time === null) {
      row = `<text class="trace-missing" x="10" y="${y + 4}">${status === "unknown" ? "Not received" : "Learned before the timeline began"}</text>`;
    } else {
      const start = x(item.time);
      const bar = (from, to, fill) => to > from ? `<rect x="${from}" y="${y - 4}" width="${to - from}" height="8" rx="2" fill="${fill}"/>` : "";
      if (status === "data" && item.fetched && item.fetched > item.time) row += bar(start, x(item.fetched), "#f3d9a0") + bar(x(item.fetched), end, "#d9920b");
      else row += bar(start, end, {active: "#16181d", data: "#d9920b", headers: "#f3d9a0", invalid: "#cf222e"}[status] || "#dde0e4");
      const note = `${item.how} · +${duration((item.time - p.first) * 1000)}`;
      row += `<text class="trace-note" x="${start + (p.links.some(link => link.to === node.id) && !item.local ? 8 : 0)}" y="${y - 10}">${escape(note)}</text>`;
      if (item.reorg) row += `<text class="trace-note" text-anchor="end" x="${x(item.reorg)}" y="${y + 20}">reorged · +${escape(duration((item.reorg - p.first) * 1000))}</text>`;
    }
    svg += `<g class="trace-row" data-link-node="${escape(node.id)}">${row}</g>`;
  });
  for (const link of p.links) {
    // Only draw the deliveries that taught a node something; echoes back to a
    // node that already had the block would loop across the chart.
    const target = p.nodes[link.to];
    if (!index.has(link.from) || !index.has(link.to) || ![target?.time, target?.fetched].includes(link.end)) continue;
    const down = index.get(link.to) > index.get(link.from);
    const y1 = rowY(index.get(link.from)) + (down ? 4 : -4), y2 = rowY(index.get(link.to)) + (down ? -4 : 4);
    const x1 = Math.max(10, x(link.start)), x2 = x(link.end), mid = (y1 + y2) / 2;
    svg += `<path d="M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}" fill="none" stroke="${link.kind === "staletip" ? "#d9920b" : "#aeb3ba"}" stroke-width="1.5"/>`;
  }
  const reached = statuses.filter(status => status !== "unknown").length;
  const labels = state.nodes.map(node => `<div class="trace-cell" data-link-node="${escape(node.id)}"><strong>${escape(node.name)}</strong><span>${escape(modeLabel(node.mode))}</span></div>`).join("");
  const sizes = state.nodes.map((node, i) => {
    const item = p.nodes[node.id];
    const kind = !item ? "—" : item.local ? "local" : statuses[i] === "headers" ? "header" : item.fetched ? "block" : "relay";
    return `<div class="trace-cell" data-link-node="${escape(node.id)}"><span class="mono">${item ? bytes(item.bytes) : "—"}</span><span>${kind}</span></div>`;
  }).join("");
  const blockSize = Math.max(0, ...state.nodes.map(node => Number(node.blocks?.[hash]?.size) || 0), ...state.events.filter(event => event.direction === "recv" && ["block", "cmpctblock"].includes(event.kind) && hashesOf(event).includes(hash)).map(event => Number(event.size) || 0));
  const headerOnly = state.nodes.filter((node, i) => statuses[i] === "headers");
  const actual = headerOnly.reduce((sum, node) => sum + (p.nodes[node.id]?.bytes || 0), 0);
  const full = actual + blockSize * headerOnly.length;
  const names = headerOnly.map(node => node.name).join(", ");
  const cost = headerOnly.length && blockSize && full ? `<div class="mode-cost"><p>Headers mode saved ${escape(names)} <b>${bytes(full - actual)}</b> (${Math.round((full - actual) / full * 100)}%)</p><div class="mode-cost-bars" role="img" aria-label="${escape(`${bytes(actual)} received, ${bytes(full)} if ${names} fetched the block`)}"><div class="cost-row"><span>As received</span><div class="cost-track"><div class="cost-bar light" style="width:${(actual / full * 100).toFixed(1)}%"></div></div><span>${bytes(actual)}</span></div><div class="cost-row"><span>If ${escape(names)} fetched it</span><div class="cost-track"><div class="cost-bar" style="width:100%"></div></div><span>${bytes(full)}</span></div></div></div>` : "";
  setHTML(panel, `<div class="panel-header"><h2>Propagation</h2><span class="panel-meta mono">${escape(short(hash))}</span><div class="panel-stats"><span>Reached <b>${reached} of ${state.nodes.length}</b> nodes</span><span>Last change <b class="mono">+${escape(duration((p.last - p.first) * 1000))}</b></span></div></div><div class="trace-body"><div class="trace-labels"><div class="trace-cell head"></div>${labels}</div><div class="trace-canvas"><svg height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Arrival of the block at each node over time">${svg}</svg></div><div class="trace-bytes"><div class="trace-cell head"><span>Received</span></div>${sizes}</div></div>${cost}`);
}

function timeOf(event, full = false) {
  const date = new Date(Number(event.time) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return full ? date.toLocaleString() + "." + String(date.getMilliseconds()).padStart(3, "0") : date.toLocaleTimeString([], {hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"}) + "." + String(date.getMilliseconds()).padStart(3, "0");
}

function eventDescription(event) {
  const d = event.details || {};
  if (event.kind === "staletip") return event.evidence === "debug-log" && !d.tip ? event.summary || "staletip observed · payload not captured" : `${d.header_count ?? d.headers?.length ?? "?"} header${(d.header_count ?? 0) === 1 ? "" : "s"} · have_block=${d.have_block} · tip ${short(d.tip)}`;
  if (event.kind === "feature") return event.evidence === "debug-log" && !isPresent(d.prefers_blocks) ? d.log || event.summary || "Feature message observed" : `${d.feature || "feature"} · ${prefLabel(d.prefers_blocks)}`;
  if (event.kind === "version") return event.evidence === "debug-log" && d.version == null ? d.log || event.summary || "Version message observed" : `Protocol ${d.version ?? "—"}`;
  if (event.kind === "reorg") return `Left ${d.depth ?? d.hashes?.length ?? "?"} block${(d.depth ?? 0) === 1 ? "" : "s"} for the chain at ${short(d.new_tip)}`;
  if (!["sent", "recv"].includes(event.direction)) return event.summary || "";
  if (d.hash) return short(d.hash, 19);
  if (d.hashes?.length) return `${d.hashes.length} ${d.hashes.length === 1 ? "hash" : "hashes"} · ${short(d.hashes[0], 14)}`;
  return event.summary || (event.size ? `${event.size} bytes` : "");
}

function observationOf(event) {
  if (event.evidence === "debug-log" && event.details?.observation === "feature-support") return `Peer preference at ${nameOf(event.node)}`;
  if (event.direction === "sent") return `sent at ${nameOf(event.node)}`;
  if (event.direction === "recv") return `recv at ${nameOf(event.node)}`;
  return event.node ? `lab · ${nameOf(event.node)}` : "lab";
}

function renderEvents() {
  const source = pausedEvents || state.events;
  const search = $("#eventSearch").value.toLowerCase().trim();
  const node = $("#eventNode").value;
  const typeSelect = $("#eventType");
  const scoped = source.filter(event => (node === "all" || [event.node, event.source, event.target, event.peer].includes(node)) && (!blockFilter || hashesOf(event).includes(blockFilter)));
  const kind = typeSelect.value || "all";
  const test = TYPES.find(([key]) => key === kind)?.[2] || TYPES[0][2];
  const filtered = scoped.filter(event => test(event) && (!search || `${JSON.stringify(event)} ${nameOf(event.source)} ${nameOf(event.target)} ${nameOf(event.node)}`.toLowerCase().includes(search)));
  const options = TYPES.map(([key, label, match]) => `<option value="${key}">${label} (${scoped.filter(match).length})</option>`).join("");
  if (typeSelect._options !== options) { typeSelect.innerHTML = options; typeSelect._options = options; typeSelect.value = kind; }
  setHTML($("#blockFilter"), blockFilter ? `<button class="filter-token" data-action="clear-block" aria-label="Stop filtering by block ${escape(short(blockFilter))}">Block <span class="mono">${escape(short(blockFilter))}</span>${CLOSE}</button>` : "");
  $("#eventCount").textContent = filtered.length === source.length ? source.length : `${filtered.length} of ${source.length}`;
  const pending = pausedEvents ? state.events.filter(event => !pausedEvents.some(old => old.id === event.id)).length : 0;
  setHTML($("#pauseButton"), pausedEvents ? `${icon('<path d="M5 3.5L12 8L5 12.5Z"/>')}Resume${pending ? ` · ${pending} new` : ""}` : `${icon('<path d="M5.5 3.5V12.5M10.5 3.5V12.5"/>')}Pause`);
  $("#timelineCaption").textContent = pausedEvents ? `Paused for inspection; nodes${supports("mining") ? " and miners" : ""} keep running` : monitoring() ? "From Core network logs; payloads are not captured" : "Captured at processing time; arrival is not acceptance";
  const rows = filtered.slice(-150).reverse();
  setHTML($("#eventList"), rows.length ? rows.map(event => {
    const route = event.source && event.target ? `${escape(nameOf(event.source))}${ARROW}${escape(nameOf(event.target))}` : escape(nameOf(event.node));
    const prose = !["sent", "recv"].includes(event.direction);
    return `<button class="event-row ${selected.type === "event" && String(selected.id) === String(event.id) ? "selected" : ""}" data-event="${escape(event.id)}"><span class="event-time">${escape(timeOf(event))}</span><span class="event-route">${route}<span class="event-observation">${escape(prose ? event.kind === "reorg" ? "chain" : "lab" : observationOf(event))}</span></span><span class="tag ${kindClass(event.kind)}">${escape(event.kind)}</span><span class="event-description ${prose ? "prose" : ""}">${escape(eventDescription(event))}</span><span class="event-size">${event.size == null || prose ? "–" : bytes(Number(event.size))}</span></button>`;
  }).join("") : `<p class="empty-message">No matching messages yet.<br>${blockFilter ? "Nothing captured mentions this block." : observing() ? "Message events require an accessible network debug log. Earlier negotiation may not have been observed." : monitoring() ? "Connect to peers to observe network activity. BIP332 requires support from the peer." : "Connect nodes or create a fork to watch the exchange."}</p>`);
  const limit = $("#timelineLimit");
  limit.hidden = filtered.length <= 150;
  limit.textContent = `Showing the latest 150 of ${filtered.length} matching messages. Narrow the filters or export the session for all retained events.`;
}

// Hovering a message highlights the node and block it concerns in the
// block trees, block panel and trace.
function applyLinks() {
  document.querySelectorAll(".linked").forEach(element => element.classList.remove("linked"));
  const event = hoveredEvent && [...(pausedEvents || []), ...state.events].find(item => String(item.id) === hoveredEvent);
  if (!event?.node) return;
  document.querySelectorAll(`[data-link-node="${CSS.escape(event.node)}"]`).forEach(element => element.classList.add("linked"));
  for (const hash of hashesOf(event)) document.querySelectorAll(`.block[data-owner="${CSS.escape(event.node)}"][data-block="${CSS.escape(hash)}"]`).forEach(element => element.classList.add("linked"));
}

function selectBlock(hash) {
  selectedHash = hash; blockFilter = hash; selected = {type: "block", id: hash};
  render();
}

function clearSelection() {
  if (selected.type === "node" || selected.type === "block") blockFilter = null;
  selected = {type: "node", id: selectedNode};
  render();
}

function clearBlock() {
  blockFilter = null;
  if (selected.type === "block") selected = {type: "node", id: selectedNode};
  render();
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
  openDialog("Add a node", `<p>${monitoring() ? `Start a local ${escape(networkLabel())} node. Each node downloads and verifies its own chain, which is retained when the monitor restarts.` : "Launch an isolated Bitcoin Core process. Connect it to peers after it starts."}</p><label class="field">Name<input name="name" maxlength="24" required value="${escape(String.fromCharCode(65 + state.nodes.length % 26))}" autocomplete="off"></label><label class="field">Stale-tip mode<select name="mode">${modes}</select></label>${monitoring() ? peerFields() : state.nodes.some(node => node.running) ? `<label class="field">Start with the chain from<select name="seed_from">${nodeOptions(state.nodes.filter(node => node.running))}</select><small>Only the active chain is copied. Stale branches must arrive over P2P.</small></label>` : ""}`, "Start node", values => action("add_node", {name: values.get("name"), mode: values.get("mode"), ...(monitoring() ? peerValues(values) : values.get("seed_from") ? {seed_from: values.get("seed_from")} : {})}));
}

function peerFields(node = {}) {
  return `<label class="check-label peer-discovery"><input type="checkbox" name="public_network" ${node.public_network !== false ? "checked" : ""}> Discover public ${escape(networkLabel())} peers automatically</label><label class="field">Additional peers<textarea name="peers" rows="3" spellcheck="false" placeholder="host:${networkName() === "signet" ? 38333 : 48333}">${escape((node.configured_peers || []).join("\n"))}</textarea><small>One host:port per line, or separated by commas. IPv6 addresses use [address]:port. With discovery off and this field empty, only connections you create between lab nodes are used.</small></label>`;
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
  openDialog(monitoring() ? "Managed node connections" : "Connections", `${monitoring() ? "<p>To choose public network peers, select a node and open its Connection settings.</p>" : ""}${links.length ? `<div class="connection-list">${links.map(link => `<div class="connection-item"><span>${escape(nameOf(link.a))} ⇄ ${escape(nameOf(link.b))}</span><button type="button" class="button" data-connection="${escape(link.id)}">Disconnect</button></div>`).join("")}</div><br>` : ""}${running.length < 2 ? '<p>Start at least two nodes to create a connection between them.</p>' : `<p>Connections are bidirectional. An arrow in the timeline shows the direction of a specific message.</p><div class="field-row"><label class="field">From<select name="a">${nodeOptions(running)}</select></label><label class="field">To<select name="b">${nodeOptions(running, running.find(node => node.id !== selectedNode)?.id)}</select></label></div>`}`, "Connect nodes", running.length < 2 ? null : values => {
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
  const blockOptions = (list, chosen) => list.map(block => `<option value="${escape(block.hash)}" ${block.hash === chosen ? "selected" : ""}>Height ${block.height} · ${short(block.hash, 10)}${block.active ? " · active" : " · stale"}</option>`).join("");
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
  openDialog("Session details", `<p>${observing() ? "This observer reads existing nodes through RPC and optional network logs. Stopping it leaves those nodes running. Change their settings through your node service configuration." : monitoring() ? `Managed nodes run locally and connect to ${escape(networkLabel())}. Node settings and downloaded chains are retained in this persistent profile when the server restarts.` : "All nodes run locally. Captures and node data are retained in this session’s directory."}</p><label class="field">Network<div class="hash-box">${escape(networkName())}</div></label><label class="field">Bitcoin Core binary<div class="hash-box session-path">${escape(observing() ? "Not required for observer mode" : state.session.binary || "Not reported")}</div></label><label class="field">${monitoring() ? "Persistent profile" : "Session directory"}<div class="hash-box session-path">${escape(state.session.run_dir || "Not reported")}</div></label><p>Block trees display the most recent ${Number(state.session.window_blocks || 80)} heights per ${observing() ? "observed" : "managed"} node.${monitoring() ? " External peers’ complete block trees are not available. Gaps between displayed heights are compressed." : ""}</p><p>${monitoring() ? "Message events come from bounded Bitcoin Core network logs. Full P2P payloads are not captured, so initial synchronization does not duplicate the downloaded chain in capture files. Received BIP332 preferences are shown when Core logs them; outgoing feature payloads remain unobserved." : "The timeline keeps the latest captured events in memory; the complete capture files remain on disk."}</p><p>${monitoring() ? "Clear timeline preserves node data and connections. Mining and fork creation are available only in the regtest lab." : "Signet is supported in observer mode; mining and fork creation use regtest."}</p><a class="button full" href="/api/export" download>Export current session as JSON</a>`, "", null);
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
  if (!control || control.disabled || (!canManage() && control.matches(managementControls))) return;
  if (control.dataset.node !== undefined) {
    selectedNode = control.dataset.node; selected = {type: "node", id: selectedNode}; render();
  } else if (control.dataset.peer !== undefined) {
    selected = {type: "peer", id: control.dataset.peer}; render();
  } else if (control.dataset.link !== undefined) {
    selected = {type: "link", id: control.dataset.link}; render();
  } else if (control.dataset.block !== undefined) {
    selectBlock(control.dataset.block);
  } else if (control.dataset.event !== undefined) {
    selected = {type: "event", id: control.dataset.event};
    const entry = [...state.events, ...(pausedEvents || [])].find(item => String(item.id) === String(selected.id));
    selectedHash = hashesOf(entry || {})[0] || selectedHash;
    renderInspector(); renderChains(); renderEvents(); applyLinks();
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
      case "mine-selected": if (supports("mining") && selectedNode) safeAction("mine", {id: selectedNode, count: 1}); break;
      case "fork": forkDialog(control.dataset.parent); break;
      case "copy-hash": navigator.clipboard?.writeText(control.dataset.id).then(() => toast("Block hash copied."), () => toast("Copy is unavailable in this browser.", true)); break;
      case "clear-block": clearBlock(); break;
      case "clear-selection": clearSelection(); break;
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
    return;
  }
  if ($("#modal").open || event.metaKey || event.ctrlKey || event.altKey || event.target.closest("input, textarea, select, [contenteditable]")) return;
  if (event.key === "Escape" && (blockFilter || selected.type !== "node")) clearSelection();
  else if (event.key.toLowerCase() === "f" && supports("forks") && !$("#forkButton").disabled) { event.preventDefault(); forkDialog(); }
});
$("#eventList").addEventListener("focusin", event => {
  const id = event.target.closest(".event-row")?.dataset.event || null;
  if (id !== hoveredEvent) { hoveredEvent = id; applyLinks(); }
});
$("#eventList").addEventListener("focusout", event => {
  if (!event.relatedTarget?.closest?.("#eventList")) { hoveredEvent = null; applyLinks(); }
});
$("#eventList").addEventListener("mouseover", event => {
  const id = event.target.closest(".event-row")?.dataset.event || null;
  if (id !== hoveredEvent) { hoveredEvent = id; applyLinks(); }
});
$("#eventList").addEventListener("mouseleave", () => { hoveredEvent = null; applyLinks(); });
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
$("#eventNode").addEventListener("change", renderEvents);
$("#eventType").addEventListener("change", renderEvents);
let resizeFrame;
window.addEventListener("resize", () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => { if (state.nodes.length) { renderChains(); renderTrace(); applyLinks(); } }); });

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
