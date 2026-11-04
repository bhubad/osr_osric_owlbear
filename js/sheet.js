// OSRIC character sheet: renders the spreadsheet-like pages and keeps the values in the token's metadata.
import {
  KEY, POPOVER_ID, FORMAT, FORMAT_VERSION, VERSION, inOwlbear, loadOBR, whenReady, whenSceneReady,
  store, applyTheme, emptySheet, sheetStats, characterName, esc,
} from "./common.js?v=1.0.2";
import { readWorkbook } from "./xlsx-import.js?v=1.0.2";

const params = new URLSearchParams(location.search);
const IN_OBR = inOwlbear() || !!window.__OBR_MOCK__;
const STANDALONE_KEY = "osric-sheet:standalone";
const PREFS_KEY = "osric-sheet:prefs";
const BACKUP_PREFIX = "osric-sheet:backup:";
const SEP = "\u0000";

const FONTS = {
  n: '"Aptos Narrow","SheetNarrow","Arial Narrow",sans-serif',
  Abadi: 'Abadi,"Aptos Narrow","SheetNarrow","Arial Narrow",sans-serif',
  a: 'Arial,"Liberation Sans",Arimo,Helvetica,sans-serif',
  c: 'Calibri,Carlito,"Segoe UI",Arial,sans-serif',
  p: 'Aptos,"Segoe UI",Arial,sans-serif',
};
const H_ALIGN = { l: "flex-start", c: "center", r: "flex-end", j: "flex-start", g: "flex-start" };
const T_ALIGN = { l: "left", c: "center", r: "right", j: "justify", g: "left" };
const V_ALIGN = { t: "flex-start", c: "center", b: "flex-end" };
const K = { DECOR: 0, LABEL: 1, INPUT: 2, AREA: 3, CHECK: 4 };

const prefs = Object.assign({ zoom: "fit", page: "cs", groups: {} }, store.get(PREFS_KEY, {}));
const savePrefs = () => store.set(PREFS_KEY, prefs);

const app = {
  OBR: null,
  itemId: params.get("id"),
  me: "local",
  sheet: emptySheet(),
  index: null,
  layouts: {},
  views: {},
  current: null,
  pending: new Map(),
  inflight: new Map(),
  saveTimer: null,
  saving: false,
  stamp: null,
  gone: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const scroller = $("#scroller");

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function newStamp() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ------------------------------------------------------------------ status / banners
function setStatus(kind, text) {
  const s = $("#status");
  s.dataset.kind = kind;
  s.textContent = text;
  s.title = text;
}

function banner(text, kind = "info") {
  const b = $("#banner");
  if (!text) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  b.dataset.kind = kind;
  b.textContent = text;
}

// ------------------------------------------------------------------ data model
function pageVals(pid, create) {
  let p = app.sheet.pages[pid];
  if (!p && create) p = app.sheet.pages[pid] = {};
  return p;
}

function getStored(pid, ref) {
  const p = app.sheet.pages[pid];
  return p && Object.prototype.hasOwnProperty.call(p, ref) ? p[ref] : undefined;
}

function setStored(pid, ref, value) {
  if (value === null) {
    const p = pageVals(pid, false);
    if (p) {
      delete p[ref];
      if (!Object.keys(p).length) delete app.sheet.pages[pid];
    }
  } else {
    pageVals(pid, true)[ref] = value;
  }
  app.pending.set(pid + SEP + ref, value);
  scheduleSave();
}

function hiddenPages() {
  const v = getStored("_", "hidden");
  return new Set(typeof v === "string" && v ? v.split(",") : []);
}

function normalizeSheet(raw) {
  const s = emptySheet();
  if (raw && typeof raw === "object" && raw.pages && typeof raw.pages === "object") {
    for (const [pid, vals] of Object.entries(raw.pages)) {
      if (vals && typeof vals === "object") s.pages[pid] = { ...vals };
    }
  }
  return s;
}

function applyBatch(sheet, batch) {
  for (const [k, v] of batch) {
    const [pid, ref] = k.split(SEP);
    if (v === null) {
      if (sheet.pages[pid]) {
        delete sheet.pages[pid][ref];
        if (!Object.keys(sheet.pages[pid]).length) delete sheet.pages[pid];
      }
    } else {
      if (!sheet.pages[pid]) sheet.pages[pid] = {};
      sheet.pages[pid][ref] = v;
    }
  }
}

// ------------------------------------------------------------------ saving
function scheduleSave() {
  setStatus("dirty", "Unsaved changes");
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(flush, 500);
}

async function flush() {
  clearTimeout(app.saveTimer);
  if (app.saving) {
    app.saveTimer = setTimeout(flush, 250);
    return;
  }
  if (!app.pending.size) return;
  const batch = new Map(app.pending);
  app.pending.clear();
  app.inflight = batch;
  app.saving = true;
  setStatus("saving", "Saving…");
  try {
    if (IN_OBR) await saveToItem(batch);
    else store.set(STANDALONE_KEY, app.sheet);
    backup();
    setStatus("ok", IN_OBR ? "Saved to token" : "Saved in this browser");
    banner(null);
  } catch (err) {
    for (const [k, v] of batch) if (!app.pending.has(k)) app.pending.set(k, v);
    const msg = (err && err.message) || String(err);
    setStatus("error", "Not saved");
    banner(`Changes could not be saved to the token (${msg}). If the GM restricted token editing, ask them for access. Retrying…`, "error");
    app.saveTimer = setTimeout(flush, 5000);
  } finally {
    app.inflight = new Map();
    app.saving = false;
    if (app.pending.size && !app.saveTimer) scheduleSave();
  }
}

async function saveToItem(batch, replaceAll = false) {
  if (app.gone) throw new Error("the token is no longer in this scene");
  const stamp = newStamp();
  let touched = false;
  await app.OBR.scene.items.updateItems([app.itemId], (items) => {
    for (const item of items) {
      touched = true;
      let m = item.metadata[KEY];
      if (replaceAll || !m || typeof m !== "object") {
        item.metadata[KEY] = { format: FORMAT, v: FORMAT_VERSION, pages: JSON.parse(JSON.stringify(app.sheet.pages)) };
        m = item.metadata[KEY];
      } else {
        if (!m.pages || typeof m.pages !== "object") m.pages = {};
        applyBatch(m, batch);
        m.format = FORMAT;
        m.v = FORMAT_VERSION;
      }
      m.stamp = stamp;
      m.by = app.me;
      m.at = Date.now();
    }
  });
  if (!touched) throw new Error("the token was not found");
  app.stamp = stamp;
}

function backup() {
  const key = BACKUP_PREFIX + (app.itemId || "standalone");
  store.set(key, { at: Date.now(), sheet: app.sheet });
}

async function replaceWhole(sheet) {
  app.sheet = normalizeSheet(sheet);
  app.pending.clear();
  refreshAll();
  if (IN_OBR) {
    setStatus("saving", "Saving…");
    try {
      await saveToItem(new Map(), true);
      setStatus("ok", "Saved to token");
    } catch (err) {
      setStatus("error", "Not saved");
      banner(`Could not save to the token: ${(err && err.message) || err}`, "error");
    }
  } else {
    store.set(STANDALONE_KEY, app.sheet);
    setStatus("ok", "Saved in this browser");
  }
  backup();
}

// remote updates
function onItemsChange(items) {
  const item = items.find((i) => i.id === app.itemId);
  if (!item) {
    if (!app.gone) {
      app.gone = true;
      banner("This token was removed from the scene, so the sheet can no longer be saved. Use ⋯ → Export to keep a copy.", "error");
      setStatus("error", "Token removed");
    }
    return;
  }
  if (app.gone) {
    app.gone = false;
    banner(null);
  }
  setTokenName(item.name);
  const m = item.metadata[KEY];
  const stamp = (m && m.stamp) || null;
  if (stamp === app.stamp) return;
  app.stamp = stamp;
  const incoming = normalizeSheet(m);
  applyBatch(incoming, app.inflight);
  applyBatch(incoming, app.pending);
  app.sheet = incoming;
  refreshAll();
}

// ------------------------------------------------------------------ rendering
function styleRule(pid, i, st) {
  const p = [`font-family:${FONTS[st.f] || `"${st.f}",sans-serif`}`, `font-size:${st.z}px`];
  if (st.bg) p.push(`background-color:#${st.bg}`);
  if (st.c) p.push(`color:#${st.c}`);
  if (st.b) p.push("font-weight:700");
  if (st.i) p.push("font-style:italic");
  const deco = [st.u ? "underline" : "", st.s ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) p.push(`text-decoration:${deco}`);
  if (st.h) {
    p.push(`justify-content:${H_ALIGN[st.h]}`);
    p.push(`text-align:${T_ALIGN[st.h]}`);
  }
  if (st.v) p.push(`align-items:${V_ALIGN[st.v]}`);
  if (st.in) p.push(`padding-left:${2 + st.in * 9}px`);
  if (st.bt) p.push(`border-top:${st.bt}`);
  if (st.br) p.push(`border-right:${st.br}`);
  if (st.bb) p.push(`border-bottom:${st.bb}`);
  if (st.bl) p.push(`border-left:${st.bl}`);
  return `#pg-${pid} .s${i}{${p.join(";")}}`;
}

async function fetchJSON(path) {
  const res = await fetch(new URL(`${path}?v=${VERSION}`, location.href));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function getLayout(pid) {
  if (!app.layouts[pid]) app.layouts[pid] = fetchJSON(`layouts/${pid}.json`);
  return app.layouts[pid];
}

function groupState(view) {
  const saved = prefs.groups[view.pid] || {};
  const colsCollapsed = new Uint8Array(view.C);
  const rowsCollapsed = new Uint8Array(view.R);
  view.layout.colGroups.forEach(([a, b, def], gi) => {
    const collapsed = saved["c" + gi] ?? def;
    if (collapsed) for (let i = a; i <= b; i++) colsCollapsed[i] = 1;
  });
  view.layout.rowGroups.forEach(([a, b, def], gi) => {
    const collapsed = saved["r" + gi] ?? def;
    if (collapsed) for (let i = a; i <= b; i++) rowsCollapsed[i] = 1;
  });
  view.colsCollapsed = colsCollapsed;
  view.rowsCollapsed = rowsCollapsed;
}

function applyTracks(view) {
  const { layout } = view;
  const cw = layout.cols.map((w, i) => (view.colsCollapsed[i] ? 0 : w));
  const rh = layout.rows.map((h, i) => (view.rowsCollapsed[i] ? 0 : h));
  view.cw = cw;
  view.rh = rh;
  view.width = cw.reduce((a, b) => a + b, 0);
  view.height = rh.reduce((a, b) => a + b, 0);
  view.cx = [0];
  for (const w of cw) view.cx.push(view.cx[view.cx.length - 1] + w);
  view.ry = [0];
  for (const h of rh) view.ry.push(view.ry[view.ry.length - 1] + h);
  const cols = cw.map((w) => w + "px").join(" ");
  const rows = rh.map((h) => h + "px").join(" ");
  view.grid.style.gridTemplateColumns = cols;
  view.grid.style.gridTemplateRows = rows;
  if (view.olTop) view.olTop.style.gridTemplateColumns = cols;
  if (view.olLeft) view.olLeft.style.gridTemplateRows = rows;
  // hide elements that sit entirely inside collapsed tracks
  const anyCollapsed = view.colsCollapsed.some((x) => x) || view.rowsCollapsed.some((x) => x);
  view.nodes.forEach((node, i) => {
    if (!node) return;
    const [r, c, rs, cs] = layout.cells[i];
    let gone = false;
    if (anyCollapsed) {
      let allC = true;
      for (let x = c; x < c + cs; x++) if (!view.colsCollapsed[x]) { allC = false; break; }
      let allR = true;
      for (let y = r; y < r + rs; y++) if (!view.rowsCollapsed[y]) { allR = false; break; }
      gone = allC || allR;
    }
    node.classList.toggle("gone", gone);
    if (node._mark) node._mark.classList.toggle("gone", gone);
  });
  for (const node of view.free.values()) {
    const r = node._r, c = node._c;
    node.classList.toggle("gone", !!(view.rowsCollapsed[r] || view.colsCollapsed[c]));
  }
}

function buildOutline(view) {
  const { layout } = view;
  const mkBtn = (collapsed, onClick, title) => {
    const b = el("button", "ol-btn", collapsed ? "+" : "−");
    b.type = "button";
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  };
  if (layout.colGroups.length) {
    const top = el("div", "ol-top");
    layout.colGroups.forEach(([a, b], gi) => {
      const collapsed = view.colsCollapsed[a];
      const line = el("div", "ol-line-h");
      line.style.gridColumn = `${a + 1} / ${b + 2}`;
      top.appendChild(line);
      const at = Math.min(b + 1, view.C - 1);
      const btn = mkBtn(collapsed, () => toggleGroup(view, "c", gi), collapsed ? `Show columns ${layout.colIds[a]}–${layout.colIds[b]}` : `Hide columns ${layout.colIds[a]}–${layout.colIds[b]}`);
      btn.style.gridColumn = `${at + 1}`;
      top.appendChild(btn);
    });
    view.olTop = top;
  }
  if (layout.rowGroups.length) {
    const left = el("div", "ol-left");
    layout.rowGroups.forEach(([a, b], gi) => {
      const collapsed = view.rowsCollapsed[a];
      const line = el("div", "ol-line-v");
      line.style.gridRow = `${a + 1} / ${b + 2}`;
      left.appendChild(line);
      const at = Math.min(b + 1, view.R - 1);
      const btn = mkBtn(collapsed, () => toggleGroup(view, "r", gi), collapsed ? `Show rows ${layout.rowIds[a]}–${layout.rowIds[b]}` : `Hide rows ${layout.rowIds[a]}–${layout.rowIds[b]}`);
      btn.style.gridRow = `${at + 1}`;
      left.appendChild(btn);
    });
    view.olLeft = left;
  }
}

function toggleGroup(view, kind, gi) {
  const [a] = kind === "c" ? view.layout.colGroups[gi] : view.layout.rowGroups[gi];
  const now = kind === "c" ? view.colsCollapsed[a] : view.rowsCollapsed[a];
  const saved = (prefs.groups[view.pid] = prefs.groups[view.pid] || {});
  saved[kind + gi] = now ? 0 : 1;
  savePrefs();
  groupState(view);
  // rebuild outline strips (button labels) and tracks
  const oldTop = view.olTop, oldLeft = view.olLeft;
  view.olTop = view.olLeft = null;
  buildOutline(view);
  if (oldTop) oldTop.replaceWith(view.olTop);
  if (oldLeft) oldLeft.replaceWith(view.olLeft);
  applyTracks(view);
  layoutOverflow(view);
  applyZoom();
}

function fieldValue(node) {
  const v = getStored(node._pid, node._ref);
  if (node._kind === K.CHECK) return v === undefined ? !!node._def : !!v;
  if (v === undefined) return node._def == null ? "" : String(node._def);
  return String(v);
}

function setFieldValue(node) {
  if (node === document.activeElement) return;
  const v = fieldValue(node);
  if (node._kind === K.CHECK) {
    if (node._box.checked !== v) node._box.checked = v;
  } else if (node.value !== v) {
    node.value = v;
  }
}

function buildView(layout) {
  const pid = layout.id;
  const view = {
    pid, layout, R: layout.rows.length, C: layout.cols.length,
    nodes: [], fields: new Map(), free: new Map(), labels: [], olTop: null, olLeft: null,
  };
  const page = el("section", "page");
  page.id = "pg-" + pid;
  page.dataset.pid = pid;
  const style = document.createElement("style");
  style.textContent = layout.styles.map((st, i) => styleRule(pid, i, st)).join("\n");
  page.appendChild(style);

  const zoomBox = el("div", "zoombox");
  const frame = el("div", "frame");
  const grid = el("div", "grid");
  view.page = page;
  view.zoomBox = zoomBox;
  view.frame = frame;
  view.grid = grid;

  groupState(view);
  buildOutline(view);

  const occ = new Int32Array(view.R * view.C).fill(-1);
  view.occ = occ;
  const frag = document.createDocumentFragment();
  layout.cells.forEach((rec, i) => {
    const [r, c, rs, cs, s, k, ref, t, note, link] = rec;
    const st = layout.styles[s];
    let node;
    if (k === K.LABEL) {
      node = el("div", `c l s${s}`);
      const span = el("span", "t", t === 0 || t == null ? "" : String(t));
      node.appendChild(span);
      if (st.w) node.classList.add("w");
      if (st.r) node.classList.add(st.r === 90 ? "r90" : st.r === 180 ? "r270" : "r90");
      if (!st.w && !st.r && rs === 1) view.labels.push(i);
      if (link) {
        node.classList.add("lnk");
        node.tabIndex = 0;
        node.addEventListener("click", () => followLink(link));
        node.addEventListener("keydown", (e) => e.key === "Enter" && followLink(link));
      }
    } else if (k === K.INPUT || k === K.AREA) {
      node = document.createElement(k === K.AREA ? "textarea" : "input");
      node.className = `c f s${s}`;
      if (k === K.INPUT) node.type = "text";
      node.spellcheck = false;
      node.autocomplete = "off";
      node._kind = k;
    } else if (k === K.CHECK) {
      node = el("label", `c k f s${s}`);
      const box = document.createElement("input");
      box.type = "checkbox";
      node.appendChild(box);
      node._box = box;
      box._owner = node;
      node._kind = k;
    } else {
      node = el("div", `c s${s}`);
    }
    if (k === K.INPUT || k === K.AREA || k === K.CHECK) {
      node._pid = pid;
      node._ref = ref;
      node._def = k === K.CHECK ? !!t : t === 0 || t == null ? "" : String(t);
      view.fields.set(ref, node);
      setFieldValue(node);
      if (k !== K.CHECK) node.setAttribute("aria-label", ref);
    }
    node.style.gridArea = `${r + 1} / ${c + 1} / span ${rs} / span ${cs}`;
    if (note) {
      node.title = note;
      const mark = el("div", "nm");
      mark.style.gridArea = `${r + 1} / ${c + cs} / span 1 / span 1`;
      node._mark = mark;
      frag.appendChild(mark);
    }
    for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) occ[y * view.C + x] = i;
    view.nodes[i] = node;
    frag.appendChild(node);
  });
  grid.appendChild(frag);

  grid.addEventListener("input", onFieldInput);
  grid.addEventListener("change", onFieldInput);
  grid.addEventListener("mousedown", (e) => onGridMouseDown(view, e));
  grid.addEventListener("focusout", (e) => onFreeBlur(view, e));

  if (view.olTop) frame.appendChild(el("div", "ol-corner"));
  if (view.olTop) frame.appendChild(view.olTop);
  if (view.olLeft) frame.appendChild(view.olLeft);
  frame.appendChild(grid);
  frame.classList.toggle("has-top", !!view.olTop);
  frame.classList.toggle("has-left", !!view.olLeft);
  zoomBox.appendChild(frame);
  page.appendChild(zoomBox);
  applyTracks(view);
  // values typed into empty (free) cells
  const vals = app.sheet.pages[pid] || {};
  for (const ref of Object.keys(vals)) if (!view.fields.has(ref)) addFree(view, ref, false, true);
  return view;
}

function buildTextView(layout) {
  const page = el("section", "page textpage");
  page.id = "pg-" + layout.id;
  const box = el("article", "doc");
  for (const para of layout.text) {
    const parts = para.split(/\n/);
    for (const part of parts) {
      if (!part.trim()) continue;
      const p = el("p", /^\[(BEGINNING|END) OF LICENSE\]|^[A-Z0-9 ()/.-]{12,}$/.test(part.trim()) ? "h" : "", part.trim());
      box.appendChild(p);
    }
  }
  const credit = el("p", "credit");
  credit.innerHTML = `Layout taken from the <a href="${esc(app.index.sourceUrl)}" target="_blank" rel="noopener">${esc(app.index.source)}</a>. This extension only reproduces its fields; it does no calculations.`;
  box.appendChild(credit);
  page.appendChild(box);
  return { pid: layout.id, layout, page, text: true, fields: new Map(), free: new Map(), nodes: [] };
}

// ------------------------------------------------------------------ text overflow (like a spreadsheet)
function isFree(view, y, x) {
  return view.occ[y * view.C + x] === -1 && !view.freeAt?.has(y * view.C + x);
}

function layoutOverflow(view) {
  if (view.text) return;
  view.freeAt = new Set();
  for (const node of view.free.values()) {
    for (let x = node._c; x < node._c + node._cs; x++) view.freeAt.add(node._r * view.C + x);
  }
  const { cells, styles } = view.layout;
  for (const i of view.labels) {
    const node = view.nodes[i];
    const [r, c, , cs, s] = cells[i];
    const h = styles[s].h || "l";
    const span = node.firstChild;
    let own = 0;
    for (let x = c; x < c + cs; x++) own += view.cw[x];
    let right = 0;
    for (let x = c + cs; x < view.C && isFree(view, r, x); x++) right += view.cw[x];
    let left = 0;
    for (let x = c - 1; x >= 0 && isFree(view, r, x); x--) left += view.cw[x];
    let max = own;
    if (h === "r") max = own + left;
    else if (h === "c") max = own + 2 * Math.min(left, right);
    else max = own + right;
    span.style.maxWidth = Math.max(0, max - 4) + "px";
  }
}

// ------------------------------------------------------------------ free cells
function refToRC(view, ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  const x = view.layout.colIds.indexOf(m[1]);
  const y = view.layout.rowIds.indexOf(Number(m[2]));
  if (x < 0 || y < 0) return null;
  return [y, x];
}

function freeSpan(view, y, x) {
  let n = 1;
  for (let c = x + 1; c < view.C; c++) {
    if (view.occ[y * view.C + c] !== -1) break;
    let taken = false;
    for (const other of view.free.values()) if (other._r === y && other._c === c) taken = true;
    if (taken) break;
    n++;
    if (n >= 40) break;
  }
  return n;
}

function respanRow(view, y) {
  for (const node of view.free.values()) {
    if (node._r !== y) continue;
    node._cs = freeSpan(view, y, node._c);
    node.style.gridArea = `${y + 1} / ${node._c + 1} / span 1 / span ${node._cs}`;
  }
}

function addFree(view, ref, focus, quiet = false) {
  if (view.free.has(ref)) {
    if (focus) view.free.get(ref).focus();
    return view.free.get(ref);
  }
  const rc = refToRC(view, ref);
  if (!rc) return null;
  const [y, x] = rc;
  if (view.occ[y * view.C + x] !== -1) return null;
  const node = document.createElement("input");
  node.type = "text";
  node.className = "c f free";
  node.spellcheck = false;
  node.autocomplete = "off";
  node._pid = view.pid;
  node._ref = ref;
  node._def = "";
  node._kind = K.INPUT;
  node._r = y;
  node._c = x;
  node._free = true;
  node.setAttribute("aria-label", ref);
  view.free.set(ref, node);
  view.grid.appendChild(node);
  respanRow(view, y);
  setFieldValue(node);
  if (view.rowsCollapsed[y] || view.colsCollapsed[x]) node.classList.add("gone");
  if (!quiet) layoutOverflow(view);
  if (focus) node.focus();
  return node;
}

function removeFree(view, ref) {
  const node = view.free.get(ref);
  if (!node) return;
  view.free.delete(ref);
  node.remove();
  respanRow(view, node._r);
  layoutOverflow(view);
}

function onGridMouseDown(view, e) {
  if (e.target !== view.grid || e.button !== 0) return;
  const rect = view.grid.getBoundingClientRect();
  const scale = rect.width / view.width || 1;
  const px = (e.clientX - rect.left) / scale;
  const py = (e.clientY - rect.top) / scale;
  const x = bisect(view.cx, px);
  const y = bisect(view.ry, py);
  if (x < 0 || y < 0 || x >= view.C || y >= view.R) return;
  if (view.occ[y * view.C + x] !== -1) return;
  e.preventDefault();
  addFree(view, view.layout.colIds[x] + view.layout.rowIds[y], true);
}

function bisect(edges, v) {
  let lo = 0, hi = edges.length - 1;
  if (v < 0 || v >= edges[hi]) return -1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] <= v) lo = mid;
    else hi = mid;
  }
  // skip zero-width (collapsed) tracks
  while (lo < edges.length - 2 && edges[lo + 1] === edges[lo]) lo++;
  return lo;
}

function onFreeBlur(view, e) {
  const node = e.target;
  if (!node._free) return;
  setTimeout(() => {
    if (node !== document.activeElement && node.value === "") removeFree(view, node._ref);
  }, 0);
}

// ------------------------------------------------------------------ editing
function onFieldInput(e) {
  let node = e.target;
  if (node._owner) node = node._owner;
  if (!node._ref) return;
  if (node._kind === K.CHECK) {
    const v = node._box.checked;
    setStored(node._pid, node._ref, v === !!node._def ? null : v);
  } else {
    const v = node.value;
    const def = node._def || "";
    setStored(node._pid, node._ref, v === def ? null : v);
  }
  if (node._pid === "cs" && node._ref === "N1") updateTitle();
}

function refreshView(view) {
  if (view.text) return;
  for (const node of view.fields.values()) setFieldValue(node);
  const vals = app.sheet.pages[view.pid] || {};
  for (const [ref, node] of [...view.free]) {
    if (!(ref in vals) && node !== document.activeElement) removeFree(view, ref);
    else setFieldValue(node);
  }
  for (const ref of Object.keys(vals)) if (!view.fields.has(ref) && !view.free.has(ref)) addFree(view, ref, false);
}

function refreshAll() {
  for (const view of Object.values(app.views)) refreshView(view);
  updateTitle();
  updateTabs();
}

// ------------------------------------------------------------------ pages / tabs / zoom
async function showPage(pid) {
  if (!app.index.pages.some((p) => p.id === pid)) pid = "cs";
  const prev = app.views[app.current];
  if (prev) prev.scroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
  app.current = pid;
  prefs.page = pid;
  savePrefs();
  updateTabs();
  let view = app.views[pid];
  if (!view) {
    const loading = el("div", "loading", "Loading page…");
    scroller.appendChild(loading);
    const layout = await getLayout(pid);
    view = app.views[pid] = layout.text ? buildTextView(layout) : buildView(layout);
    loading.remove();
    scroller.appendChild(view.page);
    if (!view.text) layoutOverflow(view);
  }
  for (const v of Object.values(app.views)) v.page.classList.toggle("on", v === view);
  applyZoom();
  scroller.scrollTop = view.scroll ? view.scroll.top : 0;
  scroller.scrollLeft = view.scroll ? view.scroll.left : 0;
}

function buildTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  for (const p of app.index.pages) {
    const b = el("button", "tab", p.title);
    b.type = "button";
    b.dataset.pid = p.id;
    b.addEventListener("click", () => showPage(p.id));
    tabs.appendChild(b);
  }
  updateTabs();
}

function updateTabs() {
  const hidden = hiddenPages();
  for (const b of document.querySelectorAll("#tabs .tab")) {
    b.classList.toggle("on", b.dataset.pid === app.current);
    b.hidden = hidden.has(b.dataset.pid) && b.dataset.pid !== app.current;
  }
  const on = $("#tabs .tab.on");
  if (on) on.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function currentZoom(view) {
  if (prefs.zoom !== "fit") return Number(prefs.zoom) || 1;
  if (!view || view.text) return 1;
  const pad = 18 + (view.olLeft ? 16 : 0);
  const avail = scroller.clientWidth - pad;
  return Math.max(0.5, Math.min(1.6, avail / view.width));
}

function applyZoom() {
  const view = app.views[app.current];
  const z = currentZoom(view);
  if (view && !view.text) view.zoomBox.style.zoom = String(z);
  $("#zoomval").textContent = prefs.zoom === "fit" ? `Fit ${Math.round(z * 100)}%` : `${Math.round(z * 100)}%`;
}

function stepZoom(dir) {
  const view = app.views[app.current];
  const cur = currentZoom(view);
  const steps = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  let next = cur;
  if (dir > 0) next = steps.find((s) => s > cur + 0.001) ?? 2;
  else next = [...steps].reverse().find((s) => s < cur - 0.001) ?? 0.5;
  prefs.zoom = next;
  savePrefs();
  applyZoom();
}

function followLink(link) {
  const m = /^([a-z0-9]+)!([A-Z]+\d+)$/.exec(link);
  if (!m) {
    if (/^https?:/.test(link)) window.open(link, "_blank", "noopener");
    return;
  }
  const [, pid, ref] = m;
  showPage(pid).then(() => {
    const view = app.views[pid];
    const rc = view && refToRC(view, ref);
    if (!rc) return;
    const z = currentZoom(view);
    scroller.scrollTo({ top: view.ry[rc[0]] * z, left: Math.max(0, view.cx[rc[1]] * z - 20), behavior: "smooth" });
  });
}

// ------------------------------------------------------------------ title
let tokenName = "";
function setTokenName(name) {
  tokenName = name || "";
  updateTitle();
}

function updateTitle() {
  const name = characterName(app.sheet, tokenName || (IN_OBR ? "Character" : "Character sheet"));
  $("#title").textContent = name;
  $("#title").title = tokenName && tokenName !== name ? `Token: ${tokenName}` : name;
  document.title = `${name} · OSRIC sheet`;
}

// ------------------------------------------------------------------ menu & dialogs
function openDialog(html, onReady) {
  const dlg = $("#dialog");
  dlg.innerHTML = html;
  dlg.showModal();
  dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
  if (onReady) onReady(dlg);
  return dlg;
}

function download(name, text) {
  try {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    return true;
  } catch (_) {
    return false;
  }
}

function exportSheet() {
  const name = characterName(app.sheet, tokenName || "character");
  const data = { format: FORMAT, v: FORMAT_VERSION, exported: new Date().toISOString(), name, pages: app.sheet.pages };
  const text = JSON.stringify(data, null, 1);
  const file = `${name.replace(/[^\w\- ]+/g, "").trim() || "character"} (OSRIC sheet).json`;
  openDialog(
    `<h2>Export sheet</h2>
     <p>A JSON file with every value on this sheet. Use <b>Import</b> to load it onto another token, in another scene or room.</p>
     <textarea class="json" readonly>${esc(text)}</textarea>
     <div class="row"><button type="button" class="primary" data-dl>Download file</button>
     <button type="button" data-copy>Copy text</button><span class="spacer"></span><button type="button" data-close>Close</button></div>`,
    (dlg) => {
      dlg.querySelector("[data-dl]").addEventListener("click", () => download(file, text));
      dlg.querySelector("[data-copy]").addEventListener("click", async (e) => {
        const ta = dlg.querySelector("textarea");
        ta.select();
        let ok = false;
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch (_) {
          try {
            ok = document.execCommand("copy");
          } catch (__) {
            ok = false;
          }
        }
        e.target.textContent = ok ? "Copied" : "Select and copy manually";
      });
    },
  );
}

function importSheet() {
  openDialog(
    `<h2>Import</h2>
     <p><b>From an exported sheet (.json)</b> or pasted text. This replaces everything on this sheet.</p>
     <div class="row"><input type="file" accept=".json,application/json" data-json></div>
     <textarea class="json" placeholder="…or paste exported JSON here" data-paste></textarea>
     <div class="row"><button type="button" class="primary" data-load>Load pasted text</button></div>
     <hr>
     <p><b>From a filled-in copy of the spreadsheet (.xlsx)</b>, e.g. downloaded from Google Sheets with File → Download → Microsoft Excel.
     Values are read from the cells, including the results of formulas, and placed in the same fields here. Made for template v2.2.</p>
     <div class="row"><input type="file" accept=".xlsx" data-xlsx></div>
     <p class="msg" data-msg></p>
     <div class="ask" data-ask hidden><p data-asktext></p><div class="row"><span class="spacer"></span>
       <button type="button" data-no>Cancel</button><button type="button" class="danger" data-yes>Replace this sheet</button></div></div>
     <div class="row"><span class="spacer"></span><button type="button" data-close>Close</button></div>`,
    (dlg) => {
      const msg = dlg.querySelector("[data-msg]");
      // window.confirm() can be blocked inside Owlbear's frames, so ask inside the dialog
      const ask = (text) =>
        new Promise((resolve) => {
          const box = dlg.querySelector("[data-ask]");
          dlg.querySelector("[data-asktext]").textContent = text;
          box.hidden = false;
          const done = (v) => {
            box.hidden = true;
            resolve(v);
          };
          dlg.querySelector("[data-yes]").onclick = () => done(true);
          dlg.querySelector("[data-no]").onclick = () => done(false);
          dlg.querySelector("[data-yes]").focus();
        });
      const loadJson = async (text) => {
        let data;
        try {
          data = JSON.parse(text);
        } catch (_) {
          msg.textContent = "That is not valid JSON.";
          return;
        }
        if (!data || typeof data.pages !== "object") {
          msg.textContent = "That file is not an exported OSRIC sheet.";
          return;
        }
        if (!(await ask(`Replace everything on this sheet with the ${sheetStats(data).fields} imported values?`))) return;
        await replaceWhole(data);
        dlg.close();
      };
      dlg.querySelector("[data-json]").addEventListener("change", async (e) => {
        const f = e.target.files[0];
        if (f) loadJson(await f.text());
      });
      dlg.querySelector("[data-load]").addEventListener("click", () => loadJson(dlg.querySelector("[data-paste]").value));
      dlg.querySelector("[data-xlsx]").addEventListener("change", async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        msg.textContent = "Reading spreadsheet…";
        try {
          const result = await importFromXlsx(f);
          if (!result.count) {
            msg.textContent = "No values found. Is this a copy of the OSRIC character sheet template?";
            return;
          }
          msg.textContent = "";
          if (!(await ask(`Found ${result.count} values on ${result.pages} pages. Replace everything on this sheet with them?`))) return;
          await replaceWhole(result.sheet);
          dlg.close();
        } catch (err) {
          msg.textContent = `Could not read the file: ${(err && err.message) || err}`;
        }
      });
    },
  );
}

async function importFromXlsx(file) {
  const layouts = await Promise.all(app.index.pages.map((p) => getLayout(p.id)));
  const grids = layouts.filter((l) => !l.text);
  const { sheets } = await readWorkbook(file, grids.map((l) => l.sheet));
  const sheet = emptySheet();
  let count = 0;
  let pages = 0;
  for (const layout of grids) {
    const cells = sheets[layout.sheet];
    if (!cells) continue;
    const kinds = new Map();
    const colIndex = new Map(layout.colIds.map((c, i) => [c, i]));
    const rowIndex = new Map(layout.rowIds.map((r, i) => [r, i]));
    const C = layout.cols.length;
    const occ = new Int32Array(layout.rows.length * C).fill(-1);
    layout.cells.forEach((rec, i) => {
      const [r, c, rs, cs, , k, ref, t] = rec;
      for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) occ[y * C + x] = i;
      if (k >= 2 && ref) kinds.set(ref, { k, def: k === 4 ? !!t : t === 0 || t == null ? "" : String(t) });
    });
    const vals = {};
    for (const [ref, cell] of cells) {
      const f = kinds.get(ref);
      if (f) {
        if (f.k === 4) {
          const b = cell.bool != null ? cell.bool : /^(true|yes|x|1)$/i.test(cell.text);
          if (b !== f.def) vals[ref] = b;
        } else if (cell.text !== f.def) {
          vals[ref] = cell.text;
        }
        continue;
      }
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!m) continue;
      const x = colIndex.get(m[1]);
      const y = rowIndex.get(Number(m[2]));
      if (x == null || y == null) continue;
      if (occ[y * C + x] === -1) vals[ref] = cell.text; // typed into an empty cell
    }
    const n = Object.keys(vals).length;
    if (n) {
      sheet.pages[layout.id] = vals;
      count += n;
      pages++;
    }
  }
  return { sheet, count, pages };
}

function pagesDialog() {
  const hidden = hiddenPages();
  const rows = app.index.pages
    .map((p) => `<label class="chk"><input type="checkbox" value="${p.id}" ${hidden.has(p.id) ? "" : "checked"}> ${esc(p.title)}</label>`)
    .join("");
  openDialog(
    `<h2>Pages</h2><p>Untick the pages this character doesn't use (for example the other classes). This is saved with the sheet, so everyone sees the same tabs.</p>
     <div class="pagelist">${rows}</div>
     <div class="row"><span class="spacer"></span><button type="button" class="primary" data-ok>Done</button></div>`,
    (dlg) => {
      dlg.querySelector("[data-ok]").addEventListener("click", () => {
        const hide = [...dlg.querySelectorAll("input[type=checkbox]")].filter((b) => !b.checked).map((b) => b.value);
        setStored("_", "hidden", hide.length ? hide.join(",") : null);
        updateTabs();
        dlg.close();
      });
    },
  );
}

function clearDialog() {
  const { fields, bytes } = sheetStats(app.sheet);
  openDialog(
    `<h2>Clear sheet</h2><p>This removes all ${fields} values from this sheet${IN_OBR ? " and its token" : ""}. Export first if you want a copy.</p>
     <div class="row"><span class="spacer"></span><button type="button" data-close>Cancel</button><button type="button" class="danger" data-ok>Clear everything</button></div>
     <p class="msg">Sheet size: ${(bytes / 1024).toFixed(1)} KB.</p>`,
    (dlg) => {
      dlg.querySelector("[data-ok]").addEventListener("click", () => {
        replaceWhole(emptySheet());
        dlg.close();
      });
    },
  );
}

function aboutDialog() {
  const { fields, bytes } = sheetStats(app.sheet);
  openDialog(
    `<h2>About this sheet</h2>
     <p>Same pages and fields as the <a href="${esc(app.index.sourceUrl)}" target="_blank" rel="noopener">${esc(app.index.source)}</a>, without the formulas and dropdowns: every field is typed in by hand.
     Click any empty spot on a page to write there, as in the spreadsheet. A small red corner means the cell has a note: hover over it to read it.
     The <b>+</b>/<b>−</b> buttons at the edge show or hide the grouped rows and columns (HP by level, psionics, weaponless tables).</p>
     <p>${IN_OBR ? "Values are saved on the token itself, so everyone in the room sees the same sheet and changes appear live." : "Preview mode: not opened from Owlbear Rodeo, so values are kept in this browser only."}
     ${fields} values, ${(bytes / 1024).toFixed(1)} KB.</p>
     <div class="row"><span class="spacer"></span><button type="button" data-close>Close</button></div>`,
  );
}

function bindToolbar() {
  $("#zoomout").addEventListener("click", () => stepZoom(-1));
  $("#zoomin").addEventListener("click", () => stepZoom(1));
  $("#zoomval").addEventListener("click", () => {
    prefs.zoom = prefs.zoom === "fit" ? 1 : "fit";
    savePrefs();
    applyZoom();
  });
  $("#pagesbtn").addEventListener("click", pagesDialog);
  const menu = $("#menu");
  $("#menubtn").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", () => (menu.hidden = true));
  menu.addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    menu.hidden = true;
    if (act === "export") exportSheet();
    else if (act === "import") importSheet();
    else if (act === "clear") clearDialog();
    else if (act === "about") aboutDialog();
  });
  window.addEventListener("resize", () => {
    if (prefs.zoom === "fit") applyZoom();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      flush();
    }
  });
  window.addEventListener("pagehide", () => flush());
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
}

function bindPopoverControls() {
  const OBR = app.OBR;
  const sizeBtn = $("#sizebtn");
  const closeBtn = $("#closebtn");
  sizeBtn.hidden = false;
  closeBtn.hidden = false;
  closeBtn.addEventListener("click", async () => {
    await flush();
    OBR.popover.close(POPOVER_ID);
  });
  let wide = prefs.wide !== false;
  const apply = async () => {
    const vw = await OBR.viewport.getWidth();
    const vh = await OBR.viewport.getHeight();
    const w = wide ? Math.max(420, Math.min(1700, vw - 32)) : Math.max(380, Math.round(vw * 0.48));
    await OBR.popover.setWidth(POPOVER_ID, Math.round(w));
    await OBR.popover.setHeight(POPOVER_ID, Math.round(Math.max(320, vh - 32)));
    sizeBtn.textContent = wide ? "◨ Half" : "▣ Full";
    sizeBtn.title = wide ? "Make the sheet half as wide so you can see the map" : "Make the sheet use the full width";
  };
  sizeBtn.addEventListener("click", () => {
    wide = !wide;
    prefs.wide = wide;
    savePrefs();
    apply();
  });
  if (!wide) apply();
  else sizeBtn.textContent = "◨ Half";
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("#dialog").open) return;
    const t = e.target;
    if (t && (t._ref || t._owner)) t.blur();
    else closeBtn.click();
  });
}

// ------------------------------------------------------------------ boot
async function bootOBR() {
  setStatus("saving", "Connecting to Owlbear…");
  let OBR;
  try {
    OBR = await loadOBR();
  } catch (err) {
    banner("Could not load the Owlbear Rodeo SDK from the internet, so this sheet can't be saved to the token. Check your connection and reopen the sheet.", "error");
    setStatus("error", "Offline");
    return false;
  }
  app.OBR = OBR;
  try {
    await whenReady(OBR);
  } catch (err) {
    banner("Owlbear Rodeo didn't answer, so this sheet can't load or save. Close the sheet and open it again.", "error");
    setStatus("error", "Not connected");
    return false;
  }
  try {
    applyTheme(await OBR.theme.getTheme());
    OBR.theme.onChange(applyTheme);
  } catch (_) {
    /* theme is optional */
  }
  app.me = await OBR.player.getId();
  bindPopoverControls();
  if (!(await OBR.scene.isReady())) setStatus("saving", "Waiting for a scene to open…");
  await whenSceneReady(OBR);
  if (!app.itemId) {
    banner("No token was given. Right-click a character token and choose “OSRIC Character Sheet”.", "error");
    setStatus("error", "No token");
    return true;
  }
  const [item] = await OBR.scene.items.getItems([app.itemId]);
  if (!item) {
    app.gone = true;
    banner("This token is not in the current scene.", "error");
    setStatus("error", "Token not found");
    return true;
  }
  setTokenName(item.name);
  const m = item.metadata[KEY];
  app.stamp = (m && m.stamp) || null;
  app.sheet = normalizeSheet(m);
  if (!m) {
    // first open: nothing stored yet; offer a local backup if one exists
    const b = store.get(BACKUP_PREFIX + app.itemId);
    if (b && b.sheet && sheetStats(b.sheet).fields) {
      banner("This token has no sheet data, but this browser has a backup of it. Use ⋯ → Import to restore it, or just start typing.", "info");
    }
  }
  OBR.scene.items.onChange(onItemsChange);
  setStatus("ok", m ? "Loaded from token" : "New sheet");
  return true;
}

function bootStandalone() {
  app.sheet = normalizeSheet(store.get(STANDALONE_KEY));
  banner("Preview mode: this page isn't running inside Owlbear Rodeo, so values are kept in this browser only.", "info");
  setStatus("ok", "Preview");
}

async function boot() {
  if (IN_OBR) loadOBR().catch(() => {}); // start downloading the SDK straight away
  applyTheme(null);
  bindToolbar();
  try {
    app.index = await fetchJSON("layouts/index.json");
  } catch (err) {
    banner(`Could not load the sheet layout: ${err.message}`, "error");
    return;
  }
  buildTabs();
  if (IN_OBR) await bootOBR();
  else bootStandalone();
  updateTitle();
  await showPage(params.get("page") || prefs.page || "cs");
  window.__sheetApp = app; // for debugging and tests
}

boot();
