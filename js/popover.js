// Toolbar popover: lists the character tokens in the scene and opens their sheets.
import { KEY, loadOBR, whenReady, whenSceneReady, openSheet, applyTheme, characterName, sheetStats, esc, inOwlbear, extUrl } from "./common.js?v=1.0.2";

const $ = (id) => document.getElementById(id);

function row(OBR, item, hasSheet) {
  const li = document.createElement("li");
  const sheet = item.metadata[KEY];
  const name = item.name || "Unnamed token";
  const charName = hasSheet ? characterName(sheet, "") : "";
  const sub = hasSheet
    ? [charName && charName !== name ? charName : "", `${sheetStats(sheet).fields} fields filled`].filter(Boolean).join(" · ")
    : "no sheet yet";
  li.innerHTML = `<div class="txt"><span class="name">${esc(name)}</span><span class="sub">${esc(sub)}</span></div>`;
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = hasSheet ? "Open" : "Create";
  b.addEventListener("click", () => openSheet(OBR, item.id));
  li.appendChild(b);
  return li;
}

function render(OBR, items, selection) {
  const chars = items.filter((i) => i.layer === "CHARACTER" || i.layer === "MOUNT");
  const withSheet = chars.filter((i) => i.metadata && i.metadata[KEY]);
  const without = chars.filter((i) => !(i.metadata && i.metadata[KEY]));
  const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
  withSheet.sort(byName);
  without.sort(byName);

  const ws = $("withSheet");
  ws.innerHTML = "";
  if (!withSheet.length) ws.innerHTML = `<li class="empty">No sheets yet. Open one from a token's right-click menu, or create one below.</li>`;
  for (const item of withSheet) ws.appendChild(row(OBR, item, true));

  const wo = $("withoutSheet");
  wo.innerHTML = "";
  for (const item of without) wo.appendChild(row(OBR, item, false));
  $("otherCount").textContent = String(without.length);
  $("othersBox").hidden = !without.length;

  const sel = $("selected");
  sel.innerHTML = "";
  if (selection && selection.length === 1) {
    const item = items.find((i) => i.id === selection[0]);
    if (item) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "primary";
      b.textContent = `${item.metadata && item.metadata[KEY] ? "Open" : "Create"} sheet for selected: ${item.name || "token"}`;
      b.addEventListener("click", () => openSheet(OBR, item.id));
      sel.appendChild(b);
    }
  }
}

async function main() {
  if (!inOwlbear()) {
    applyTheme(null);
    $("withSheet").innerHTML = `<li class="empty">This page runs inside Owlbear Rodeo. To try the sheet outside Owlbear, open <a href="${esc(extUrl("sheet.html"))}" target="_blank">the preview</a>.</li>`;
    $("othersBox").hidden = true;
    return;
  }
  let OBR;
  try {
    OBR = await loadOBR();
  } catch (_) {
    $("withSheet").innerHTML = `<li class="empty">Could not load the Owlbear Rodeo SDK. Check your internet connection.</li>`;
    return;
  }
  try {
    await whenReady(OBR);
  } catch (_) {
    $("withSheet").innerHTML = `<li class="empty">Owlbear Rodeo didn't answer. Close this panel and open it again.</li>`;
    return;
  }
  try {
    applyTheme(await OBR.theme.getTheme());
    OBR.theme.onChange(applyTheme);
  } catch (_) {
    /* optional */
  }
  const sceneReady = await OBR.scene.isReady();
  if (!sceneReady) $("withSheet").innerHTML = `<li class="empty">Open a scene to see its tokens.</li>`;
  await whenSceneReady(OBR);
  let items = await OBR.scene.items.getItems();
  let selection = await OBR.player.getSelection();
  render(OBR, items, selection);
  OBR.scene.items.onChange((next) => {
    items = next;
    render(OBR, items, selection);
  });
  OBR.player.onChange(async (player) => {
    selection = player.selection;
    render(OBR, items, selection);
  });
  $("foot").textContent = "Sheets are saved on the tokens, so they belong to this scene. To move one, use Export and Import in the sheet's ⋯ menu.";
}

main();
