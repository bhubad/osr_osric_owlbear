# OSRIC Character Sheet for Owlbear Rodeo

An Owlbear Rodeo extension that shows an editable character sheet for a character token. It has the same pages,
fields, colours and layout as the **1st Edition / OSRIC Automated Charactersheet v2.2 by FlacoAlto**
(<https://flacoalto.itch.io/1st-edition-osric-automated-charactersheet>), but no formulas and no dropdowns:
every field is typed in by hand.

Pages: Character Options/Assumptions, Character Sheet, Cleric, Druid, Fighter, Ranger, Paladin, MU, Ill, Thief,
Assassin, Monk, Bard, Hirelings, License, 2-Weapon, Weaponless. The spreadsheet's Instructions, Tables and
OSRIC Tables tabs are left out; the last two only fed the formulas.

## 1. Put the files online

Owlbear Rodeo loads extensions from a web address, so this folder has to be hosted somewhere. All of these are free.

**GitHub Pages (simplest)**
1. Create a GitHub account and a new **public** repository named exactly `<your-username>.github.io`.
2. On the repository page choose **Add file → Upload files** and drag in everything inside this folder
   (`manifest.json`, `index.html`, `sheet.html`, and the `css`, `js`, `fonts`, `layouts` folders, etc.). Commit.
3. In **Settings → Pages**, set *Source* to *Deploy from a branch*, branch `main`, folder `/ (root)`. Save.
4. After a minute or two, open `https://<your-username>.github.io/`. The page shows the install link and checks the setup.

If you use a repository with any other name, the site lives in a sub-folder (`https://<user>.github.io/<repo>/`).
That works too, but `manifest.json` must then point into that folder: open the site's front page and it will show
you the exact `manifest.json` to upload instead.

**Netlify or Cloudflare Pages**: drag this folder onto a new site (Netlify: <https://app.netlify.com/drop>).
The `_headers` file already sends the CORS header Owlbear needs. Vercel uses `vercel.json` for the same thing.

## 2. Add it to Owlbear Rodeo

1. In your Owlbear Rodeo profile click **Add Extension** and paste the install link, e.g.
   `https://<your-username>.github.io/manifest.json`.
2. Turn it on for a room: pick it when creating a room, or open an existing room and add it from the extension menu.

## 3. Use it

- **Right-click a character token → OSRIC Character Sheet.** The sheet opens on the right and stays open while you
  use the map. **◨ Half** makes it half as wide; **✕** or *Esc* closes it.
- The extension's button (top left in the room) lists every sheet in the scene and the tokens that don't have one yet.
- Click a field and type. Coloured cells, white boxes and every former formula or dropdown are plain fields.
  Click any empty spot to write there, as in the spreadsheet.
- A small red corner means the cell has a note from the spreadsheet: hover to read it.
- The **+ / −** buttons on the top and left edges show or hide grouped columns and rows, like in the
  spreadsheet (HP by level, Psionics, the Weaponless result tables).
- **Pages** hides the tabs a character doesn't use (e.g. the other classes). This is saved with the sheet.
- **Zoom**: −/+ or click the percentage to switch between fit-to-width and 100 %.
- **⋯ → Export / Import** saves the sheet as a JSON file or loads one. Use it to back up a sheet or move it to a token
  in another scene or room.
- **⋯ → Import → .xlsx** reads a filled-in copy of the v2.2 spreadsheet (Google Sheets: *File → Download →
  Microsoft Excel*) and puts its values, including formula results, into the same fields.

### Where the data lives

Each sheet is stored in its token's metadata (key `osric-character-sheet/sheet`), so everyone in the room sees the same
sheet and edits appear live for everyone. Tokens belong to a scene, so a sheet is tied to that token in that scene.
If the GM restricts editing of tokens, players can't save changes to tokens they aren't allowed to edit; the sheet
then shows a warning. Each browser also keeps a local backup copy of every sheet it opened.

Opening `sheet.html` directly (outside Owlbear) gives a preview that saves only in that browser.

## Files

| Path | What it is |
| --- | --- |
| `manifest.json` | Extension manifest Owlbear reads |
| `background.html`, `js/background.js` | Adds the token right-click entry |
| `popover.html`, `js/popover.js`, `css/popover.css` | The toolbar list of sheets |
| `sheet.html`, `js/sheet.js`, `css/sheet.css` | The sheet itself |
| `js/common.js` | Shared helpers; loads the Owlbear SDK (`@owlbear-rodeo/sdk` 3.1.0, MIT) from esm.sh or jsDelivr |
| `js/xlsx-import.js` | Reads .xlsx files for the import |
| `layouts/*.json` | Page layouts generated from the template |
| `fonts/` | TeX Gyre Heros Condensed, used when Aptos Narrow isn't installed (GUST Font License) |
| `tools/gen.py` | Regenerates `layouts/` from the template: `python3 tools/gen.py template.xlsx .` (needs openpyxl) |
| `index.html` | Front page with the install link and a setup check |
| `_headers`, `vercel.json`, `.nojekyll` | Hosting settings |

## Credits

The layout, labels and notes come from FlacoAlto's character sheet template. The License tab reproduces that
workbook's notices: OSRIC and Mythmere Games are trademarks of Mythmere Games LLC; this work is not affiliated with or
endorsed by Mythmere Games LLC; material from the SRD 5.1 is used under CC BY 4.0, and OSRIC content under the AELF
Open License 1.0a.
