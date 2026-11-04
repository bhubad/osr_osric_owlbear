// Minimal .xlsx reader: enough to pull cell values out of a filled-in copy of the template.
// No libraries: a ZIP reader using the browser's DecompressionStream and DOMParser for the XML.

const td = new TextDecoder("utf-8");

function u16(dv, o) {
  return dv.getUint16(o, true);
}
function u32(dv, o) {
  return dv.getUint32(o, true);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot unzip files (DecompressionStream missing).");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buffer) {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (u32(dv, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (zip directory not found).");
  const count = u16(dv, eocd + 10);
  let p = u32(dv, eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (u32(dv, p) !== 0x02014b50) break;
    const method = u16(dv, p + 10);
    const csize = u32(dv, p + 20);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const local = u32(dv, p + 42);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => entries.has(name),
    async text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lnameLen = u16(dv, e.local + 26);
      const lextraLen = u16(dv, e.local + 28);
      const start = e.local + 30 + lnameLen + lextraLen;
      const raw = bytes.subarray(start, start + e.csize);
      const out = e.method === 0 ? raw : await inflateRaw(raw);
      return td.decode(out);
    },
  };
}

function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}

function byTag(node, tag) {
  return Array.from(node.getElementsByTagNameNS("*", tag));
}

function textOf(node) {
  // shared strings may be rich text: <si><r><t>..</t></r>...</si>
  return byTag(node, "t").map((t) => t.textContent).join("");
}

const BUILTIN_FORMATS = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%",
  14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 20: "h:mm",
  22: "m/d/yyyy h:mm", 37: "#,##0_);(#,##0)", 38: "#,##0_);(#,##0)", 41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', 49: "@",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isDateFormat(code) {
  const c = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return /[dmy]/i.test(c) && !/[0#]/.test(c);
}

function serialToDate(serial) {
  // Excel 1900 date system (with the 1900 leap-year bug)
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms);
}

export function formatNumber(v, code) {
  code = code || "General";
  if (code === "General" || code === "@") return generalNumber(v);
  if (isDateFormat(code)) {
    const d = serialToDate(v);
    const M = d.getUTCMonth() + 1, D = d.getUTCDate(), Y = d.getUTCFullYear();
    return code
      .replace(/"([^"]*)"/g, "$1")
      .replace(/\\(.)/g, "$1")
      .replace(/yyyy/gi, String(Y))
      .replace(/yy/gi, String(Y).slice(-2))
      .replace(/mmmm/gi, "\u0001")
      .replace(/mmm/gi, "\u0002")
      .replace(/mm/gi, String(M).padStart(2, "0"))
      .replace(/m/gi, String(M))
      .replace(/dd/gi, String(D).padStart(2, "0"))
      .replace(/d/gi, String(D))
      .replace("\u0001", MONTHS[M - 1])
      .replace("\u0002", MONTHS[M - 1])
      .replace(/\s*h:mm.*$/i, "");
  }
  const pct = /^0(?:\.(0+))?%$/.exec(code);
  if (pct) return (v * 100).toFixed((pct[1] || "").length) + "%";
  if (code.includes('"-"') && code.includes("#,##0")) {
    if (Math.abs(v) < 1e-9) return "-";
    const dec = /#,##0\.(0+)/.exec(code);
    const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dec ? dec[1].length : 0, maximumFractionDigits: dec ? dec[1].length : 0 });
    return v < 0 ? `(${s})` : s;
  }
  const fixed = /^(#,##)?0(?:\.(0+))?$/.exec(code.split(";")[0].replace(/_\(|_\)|\\|\(|\)/g, ""));
  if (fixed) {
    const d = (fixed[2] || "").length;
    return fixed[1] ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : v.toFixed(d);
  }
  const signed = /^\+0;-0;0$/.exec(code);
  if (signed) return v > 0 ? `+${Math.round(v)}` : String(Math.round(v));
  return generalNumber(v);
}

function generalNumber(v) {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(10)));
}

const ERRORS = new Set(["#N/A", "#NAME?", "#REF!", "#VALUE!", "#DIV/0!", "#NUM!", "#NULL!", "#ERROR!"]);

/**
 * Read an .xlsx and return { sheetName: Map(ref -> {text, bool}) } for the given sheet names.
 * Values come from the cached results stored in the file, so formula results are included.
 */
export async function readWorkbook(file, wantedSheets) {
  const zip = await readZip(await file.arrayBuffer());
  const wbXml = await zip.text("xl/workbook.xml");
  if (!wbXml) throw new Error("Not an Excel workbook (xl/workbook.xml missing).");
  const relsXml = await zip.text("xl/_rels/workbook.xml.rels");
  const rels = {};
  if (relsXml) {
    for (const r of byTag(parseXml(relsXml), "Relationship")) rels[r.getAttribute("Id")] = r.getAttribute("Target");
  }
  const shared = [];
  const ssXml = await zip.text("xl/sharedStrings.xml");
  if (ssXml) for (const si of byTag(parseXml(ssXml), "si")) shared.push(textOf(si));

  const xfFormats = [];
  const stXml = await zip.text("xl/styles.xml");
  if (stXml) {
    const st = parseXml(stXml);
    const custom = {};
    for (const nf of byTag(st, "numFmt")) custom[nf.getAttribute("numFmtId")] = nf.getAttribute("formatCode");
    const cellXfs = byTag(st, "cellXfs")[0];
    if (cellXfs) {
      for (const xf of Array.from(cellXfs.children)) {
        const id = xf.getAttribute("numFmtId") || "0";
        xfFormats.push(custom[id] || BUILTIN_FORMATS[id] || "General");
      }
    }
  }

  const wanted = new Set(wantedSheets);
  const result = {};
  const found = [];
  const sheetEls = byTag(parseXml(wbXml), "sheet");
  for (const sh of sheetEls) {
    const name = sh.getAttribute("name");
    if (!wanted.has(name)) continue;
    const rid = sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || sh.getAttribute("r:id");
    let target = rels[rid];
    if (!target) continue;
    target = target.replace(/^\/?xl\//, "").replace(/^\//, "");
    const xml = await zip.text("xl/" + target);
    if (!xml) continue;
    found.push(name);
    const cells = new Map();
    for (const c of byTag(parseXml(xml), "c")) {
      const ref = c.getAttribute("r");
      const t = c.getAttribute("t") || "n";
      const s = Number(c.getAttribute("s") || 0);
      const vEl = byTag(c, "v")[0];
      let text = null;
      let bool = null;
      if (t === "s") {
        if (vEl) text = shared[Number(vEl.textContent)] ?? "";
      } else if (t === "inlineStr") {
        const is = byTag(c, "is")[0];
        if (is) text = textOf(is);
      } else if (t === "str") {
        if (vEl) text = vEl.textContent;
      } else if (t === "b") {
        if (vEl) {
          bool = vEl.textContent === "1" || vEl.textContent.toLowerCase() === "true";
          text = bool ? "TRUE" : "FALSE";
        }
      } else if (t === "e") {
        text = null;
      } else if (t === "d") {
        if (vEl) text = vEl.textContent.slice(0, 10);
      } else if (vEl && vEl.textContent !== "") {
        const num = Number(vEl.textContent);
        text = Number.isFinite(num) ? formatNumber(num, xfFormats[s]) : vEl.textContent;
      }
      if (text == null || text === "" || ERRORS.has(text)) continue;
      cells.set(ref, { text, bool });
    }
    result[name] = cells;
  }
  return { sheets: result, found };
}
