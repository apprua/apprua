# Design: "Bicromia"

Visual system of Apprua (chosen on 2026-11-05, replacing "Banchina"): a risograph print. Four inks, the grain of paper, ruled lists instead of cards, round heavy titles, flat naive illustrations at the right moments. Source of truth for the tokens: the `CSS` constant in `packages/server/src/views.ts`.

Why: the calm cobalt "Banchina" was clean but looked like any AI-made interface. We chose the bichrome risograph genre (inspired by it, not copied: our own harbour, lighthouse and figures; a fourth ink, the lamp yellow, makes it ours).

## The four inks

| Ink | Value | Role |
|---|---|---|
| Electric blue | `#2234EE` | Actions (primary buttons), the sea, strong surfaces |
| Bone | `#F1E9DA` | The paper: page background in light; text and shapes on blue or black |
| Black | `#121212` | Ink: text, rules, the night; the ground of the lighthouse before each app |
| Lamp yellow | `#FFC94D` | **Only the light**: the lighthouse lamp and beam, celebrations, the "Just published" badge |

Red is not a brand ink: `--warn` only for errors and destructive actions. Green `--ok` only for "Online".

**Rules (measured, WCAG):** black on bone 15.5; bone on blue 6.2; muted `#55524C` on bone 6.0. Never black text on blue (2.5). Never yellow on bone (1.3): yellow only on blue (4.9) or black (12.4). Status text on bone: green `#17602D` (6.3), red `#B02814` (5.5). In the dark theme buttons keep the same blue (bone on blue 6.2) and blue text becomes `#9AA6FF`; links are ink with an underline.

## Tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg`, `--surface` | `#F1E9DA` | `#0F0F10` | The paper (no raised cards) |
| `--ink` | `#121212` | `#F1E9DA` | Text, outlines |
| `--muted` | `#55524C` | `#B3AC9E` | Secondary text |
| `--rule` | `#121212` | `#4A463F` | 2 px rules and outlines |
| `--line` | `#C9C0AE` | `#3A3833` | Quiet tracks (progress) |
| `--soft` | `#E6DCCA` | `#1C1B1A` | Hover, code blocks |
| `--accent` / `--accent-ink` | `#2234EE` / `#F1E9DA` | same | Primary actions |
| `--accent-text` | `#2234EE` | `#9AA6FF` | Blue used as text |
| `--light` | `#FFC94D` | `#FFC94D` | The lamp |
| `--ok` / `--warn` | `#17602D` / `#B02814` | `#7FD39A` / `#FF7A62` | Online / errors |

**Grain:** a fractal-noise SVG over the whole page (`body::after`, multiply at 10% in light, screen at 5% in dark). Off with `prefers-contrast: more`.

## Typography

- **Lilita One** (OFL, `assets/fonts/lilita-one-*.woff2`): round, heavy, cheerful. **Only** for h1, h2, the name "Apprua", the account initial and the celebration title. Never for labels, buttons or small text.
- **Atkinson Hyperlegible Next** (variable, OFL) for everything else: body, labels, buttons (700).
- System monospace only for addresses, keys and logs.
- h1 2.7rem, h2 1.55rem (Lilita, line-height 1); body 16px. No uppercase labels.

## Components (bichrome)

- **Buttons:** primary = solid blue, bone text. Secondary = transparent with a 2 px ink outline. Quiet = text only. Danger = red outline.
- **Lists:** the app list is a stack of 2 px black rules, no box, no rounded card. Other surfaces (checklist, forms, notices) have a 2 px ink outline and 14 px radius, no shadow, no glass.
- **Inputs, menus, command bar:** 2 px ink outline on the paper; the open command bar dims the page.
- **An app is just its name** (chosen on 2026-11-05, after trying coloured tiles, initials, the apps' own icons, a big lighthouse and signal flags): nothing before the name. The state is the tiny lighthouse printed on black before the state word, its light is the state. One symbol for the whole product; the name tells the apps apart. Apprua does not collect the apps' own icons.
- **Focus:** 3 px ink outline, offset 3 px.
- **No tints:** hover and highlighted rows use `--soft`; a chosen option has a blue outline; text selection is blue ink with bone text. Badges are black, except the yellow "Just published" (yellow is only light).

## Illustrations (only at moments)

**Everything is drawn once, as vectors, in the brand kit** (kept in its own repository; the scenes the portal uses are in `packages/server/assets/img`): every scene is composed from the same pieces, so the lighthouse, the boat and the people are identical everywhere (portal, website, social posts). Do not ask an image AI to draw a scene: it redraws every piece a little differently each time. An image AI may only make a new character sheet, which is then traced once and reused. A test checks that every scene uses the logo's "A" and only our inks.

| Piece | How it is drawn (one shape, never redrawn) |
|---|---|
| Lighthouse `lighthouse()` | Always the mark: the Lilita One `A` as tower (bone), a band on its flat top (black on blue, blue on black), a rounded square lamp. Never a roof, railing, windows or lantern panes |
| Light | Lamp and beam in lamp yellow; the beam is a flat wedge that fades; `rays` = short joy rays; off = grey lamp (`#6E6A62`, black at half strength), no beam |
| People `piece('persona-...')` | Drawn once on a character sheet and traced into vectors: bone, big round head, soft body, rounded hands and feet, two black dot eyes, no mouth, thin gaps where an arm crosses the body. Poses: in piedi, cammina, porta (a box over the head), esulta, ripara (kneeling with a wrench at a box), seduta. Never redrawn: a new pose means a new sheet in the same style, traced the same way |
| The app `piece('scatola')` | A bone box with a black tape cross; `joy()` adds the yellow joy rays |
| Boat `piece('barca')` | One boat only: bone hull with a black bottom, a cabin with two black windows, a short mast; always on blue or black water; may carry the box |
| Sea, rock, quay | Blue or black water with short bone wave strokes; the lighthouse always stands on a black rock in the water (or on a quay), never on a hump of the sea colour; quays as flat blue, black or bone shapes; black bollards |
| Sky | Black night with bone dots and a crescent moon, or flat blue |
| Print | One risograph filter on the whole scene: rare paper specks and slightly rough edges |

Only the four inks; yellow only for light and for the joy rays.

| Moment | Illustration |
|---|---|
| Sign in and first-run setup | `porto-notte.svg`: the lighthouse lights up the harbour at night (left half of the page, the form on the right) |
| No apps yet | `barca.svg`: the boat carries a box towards the lighthouse |
| First app online (celebration) | `prima-app.svg`: people carry the glowing box onto the quay |
| An app needs a fix | `da-sistemare.svg`: one person fixes the box under the lighthouse |
| Apprua not answering | `riposo.svg`: the lighthouse with its light off, the moon |
The everyday list stays clean: no illustration there.

## Mark (chosen on 2026-11-05)

A **lighthouse drawn as the letter A**, and the A is the one of **Lilita One**, our display font: the same letter as the titles and the wordmark, so logo, type and illustrations are one family (`TOWER_A` in `views.ts`). The tower is the A, a black band sits on its flat top, the lamp on the band. No characters or mascots in the UI; figures appear only inside illustrations.

Brand files in `brand/`: `logo.svg` and the wordmark `APPRUA` set in Lilita One with the lighthouse as first A (`wordmark-on-blue.svg`, `wordmark-on-black.svg`). The wordmark lives only on blue or black (its yellow lamp is never printed on bone). On bone paper use the logo tile next to the name. On large brand surfaces the mark may carry the paper grain; in the UI and in icons it stays flat.

- **One shape for every size**, from 16 px to the website: tower (the Lilita A), band, lamp.
- **The four inks, fixed in both themes**: blue tile `#2234EE`, bone tower `#F1E9DA`, black band `#121212`, lamp `#FFC94D`. The mark never inverts.
- **The beam** appears only in illustrations, animations and the state lighthouse while publishing, never in the logo, icons or the favicon.
- **The light tells the state:** a tiny lighthouse printed on black before the state of each app (15 px in the list and tables, 17 px in the command bar): lamp yellow = online or publishing (the beam sweeps), grey = paused, red pulsing = needs a fix. Windows icons: `apprua.ico` (on), `apprua-starting.ico` (light still off), `apprua-off.ico` (all grey), built by `install/windows/icons/make-icons.ps1`, which also makes the Claude Desktop extension icon (`packages/mcp/icon.png`).

## Brand surfaces (website, social)

The same four inks at full page: big Lilita titles on solid black or blue, illustrations as posters, the "APPRUA" wordmark in Lilita One with the lighthouse as A (`brand/`). Text never sits on the busy part of an illustration: only on flat ink (for example the banner splits text on black and picture on the right).
## Layout & components

- **First-run setup** (two steps, centered column): step 1 "Who is this Apprua for?" with two large choice rows ("Just for me" / "For a group of people"), the one that fits the install marked "Suggested here" (localhost: just me; a domain: a group). Step 2 creates the first account; for a group it becomes "Create the administrator account" and adds a "Rules for the group" fieldset (apps per person, periodic review). Choosing a group on localhost shows a plain notice that a group needs a server. When the installer set a one-time setup code, step 2 asks for it first.
- **Minimal home (audit of 2026-11-05).** The home page shows only what is needed to see the apps, open them and notice a problem. Everything else is one click away. Removed or moved, on purpose: the "On" dot when all is well, the publication history bars and version count, "updated ... ago", the on/paused switch, the visible command bar, the app count, the "All calm" sentence, the row of header buttons, the administration section.
- **Top bar**: the lighthouse mark + "Apprua" on the left; on the right **one account menu** (avatar initial + name + chevron): Search and commands (Ctrl K), Settings (administrators), language, light/dark, sign out. Sign-in and setup pages keep plain language and theme buttons.
- **Status dot** next to the name: **hidden when all is well**. `--warn` "Motore fermo" (plus an error notice) when the engine does not answer. If the portal stops answering while the page is open (checked every 30 s, and when the tab comes back into view), the dot appears as "Non risponde" with an error notice on how to turn Apprua on; the page reloads by itself when it is back.
- **Greeting** (h1). Under it a sentence **only when something is worth a look** (an app whose last publication did not go through, with a link to its diary); before the first app, one line on where the apps live.
- **Command bar** (idea from direction "F · Comando"): **not on the page**. Ctrl K / ⌘K, "/" or "Search and commands" in the account menu bring it up as a floating panel over a dimmed page. Empty: suggests opening each app (or turning it back on), connecting an AI app, a new key. Typing filters every app action and portal action by word prefix, accent-insensitive, Italian and English keywords. ↑↓ to choose, Enter to run, Esc to clear, then to close. Risky actions ask for confirmation. Accessible combobox (`role="combobox"` + `listbox`, `aria-activedescendant`).
- **Checklist "Ready in three steps"**: round check circles, progress bar, the current step expanded with its action. Hidden when all steps are done; a small "Connect another AI app" disclosure remains under the list.
- **App list**: one bordered surface, rows divided by 1px lines. Row = name, description, address · the state (tiny lighthouse + word) · **one button** (Open; "Turn back on" when paused; "Open the diary" when it needs a fix) · "⋯" menu (`<details>`) with pause (no "are you sure?": the notice offers **Undo**), restart, what's happening, publishing diary, still needed, archive (red, last). A row published in the last two minutes shows "Just published".
- **Needs a fix** state: an app whose last publication did not go through shows a red "Needs a fix" and "Open the diary" instead of "Open".
- **Administration** (every app of every person, people, add a person) lives on the **Settings** page, under the resources, rules and "who it is for".- **Empty state** teaches the one sentence to say to the AI.
- **Notices**: tinted surface + icon, full border (never a side stripe).
- Radius: 10px controls, 16px surfaces. Shadows only on the open menu.
- Icons: Lucide (ISC) inline SVG, 18px, stroke 2.

## Motion

150-220ms ease-out (`cubic-bezier(.22,1,.36,1)`) on hover, focus, menu open and progress. One moment: a row published in the last two minutes gets a soft lamp-yellow tint and the yellow "Just published" badge. The beam of the lighthouse sweeps while an app is publishing; on the website the beam may sweep across the night scene. Everything collapses to instant with `prefers-reduced-motion`.
