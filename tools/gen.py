#!/usr/bin/env python3
"""Turn the OSRIC character-sheet template (.xlsx) into layout JSON for the Owlbear extension.

Each page becomes a grid: column widths, row heights, outline groups, and a list of
elements (labels, inputs, checkboxes, decoration) with deduplicated styles.
No formulas and no dropdowns are carried over: every computed or dropdown cell becomes
a plain editable field.

usage: gen.py template.xlsx out_dir
"""
import datetime
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

import openpyxl
from openpyxl.styles.colors import COLOR_INDEX
from openpyxl.utils import get_column_letter as L, column_index_from_string as CI
from openpyxl.utils.cell import range_boundaries

SRC, OUT = sys.argv[1], sys.argv[2]

# (sheet name, page id, tab title, options) in workbook order, minus Instructions/Tables/OSRIC Tables.
# policy "keep": constants in dropdown cells stay as default values.
# policy "blank": dropdown cells start empty (the template has example data there).
PAGES = [
    ("Character OptionsAssumptions", "opt", "Character Options/Assumptions", dict(policy="keep", labelFormulas=True, maxCol="L")),
    ("Character Sheet", "cs", "Character Sheet", dict(policy="blank")),
    ("Cleric", "cleric", "Cleric", dict(policy="keep")),
    ("Druid", "druid", "Druid", dict(policy="keep")),
    ("Fighter", "fighter", "Fighter", dict(policy="keep")),
    ("Ranger", "ranger", "Ranger", dict(policy="keep")),
    ("Paladin", "paladin", "Paladin", dict(policy="keep")),
    ("MU", "mu", "MU", dict(policy="keep")),
    ("Ill", "ill", "Ill", dict(policy="keep")),
    ("Thief", "thief", "Thief", dict(policy="keep")),
    ("Assassin", "assassin", "Assassin", dict(policy="keep")),
    ("Monk", "monk", "Monk", dict(policy="keep", maxCol="AR")),
    ("Bard", "bard", "Bard", dict(policy="keep")),
    ("Hirelings", "hire", "Hirelings", dict(policy="blank", dataText={"Mage", "Porter", "2gp/month", "1/2 share", "1gp/month"})),
    ("License", "license", "License", dict(text=True)),
    ("2-Weapon", "twoweapon", "2-Weapon", dict(policy="blank", maxCol="AM")),
    ("Weaponless", "weaponless", "Weaponless", dict(policy="keep")),
]

DARK = {"000000", "0C0C0C"}
TITLE_FILLS = {"D8D8D8", "D9D9D9", "F2F2F2", "F3F3F3"}
DECOR_EMPTY = DARK | TITLE_FILLS | {"999999", "CCCCCC"}
INPUT_FILLS = {"FAE2D5", "FFFF00", "CAEDFB", "00FFFF", "FFF2CC", "FFE599", "FF0000", "F8F8F9"}
PEACH = "FAE2D5"

K_DECOR, K_LABEL, K_INPUT, K_AREA, K_CHECK = 0, 1, 2, 3, 4

# ---------------------------------------------------------------- colours
def load_theme(path):
    names = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]
    out = {}
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read("xl/theme/theme1.xml")
    except KeyError:
        return ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"]
    root = ET.fromstring(xml)
    ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    scheme = root.find(".//a:clrScheme", ns)
    for child in scheme:
        tag = child.tag.split("}")[1]
        el = child[0]
        val = el.get("val") if el.tag.endswith("srgbClr") else el.get("lastClr")
        out[tag] = (val or "000000").upper()
    return [out.get(n, "000000") for n in names]

THEME = load_theme(SRC)

def apply_tint(hexrgb, tint):
    if not tint:
        return hexrgb
    r, g, b = (int(hexrgb[i:i + 2], 16) for i in (0, 2, 4))
    def ch(v):
        return v * (1 + tint) if tint < 0 else v + (255 - v) * tint
    return "%02X%02X%02X" % tuple(max(0, min(255, round(ch(v)))) for v in (r, g, b))

def color_hex(col):
    """openpyxl Color -> 'RRGGBB' or None (automatic / unset)."""
    if col is None:
        return None
    t = col.type
    if t == "rgb":
        v = col.rgb
        if not isinstance(v, str):
            return None
        v = v.upper()
        if len(v) == 8:
            if v == "00000000":
                return None
            v = v[2:]
        return v
    if t == "theme":
        try:
            return apply_tint(THEME[col.theme], col.tint)
        except (IndexError, TypeError):
            return None
    if t == "indexed":
        i = col.indexed
        if i is None or i >= 64:
            return None
        try:
            return COLOR_INDEX[i][2:].upper()
        except IndexError:
            return None
    return None

def fill_hex(cell):
    f = cell.fill
    if f is None or not f.fill_type or f.fill_type == "none":
        return None
    v = color_hex(f.fgColor)
    if v == "FFFFFF":
        return None
    return v

# ---------------------------------------------------------------- formats
def fmt_value(v, nf):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (datetime.datetime, datetime.date)):
        if nf in ("m-d", "m/d"):
            return f"{v.month}{nf[1]}{v.day}"
        if nf in ("mm/dd", "mm-dd"):
            return f"{v.month:02d}{nf[2]}{v.day:02d}"
        return v.strftime("%m/%d/%Y")
    if isinstance(v, (int, float)):
        nf = nf or "General"
        m = re.fullmatch(r"0(?:\.(0+))?%", nf)
        if m:
            d = len(m.group(1) or "")
            return f"{v * 100:.{d}f}%"
        if '"-"' in nf and "#,##0" in nf:  # accounting
            if abs(v) < 1e-9:
                return "-"
            s = f"{abs(v):,.0f}"
            return f"({s})" if v < 0 else s
        if nf == "#,##0":
            return f"{v:,.0f}"
        if nf == "#,##0.00":
            return f"{v:,.2f}"
        if nf == "0":
            return f"{v:.0f}"
        if nf == "0.0":
            return f"{v:.1f}"
        if nf == "0.00":
            return f"{v:.2f}"
        if isinstance(v, float) and v.is_integer():
            return str(int(v))
        if isinstance(v, float):
            return ("%.10g" % v)
        return str(v)
    return str(v)

ERRORS = {"#N/A", "#NAME?", "#REF!", "#VALUE!", "#DIV/0!", "#NUM!", "#NULL!", "#ERROR!"}

# ---------------------------------------------------------------- borders
BORDER_CSS = {
    "thin": (1, "solid"), "hair": (1, "dotted"), "dotted": (1, "dotted"), "dashed": (1, "dashed"),
    "dashDot": (1, "dashed"), "dashDotDot": (1, "dashed"), "medium": (2, "solid"),
    "mediumDashed": (2, "dashed"), "mediumDashDot": (2, "dashed"), "mediumDashDotDot": (2, "dashed"),
    "slantDashDot": (2, "dashed"), "thick": (3, "solid"), "double": (3, "double"),
}

def side_val(side):
    if side is None or not side.style or side.style not in BORDER_CSS:
        return None
    w, s = BORDER_CSS[side.style]
    col = color_hex(side.color) or "000000"
    return (w, s, col)

def heavier(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return a if a[0] >= b[0] else b

# ---------------------------------------------------------------- notes
def clean_note(text):
    if not text:
        return None
    t = text.replace("\r", "")
    t = re.sub(r"^=+\s*$", "", t, flags=re.M)
    t = re.sub(r"^ID#\S+\s*", "", t, flags=re.M)
    t = re.sub(r"\s*\(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\)", "", t)
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    return t or None

# ---------------------------------------------------------------- workbook
wb = openpyxl.load_workbook(SRC)
wbv = openpyxl.load_workbook(SRC, data_only=True)

DEFINED = {}
for name, dn in wb.defined_names.items():
    DEFINED[name] = dn.attr_text

def resolve_link(loc, depth=0):
    """Resolve a hyperlink location (named range or Sheet!A1) to (sheet, A1 of top-left)."""
    if not loc or depth > 5:
        return None
    if loc in DEFINED:
        return resolve_link(DEFINED[loc], depth + 1)
    m = re.match(r"^'?(.+?)'?!\$?([A-Z]+)\$?(\d+)", loc)
    if m:
        return m.group(1), f"{m.group(2)}{m.group(3)}"
    return None

SHEET_TO_PAGE = {p[0]: p[1] for p in PAGES}

def page_text(ws):
    paras = []
    for row in ws.iter_rows():
        for c in row:
            if isinstance(c.value, str) and c.value.strip():
                paras.append(c.value.strip())
    return paras

def build_page(sheet, pid, title, opts):
    ws = wb[sheet]
    wsv = wbv[sheet]
    policy = opts.get("policy", "keep")

    # ---- columns / rows: excluded helpers vs collapsible outline groups
    colinfo = {}
    for k, d in ws.column_dimensions.items():
        lo, hi = d.min or CI(k), d.max or CI(k)
        for c in range(lo, hi + 1):
            colinfo[c] = d
    def col_w(c):
        d = colinfo.get(c)
        w = d.width if d is not None and d.width else (ws.sheet_format.defaultColWidth or 8.43)
        return w
    def col_hidden(c):
        d = colinfo.get(c)
        return bool(d is not None and d.hidden)
    def col_level(c):
        d = colinfo.get(c)
        return (d.outlineLevel or 0) if d is not None else 0
    def row_h(r):
        d = ws.row_dimensions.get(r) if hasattr(ws.row_dimensions, "get") else ws.row_dimensions[r]
        h = d.height if d is not None and d.height else (ws.sheet_format.defaultRowHeight or 15)
        return h
    def row_hidden(r):
        d = ws.row_dimensions.get(r)
        return bool(d is not None and d.hidden)
    def row_level(r):
        d = ws.row_dimensions.get(r)
        return (d.outlineLevel or 0) if d is not None else 0

    excl_col = lambda c: col_hidden(c) and col_level(c) == 0
    excl_row = lambda r: row_hidden(r) and row_level(r) == 0

    # merged ranges
    merged = {}
    covered = set()
    for mr in ws.merged_cells.ranges:
        merged[(mr.min_row, mr.min_col)] = (mr.max_row, mr.max_col)
        for r in range(mr.min_row, mr.max_row + 1):
            for c in range(mr.min_col, mr.max_col + 1):
                if (r, c) != (mr.min_row, mr.min_col):
                    covered.add((r, c))

    dv_cells = set()
    for dv in ws.data_validations.dataValidation:
        for rng in str(dv.sqref).split():
            c1, r1, c2, r2 = range_boundaries(rng)
            for r in range(r1, r2 + 1):
                for c in range(c1, c2 + 1):
                    dv_cells.add((r, c))

    def has_border(cell):
        b = cell.border
        if not b:
            return False
        return any(side_val(getattr(b, s)) for s in ("left", "right", "top", "bottom"))

    # ---- bounding box
    maxr = maxc = 0
    for row in ws.iter_rows():
        for cell in row:
            if excl_col(cell.column):
                continue
            f = fill_hex(cell)
            if cell.value is not None or (f and f not in DARK) or has_border(cell):
                maxr = max(maxr, cell.row)
                maxc = max(maxc, cell.column)
    if "maxRow" in opts:
        maxr = opts["maxRow"]
    if "maxCol" in opts:
        maxc = CI(opts["maxCol"])
    # include a black frame bar directly to the right of / below the content
    def dark_share(cells):
        cells = list(cells)
        return sum(1 for cl in cells if fill_hex(cl) in DARK) / max(1, len(cells))
    if "maxCol" not in opts and dark_share(ws.cell(r, maxc + 1) for r in range(1, maxr + 1)) > 0.6:
        maxc += 1
    if "maxRow" not in opts and dark_share(ws.cell(maxr + 1, c) for c in range(1, maxc + 1) if not excl_col(c)) > 0.6:
        maxr += 1
    cols =[c for c in range(1, maxc + 1) if not excl_col(c)]
    rows = [r for r in range(1, maxr + 1) if not excl_row(r)]
    cidx = {c: i for i, c in enumerate(cols)}
    ridx = {r: i for i, r in enumerate(rows)}

    def groups(items, level_fn, hidden_fn):
        out, cur = [], None
        for i, x in enumerate(items):
            if level_fn(x) > 0:
                if cur is None:
                    cur = [i, i, True]
                cur[1] = i
                cur[2] = cur[2] and hidden_fn(x)
            elif cur is not None:
                out.append(cur)
                cur = None
        if cur is not None:
            out.append(cur)
        return [[a, b, 1 if h else 0] for a, b, h in out]

    colGroups = groups(cols, col_level, col_hidden)
    rowGroups = groups(rows, row_level, row_hidden)

    # Google Sheets exports its default 100 px column as width 12.63, so 1 unit = 100/12.63 px
    colpx = [max(2, round(col_w(c) * 100 / 12.63)) for c in cols]
    rowpx = [max(2, round(row_h(r) * 4 / 3)) for r in rows]

    # ---- edges
    H, V = {}, {}
    for row in ws.iter_rows(min_row=1, max_row=maxr + 1, min_col=1, max_col=maxc + 1):
        for cell in row:
            b = cell.border
            if not b:
                continue
            r, c = cell.row, cell.column
            t, bo, le, ri = side_val(b.top), side_val(b.bottom), side_val(b.left), side_val(b.right)
            if t:
                H[(r, c)] = heavier(H.get((r, c)), t)
            if bo:
                H[(r + 1, c)] = heavier(H.get((r + 1, c)), bo)
            if le:
                V[(r, c)] = heavier(V.get((r, c)), le)
            if ri:
                V[(r, c + 1)] = heavier(V.get((r, c + 1)), ri)

    # ---- classify anchors
    styles, style_ix = [], {}
    def style_id(st):
        key = json.dumps(st, sort_keys=True)
        if key not in style_ix:
            style_ix[key] = len(styles)
            styles.append(st)
        return style_ix[key]

    elems = []          # dicts before border pass
    occ = {}            # (r,c) original -> element index
    stats = {"label": 0, "input": 0, "check": 0, "decor": 0}
    for r in rows:
        for c in cols:
            if (r, c) in covered:
                continue
            r2, c2 = merged.get((r, c), (r, c))
            r2, c2 = min(r2, maxr), min(c2, maxc)
            span_rows = [x for x in rows if r <= x <= r2]
            span_cols = [x for x in cols if c <= x <= c2]
            if not span_rows or not span_cols:
                continue
            cell = ws.cell(r, c)
            v = cell.value
            cv = wsv.cell(r, c).value
            fill = fill_hex(cell)
            is_formula = isinstance(v, str) and v.startswith("=")
            is_merged = (r2, c2) != (r, c)
            font = cell.font
            fcol = color_hex(font.color) if font is not None else None
            nf = cell.number_format or "General"
            kind, text = None, ""

            def light(hexrgb):
                if not hexrgb:
                    return False
                rr, gg, bb = (int(hexrgb[i:i + 2], 16) for i in (0, 2, 4))
                return (rr * 299 + gg * 587 + bb * 114) / 1000 > 150

            shown = cv if is_formula else v
            if fill in DARK:
                if shown not in (None, "") and not isinstance(shown, bool) and light(fcol):
                    kind, text = K_LABEL, fmt_value(shown, nf)
                else:
                    kind = K_DECOR
            elif isinstance(v, bool) or (is_formula and isinstance(cv, bool)):
                kind = K_CHECK
                text = 1 if (v is True) else 0
            elif is_formula:
                if opts.get("labelFormulas") and fill is None:
                    kind, text = K_LABEL, fmt_value(cv, nf) if cv not in ERRORS else ""
                elif fill in TITLE_FILLS:
                    kind = K_INPUT
                    text = "" if (cv is None or (isinstance(cv, str) and cv in ERRORS)) else fmt_value(cv, nf)
                else:
                    kind = K_INPUT
            elif v is None:
                if (r, c) in dv_cells or fill in INPUT_FILLS:
                    kind = K_INPUT
                elif fill in DECOR_EMPTY:
                    kind = K_DECOR
                elif fill is not None:
                    kind = K_INPUT
                elif is_merged or has_border(cell):
                    kind = K_INPUT
                else:
                    kind = None  # free cell
            else:
                sval = fmt_value(v, nf)
                if fill in INPUT_FILLS or (r, c) in dv_cells:
                    if isinstance(v, str) and v.strip() in ("'", "/"):
                        kind, text = K_LABEL, sval
                    elif isinstance(v, str) and v.strip() == "--":
                        kind = K_INPUT
                    elif fill == PEACH and isinstance(v, str) and not is_merged:
                        kind, text = K_LABEL, sval  # a caption such as "Chance to Hit", may spill over
                    elif fill == PEACH or policy == "keep":
                        kind, text = K_INPUT, sval
                    else:
                        kind = K_INPUT
                elif isinstance(v, (int, float, datetime.datetime, datetime.date)) and fill is None:
                    # numbers typed into white "manual entry" cells are data, not labels
                    kind, text = K_INPUT, (sval if policy == "keep" else "")
                elif isinstance(v, str) and v in opts.get("dataText", ()):
                    kind = K_INPUT
                else:
                    kind, text = K_LABEL, sval
            if kind is None:
                continue

            al = cell.alignment
            ha = (al.horizontal or "general") if al else "general"
            ha = {"general": "g", "left": "l", "center": "c", "centerContinuous": "c", "right": "r",
                  "justify": "j", "distributed": "j", "fill": "l"}.get(ha, "g")
            if ha == "g":
                if kind == K_LABEL:
                    num = isinstance(shown, (int, float)) and not isinstance(shown, bool)
                    ha = "r" if num else "l"
                elif kind == K_CHECK:
                    ha = "c"
                else:
                    ha = "r" if (is_formula and isinstance(cv, (int, float)) and not isinstance(cv, bool)) else "l"
            va = (al.vertical or "bottom") if al else "bottom"
            va = {"top": "t", "center": "c", "bottom": "b", "justify": "c", "distributed": "c"}.get(va, "b")
            wrap = bool(al and al.wrap_text)
            rot = int(al.textRotation or 0) if al else 0
            indent = int(al.indent or 0) if al else 0
            fname = (font.name if font is not None and font.name else "Aptos Narrow")
            fkey = {"Aptos Narrow": "n", "Arial": "a", "Calibri": "c", "Aptos": "p"}.get(fname, fname)
            fsz = float(font.sz) if font is not None and font.sz else 11.0
            h_px = sum(rowpx[ridx[x]] for x in span_rows)
            if kind == K_INPUT and (wrap or (len(span_rows) >= 2 and h_px >= fsz * 4 / 3 * 2.3)):
                kind = K_AREA
            st = {"f": fkey, "z": round(fsz * 4 / 3, 2)}
            if fill:
                st["bg"] = fill
            if fcol and fcol != "000000":
                st["c"] = fcol
            if font is not None:
                if font.b:
                    st["b"] = 1
                if font.i:
                    st["i"] = 1
                if font.u and font.u != "none":
                    st["u"] = 1
                if font.strike:
                    st["s"] = 1
            if kind in (K_LABEL, K_INPUT, K_AREA, K_CHECK):
                st["h"] = ha
                st["v"] = va
                if wrap and kind == K_LABEL:
                    st["w"] = 1
                if rot and kind == K_LABEL:
                    st["r"] = rot
                if indent:
                    st["in"] = indent
            note = clean_note(cell.comment.text) if cell.comment else None
            link = None
            if cell.hyperlink is not None:
                tgt = resolve_link(cell.hyperlink.location) if cell.hyperlink.location else None
                if tgt and tgt[0] in SHEET_TO_PAGE:
                    link = f"{SHEET_TO_PAGE[tgt[0]]}!{tgt[1]}"
                elif cell.hyperlink.target:
                    link = cell.hyperlink.target
            e = {"r": r, "c": c, "r2": r2, "c2": c2, "rows": span_rows, "cols": span_cols, "st": st,
                 "k": kind, "t": text, "ref": f"{L(c)}{r}", "n": note, "ln": link}
            idx = len(elems)
            elems.append(e)
            for x in span_rows:
                for y in span_cols:
                    occ[(x, y)] = idx
            stats[{K_DECOR: "decor", K_LABEL: "label", K_INPUT: "input", K_AREA: "input", K_CHECK: "check"}[kind]] += 1

    # ---- border pass: who draws which edge
    prev_row = {rows[i]: (rows[i - 1] if i else None) for i in range(len(rows))}
    next_row = {rows[i]: (rows[i + 1] if i + 1 < len(rows) else None) for i in range(len(rows))}
    prev_col = {cols[i]: (cols[i - 1] if i else None) for i in range(len(cols))}
    next_col = {cols[i]: (cols[i + 1] if i + 1 < len(cols) else None) for i in range(len(cols))}

    def css(bv):
        return f"{bv[0]}px {bv[1]} #{bv[2]}" if bv else None

    out = []
    for i, e in enumerate(elems):
        st = dict(e["st"])
        r1, r2 = e["rows"][0], e["rows"][-1]
        c1, c2 = e["cols"][0], e["cols"][-1]
        # bottom: edge under the last row (original r2 + 1 edge uses next included row's top too)
        def pick(segments):
            best = None
            for s in segments:
                best = heavier(best, s)
            return best
        nr = next_row[r2]
        bottom = pick([heavier(H.get((r2 + 1, y)), H.get((nr, y)) if nr else None) for y in e["cols"]])
        nc = next_col[c2]
        right = pick([heavier(V.get((x, c2 + 1)), V.get((x, nc)) if nc else None) for x in e["rows"]])
        pr = prev_row[r1]
        top_needed = []
        for y in e["cols"]:
            seg = heavier(H.get((r1, y)), H.get((pr + 1, y)) if pr else None)
            if seg and (pr is None or (pr, y) not in occ):
                top_needed.append(seg)
        top = pick(top_needed)
        pc = prev_col[c1]
        left_needed = []
        for x in e["rows"]:
            seg = heavier(V.get((x, c1)), V.get((x, pc + 1)) if pc else None)
            if seg and (pc is None or (x, pc) not in occ):
                left_needed.append(seg)
        left = pick(left_needed)
        for key, bv in (("bt", top), ("br", right), ("bb", bottom), ("bl", left)):
            if bv:
                st[key] = css(bv)
        s = style_id(st)
        rec = [ridx[r1], cidx[c1], len(e["rows"]), len(e["cols"]), s, e["k"]]
        tail = [e["ref"] if e["k"] in (K_INPUT, K_AREA, K_CHECK) or e["n"] or e["ln"] else 0,
                e["t"] if e["t"] not in ("", None) else 0,
                e["n"] or 0, e["ln"] or 0]
        while tail and tail[-1] == 0:
            tail.pop()
        out.append(rec + tail)

    # free cells that still need to draw a border (a neighbour defines it, but the neighbour is free too)
    # are rare; ignored.

    page = {
        "id": pid, "title": title, "sheet": sheet,
        "cols": colpx, "rows": rowpx,
        "colIds": [L(c) for c in cols], "rowIds": rows,
        "colGroups": colGroups, "rowGroups": rowGroups,
        "styles": styles, "cells": out,
    }
    return page, stats

os.makedirs(os.path.join(OUT, "layouts"), exist_ok=True)
index = []
for sheet, pid, title, opts in PAGES:
    if opts.get("text"):
        page = {"id": pid, "title": title, "sheet": sheet, "text": page_text(wb[sheet])}
        stats = {}
    else:
        page, stats = build_page(sheet, pid, title, opts)
    path = os.path.join(OUT, "layouts", f"{pid}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(page, fh, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(path)
    entry = {"id": pid, "title": title}
    if "cols" in page:
        entry["w"] = sum(page["cols"])
        entry["h"] = sum(page["rows"])
    index.append(entry)
    print(f"{pid:11s} {title[:28]:28s} {size/1024:7.1f} KB  {stats}  grid={len(page.get('cols', []))}x{len(page.get('rows', []))}")

with open(os.path.join(OUT, "layouts", "index.json"), "w", encoding="utf-8") as fh:
    json.dump({"source": "1st Edition / OSRIC Automated Charactersheet v2.2 by FlacoAlto",
               "sourceUrl": "https://flacoalto.itch.io/1st-edition-osric-automated-charactersheet",
               "pages": index}, fh, ensure_ascii=False, indent=1)
