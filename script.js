/**
 * ============================================================
 *  NEXPARK · SMART PARKING SYSTEM — script.js
 *
 *  Architecture:
 *   - ParkingGraph  : Graph data structure (adjacency list)
 *   - BFS           : Shortest-path finder (Greedy + BFS)
 *   - ParkingSystem : Core state manager
 *   - UI            : DOM rendering, animations, events
 * ============================================================
 */

"use strict";

/* ── Constants ─────────────────────────────────────────────── */
const FLOOR_CONFIG = {
  f1: { id: "f1", name: "Floor -1", type: "bike", rows: 4, cols: 12, total: 48 },
  f2: { id: "f2", name: "Floor -2", type: "car",  rows: 2, cols: 12, total: 24 },
  f3: { id: "f3", name: "Floor -3", type: "car",  rows: 2, cols: 12, total: 24 },
};

const VEHICLE_ICON  = { bike: "🏍", car: "🚗" };
const ANIM_DELAY    = 120;  // ms per path step
const PARK_DURATION = 1800; // ms for vehicle drive-in animation

/* ── ParkingGraph ──────────────────────────────────────────── */
/**
 * Represents the parking structure as a graph.
 * Nodes = "ENTRY", "F1_ENTRY", "F2_ENTRY", "F3_ENTRY", and all slots (e.g. "f1-0-5")
 * Edges = directional connections (entry → row-start → slot)
 */
class ParkingGraph {
  constructor() {
    this.adjacency = new Map(); // nodeId -> [nodeId, ...]
    this._build();
  }

  addNode(id) {
    if (!this.adjacency.has(id)) this.adjacency.set(id, []);
  }

  addEdge(a, b) {
    this.addNode(a); this.addNode(b);
    if (!this.adjacency.get(a).includes(b)) this.adjacency.get(a).push(b);
    if (!this.adjacency.get(b).includes(a)) this.adjacency.get(b).push(a);
  }

  /**
   * Builds the full graph:
   * ENTRY ─> F1_ENTRY ─> rows ─> slots  (bikes)
   * ENTRY ─> F2_ENTRY ─> rows ─> slots  (cars)
   * ENTRY ─> F3_ENTRY ─> rows ─> slots  (cars)
   */
  _build() {
    this.addNode("ENTRY");

    ["f1", "f2", "f3"].forEach(fid => {
      const cfg  = FLOOR_CONFIG[fid];
      const fEntry = `${fid}_ENTRY`;
      this.addEdge("ENTRY", fEntry);

      for (let r = 0; r < cfg.rows; r++) {
        const rowNode = `${fid}_ROW_${r}`;
        this.addEdge(fEntry, rowNode);

        for (let c = 0; c < cfg.cols; c++) {
          const slotNode = `${fid}-${r}-${c}`;
          this.addEdge(rowNode, slotNode);
          // Connect adjacent slots in the same row
          if (c > 0) this.addEdge(`${fid}-${r}-${c-1}`, slotNode);
        }
      }
    });
  }

  /**
   * BFS from startNode; stops at the first available slot of the given type.
   * Returns { slotId, path } where path is an array of node IDs.
   *
   * Greedy heuristic: BFS inherently finds the nearest slot
   * (fewest hops = physically nearest in our structured graph).
   */
  bfsNearestSlot(startNode, availableSet) {
    const visited = new Set();
    const queue   = [{ node: startNode, path: [startNode] }];
    visited.add(startNode);

    while (queue.length > 0) {
      const { node, path } = queue.shift();

      // If this node is an available slot, we found it!
      if (availableSet.has(node)) {
        return { slotId: node, path };
      }

      const neighbors = this.adjacency.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ node: neighbor, path: [...path, neighbor] });
        }
      }
    }
    return null; // No slot found
  }
}

/* ── ParkingSystem ─────────────────────────────────────────── */
/**
 * Core state: tracks occupied slots and provides park/exit logic.
 */
class ParkingSystem {
  constructor() {
    this.graph     = new ParkingGraph();
    this.slots     = {};   // slotId -> { floor, row, col, type, vehicle? }
    this.occupied  = new Map(); // slotId -> vehicleInfo
    this._initSlots();
  }

  _initSlots() {
    for (const [fid, cfg] of Object.entries(FLOOR_CONFIG)) {
      for (let r = 0; r < cfg.rows; r++) {
        for (let c = 0; c < cfg.cols; c++) {
          const id = `${fid}-${r}-${c}`;
          this.slots[id] = { id, floor: fid, row: r, col: c, type: cfg.type };
        }
      }
    }
  }

  /**
   * Returns a Set of available slot IDs filtered by vehicle type.
   */
  getAvailableSet(vehicleType) {
    const set = new Set();
    for (const [id, slot] of Object.entries(this.slots)) {
      if (slot.type === vehicleType && !this.occupied.has(id)) {
        set.add(id);
      }
    }
    return set;
  }

  /**
   * Greedy + BFS: finds nearest slot for a vehicle type.
   */
  findNearestSlot(vehicleType) {
    // Entry node per type
    const entryNode = vehicleType === "bike" ? "f1_ENTRY" : "f2_ENTRY";
    const available  = this.getAvailableSet(vehicleType);
    if (available.size === 0) return null;

    // BFS from ENTRY to find nearest available slot
    return this.graph.bfsNearestSlot("ENTRY", available);
  }

  /**
   * Parks a vehicle at the given slot.
   */
  park(slotId, vehicleInfo) {
    this.occupied.set(slotId, vehicleInfo);
  }

  /**
   * Removes a vehicle from the given slot.
   */
  exit(slotId) {
    const info = this.occupied.get(slotId);
    this.occupied.delete(slotId);
    return info;
  }

  getAvailableCount(floorId) {
    return Object.values(this.slots)
      .filter(s => s.floor === floorId && !this.occupied.has(s.id)).length;
  }

  getOccupiedList() {
    return [...this.occupied.entries()].map(([id, info]) => ({ id, ...info }));
  }
}

/* ── UI Controller ─────────────────────────────────────────── */
const parking = new ParkingSystem();
let   exitMode = false;
let   animating = false;

/* DOM refs */
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

/* ── Build Grid DOM ─────────────────────────────────────────── */
function buildGrids() {
  for (const [fid, cfg] of Object.entries(FLOOR_CONFIG)) {
    const gridEl = $(`grid-${fid}`);
    gridEl.classList.add(`floor-${fid}`);

    for (let r = 0; r < cfg.rows; r++) {
      const rowDiv = document.createElement("div");
      rowDiv.className = "slot-row";
      rowDiv.id = `row-${fid}-${r}`;

      for (let c = 0; c < cfg.cols; c++) {
        const id    = `${fid}-${r}-${c}`;
        const slotN = r * cfg.cols + c + 1;  // 1-based slot number

        const el = document.createElement("div");
        el.className  = "slot";
        el.id         = `slot-${id}`;
        el.dataset.id = id;
        el.innerHTML  = `
          <div class="slot-num">${String(slotN).padStart(2,"0")}</div>
          <div class="slot-icon" id="icon-${id}"></div>
        `;
        el.addEventListener("click", () => onSlotClick(id, el));
        rowDiv.appendChild(el);
      }
      gridEl.appendChild(rowDiv);
    }
  }
}

/* ── Slot Click ─────────────────────────────────────────────── */
function onSlotClick(id, el) {
  if (!exitMode) return;
  if (!parking.occupied.has(id)) return;

  // Exit this vehicle
  closeModal();
  exitVehicle(id);
}

/* ── Park Vehicle ───────────────────────────────────────────── */
async function parkVehicle(type) {
  if (animating) { showToast("Please wait — animation in progress", "error"); return; }

  const result = parking.findNearestSlot(type);
  if (!result) {
    showToast(`No ${type} slots available!`, "error");
    addLog(`⚠ NO ${type.toUpperCase()} SLOTS AVAILABLE`, "error");
    return;
  }

  const { slotId, path } = result;
  animating = true;
  disableButtons(true);

  addLog(`▶ PARKING ${type.toUpperCase()} → Slot ${slotId}`, "park");
  addLog(`◈ BFS PATH: ${path.filter(n=>!n.includes("_ENTRY")&&!n.includes("_ROW")&&n!=="ENTRY").join(" → ") || slotId}`, "path");

  // 1. Animate vehicle along entry road
  await animateEntryRoad(type);

  // 2. Highlight BFS path slots step by step
  const slotNodes = path.filter(n => n.match(/^f[123]-\d+-\d+$/));
  await highlightPath(slotNodes, slotId);

  // 3. Mark slot as occupied
  const vehicleInfo = { type, icon: VEHICLE_ICON[type], parkedAt: new Date().toLocaleTimeString() };
  parking.park(slotId, vehicleInfo);

  const slotEl = $(`slot-${slotId}`);
  // Remove path highlights
  slotNodes.forEach(s => { if (s !== slotId) getSlotEl(s)?.classList.remove("path-highlight"); });

  // Apply occupied class
  slotEl.classList.remove("highlighted", "path-highlight");
  slotEl.classList.add(type === "bike" ? "occupied-bike" : "occupied-car");
  $(`icon-${slotId}`).textContent = vehicleInfo.icon;

  // Fill animation
  const fill = document.createElement("div");
  fill.className = "fill-anim";
  slotEl.appendChild(fill);
  setTimeout(() => fill.remove(), 450);

  updateCounters();
  showToast(`✓ ${type.charAt(0).toUpperCase()+type.slice(1)} parked at ${slotId}`, "success");
  addLog(`✓ PARKED @ ${slotId}`, "park");

  animating = false;
  disableButtons(false);
}

/* ── Exit Vehicle ───────────────────────────────────────────── */
async function exitVehicle(slotId) {
  if (animating) return;
  animating = true;
  disableButtons(true);
  setExitMode(false);

  const info = parking.exit(slotId);
  const slotEl = $(`slot-${slotId}`);

  addLog(`◀ EXITING ${info.type.toUpperCase()} from ${slotId}`, "exit");

  // Flash exit animation
  slotEl.style.transition = "all 0.15s";
  for (let i = 0; i < 3; i++) {
    slotEl.style.borderColor = "var(--neon-red)";
    slotEl.style.boxShadow   = "0 0 20px rgba(255,34,68,0.6)";
    await sleep(150);
    slotEl.style.borderColor = "";
    slotEl.style.boxShadow   = "";
    await sleep(100);
  }

  // Clear slot
  slotEl.classList.remove("occupied-bike", "occupied-car", "highlighted", "path-highlight");
  $(`icon-${slotId}`).textContent = "";

  // Animate vehicle leaving entry road
  await animateExitRoad(info.type);

  updateCounters();
  showToast(`✓ Vehicle exited from ${slotId}`, "success");
  addLog(`✓ SLOT ${slotId} NOW AVAILABLE`, "park");

  animating = false;
  disableButtons(false);
}

/* ── BFS Path Highlight ─────────────────────────────────────── */
async function highlightPath(slotNodes, targetSlot) {
  // Highlight target slot first (assignment indicator)
  const targetEl = $(`slot-${targetSlot}`);
  targetEl.classList.add("highlighted");

  // Highlight intermediate path nodes with a delay
  for (let i = 0; i < slotNodes.length - 1; i++) {
    const el = getSlotEl(slotNodes[i]);
    if (el && slotNodes[i] !== targetSlot) {
      el.classList.add("path-highlight");
    }
    await sleep(ANIM_DELAY);
  }
  await sleep(300);
}

/* ── Entry Road Animation ───────────────────────────────────── */
function animateEntryRoad(type) {
  return new Promise(resolve => {
    const vEl = $("animated-vehicle");
    vEl.textContent = VEHICLE_ICON[type];
    vEl.style.transition = "none";
    vEl.style.left = "-60px";
    vEl.style.opacity = "1";

    // Drive across entry road
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        vEl.style.transition = `left ${PARK_DURATION * 0.5}ms cubic-bezier(0.25,0.46,0.45,0.94)`;
        vEl.style.left = "105%";
        setTimeout(() => {
          vEl.style.opacity = "0";
          vEl.style.left    = "-60px";
          resolve();
        }, PARK_DURATION * 0.55);
      });
    });
  });
}

function animateExitRoad(type) {
  return new Promise(resolve => {
    const vEl = $("animated-vehicle");
    vEl.textContent = VEHICLE_ICON[type];
    vEl.style.transition = "none";
    vEl.style.left = "105%";
    vEl.style.opacity = "1";

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        vEl.style.transition = `left ${PARK_DURATION * 0.5}ms cubic-bezier(0.55,0,0.75,0.54)`;
        vEl.style.left = "-60px";
        setTimeout(() => {
          vEl.style.opacity = "0";
          resolve();
        }, PARK_DURATION * 0.55);
      });
    });
  });
}

/* ── Exit Modal ─────────────────────────────────────────────── */
function openExitModal() {
  const list = parking.getOccupiedList();
  const body = $("modal-body");
  body.innerHTML = "";

  if (list.length === 0) {
    body.innerHTML = `<div style="color:var(--text-dim);font-family:var(--font-mono);font-size:11px;text-align:center;padding:20px">No vehicles currently parked.</div>`;
  } else {
    list.forEach(v => {
      const [fid, r, c] = v.id.split("-");
      const floorName = FLOOR_CONFIG[fid]?.name || fid;
      const slotNum   = parseInt(r) * FLOOR_CONFIG[fid].cols + parseInt(c) + 1;

      const item = document.createElement("div");
      item.className = "exit-item";
      item.innerHTML = `
        <span>${v.icon} &nbsp; Slot ${v.id}</span>
        <span>${floorName} · #${String(slotNum).padStart(2,"0")} · ${v.parkedAt}</span>
      `;
      item.addEventListener("click", () => {
        closeModal();
        exitVehicle(v.id);
      });
      body.appendChild(item);
    });
  }

  $("modal-overlay").classList.add("active");
}

function closeModal() {
  $("modal-overlay").classList.remove("active");
  setExitMode(false);
}

/* ── Exit Mode Toggle ───────────────────────────────────────── */
function setExitMode(on) {
  exitMode = on;
  // Visual cue: add/remove exit-mode class from occupied slots
  $$(".slot.occupied-bike, .slot.occupied-car").forEach(el => {
    on ? el.classList.add("exit-mode") : el.classList.remove("exit-mode");
  });
}

/* ── Update Counters ────────────────────────────────────────── */
function updateCounters() {
  const f1 = parking.getAvailableCount("f1");
  const f2 = parking.getAvailableCount("f2");
  const f3 = parking.getAvailableCount("f3");

  $("f1-count").textContent   = f1;
  $("f2-count").textContent   = f2;
  $("f3-count").textContent   = f3;
  $("bike-avail").textContent = f1;
  $("car-f2-avail").textContent = f2;
  $("car-f3-avail").textContent = f3;

  // Color coding
  const color = n => n === 0 ? "var(--neon-red)" : n < 5 ? "var(--neon-orange)" : "var(--neon-green)";
  $("f1-count").style.color = color(f1);
  $("f2-count").style.color = color(f2);
  $("f3-count").style.color = color(f3);
  $("bike-avail").style.color = color(f1);
  $("car-f2-avail").style.color = color(f2);
  $("car-f3-avail").style.color = color(f3);
}

/* ── Toast ──────────────────────────────────────────────────── */
let toastTimer;
function showToast(msg, type = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className   = "toast show" + (type ? ` ${type}` : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

/* ── Activity Log ───────────────────────────────────────────── */
function addLog(msg, cls = "") {
  const box  = $("log-box");
  const line = document.createElement("div");
  line.className = `log-entry${cls ? " " + cls : ""}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;

  // Keep log to last 50 entries
  while (box.children.length > 50) box.removeChild(box.firstChild);
}

/* ── Helpers ────────────────────────────────────────────────── */
function getSlotEl(slotId) { return $(`slot-${slotId}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function disableButtons(flag) {
  ["btn-park-bike", "btn-park-car", "btn-exit"].forEach(id => {
    $(id).disabled = flag;
  });
}

/* ── Event Listeners ────────────────────────────────────────── */
$("btn-park-bike").addEventListener("click", () => parkVehicle("bike"));
$("btn-park-car").addEventListener("click",  () => parkVehicle("car"));
$("btn-exit").addEventListener("click", () => {
  if (parking.getOccupiedList().length === 0) {
    showToast("No vehicles parked yet!", "error"); return;
  }
  openExitModal();
});
$("modal-close").addEventListener("click", closeModal);
$("modal-overlay").addEventListener("click", e => {
  if (e.target === $("modal-overlay")) closeModal();
});

/* ── Init ───────────────────────────────────────────────────── */
function init() {
  buildGrids();
  updateCounters();
  addLog("◈ GRAPH INITIALIZED · 96 nodes · BFS ready", "init");
  addLog("◈ FLOORS F1, F2, F3 ONLINE", "init");
  console.log("NEXPARK — Parking Graph adjacency nodes:", parking.graph.adjacency.size);
}

init();
