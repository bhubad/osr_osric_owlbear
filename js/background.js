// Runs invisibly for every player while the extension is enabled: adds the token context-menu entry.
import { MENU_ID, loadOBR, whenReady, extUrl, openSheet } from "./common.js?v=1.0.2";

const OBR = await loadOBR();
await whenReady(OBR, 120000);

await OBR.contextMenu.create({
  id: MENU_ID,
  icons: [
    {
      icon: extUrl("icon.svg"),
      label: "OSRIC Character Sheet",
      filter: {
        max: 1,
        every: [
          { key: "layer", value: "CHARACTER", coordinator: "||" },
          { key: "layer", value: "MOUNT" },
        ],
      },
    },
  ],
  onClick(context) {
    const item = context.items[0];
    if (item) openSheet(OBR, item.id);
  },
});
