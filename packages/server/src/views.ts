// Portal pages: server-rendered HTML, no build step, no external resources (works offline and on localhost).
// Visual system "Bicromia" (see DESIGN.md): a risograph print in four inks, one symbol (the lighthouse "A").
import { appMiddleware, appUrl, autoAppMemory, config } from './config.js';
import type { App, User } from './db.js';
import { t, type Lang } from './i18n.js';
import { memoryMb, type Resources } from './resources.js';
import { lockedRules, MEMORY_CHOICES } from './setup.js';
import { connectorConfig, VERSION } from './downloads.js';
import { COOLIFY_TESTED } from './version.js';
import { isDown, outOfMemory } from './monitor.js';
import type { CertInfo, CheckLine } from './network.js';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const day = (s: string | null) => (s ? s.slice(0, 10) : '');

/** Dates come from SQLite ("YYYY-MM-DD HH:MM:SS", UTC) or ISO strings. */
const parseDate = (s: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);

/** Colours, fonts and paper grain of the Bicromia system (also used by the signpost page of apps that are not on). */
export const TOKENS = `/* Bicromia (2026-11-05): four inks like a risograph print. Blue = actions, bone = the paper, black = ink and night,
   lamp yellow = only the light (lighthouse, celebrations; never on the bone paper). Red only for errors. See DESIGN.md. */
:root{--bg:#F1E9DA;--surface:#F1E9DA;--ink:#121212;--muted:#55524C;--line:#C9C0AE;--soft:#E6DCCA;--rule:#121212;--accent:#2234EE;--accent-ink:#F1E9DA;--accent-text:#2234EE;--accent-soft:#DADCF2;--ok:#17602D;--light:#FFC94D;--warn:#B02814;--shadow:rgb(18 18 18 / .2);
--ease:cubic-bezier(.22,1,.36,1);--ui:"Atkinson Next","Segoe UI",system-ui,-apple-system,sans-serif;--display:"Lilita One","Atkinson Next",system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,Consolas,Menlo,monospace;
--grain:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .6 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0F0F10;--surface:#0F0F10;--ink:#F1E9DA;--muted:#B3AC9E;--line:#3A3833;--soft:#1C1B1A;--rule:#4A463F;--accent:#2234EE;--accent-ink:#F1E9DA;--accent-text:#9AA6FF;--accent-soft:#1D2468;--ok:#7FD39A;--light:#FFC94D;--warn:#FF7A62;--shadow:rgb(0 0 0 / .5);color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0F0F10;--surface:#0F0F10;--ink:#F1E9DA;--muted:#B3AC9E;--line:#3A3833;--soft:#1C1B1A;--rule:#4A463F;--accent:#2234EE;--accent-ink:#F1E9DA;--accent-text:#9AA6FF;--accent-soft:#1D2468;--ok:#7FD39A;--light:#FFC94D;--warn:#FF7A62;--shadow:rgb(0 0 0 / .5);color-scheme:dark}
`;

const CSS = `
@font-face{font-family:"Atkinson Next";src:url(/assets/fonts/atkinson-next-latin.woff2) format("woff2");font-weight:200 800;font-style:normal;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Atkinson Next";src:url(/assets/fonts/atkinson-next-latin-ext.woff2) format("woff2");font-weight:200 800;font-style:normal;font-display:swap;unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
${TOKENS}*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.55 var(--ui);min-height:100vh;display:flex;flex-direction:column}
::selection{background:var(--accent-soft);color:var(--ink)}
.wrap{width:100%;max-width:800px;margin:0 auto;padding-inline:20px}
a{color:var(--accent-text);text-underline-offset:3px}
svg.i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
h1,h2,h3{margin:0;line-height:1.2;text-wrap:balance}
h1{font-size:1.75rem;font-weight:700;letter-spacing:-.01em}
h2{font-size:1.1rem;font-weight:700}
h3{font-size:1rem;font-weight:700}
p{margin:0}
.muted{color:var(--muted)}
.mono{font-family:var(--mono);font-size:.82rem}
/* top bar */
header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-block:18px}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-weight:700;font-size:1.05rem}
.brand svg{width:28px;height:28px;flex:none}
.bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
details.menu.acct summary{width:auto;height:38px;padding:0 8px 0 4px;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.9rem}
details.menu.acct summary > svg{transform:rotate(90deg);width:15px;height:15px}
details.menu.acct[open] summary > svg{transform:rotate(-90deg)}
.pop .item kbd{margin-left:auto;font:600 .72rem/1 var(--mono);color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:3px 5px}
.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-text);font-weight:700;font-size:.9rem}
/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;font:600 .92rem/1 var(--ui);padding:9px 14px;min-height:38px;border-radius:10px;border:1px solid transparent;background:var(--accent-soft);color:var(--accent-text);cursor:pointer;text-decoration:none;white-space:nowrap;transition:background-color .18s var(--ease),border-color .18s var(--ease),filter .18s var(--ease)}
.btn:hover{filter:brightness(.97)}
.btn.primary{background:var(--accent);color:var(--accent-ink)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.quiet{background:transparent;color:var(--muted);border-color:var(--line)}
.btn.quiet:hover{color:var(--ink);border-color:var(--muted)}
.btn.icon{padding:0;width:38px;justify-content:center}
.btn.small{font-size:.84rem;padding:6px 10px;min-height:32px;border-radius:8px}
.btn.danger{background:transparent;color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,var(--line))}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
form.inline{display:inline}
/* page blocks */
main{flex:1}
.hello{display:grid;gap:6px;padding-block:18px 26px}
.stack{display:grid;grid-template-columns:minmax(0,1fr);gap:28px;padding-bottom:40px}
.stack > *{min-width:0}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px}
.head .muted{font-size:.88rem}
.surface{background:var(--surface);border:1px solid var(--line);border-radius:16px}
/* checklist */
.check{padding:18px 20px;display:grid;gap:14px}
.check .head{margin:0}
.progress{height:6px;border-radius:99px;background:var(--line);overflow:hidden}
.progress span{display:block;width:100%;height:100%;background:var(--accent);border-radius:99px;transform-origin:left center;transition:transform .4s var(--ease)}
.task{display:grid;grid-template-columns:24px minmax(0,1fr);gap:4px 12px;align-items:start}
.tick{width:24px;height:24px;border-radius:50%;border:2px solid var(--line);display:grid;place-items:center;color:var(--accent-ink);margin-top:-1px}
.tick svg{width:14px;height:14px;stroke-width:3}
.task.done .tick{background:var(--accent);border-color:var(--accent-text)}
.task.done .title{color:var(--muted)}
.task.now .tick{border-color:var(--accent-text)}
.task .title{font-weight:600}
.task .body{grid-column:2;display:grid;gap:10px;color:var(--muted);font-size:.94rem;padding-top:2px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.say{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chip{display:inline-block;background:var(--accent-soft);color:var(--accent-text);padding:6px 12px;border-radius:99px;font-weight:600;font-size:.92rem}
/* snippets */
.snip{display:flex;gap:8px;align-items:flex-start;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:10px 10px 10px 12px;min-width:0}
.snip span{flex:1;min-width:0;font-family:var(--mono);font-size:.8rem;white-space:pre-wrap;word-break:break-all;color:var(--ink)}
.copy{flex:none;font:600 .78rem/1 var(--ui);padding:6px 9px;border-radius:7px;border:1px solid var(--line);background:var(--surface);color:var(--muted);cursor:pointer}
.copy:hover{color:var(--ink)}
details.more summary{cursor:pointer;color:var(--accent-text);font-weight:600;font-size:.92rem;list-style:none;display:inline-flex;align-items:center;gap:6px}
details.more summary::-webkit-details-marker{display:none}
details.more summary svg{transition:transform .18s var(--ease)}
details.more[open] > summary svg{transform:rotate(90deg)}
details.more > div{display:grid;gap:10px;margin-top:12px}
/* app list */
ul.apps{list-style:none;margin:0;padding:0}
ul.apps li{display:flex;align-items:center;gap:14px;padding:14px 16px;position:relative;transition:background-color .6s var(--ease)}
ul.apps li+li{border-top:1px solid var(--line)}
ul.apps li.fresh{background:color-mix(in srgb,var(--accent-soft) 60%,transparent)}
ul.apps li:first-child{border-radius:16px 16px 0 0}
ul.apps li:last-child{border-radius:0 0 16px 16px}
ul.apps li:only-child{border-radius:16px}
/* an app is just its name (no tiles, initials, icons or flags); the tiny lighthouse before its state tells the state with its light */
.beacon{display:inline-grid;flex:none;line-height:0}
.meta{flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,1fr);gap:1px}
.meta b{font-size:1rem;overflow-wrap:anywhere}
.meta .desc{color:var(--muted);font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta .line{display:flex;gap:6px 12px;flex-wrap:wrap;align-items:center;color:var(--muted);font-size:.82rem}
.meta .line a{color:var(--muted);font-family:var(--mono);font-size:.8rem;text-decoration:none;overflow-wrap:anywhere}
.meta .line a:hover{color:var(--accent-text);text-decoration:underline}
.badge{font-size:.78rem;font-weight:700;color:var(--accent-text);background:var(--accent-soft);padding:2px 8px;border-radius:99px}
.state{display:inline-flex;align-items:center;gap:6px;font-size:.84rem;color:var(--muted);white-space:nowrap}
.state.active{color:var(--ok)}
.state.failed,.state.down{color:var(--warn)}
/* the lighthouse: its light tells the state */
.lamp{width:15px;height:15px;flex:none;overflow:visible}
.lamp .bm{opacity:0}
.state.publishing{color:var(--ink)}
.beacon.publishing .lamp .bm{opacity:.7;transform-box:view-box;transform-origin:75px 17px;animation:beamk 2.4s var(--ease) infinite}
.beacon.failed .lamp .lt,.beacon.down .lamp .lt{animation:pulsek 1.6s ease-in-out infinite}
@keyframes pulsek{0%,100%{opacity:1}50%{opacity:.35}}
.actions{display:flex;align-items:center;gap:4px;flex:none}
/* "more" menu */
details.menu{position:relative}
details.menu summary{list-style:none;width:36px;height:36px;border-radius:9px;display:grid;place-items:center;color:var(--muted);cursor:pointer}
details.menu summary::-webkit-details-marker{display:none}
details.menu summary:hover,details.menu[open] summary{background:var(--soft);color:var(--ink)}
.pop{position:absolute;right:0;top:calc(100% + 6px);z-index:20;min-width:236px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:6px;box-shadow:0 14px 34px -12px var(--shadow);display:grid;gap:2px;transform-origin:top right;animation:pop .16s var(--ease)}
@keyframes pop{from{opacity:0;transform:scale(.96) translateY(-4px)}}
.pop form{display:block}
.pop .item{width:100%;display:flex;align-items:center;gap:10px;padding:9px 10px;border:0;border-radius:8px;background:transparent;color:var(--ink);font:500 .92rem/1.2 var(--ui);text-align:left;text-decoration:none;cursor:pointer}
.pop .item:hover,.pop .item:focus-visible{background:var(--soft)}
.pop .item svg{color:var(--muted)}
.pop .item.danger,.pop .item.danger svg{color:var(--warn)}
.pop hr{border:0;border-top:1px solid var(--line);margin:4px 2px}
/* summary sentence under the greeting */
.summary{display:flex;align-items:flex-start;gap:8px;color:var(--muted)}
.summary svg{margin-top:3px}
.summary.ok svg{color:var(--ok)}
.summary.warn{color:var(--ink)}
.summary.warn svg{color:var(--warn)}
/* command bar: one line to reach every app and action */
.cmd{position:fixed;z-index:40;left:50%;top:14vh;width:min(640px,calc(100vw - 32px));transform:translateX(-50%);display:none;border-radius:16px;box-shadow:0 0 0 100vmax rgb(18 18 18 / .35)}
.cmd.show{display:block;animation:pop .16s var(--ease)}
.cmd .field{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:0 12px 0 14px;min-height:52px;cursor:text;transition:border-color .18s var(--ease),box-shadow .18s var(--ease)}
.cmd .field:hover{border-color:var(--muted)}
.cmd .field:focus-within{border-color:var(--accent-text);box-shadow:0 0 0 3px var(--accent-soft)}
.cmd .field > svg{color:var(--muted)}
.cmd input{flex:1;min-width:0;border:0;background:transparent;color:var(--ink);font:inherit;font-size:1rem;padding:14px 0;outline:none}
.cmd input::placeholder{color:var(--muted)}
.cmd .field input,.cmd .field input:hover{border:0;border-radius:0;background:transparent;padding:14px 0}
.cmd .field input:focus-visible{outline:none}
.cmd [hidden]{display:none!important}
.cmd kbd{font:600 .74rem/1 var(--mono);color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:4px 6px;white-space:nowrap;background:var(--surface)}
.cmd .drop{position:absolute;left:0;right:0;top:calc(100% + 8px);background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 40px -16px var(--shadow);padding:6px;display:none}
.cmd.open .drop{display:block;animation:pop .16s var(--ease)}
.cmd ul{list-style:none;margin:0;padding:0;max-height:min(400px,55vh);overflow:auto}
.cmd .grp{padding:8px 10px 4px;color:var(--muted);font-size:.8rem;font-weight:600}
.cmd .opt{display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:9px;cursor:pointer;min-width:0}
.cmd .opt.on{background:var(--accent-soft)}
.cmd .opt .beacon{width:26px;height:26px;place-items:center}
.cmd .opt .beacon .lamp{width:17px;height:17px}
.cmd .opt .ico{width:26px;height:26px;border-radius:8px;background:var(--soft);display:grid;place-items:center;color:var(--muted);flex:none}
.cmd .opt .ico svg{width:15px;height:15px}
.cmd .opt .lbl{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.cmd .opt .hint{color:var(--muted);font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.cmd .opt .enter{margin-left:auto;visibility:hidden}
.cmd .opt.on .enter{visibility:visible;color:var(--accent-text);border-color:var(--accent-text)}
.cmd .opt.danger .lbl{color:var(--warn)}
.cmd .none{padding:12px 10px;color:var(--muted)}
.cmd .keys{display:flex;gap:16px;flex-wrap:wrap;padding:8px 10px 4px;border-top:1px solid var(--line);margin-top:4px;color:var(--muted);font-size:.78rem}
.cmd .keys kbd{margin-right:5px;padding:2px 5px}
/* empty state */
.empty{padding:28px 24px;display:grid;gap:12px;justify-items:start}
.notice.celebrate{align-items:center;gap:18px;padding:18px 20px;border-color:color-mix(in srgb,var(--accent) 35%,var(--line));background:color-mix(in srgb,var(--accent-soft) 55%,var(--surface))}
.celebrate h3{font-size:1.1rem}
@keyframes beamk{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(12deg)}}
.empty .ghost{display:flex;gap:12px;align-items:center;width:100%;max-width:420px;padding:10px 12px;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}
.empty .ghost i{width:34px;height:34px;border-radius:10px;background:var(--soft);flex:none}
.empty .ghost span{height:10px;border-radius:5px;background:var(--soft);flex:1}
/* notices */
.notice{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:14px;border:1px solid color-mix(in srgb,var(--ok) 35%,var(--line));background:color-mix(in srgb,var(--ok) 7%,var(--surface));margin-bottom:22px}
.notice > svg{color:var(--ok);margin-top:2px}
.notice.err{border-color:color-mix(in srgb,var(--warn) 40%,var(--line));background:color-mix(in srgb,var(--warn) 7%,var(--surface))}
.notice.err > svg{color:var(--warn)}
.notice.plain{border-color:var(--line);background:var(--surface)}
.notice.plain > svg{color:var(--muted)}
.notice .grow{flex:1;min-width:0;display:grid;gap:10px}
pre.logs{margin:0;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:12px;font:.8rem/1.5 var(--mono);max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-all}
/* forms */
.form{display:grid;gap:14px}
.form label{display:grid;gap:6px;font-weight:600;font-size:.92rem}
.form .check-row{display:flex;gap:8px;align-items:center;font-weight:400}
input[type=email],input[type=password],input[type=text]{font:inherit;font-size:1rem;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);width:100%;transition:border-color .18s var(--ease)}
input:hover{border-color:var(--muted)}
input:focus-visible{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent-text)}
/* sign in / setup */
.center{flex:1;display:grid;place-items:center;padding:24px 20px 48px}
.gate{width:100%;max-width:420px;display:grid;gap:20px}
.gate .brand{justify-content:center;font-size:1.2rem}
.gate .brand svg{width:34px;height:34px}
.gate .surface{padding:26px;display:grid;gap:18px}
.gate .lead{color:var(--muted)}
.gate .steplabel{display:block;color:var(--muted);font-size:.84rem;margin-bottom:6px}
.choices{display:grid;gap:10px}
.choice{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:12px;align-items:center;padding:14px;border:1px solid var(--line);border-radius:14px;color:var(--ink);text-decoration:none;transition:border-color .18s var(--ease),background-color .18s var(--ease)}
.choice:hover{border-color:var(--accent-text);background:color-mix(in srgb,var(--accent-soft) 45%,transparent)}
.choice.suggested{border-color:color-mix(in srgb,var(--accent) 55%,var(--line))}
.choice .ico{width:40px;height:40px;border-radius:12px;background:var(--accent-soft);color:var(--accent-text);display:grid;place-items:center}
.choice .txt{display:grid;gap:3px}
.choice .txt b{font-size:1rem}
.choice .txt span:last-child{color:var(--muted);font-size:.9rem}
.choice .badge{justify-self:start}
.choice > svg:last-child{color:var(--muted)}
.gate fieldset{border:1px solid var(--line);border-radius:12px;padding:12px 14px 14px;margin:0;display:grid;gap:12px}
.gate legend{font-weight:700;padding:0 6px}
.form .hint{font-weight:400;color:var(--muted);font-size:.84rem}
.gate .back{color:var(--muted);font-size:.9rem;justify-self:start}
select{font:inherit;font-size:1rem;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);width:100%}
input[type=number]{font:inherit;font-size:1rem;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);width:100%}
.gate .surface > div:first-child{display:grid;gap:6px}
/* admin */
.tbl{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-weight:600;color:var(--muted);font-size:.84rem}
tr:last-child td{border-bottom:0}
.admin .surface + h3{margin-top:22px}
.admin h3{margin-bottom:10px}
.admin .add{padding:18px 20px;margin-top:16px;display:grid;gap:12px;max-width:480px}
footer{padding-block:24px 36px;color:var(--muted);font-size:.84rem}
footer .ver{margin-left:6px;font-family:ui-monospace,Consolas,monospace;white-space:nowrap}
.quiet-link{color:var(--ink);font-weight:600;text-underline-offset:3px}
.selfhelp{display:grid;gap:8px;border-top:2px solid var(--rule);padding-top:14px}
.selfhelp h3{margin:0}
/* status dot next to the name, and the notice when the portal stops answering */
.brandwrap{display:flex;align-items:center;gap:12px;min-width:0}
.live{display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 8px;border-radius:99px;font-size:.8rem;font-weight:600;color:var(--ok);background:color-mix(in srgb,var(--ok) 11%,transparent);white-space:nowrap}
.live i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 22%,transparent)}
.live.bad{color:var(--warn);background:color-mix(in srgb,var(--warn) 11%,transparent)}
.notice[hidden],.live[hidden]{display:none}
/* connect your AI app: one tab per app (radio buttons, works without JavaScript) */
.conn{border:0;padding:0;margin:0;min-width:0;display:flex;flex-wrap:wrap;gap:6px}
.conn legend{float:left;width:100%;padding:0;margin-bottom:4px;font-weight:600;color:var(--ink);font-size:.92rem}
.conn > input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.conn > label{padding:7px 12px;border-radius:99px;border:1px solid var(--line);background:var(--surface);color:var(--muted);font:600 .86rem/1.1 var(--ui);cursor:pointer;transition:background-color .18s var(--ease),border-color .18s var(--ease),color .18s var(--ease)}
.conn > label:hover{color:var(--ink);border-color:var(--muted)}
.conn > input:checked + label{background:var(--accent);border-color:var(--accent-text);color:var(--accent-ink)}
.conn > input:focus-visible + label{outline:2px solid var(--accent);outline-offset:2px}
.conn .tp{display:none;flex-basis:100%;gap:10px;margin-top:8px;color:var(--muted);font-size:.94rem}
.conn .tp > p:not(.hint):not(.muted){color:var(--ink)}
.conn input[value=claude]:checked ~ .tp-claude,.conn input[value=code]:checked ~ .tp-code,.conn input[value=codex]:checked ~ .tp-codex,.conn input[value=cursor]:checked ~ .tp-cursor,
.conn input[value=vscode]:checked ~ .tp-vscode,.conn input[value=other]:checked ~ .tp-other{display:grid}
.conn .os-win,.conn .os-other{display:grid;gap:6px}
.os-is-win .conn .os-other,.os-is-other .conn .os-win{display:none}
.conn .hint{font-size:.84rem}
/* settings */
.back-link{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:.92rem;text-decoration:none}
.back-link svg{transform:rotate(180deg)}
.back-link:hover{color:var(--accent-text)}
.set{padding:20px;display:grid;gap:18px}
.res{display:grid;gap:8px}
.res .res-h{display:flex;justify-content:space-between;align-items:baseline;gap:6px 12px;flex-wrap:wrap}
.progress.high span{background:var(--warn)}
.fit{display:grid;gap:6px;padding:14px 16px;border-radius:12px;background:var(--soft)}
.fit b{font-size:1.02rem}
.fit p{color:var(--muted);font-size:.92rem}
ol.steps{margin:0;padding-left:20px;display:grid;gap:10px;color:var(--muted)}
ol.steps li{padding-left:4px}
label.choice{cursor:pointer;font-weight:400}
.form label.choice{display:grid;gap:12px;font-size:1rem}
label.choice input[type=radio]{width:20px;height:20px;margin:0;accent-color:var(--accent-text)}
label.choice:has(input:checked){border-color:var(--accent-text);background:color-mix(in srgb,var(--accent-soft) 45%,transparent)}
.set select:disabled,.set input:disabled{opacity:.6;cursor:not-allowed}
/* ===== Bicromia layer (2026-11-05): display titles, paper grain, ink outlines, ruled lists, illustrations ===== */
@font-face{font-family:"Lilita One";src:url(/assets/fonts/lilita-one-latin.woff2) format("woff2");font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+20AC}
@font-face{font-family:"Lilita One";src:url(/assets/fonts/lilita-one-latin-ext.woff2) format("woff2");font-display:swap;unicode-range:U+0100-024F,U+1E00-1EFF}
h1,h2{font-family:var(--display);font-weight:400;letter-spacing:.005em;line-height:1}
h1{font-size:2.7rem}
h2{font-size:1.55rem}
.brand{font-family:var(--display);font-weight:400;font-size:1.5rem}
.brand svg{width:32px;height:32px}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:60;background:var(--grain);opacity:.1;mix-blend-mode:multiply}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) body::after{mix-blend-mode:screen;opacity:.05}}
:root[data-theme="dark"] body::after{mix-blend-mode:screen;opacity:.05}
@media (prefers-contrast:more){body::after{display:none}}
a{color:var(--ink);text-decoration-thickness:2px}
.btn{background:transparent;color:var(--ink);border:2px solid var(--ink);font-weight:700}
.btn:hover{background:var(--soft);filter:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.primary:hover{background:var(--accent);filter:brightness(1.12)}
.btn.quiet{border-color:transparent;color:var(--muted)}
.btn.quiet:hover{color:var(--ink);border-color:var(--ink)}
.btn.danger{border-color:var(--warn);color:var(--warn)}
:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
.surface{border:2px solid var(--rule);border-radius:14px}
ul.apps.surface{border:0;border-top:2px solid var(--rule);border-radius:0;background:transparent}
ul.apps li{padding:16px 2px;border-bottom:2px solid var(--rule)}
ul.apps li+li{border-top:0}
ul.apps li:first-child,ul.apps li:last-child,ul.apps li:only-child{border-radius:0}
ul.apps li.fresh{background:color-mix(in srgb,var(--light) 20%,transparent)}
.badge{background:var(--light);color:#121212}
.badge.warn{background:transparent;color:var(--warn);border:1.5px solid var(--warn);text-decoration:none}
.chip{background:var(--accent);color:var(--accent-ink)}
.avatar{background:var(--ink);color:var(--bg);font-family:var(--display);font-weight:400;font-size:1rem}
input[type=email],input[type=password],input[type=text],input[type=number],select{border:2px solid var(--ink);background:transparent}
.pop{border:2px solid var(--rule);box-shadow:none;background:var(--bg)}
.cmd .field{border:2px solid var(--ink);background:var(--bg)}
.cmd .drop{border:2px solid var(--ink);box-shadow:none;background:var(--bg)}
.notice{border:2px solid var(--rule);background:transparent}
.notice.err{border-color:var(--warn);background:transparent}
.progress{background:var(--line)}
.tick{border-color:var(--ink)}
.task.done .tick{background:var(--ink);border-color:var(--ink);color:var(--bg)}
/* no lavender tints (left from "Banchina"): selection in blue ink, highlights on --soft, outlines in ink; yellow badges only for "Just published" */
::selection{background:var(--accent);color:var(--accent-ink)}
.cmd .field:focus-within{border-color:var(--accent);box-shadow:none}
.cmd .opt.on{background:var(--soft)}
.cmd .opt.on .enter{color:var(--ink);border-color:var(--ink)}
.choice{border:2px solid var(--rule)}
.choice:hover{border-color:var(--ink);background:var(--soft)}
.choice.suggested{border-color:var(--ink)}
.choice .ico{background:var(--soft);color:var(--ink)}
.choice .badge{background:var(--ink);color:var(--bg)}
label.choice:has(input:checked){border-color:var(--accent);background:transparent;box-shadow:inset 0 0 0 1px var(--accent)}
.gate fieldset{border:2px solid var(--rule)}
.conn > label{border:2px solid var(--ink);color:var(--ink)}
.conn > input:checked + label{border-color:var(--accent)}
a.name{color:inherit;text-decoration:none}a.name:hover{text-decoration:underline}
details.menu.env-edit>summary{list-style:none;width:auto;height:auto;min-height:34px;display:inline-flex;padding:0 14px;border:2px solid var(--ink);border-radius:999px;color:var(--ink);font-weight:700}details.env-edit>summary::-webkit-details-marker{display:none}
details.env-edit .pop .form{padding:12px;display:grid;gap:10px;min-width:260px}
ul.drift{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.line .vis{display:inline-flex;align-items:center;gap:4px;color:var(--muted)}
.line .vis svg.i{width:14px;height:14px}
.pop .item.label{font-size:.8rem;color:var(--muted);cursor:default;padding-top:4px;padding-bottom:2px}
.pop .item.current{font-weight:700;cursor:default}
.pop .item.current svg.i:last-child{margin-left:auto}
/* the lighthouse of an app: always printed on black; lamp yellow = on, grey = off, red pulsing = needs a fix */
.lamp .bg{fill:#121212}
.lamp .tw{fill:#F1E9DA}
.lamp .lt{fill:#6E6A62}
.beacon.active .lamp .lt,.beacon.publishing .lamp .lt{fill:#FFC94D}
.beacon.failed .lamp .lt,.beacon.down .lamp .lt{fill:#FF6A4D}
.lamp .bm{fill:#FFC94D}
/* illustrations: only at moments */
img.art{display:block;width:100%;height:100%;object-fit:cover}
.empty{grid-template-columns:minmax(0,240px) minmax(0,1fr);align-items:stretch;gap:0;padding:0;overflow:hidden;justify-items:stretch}
.empty .txt{padding:24px;display:grid;gap:12px;justify-items:start;align-content:center}
.notice.celebrate{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);padding:0;gap:0;overflow:hidden;align-items:stretch}
.celebrate .art{width:230px;flex:none}
.celebrate .grow{padding:20px 22px;align-content:center}
.celebrate h3{font-family:var(--display);font-weight:400;font-size:1.8rem;line-height:1}
.celebrate .btn.primary{background:#F1E9DA;border-color:#F1E9DA;color:#2234EE}
.notice.fix{padding:0;gap:0;overflow:hidden;align-items:stretch;border-color:var(--rule)}
.notice.fix .art{width:120px;flex:none}
.notice.fix .grow{padding:14px 18px;align-content:center}
.notice.fix b{color:var(--warn)}
#offline .art{width:110px;flex:none;margin:-14px 0 -14px -16px;border-radius:12px 0 0 12px}
/* sign in and setup: the harbour at night on one side, the form on the other */
main.split{flex:1;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);min-height:100vh}
main.split .pic{background:#0b0b0b url(/assets/img/porto-notte.svg?v=6) 60% center/cover}
main.split .side{display:grid;grid-template-rows:auto 1fr;padding:0 28px}
main.split .gate{align-self:center;justify-self:center;padding:24px 0 48px}
main.split .gate .brand{justify-content:flex-start}
.gate .surface{border:0;padding:0;background:transparent}
.gate h1{font-size:2.6rem}@media (max-width:620px){
  main.split{grid-template-columns:1fr;min-height:0}
  main.split .pic{min-height:220px}
  .empty{grid-template-columns:1fr}
  .empty .art{max-height:220px}
  .notice.celebrate{flex-direction:column}
  .celebrate .art{width:100%;max-height:220px}
  h1{font-size:2.2rem}
  .notice.fix .art{width:90px}
  ul.apps li{flex-wrap:wrap;padding:14px 2px}
  .meta{flex-basis:100%}
  .acct .name{display:none}
  .live .txt{display:none}
  .live{padding:7px}
  .cmd kbd.kbd-k,.cmd .opt .hint,.cmd .keys{display:none}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

/** The tower of the lighthouse: the letter "A" of Lilita One (our display font, OFL), in font units (y up, 1000 upm).
 *  Logo, tiny lamp, Windows icons and the illustrations all use this one shape (see DESIGN.md "Mark"). */
export const TOWER_A = 'M520 -2Q433 -2 426 26L393 155L234 155L205 31Q199 0 109 0Q61 0 38 5.5Q15 11 15 14L192 691Q192 699 329 699Q466 699 466 691L639 13Q639 6 593 2Q547 -2 520 -2ZM259 282L364 282L319 489L313 489Z';

/** The mark: tower (the A), a black band on its flat top, the lamp. Fixed brand colours in both themes.
 *  Same geometry as install/windows/icons/make-icons.ps1. */
const MARK = `<path transform="translate(24.68 108) scale(.108 -.108)" d="${TOWER_A}" fill="#F1E9DA"/><rect x="42.2" y="27.5" width="35.6" height="5" rx="2.5" fill="#121212"/>`;
export const LOGO = `<svg viewBox="0 0 120 120" aria-hidden="true"><rect width="120" height="120" rx="30" fill="#2234EE"/>${MARK}<rect x="46" y="7.5" width="28" height="20" rx="5" fill="#FFC94D"/></svg>`;


/** The lighthouse that stands for an app, printed on black: its light tells the state (CSS colours it by
 *  state: on = yellow, publishing = the beam sweeps, paused = off, needs a fix = red pulsing). */
const LAMP = `<svg class="lamp" viewBox="0 0 120 120" aria-hidden="true"><rect class="bg" width="120" height="120" rx="26"/><path class="bm" d="M75 17 L118 3 L118 31 Z"/><path class="tw" transform="translate(22.4 112) scale(.115 -.115)" d="${TOWER_A}"/><rect class="lt" x="45" y="5" width="30" height="24" rx="6"/></svg>`;

// Icons: Lucide (ISC license, some derived from Feather, MIT; https://lucide.dev), inlined so nothing is loaded from
// outside. Their license texts are in THIRD_PARTY_NOTICES.md.
const ICONS: Record<string, string> = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  restart: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  hammer: '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  memory: '<path d="M6 19v-3"/><path d="M10 19v-3"/><path d="M14 19v-3"/><path d="M18 19v-3"/><path d="M8 11V9"/><path d="M16 11V9"/><path d="M12 11V9"/><path d="M2 15h20"/><path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z"/>',
};
const icon = (name: string) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const SCRIPT = `<script>
(function(){try{var t=localStorage.getItem('apprua-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();
document.documentElement.classList.add(/Win/.test(navigator.platform||navigator.userAgent)?'os-is-win':'os-is-other');
function toggleTheme(){var d=document.documentElement,cur=d.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'),n=cur==='dark'?'light':'dark';d.dataset.theme=n;try{localStorage.setItem('apprua-theme',n);}catch(e){}}
document.addEventListener('click',function(e){
  var b=e.target.closest('[data-copy]');
  if(b){var el=document.getElementById(b.dataset.copy);if(!el)return;var txt=el.innerText.trim(),o=b.textContent;
    var ok=function(){b.textContent=b.dataset.done||'ok';setTimeout(function(){b.textContent=o;},1500);};
    var sel=function(){var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);};
    if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(txt).then(ok,sel);}else{sel();}
    return;}
  document.querySelectorAll('details.menu[open]').forEach(function(d){if(!d.contains(e.target))d.removeAttribute('open');});
});
document.addEventListener('keydown',function(e){if(e.key==='Escape')document.querySelectorAll('details.menu[open]').forEach(function(d){d.removeAttribute('open');d.querySelector('summary').focus();});});
document.addEventListener('DOMContentLoaded',function(){
  var live=document.getElementById('live'),bar=document.getElementById('offline');if(!live||!bar)return;
  var down=false,tm=0;
  function later(ms){clearTimeout(tm);tm=setTimeout(check,ms);}
  function up(){if(down){location.reload();return;}later(30000);}
  function lost(){if(!down){down=true;bar.hidden=false;live.hidden=false;live.className='live bad';live.querySelector('.txt').textContent=live.dataset.down;live.removeAttribute('title');}later(5000);}
  function check(){fetch('/healthz',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('down');}).then(up).catch(lost);}
  later(30000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)later(300);});
});
document.addEventListener('submit',function(e){var f=e.target;if(f.dataset.confirm&&!confirm(f.dataset.confirm))e.preventDefault();if(f.dataset.prompt){var v=prompt(f.dataset.prompt);if(v===null){e.preventDefault();return;}f.querySelector('[name=confirm]').value=v;}});
document.addEventListener('DOMContentLoaded',function(){
  var box=document.getElementById('cmd');if(!box)return;
  var q=box.querySelector('input'),list=box.querySelector('[role=listbox]'),none=box.querySelector('.none');
  var opts=[].slice.call(list.querySelectorAll('[role=option]')),groups=[].slice.call(list.querySelectorAll('.grp')),cur=-1;
  var norm=function(s){return s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');};
  var vis=function(){return opts.filter(function(o){return !o.hidden;});};
  function show(v){box.classList.toggle('open',v);q.setAttribute('aria-expanded',v?'true':'false');}
  function sel(i){var v=vis();opts.forEach(function(o){o.classList.remove('on');o.setAttribute('aria-selected','false');});var o=v[i];cur=o?i:-1;
    if(o){o.classList.add('on');o.setAttribute('aria-selected','true');q.setAttribute('aria-activedescendant',o.id);o.scrollIntoView({block:'nearest'});}else q.removeAttribute('aria-activedescendant');}
  function filter(){var w=norm(q.value).split(/\\s+/).filter(Boolean);
    opts.forEach(function(o){var t=norm(o.textContent+' '+(o.dataset.k||'')).split(/[^a-z0-9]+/);
      o.hidden=w.length?!w.every(function(x){return t.some(function(p){return p.indexOf(x)===0;});}):o.dataset.def!=='1';});
    groups.forEach(function(g){var n=g.nextElementSibling,any=false;while(n&&!n.classList.contains('grp')){if(!n.hidden)any=true;n=n.nextElementSibling;}g.hidden=!any;});
    none.hidden=vis().length>0;sel(0);}
  function run(o){if(!o)return;var d=o.dataset;if(d.confirm&&!confirm(d.confirm))return;conceal();
    if(d.do==='link'){if(d.target==='_blank')window.open(d.href,'_blank','noopener');else location.href=d.href;}
    else if(d.do==='post'){var f=document.createElement('form');f.method='post';f.action=d.href;document.body.appendChild(f);f.submit();}
    else if(d.js==='theme'){toggleTheme();}
    else{var el=document.getElementById(d.js);if(el){if(el.tagName==='DETAILS')el.open=true;el.scrollIntoView({behavior:'smooth',block:'start'});var fc=el.querySelector('summary,input,button');if(fc)fc.focus({preventScroll:true});}}
    q.value='';filter();}
  q.addEventListener('focus',function(){filter();show(true);});
  q.addEventListener('input',function(){filter();show(true);});
  q.addEventListener('keydown',function(e){var v=vis();
    if(e.key==='ArrowDown'){e.preventDefault();show(true);sel(Math.min(cur+1,v.length-1));}
    else if(e.key==='ArrowUp'){e.preventDefault();sel(Math.max(cur-1,0));}
    else if(e.key==='Enter'){e.preventDefault();run(v[cur]);}
    else if(e.key==='Escape'){if(q.value){q.value='';filter();}else{conceal();}}});
  list.addEventListener('mousedown',function(e){var o=e.target.closest('[role=option]');if(o){e.preventDefault();run(o);}});
  list.addEventListener('mousemove',function(e){var o=e.target.closest('[role=option]');if(o&&!o.classList.contains('on'))sel(vis().indexOf(o));});
  box.querySelector('.field').addEventListener('click',function(){q.focus();});
  // The bar is not on the page: Ctrl K, "/" or "Search and commands" in the account menu bring it up
  function reveal(){box.classList.add('show');document.querySelectorAll('details.menu[open]').forEach(function(d){d.removeAttribute('open');});q.focus();q.select();}
  function conceal(){show(false);box.classList.remove('show');q.blur();}
  document.addEventListener('click',function(e){if(e.target.closest('[data-open-cmd]')){e.preventDefault();reveal();return;}if(!box.contains(e.target))conceal();});
  document.addEventListener('keydown',function(e){var tag=(document.activeElement||{}).tagName||'';
    if((e.key==='k'||e.key==='K')&&(e.ctrlKey||e.metaKey)){e.preventDefault();reveal();}
    else if(e.key==='/'&&!/INPUT|TEXTAREA|SELECT/.test(tag)){e.preventDefault();reveal();}});
  if(/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent)){var k=box.querySelector('.kbd-k');if(k)k.textContent='\\u2318K';}
});
</script>`;

function shell(lang: Lang, title: string, inner: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="color-scheme" content="light dark"><link rel="icon" href="/favicon.svg?v=7" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/atkinson-next-latin.woff2" as="font" type="font/woff2" crossorigin><style>${CSS}</style>${SCRIPT}</head>
<body>${inner}</body></html>`;
}

const langLink = (lang: Lang) => {
  const other: Lang = lang === 'it' ? 'en' : 'it';
  return `<a class="btn quiet small" href="?lang=${other}" hreflang="${other}">${esc(t(lang, 'nav.lang'))}</a>`;
};
const themeBtn = (lang: Lang) =>
  `<button class="btn quiet icon" type="button" onclick="toggleTheme()" title="${esc(t(lang, 'nav.theme'))}" aria-label="${esc(t(lang, 'nav.theme'))}">${icon('sun')}</button>`;

const onThisPc = () => config.baseDomain === 'localhost';

/** Status dot next to the name: "On" (portal and engine answer) or "Engine stopped". The page also checks every
 *  30 seconds that the portal still answers: if not, it says so (and how to fix it) and reloads when it is back. */
function liveStatus(lang: Lang, engineOk: boolean): { dot: string; banner: string } {
  // calm by default: the dot shows only when something is wrong (the engine now, the portal later from the page)
  const dot = `<span class="live${engineOk ? '' : ' bad'}" id="live" role="status"${engineOk ? ' hidden' : ''} data-down="${esc(t(lang, 'live.down'))}" title="${esc(t(lang, engineOk ? 'live.on.title' : 'live.engine.title'))}"><i aria-hidden="true"></i><span class="txt">${esc(t(lang, engineOk ? 'live.on' : 'live.engine'))}</span></span>`;
  const banner = `<div class="notice err" id="offline" role="alert" hidden><img class="art" src="/assets/img/riposo.svg?v=6" alt="${esc(t(lang, 'art.rest'))}"><p>${esc(t(lang, onThisPc() ? 'live.offline' : 'live.offline.server'))}</p></div>`;
  return { dot, banner };
}

/** Shown when the portal answers but the engine does not: the apps may not work. */
export const engineNotice = (lang: Lang) => notice(t(lang, onThisPc() ? 'live.engine.text' : 'live.engine.text.server'), true);

export function page(lang: Lang, title: string, body: string, opts: { user?: User; centered?: boolean; engineOk?: boolean; search?: boolean } = {}): string {
  if (opts.centered) {
    // sign in and setup: the harbour at night (illustration) beside the form
    return shell(lang, title, `<main class="split"><div class="pic" role="img" aria-label="${esc(t(lang, 'art.harbour'))}"></div>
<div class="side"><header class="top"><span></span><div class="bar">${langLink(lang)}${themeBtn(lang)}</div></header>
<div class="gate"><a class="brand" href="/">${LOGO}<span>${esc(config.brand)}</span></a>${body}</div></div></main>`);
  }
  const u = opts.user;
  const name = u ? (u.name ?? u.email.split('@')[0]) : '';
  // One account menu instead of a row of buttons: search, settings, language, theme, sign out
  const other: Lang = lang === 'it' ? 'en' : 'it';
  const items = u ? [
    opts.search ? `<button class="item" type="button" data-open-cmd>${icon('search')}${esc(t(lang, 'nav.search'))}<kbd class="kbd-k">Ctrl K</kbd></button>` : '',
    `<a class="item" href="/account">${icon('user')}${esc(t(lang, 'nav.myaccount'))}</a>`,
    u.role === 'admin' ? `<a class="item" href="/settings">${icon('settings')}${esc(t(lang, 'set.title'))}</a>` : '',
    `<a class="item" href="?lang=${other}" hreflang="${other}">${icon('globe')}${esc(t(lang, 'nav.lang'))}</a>`,
    `<button class="item" type="button" onclick="toggleTheme()">${icon('sun')}${esc(t(lang, 'nav.theme'))}</button>`,
    config.auth.mode === 'local' ? `<hr><form method="post" action="/logout"><button class="item">${icon('logout')}${esc(t(lang, 'nav.signout'))}</button></form>` : '',
  ].join('') : '';
  const right = u ? `<details class="menu acct"><summary aria-label="${esc(t(lang, 'nav.account'))}"><span class="avatar" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</span><span class="name">${esc(name)}</span>${icon('chevron')}</summary><div class="pop">${items}</div></details>`
    : `${langLink(lang)}${themeBtn(lang)}`;
  const live = opts.engineOk === undefined ? { dot: '', banner: '' } : liveStatus(lang, opts.engineOk);
  return shell(lang, title, `<div class="wrap"><header class="top"><span class="brandwrap"><a class="brand" href="/">${LOGO}<span>${esc(config.brand)}</span></a>${live.dot}</span><div class="bar">${right}</div></header></div>
<main><div class="wrap">${live.banner}${body}</div></main>
<div class="wrap"><footer>${esc(t(lang, 'footer'))} <span class="ver">v${esc(VERSION)}</span></footer></div>`);
}

export const favicon = () => LOGO.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');

export function notice(text: string, error = false): string {
  return `<div class="notice${error ? ' err' : ''}" role="${error ? 'alert' : 'status'}">${icon(error ? 'alert' : 'ok')}<p>${esc(text)}</p></div>`;
}

export function loginPage(lang: Lang, error = '', email = '', next = ''): string {
  return page(lang, `${t(lang, 'login.title')} · ${config.brand}`, `<div class="surface">
<div><h1>${esc(t(lang, 'login.title'))}</h1><p class="lead">${esc(t(lang, 'login.lead'))}</p></div>
${error ? notice(error, true) : ''}
<form class="form" method="post" action="/login">${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
<label>${esc(t(lang, 'login.email'))}<input type="email" name="email" autocomplete="username" required value="${esc(email)}" autofocus></label>
<label>${esc(t(lang, 'login.password'))}<input type="password" name="password" autocomplete="current-password" required></label>
<button class="btn primary">${esc(t(lang, 'login.submit'))}</button></form>
<p><a class="quiet-link" href="/forgot">${esc(t(lang, 'login.forgot'))}</a></p></div>`, { centered: true });
}

/** The two password fields of a new password (with the hint). */
const newPasswordFields = (lang: Lang) => `<label>${esc(t(lang, 'pw.new'))}<input type="password" name="password" autocomplete="new-password" minlength="10" required><span class="hint">${esc(t(lang, 'pw.hint'))}</span></label>
<label>${esc(t(lang, 'pw.new2'))}<input type="password" name="password2" autocomplete="new-password" minlength="10" required></label>`;

/** "Forgot your password?": a link by email when this installation can send emails, otherwise who can help and how. */
export function forgotPage(lang: Lang, o: { mail: boolean; flash?: string; email?: string }): string {
  const back = `<p><a class="quiet-link" href="/login">${esc(t(lang, 'forgot.back'))}</a></p>`;
  const body = o.mail
    ? `<div><h1>${esc(t(lang, 'forgot.title'))}</h1><p class="lead">${esc(t(lang, 'forgot.lead'))}</p></div>${o.flash ?? ''}
<form class="form" method="post" action="/forgot"><label>${esc(t(lang, 'login.email'))}<input type="email" name="email" autocomplete="username" required value="${esc(o.email ?? '')}" autofocus></label>
<button class="btn primary">${esc(t(lang, 'forgot.submit'))}</button></form>${back}`
    : `<div><h1>${esc(t(lang, 'forgot.title'))}</h1><p class="lead">${esc(t(lang, 'forgot.nomail'))}</p></div>
<p>${esc(t(lang, 'forgot.ask'))}</p>
<div class="selfhelp"><h3>${esc(t(lang, 'forgot.self'))}</h3>
<p class="muted">${esc(t(lang, 'forgot.self.pc'))}</p>${snippet('powershell -ExecutionPolicy Bypass -File install\\windows\\install-apprua.ps1 -ResetPassword', lang)}
<p class="muted">${esc(t(lang, 'forgot.self.server'))}</p>${snippet('sudo bash install/reset-password.sh', lang)}
<p class="muted">${esc(t(lang, 'forgot.self.after'))}</p></div>${back}`;
  return page(lang, `${t(lang, 'forgot.title')} · ${config.brand}`, `<div class="surface">${body}</div>`, { centered: true });
}

/** The page of the link sent by email: choose a new password. */
export function resetPage(lang: Lang, o: { token: string; email: string; error?: string }): string {
  return page(lang, `${t(lang, 'reset.title')} · ${config.brand}`, `<div class="surface">
<div><h1>${esc(t(lang, 'reset.title'))}</h1><p class="lead">${esc(t(lang, 'reset.lead', { email: o.email }))}</p></div>
${o.error ? notice(o.error, true) : ''}
<form class="form" method="post" action="/reset"><input type="hidden" name="t" value="${esc(o.token)}">${newPasswordFields(lang)}
<button class="btn primary">${esc(t(lang, 'reset.submit'))}</button></form></div>`, { centered: true });
}

/** "Your account": the email, and changing the password (local accounts). */
export function accountPage(lang: Lang, u: User, flash = ''): string {
  const pw = config.auth.mode === 'local'
    ? `<section aria-labelledby="pw-h"><div class="head"><h2 id="pw-h">${esc(t(lang, 'pw.title'))}</h2></div>
<form class="surface set form" method="post" action="/account/password"><p class="muted">${esc(t(lang, 'pw.text'))}</p>
<input type="text" name="username" value="${esc(u.email)}" autocomplete="username" hidden>
<label>${esc(t(lang, 'pw.current'))}<input type="password" name="current" autocomplete="current-password" required></label>
${newPasswordFields(lang)}<div><button class="btn primary">${esc(t(lang, 'pw.submit'))}</button></div></form></section>`
    : `<p class="muted">${esc(t(lang, 'pw.proxy'))}</p>`;
  return page(lang, `${t(lang, 'acct.title')} · ${config.brand}`, `<div class="hello"><h1>${esc(t(lang, 'acct.title'))}</h1><p class="muted">${esc(t(lang, 'acct.lead', { email: u.email }))}</p></div>${flash}
<div class="stack">${pw}</div>`, { user: u });
}

/** The new password an administrator gave to a person: shown once, to be told in person. */
export function newPasswordNotice(lang: Lang, email: string, password: string): string {
  const [before, after] = t(lang, 'admin.newpw.done', { email, password: '\u0000' }).split('\u0000');
  return `<div class="notice" role="status">${icon('key')}<div class="grow"><p>${esc(before.replace(/[:\s]+$/, ':'))}</p>${snippet(password, lang)}<p class="muted">${esc(after.replace(/^[.\s]+/, ''))}</p></div></div>`;
}

/** First-run setup, step 1: who is this Apprua for? */
export function setupChoicePage(lang: Lang, suggested: 'personal' | 'team'): string {
  const choice = (p: 'personal' | 'team', href: string, ic: string) => `<a class="choice${p === suggested ? ' suggested' : ''}" href="${href}">
<span class="ico">${icon(ic)}</span><span class="txt"><b>${esc(t(lang, p === 'personal' ? 'setup.me.title' : 'setup.team.title'))}</b>${p === suggested ? `<span class="badge">${esc(t(lang, 'setup.suggested'))}</span>` : ''}
<span>${esc(t(lang, p === 'personal' ? 'setup.me.text' : 'setup.team.text'))}</span></span>${icon('chevron')}</a>`;
  return page(lang, t(lang, 'setup.title'), `<div class="surface">
<div><span class="steplabel">${esc(t(lang, 'setup.step', { n: 1 }))}</span><h1>${esc(t(lang, 'setup.title'))}</h1><p class="lead">${esc(t(lang, 'setup.choose.lead'))}</p></div>
<div class="choices">${choice('personal', '/setup?for=me', 'user')}${choice('team', '/setup?for=team', 'users')}</div></div>`, { centered: true });
}

export interface SetupForm { profile: 'personal' | 'team'; error?: string; email?: string; name?: string; quota?: number; reviewMonths?: number }

/** First-run setup, step 2: the first account (and, for a group, the rules). */
export function setupPage(lang: Lang, f: SetupForm): string {
  const team = f.profile === 'team';
  const code = config.auth.setupCode ? `<label>${esc(t(lang, 'setup.code'))}<input type="text" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required><span class="hint">${esc(t(lang, 'setup.code.hint'))}</span></label>` : '';
  const months = (m: number) => `<option value="${m}"${(f.reviewMonths ?? 6) === m ? ' selected' : ''}>${esc(t(lang, `setup.review.${m}`))}</option>`;
  const rules = team ? `<fieldset><legend>${esc(t(lang, 'setup.rules'))}</legend>
<label>${esc(t(lang, 'setup.quota'))}<input type="number" name="quota" min="1" max="100" value="${f.quota ?? 5}" required></label>
<label>${esc(t(lang, 'setup.review'))}<select name="review">${[6, 12, 0].map(months).join('')}</select><span class="hint">${esc(t(lang, 'setup.review.text'))}</span></label></fieldset>` : '';
  const local = team && config.baseDomain === 'localhost' ? `<div class="notice plain">${icon('alert')}<p>${esc(t(lang, 'setup.local.warn'))}</p></div>` : '';
  return page(lang, t(lang, 'setup.title'), `<div class="surface">
<div><span class="steplabel">${esc(t(lang, 'setup.step', { n: 2 }))}</span><h1>${esc(t(lang, team ? 'setup.title.team' : 'setup.title.me'))}</h1><p class="lead">${esc(t(lang, team ? 'setup.lead.team' : 'setup.lead.me'))}</p></div>
${f.error ? notice(f.error, true) : ''}${local}
<form class="form" method="post" action="/setup"><input type="hidden" name="profile" value="${team ? 'team' : 'personal'}">${code}
<label>${esc(t(lang, 'setup.name'))}<input type="text" name="name" autocomplete="name" value="${esc(f.name ?? '')}"></label>
<label>${esc(t(lang, 'login.email'))}<input type="email" name="email" autocomplete="username" required value="${esc(f.email ?? '')}"></label>
<label>${esc(t(lang, 'login.password'))}<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
<label>${esc(t(lang, 'setup.password2'))}<input type="password" name="password2" autocomplete="new-password" minlength="10" required></label>
${rules}<button class="btn primary">${esc(t(lang, 'setup.submit'))}</button></form>
<a class="back" href="/setup">${esc(t(lang, 'setup.back'))}</a></div>`, { centered: true });
}

/** Shown once to the administrator after setting Apprua up for a group. */
export function teamWelcome(lang: Lang): string {
  return `<div class="notice" role="status">${icon('ok')}<p>${esc(t(lang, 'setup.team.done'))} <a href="/settings#adduser">${esc(t(lang, 'setup.team.add'))}</a></p></div>`;
}

let snipId = 0;
function snippet(text: string, lang: Lang): string {
  const id = `s${++snipId}`;
  return `<div class="snip"><span id="${id}">${esc(text)}</span><button class="copy" type="button" data-copy="${id}" data-done="${esc(t(lang, 'copied'))}">${esc(t(lang, 'copy'))}</button></div>`;
}

/** Links that add the connector to Cursor and VS Code with one click (they carry the key: only built when it was just created). */
export function installLinks(token: string) {
  const cfg = connectorConfig(token);
  return {
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=apprua&config=${encodeURIComponent(Buffer.from(JSON.stringify(cfg)).toString('base64'))}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'apprua', type: 'stdio', ...cfg }))}`,
  };
}

let connectId = 0;
/** "Which AI app do you use?": one tab for each app, with its own steps. With the key just created, the settings
 *  carry it and Cursor / VS Code get a one-click button; otherwise the settings show a placeholder for the key. */
function connectBlock(lang: Lang, o: { token?: string; hasToken: boolean; keyAbove?: boolean }): string {
  const id = `c${++connectId}`;
  const token = o.token ?? '';
  const tok = token || (lang === 'it' ? '<la tua chiave>' : '<your key>');
  const cfg = connectorConfig(tok);
  const npx = [cfg.command, ...cfg.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const add = `claude mcp add --scope user apprua -e APPRUA_URL=${config.publicUrl} -e APPRUA_TOKEN=${tok}`;
  const codexAdd = `codex mcp add apprua --env APPRUA_URL=${config.publicUrl} --env APPRUA_TOKEN=${tok}`;
  // The Codex app has no "codex" command on the PATH (on Windows it is locked inside the Store package), so the
  // main way is the few lines "codex mcp add" would write in config.toml (tried with the Codex app on Windows)
  const codexToml = (command: string, args: string[]) => `[mcp_servers.apprua]
command = ${JSON.stringify(command)}
args = [${args.map((a) => JSON.stringify(a)).join(', ')}]

[mcp_servers.apprua.env]
${Object.entries(cfg.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n')}`;
  const cursorJson = JSON.stringify({ mcpServers: { apprua: cfg } }, null, 2);
  const vscodeJson = JSON.stringify({ servers: { apprua: { type: 'stdio', ...cfg } } }, null, 2);
  const node = `<p class="hint">${esc(t(lang, 'conn.node'))} <a href="https://nodejs.org" target="_blank" rel="noopener">nodejs.org</a></p>`;
  const keyFirst = `<form method="post" action="/portal/token"${o.hasToken ? ` data-confirm="${esc(t(lang, 'cmd.key.confirm'))}"` : ''}><button class="btn small">${icon('key')}${esc(t(lang, o.hasToken ? 'step1.renew' : 'step1.button'))}</button></form>`;
  const oneClick = (app: 'cursor' | 'vscode', name: string) => token
    ? `<div class="row"><a class="btn primary" href="${esc(installLinks(token)[app])}">${icon('plug')}${esc(t(lang, 'conn.add', { app: name }))}</a></div><p>${esc(t(lang, 'conn.add.then', { app: name }))}</p>`
    : o.keyAbove ? `<p>${esc(t(lang, 'conn.add.needkey.above', { app: name }))}</p>`
    : `<p>${esc(t(lang, 'conn.add.needkey', { app: name }))}</p><div>${keyFirst}</div>`;
  const manual = (json: string, where: string) => `<details class="more"><summary>${icon('chevron')}${esc(t(lang, 'conn.manual'))}</summary><div><p class="muted">${esc(where)}</p>${snippet(json, lang)}</div></details>`;
  const tabs: [string, string, string][] = [
    ['claude', 'Claude Desktop', `<p>${esc(t(lang, 'conn.claude'))}</p><div class="row"><a class="btn primary" href="/download/apprua.mcpb">${icon('download')}${esc(t(lang, 'step2.mcpb'))}</a></div>`],
    ['code', 'Claude Code', `<p>${esc(t(lang, 'conn.code'))}</p>
<div class="os-win"><p class="muted">Windows</p>${snippet(`${add} -- cmd /c ${npx}`, lang)}</div><div class="os-other"><p class="muted">macOS / Linux</p>${snippet(`${add} -- ${npx}`, lang)}</div>${node}`],
    // Codex: the app of OpenAI for building apps with GPT (included in the ChatGPT plans); it takes local connectors
    ['codex', 'Codex (ChatGPT)', `<p>${esc(t(lang, 'conn.codex'))}</p>
<div class="os-win"><p class="muted">Windows: <code>%USERPROFILE%\\.codex\\config.toml</code></p>${snippet(codexToml('cmd', ['/c', cfg.command, ...cfg.args]), lang)}</div><div class="os-other"><p class="muted">macOS / Linux: <code>~/.codex/config.toml</code></p>${snippet(codexToml(cfg.command, cfg.args), lang)}</div>
<details class="more"><summary>${icon('chevron')}${esc(t(lang, 'conn.codex.cli'))}</summary><div>
<div class="os-win"><p class="muted">Windows</p>${snippet(`${codexAdd} -- cmd /c ${npx}`, lang)}</div><div class="os-other"><p class="muted">macOS / Linux</p>${snippet(`${codexAdd} -- ${npx}`, lang)}</div></div></details>${node}`],
    ['cursor', 'Cursor', `${oneClick('cursor', 'Cursor')}${manual(cursorJson, t(lang, 'conn.cursor.file'))}${node}`],
    ['vscode', 'VS Code', `${oneClick('vscode', 'VS Code')}${manual(vscodeJson, t(lang, 'conn.vscode.file'))}${node}`],
    ['other', t(lang, 'conn.other'), `<p>${esc(t(lang, 'conn.other.text'))}</p>${snippet(cursorJson, lang)}${node}
<p class="hint">${esc(t(lang, 'conn.file'))} <a href="/download/apprua-mcp.mjs">apprua-mcp.mjs</a></p>`],
  ];
  // on a local network without HTTPS the key travels unencrypted: say so where it is used
  const plain = config.network !== 'local' && config.publicUrl.startsWith('http://')
    ? `<p class="summary warn">${icon('alert')}<span>${esc(t(lang, 'conn.plainhttp'))}</span></p>` : '';
  return `${plain}<fieldset class="conn"><legend>${esc(t(lang, 'conn.which'))}</legend>
${tabs.map(([k, label], i) => `<input type="radio" name="${id}" id="${id}-${k}" value="${k}"${i === 0 ? ' checked' : ''}><label for="${id}-${k}">${esc(label)}</label>`).join('')}
${tabs.map(([k, , body]) => `<div class="tp tp-${k}">${body}</div>`).join('')}</fieldset>`;
}

/** The key just created. Where the checklist is still open, the steps to connect are in step 2 (with this key in them). */
export function tokenNotice(lang: Lang, token: string, expiresAt: string, withConnect = true): string {
  return `<div class="notice" role="status">${icon('key')}<div class="grow"><h3>${esc(t(lang, 'token.title'))}</h3><p>${esc(t(lang, 'token.text', { date: day(expiresAt) }))}</p>
${snippet(token, lang)}${withConnect ? connectBlock(lang, { token, hasToken: true }) : `<p>${esc(t(lang, 'token.next'))}</p>`}</div></div>`;
}

export function logsCard(lang: Lang, app: string, type: 'runtime' | 'build', lines: string[], result: string | null): string {
  const title = t(lang, 'logs.title', { app, type: t(lang, type === 'build' ? 'logs.build' : 'logs.runtime') });
  return `<div class="notice plain" role="status">${icon(type === 'build' ? 'hammer' : 'doc')}<div class="grow"><h3>${esc(title)}${result ? ` · ${esc(result)}` : ''}</h3>
<pre class="logs">${esc(lines.join('\n') || t(lang, 'logs.empty'))}</pre><div><a class="btn quiet small" href="/">${esc(t(lang, 'logs.close'))}</a></div></div></div>`;
}

/** The tiny lighthouse before the state of an app (list, command bar, admin table): its light is the state. */
/** The state of an app as its lighthouse tells it: a failed or running last publication wins over on/paused. */
function appState(a: App, h?: Publication[]): string {
  const last = h?.[h.length - 1];
  if (last?.result && last.result !== 'running') return 'failed';
  if (last && last.result === null) return 'publishing';
  return isDown(a) ? 'down' : a.status;
}
const beacon = (state: string) => `<span class="beacon ${esc(state)}" aria-hidden="true">${LAMP}</span>`;
export const prettyName = (n: string) => n.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

export interface Publication { result: string | null; at: string }

const VIS_ICON = { private: 'key', team: 'users', public: 'globe' } as const;
/** Apprua's gate is in front of the apps (local network or internet, no other login configured). */
const gateOn = () => config.network !== 'local' && appMiddleware() === 'apprua-auth@file';

/** One app: name, description, address and the state (the tiny lighthouse and a word); one button and the "⋯" menu.
 *  Kept minimal on purpose (2026-11-05): no history bars, no "updated ... ago", pause lives in the menu. */
function appRow(lang: Lang, a: App, h?: Publication[]): string {
  const last = h?.[h.length - 1];
  const broken = !!last?.result && last.result !== 'running'; // the last publication did not go through
  const fresh = !broken && !!a.last_deploy_at && Date.now() - parseDate(a.last_deploy_at) < 120_000;
  const post = (action: string, ic: string, label: string, confirmText = '', cls = '') =>
    `<form method="post" action="/portal/apps/${esc(a.name)}/${action}"${confirmText ? ` data-confirm="${esc(confirmText)}"` : ''}><button class="item${cls}">${icon(ic)}${esc(label)}</button></form>`;
  const items: string[] = [];
  const on = a.status === 'active';
  // Pause needs no "are you sure?": the page offers "Undo" right after pausing
  if (on) items.push(post('stop', 'pause', t(lang, 'act.stop')), post('restart', 'restart', t(lang, 'act.restart')));
  items.push(`<a class="item" href="/portal/apps/${esc(a.name)}">${icon('key')}${esc(t(lang, 'act.details'))}</a>`);
  items.push(`<a class="item" href="/portal/apps/${esc(a.name)}/logs">${icon('doc')}${esc(t(lang, 'act.logs'))}</a>`,
    `<a class="item" href="/portal/apps/${esc(a.name)}/logs?type=build">${icon('hammer')}${esc(t(lang, 'act.buildlogs'))}</a>`);
  if (a.review_at && config.policy.reviewMonths > 0) items.push(post('confirm', 'calendar', t(lang, 'act.confirm')));
  // who can open it: only where others can reach the apps and Apprua's gate is in front of them
  if (gateOn()) {
    items.push('<hr>', `<span class="item label">${esc(t(lang, 'vis.label'))}</span>`);
    for (const v of ['private', 'team', 'public'] as const) {
      items.push(v === a.visibility
        ? `<span class="item current" aria-current="true">${icon(VIS_ICON[v])}${esc(t(lang, `vis.${v}`))}${icon('check')}</span>`
        : post(`see-${v}`, VIS_ICON[v], t(lang, `vis.${v}`)));
    }
  }
  items.push('<hr>', post('archive', 'archive', t(lang, 'act.archive'), t(lang, 'act.confirm_archive', { app: a.name }), ' danger'));
  const primary = broken
    ? `<a class="btn small" href="/portal/apps/${esc(a.name)}/logs?type=build">${icon('hammer')}${esc(t(lang, 'sum.err.link'))}</a>`
    : isDown(a) ? `<form class="inline" method="post" action="/portal/apps/${esc(a.name)}/restart"><button class="btn small">${icon('restart')}${esc(t(lang, 'act.restart'))}</button></form>`
    : on ? `<a class="btn primary small" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(t(lang, 'act.open'))}</a>`
    : `<form class="inline" method="post" action="/portal/apps/${esc(a.name)}/start"><button class="btn small">${icon('play')}${esc(t(lang, 'act.start'))}</button></form>`;
  const state = appState(a, h);
  const review = a.review_at && config.policy.reviewMonths > 0 ? `<span>${esc(t(lang, 'review.due', { date: day(a.review_at) }))}</span>` : '';
  const vis = gateOn() ? `<span class="vis" title="${esc(t(lang, 'vis.label'))}">${icon(VIS_ICON[a.visibility])}${esc(t(lang, `vis.${a.visibility}`))}</span>` : '';
  return `<li${fresh ? ' class="fresh"' : ''}>
<span class="meta"><b><a class="name" href="/portal/apps/${esc(a.name)}">${esc(prettyName(a.name))}</a></b><span class="desc">${esc(a.description)}</span>
<span class="line"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url.replace(/^https?:\/\//, ''))}</a><span class="state ${esc(state)}">${beacon(state)}${esc(t(lang, `status.${state}`))}</span>${fresh ? `<span class="badge">${esc(t(lang, 'apps.fresh'))}</span>` : ''}${outOfMemory(a) ? `<a class="badge warn" href="/portal/apps/${esc(a.name)}#mem">${esc(t(lang, 'mem.tag'))}</a>` : ''}${vis}${review}</span></span>
<span class="actions">${primary}<details class="menu"><summary aria-label="${esc(t(lang, 'act.more', { app: a.name }))}">${icon('more')}</summary><div class="pop">${items.join('')}</div></details></span></li>`;
}

export interface VersionRow { sha: string; at: string; author: string; message: string; current: boolean; result: string | null }

/** The page of one app (click on its name): versions (go back to one, download the code), its secrets and its memory.
 *  mem: what the apps that are on may use together, and the room for apps (shown to administrators). */
export function appPage(lang: Lang, u: User, a: App, versions: VersionRow[], envKeys: string[], flash = '', engineOk = true,
  mem?: { onMb: number; roomMb: number }): string {
  const loc = lang === 'it' ? 'it-IT' : 'en-GB';
  const when = (iso: string) => {
    const d = new Date(iso);
    const text = isNaN(d.getTime()) ? iso : d.toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
    return `<time datetime="${esc(iso)}" data-local>${esc(text)}</time>`;
  };
  const base = `/portal/apps/${esc(a.name)}`;
  const rows = versions.map((v) => {
    const tag = v.current ? `<span class="badge">${esc(t(lang, 'ver.current'))}</span>`
      : v.result && v.result !== 'running' ? `<span class="muted">${esc(t(lang, 'ver.failed'))}</span>` : '';
    const back = v.current ? '' : `<form method="post" action="${base}/restore" data-confirm="${esc(t(lang, 'ver.confirm', { app: prettyName(a.name) }))}"><input type="hidden" name="sha" value="${esc(v.sha)}"><button class="btn small">${icon('restart')}${esc(t(lang, 'ver.restore'))}</button></form>`;
    return `<li><span class="meta"><b>${when(v.at)}</b><span class="desc">${esc(v.message)}</span><span class="line"><span class="mono">${esc(v.sha.slice(0, 7))}</span><span>${esc(v.author.replace(/\s*<.*>$/, ''))}</span>${tag}</span></span>
<span class="actions">${back}<a class="btn quiet small" href="${base}/source?ref=${esc(v.sha)}" download>${icon('download')}${esc(t(lang, 'ver.download'))}</a></span></li>`;
  }).join('');
  const versionsHtml = `<section aria-labelledby="ver-h"><div class="head"><h2 id="ver-h">${esc(t(lang, 'ver.title'))}</h2><span class="muted">${esc(t(lang, 'ver.hint'))}</span></div>
${rows ? `<ul class="apps surface">${rows}</ul>` : `<p class="muted">${esc(t(lang, 'ver.none'))}</p>`}</section>`;

  const keyRe = '[A-Z_][A-Z0-9_]{0,63}';
  const envRows = envKeys.map((k) => `<li><span class="meta"><b class="mono">${esc(k)}</b><span class="desc">${esc(t(lang, 'env.hidden'))}</span></span>
<span class="actions"><details class="menu env-edit"><summary class="btn small">${esc(t(lang, 'env.change'))}</summary><div class="pop"><form class="form" method="post" action="${base}/env"><input type="hidden" name="key" value="${esc(k)}">
<label>${esc(t(lang, 'env.new_value', { key: k }))}<input type="password" name="value" autocomplete="off" required></label><button class="btn primary small">${esc(t(lang, 'env.save'))}</button></form></div></details>
<form method="post" action="${base}/env-delete" data-confirm="${esc(t(lang, 'env.confirm_delete', { key: k }))}"><input type="hidden" name="key" value="${esc(k)}"><button class="btn quiet small danger">${esc(t(lang, 'env.delete'))}</button></form></span></li>`).join('');
  const envHtml = `<section aria-labelledby="env-h"><div class="head"><h2 id="env-h">${esc(t(lang, 'env.title'))}</h2></div>
<p class="muted">${esc(t(lang, 'env.hint'))}</p>
${envRows ? `<ul class="apps surface">${envRows}</ul>` : `<p class="muted">${esc(t(lang, 'env.none'))}</p>`}
<form class="surface set form" method="post" action="${base}/env"><b>${esc(t(lang, 'env.add'))}</b>
<label>${esc(t(lang, 'env.key'))}<input type="text" name="key" required pattern="${keyRe}" placeholder="OPENAI_API_KEY" autocomplete="off" spellcheck="false"><span class="hint">${esc(t(lang, 'env.key.hint'))}</span></label>
<label>${esc(t(lang, 'env.value'))}<input type="password" name="value" required autocomplete="off"></label>
<div><button class="btn primary">${esc(t(lang, 'env.save'))}</button></div></form></section>`;

  // ----- memory: administrators choose it (up to the ceiling of this machine); everyone sees when it ran out
  const admin = u.role === 'admin';
  const oom = outOfMemory(a);
  const maxMb = config.policy.maxMemoryMb;
  const sizes = MEMORY_CHOICES.filter((m) => memoryMb(m) <= maxMb);
  if (!sizes.includes(a.memory)) sizes.push(a.memory);
  sizes.sort((x, y) => memoryMb(x) - memoryMb(y));
  const maxLabel = maxMb % 1024 === 0 ? `${maxMb / 1024} GB` : `${maxMb} MB`;
  const oomDay = a.oom_at ? new Date(a.oom_at).toLocaleDateString(loc) : '';
  const oomBox = oom ? `<p class="summary warn">${icon('alert')}<span>${esc(t(lang, admin ? 'mem.oom.admin' : 'mem.oom.owner', { when: oomDay, mem: memLabel(a.memory) }))}</span></p>` : '';
  const memForm = admin
    ? `<form class="form" method="post" action="${base}/memory"><label>${esc(t(lang, 'mem.label'))}<select name="memory">${sizes.map((m) => `<option value="${esc(m)}"${m === a.memory ? ' selected' : ''}>${esc(memLabel(m))}</option>`).join('')}</select>
<span class="hint">${esc(t(lang, 'mem.hint', { max: maxLabel }))}</span></label><div><button class="btn primary">${esc(t(lang, a.status === 'active' ? 'mem.save.on' : 'mem.save'))}</button></div></form>`
    : `<p>${esc(t(lang, 'mem.now', { mem: memLabel(a.memory) }))} ${esc(t(lang, 'mem.ask'))}</p>`;
  const room = mem && admin ? `<p class="muted">${esc(t(lang, 'mem.room', { on: gb(lang, mem.onMb), room: gb(lang, mem.roomMb) }))}</p>` : '';
  const memHtml = `<section id="mem" aria-labelledby="mem-h"><div class="head"><h2 id="mem-h">${esc(t(lang, 'mem.title'))}</h2></div>
<div class="surface set">${oomBox}${memForm}${room}</div></section>`;

  const state = a.status;
  const local = `<script>document.querySelectorAll('time[data-local]').forEach(function(e){var d=new Date(e.dateTime.replace(' ','T')+(/[zZ]|[+-]\\d\\d:?\\d\\d$/.test(e.dateTime)?'':'Z'));if(!isNaN(d))e.textContent=d.toLocaleString('${loc}',{dateStyle:'medium',timeStyle:'short'});});</script>`;
  const body = `<div class="hello"><a class="back-link" href="/">${icon('chevron')}${esc(t(lang, 'set.back'))}</a><h1>${esc(prettyName(a.name))}</h1>
<p class="line"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url.replace(/^https?:\/\//, ''))}</a> <span class="state ${esc(state)}">${beacon(state)}${esc(t(lang, `status.${state}`))}</span></p>
<p class="muted">${esc(a.description)}</p></div>${flash}
<div class="stack">${oom ? memHtml : ''}${versionsHtml}${envHtml}${oom ? '' : memHtml}</div>${local}`;
  return page(lang, `${prettyName(a.name)} · ${config.brand}`, body, { user: u, engineOk });
}

/** Words that also find a command (both languages, so "pause" works in Italian and "pausa" in English). */
const KEYWORDS: Record<string, string> = {
  open: 'apri open vai visita go',
  start: 'riaccendi avvia accendi start turn on',
  restart: 'riavvia restart ricarica reload',
  stop: 'pausa metti ferma spegni stop pause',
  logs: 'log errori cosa succede logs errors what happening',
  build: 'diario pubblicazione build log deploy publishing',
  archive: 'archivia togli elimina archive remove',
  connect: 'collega connetti claude codex chatgpt gpt openai cursor vs code mcp connettore connect ai',
  key: 'chiave token rinnova nuova key renew new',
  mcpb: 'scarica estensione claude desktop download extension mcpb',
  theme: 'tema scuro chiaro dark light theme',
  lang: 'lingua english italiano language',
  adduser: 'persona utente aggiungi invita person user add invite',
  settings: 'impostazioni regole memoria risorse ram disco spazio settings rules memory resources disk space',
  signout: 'esci logout sign out',
};

interface Cmd { label: string; hint?: string; app?: App; ico?: string; act: 'link' | 'post' | 'js'; href?: string; blank?: boolean; js?: string; confirm?: string; k: string; def?: boolean; danger?: boolean }

/** The command bar: every app and action reachable by typing (Ctrl K / "/"), or by clicking. */
function commandBar(lang: Lang, u: User, mine: App[], opts: { admin: boolean; hasToken: boolean; connectId: string; history: Record<string, Publication[]> }): string {
  const cmds: { group: string; items: Cmd[] }[] = [];
  const appCmds: Cmd[] = [];
  for (const a of mine) {
    const app = prettyName(a.name);
    const host = a.url.replace(/^https?:\/\//, '');
    const base = `/portal/apps/${a.name}`;
    if (a.status === 'active') {
      appCmds.push({ label: t(lang, 'cmd.open', { app }), hint: host, app: a, act: 'link', href: a.url, blank: true, k: `${KEYWORDS.open} ${a.name}`, def: true });
      appCmds.push({ label: t(lang, 'cmd.restart', { app }), app: a, act: 'post', href: `${base}/restart`, k: `${KEYWORDS.restart} ${a.name}` });
      appCmds.push({ label: t(lang, 'cmd.stop', { app }), app: a, act: 'post', href: `${base}/stop`, k: `${KEYWORDS.stop} ${a.name}` });
    } else {
      appCmds.push({ label: t(lang, 'cmd.start', { app }), hint: t(lang, `status.${a.status}`), app: a, act: 'post', href: `${base}/start`, k: `${KEYWORDS.start} ${a.name}`, def: true });
    }
    appCmds.push({ label: t(lang, 'cmd.logs', { app }), app: a, act: 'link', href: `${base}/logs`, k: `${KEYWORDS.logs} ${a.name}` });
    appCmds.push({ label: t(lang, 'cmd.build', { app }), app: a, act: 'link', href: `${base}/logs?type=build`, k: `${KEYWORDS.build} ${a.name}` });
    appCmds.push({ label: t(lang, 'cmd.archive', { app }), app: a, act: 'post', href: `${base}/archive`, confirm: t(lang, 'act.confirm_archive', { app: a.name }), k: `${KEYWORDS.archive} ${a.name}`, danger: true });
  }
  if (appCmds.length) cmds.push({ group: t(lang, 'apps.title'), items: appCmds });
  const other: Lang = lang === 'it' ? 'en' : 'it';
  const actions: Cmd[] = [
    { label: t(lang, 'cmd.connect'), ico: 'plug', act: 'js', js: opts.connectId, k: KEYWORDS.connect, def: true },
    { label: t(lang, opts.hasToken ? 'cmd.key' : 'step1.button'), ico: 'key', act: 'post', href: '/portal/token', confirm: opts.hasToken ? t(lang, 'cmd.key.confirm') : undefined, k: KEYWORDS.key, def: true },
    { label: t(lang, 'cmd.mcpb'), ico: 'download', act: 'link', href: '/download/apprua.mcpb', k: KEYWORDS.mcpb },
    { label: t(lang, 'nav.theme'), ico: 'sun', act: 'js', js: 'theme', k: KEYWORDS.theme },
    { label: t(lang, 'cmd.lang'), ico: 'globe', act: 'link', href: `?lang=${other}`, k: KEYWORDS.lang },
  ];
  if (opts.admin) actions.push({ label: t(lang, 'set.title'), ico: 'settings', act: 'link', href: '/settings', k: KEYWORDS.settings });
  if (opts.admin && config.auth.mode === 'local') actions.push({ label: t(lang, 'admin.adduser'), ico: 'user', act: 'link', href: '/settings#adduser', k: KEYWORDS.adduser });
  if (config.auth.mode === 'local') actions.push({ label: t(lang, 'nav.signout'), ico: 'logout', act: 'post', href: '/logout', k: KEYWORDS.signout });
  cmds.push({ group: t(lang, 'cmd.actions'), items: actions });

  let n = 0;
  const li = (c: Cmd) => {
    const attrs = [`data-do="${c.act}"`, c.href ? `data-href="${esc(c.href)}"` : '', c.blank ? 'data-target="_blank"' : '', c.js ? `data-js="${esc(c.js)}"` : '',
      c.confirm ? `data-confirm="${esc(c.confirm)}"` : '', `data-k="${esc(c.k)}"`, c.def ? 'data-def="1"' : ''].filter(Boolean).join(' ');
    const lead = c.app ? beacon(appState(c.app, opts.history[c.app.name])) : `<span class="ico">${icon(c.ico!)}</span>`;
    return `<li role="option" aria-selected="false" id="cmd-${++n}" class="opt${c.danger ? ' danger' : ''}" ${attrs}${c.def ? '' : ' hidden'}>${lead}<span class="lbl">${esc(c.label)}</span>${c.hint ? `<span class="hint">${esc(c.hint)}</span>` : ''}<kbd class="enter" aria-hidden="true">↵</kbd></li>`;
  };
  const items = cmds.map((g) => `<li class="grp" role="presentation">${esc(g.group)}</li>${g.items.map(li).join('')}`).join('');
  return `<div class="cmd" id="cmd"><div class="field">${icon('search')}<input type="text" role="combobox" aria-expanded="false" aria-controls="cmd-list" aria-autocomplete="list" aria-label="${esc(t(lang, 'cmd.label'))}" placeholder="${esc(t(lang, 'cmd.placeholder'))}" autocomplete="off" spellcheck="false"><kbd class="kbd-k" aria-hidden="true">Ctrl K</kbd></div>
<div class="drop"><ul role="listbox" id="cmd-list" aria-label="${esc(t(lang, 'cmd.label'))}">${items}</ul><p class="none" hidden>${esc(t(lang, 'cmd.empty'))}</p>
<div class="keys" aria-hidden="true"><span><kbd>↑↓</kbd>${esc(t(lang, 'cmd.k.move'))}</span><span><kbd>↵</kbd>${esc(t(lang, 'cmd.k.run'))}</span><span><kbd>Esc</kbd>${esc(t(lang, 'cmd.k.close'))}</span></div></div></div>`;
}

export interface AdminData {
  apps: any[]; users: any[]; engine: string;
  /** Apps whose engine side differs from what Apprua knows (null: not checked, the engine does not answer). */
  drift?: { name: string; problem: 'missing' | 'stopped' }[] | null;
  net?: NetData;
}

/** Settings, administrators: which version runs, what is new, how to update. Nothing is asked to the internet: the
 *  page only links to the releases. */
const RELEASES = 'https://github.com/apprua/apprua/releases';
function updatesSection(lang: Lang, admin: AdminData, wsl: boolean): string {
  const engine = /Coolify\s+([0-9][^\s,;)]*)/i.exec(admin.engine)?.[1];
  const tested = COOLIFY_TESTED;
  const eng = engine
    ? `<p>${esc(t(lang, !tested || engine === tested ? 'upd.engine' : 'upd.engine.other', { engine: `Coolify ${engine}`, tested: tested || '' }))}</p>`
    : '';
  const how = wsl
    ? `<p>${esc(t(lang, 'upd.pc'))}</p>${snippet('powershell -ExecutionPolicy Bypass -File install\\windows\\install-apprua.ps1', lang)}`
    : `<p>${esc(t(lang, 'upd.server'))}</p>${snippet(`curl -fsSL ${RELEASES}/latest/download/apprua.tar.gz | tar -xz && sudo bash apprua/install/install.sh`, lang)}`;
  return `<section aria-labelledby="upd-h"><div class="head"><h2 id="upd-h">${esc(t(lang, 'upd.title'))}</h2></div>
<div class="surface set"><p><b>${esc(t(lang, 'upd.version', { version: VERSION }))}</b></p>${eng}<p class="muted">${esc(t(lang, 'upd.auto'))}</p>
<p><a class="quiet-link" href="${RELEASES}" target="_blank" rel="noopener">${esc(t(lang, 'upd.news'))}</a></p>
<details class="more"><summary>${icon('chevron')}${esc(t(lang, 'upd.how'))}</summary><div>${how}</div></details></div></section>`;
}

/** Settings, administrators: the engine for experts (how to open the Coolify panel) and whether it agrees with Apprua. */
function engineSection(lang: Lang, admin: AdminData, wsl: boolean): string {
  const cmd = wsl ? 'wsl -d Apprua -u root -- grep COOLIFY_ADMIN_PASSWORD /root/.apprua/apprua.env' : 'sudo grep COOLIFY_ADMIN_PASSWORD /root/.apprua/apprua.env';
  const open = wsl
    ? `<p>${esc(t(lang, 'eng.open.pc'))} <a href="http://localhost:8000" target="_blank" rel="noopener">http://localhost:8000</a></p>`
    : `<p>${esc(t(lang, 'eng.open.server'))}</p>${snippet('ssh -L 8000:localhost:8000 root@' + (config.network === 'local' ? 'your-server' : new URL(config.publicUrl).hostname), lang)}<p class="hint muted">${esc(t(lang, 'eng.open.then'))}</p>`;
  const drift = admin.drift == null ? `<p class="muted">${esc(t(lang, 'eng.drift.unknown'))}</p>`
    : admin.drift.length === 0 ? `<p class="summary">${icon('ok')}<span>${esc(t(lang, 'eng.drift.ok'))}</span></p>`
    : `<ul class="drift">${admin.drift.map((d) => `<li class="summary warn">${icon('alert')}<span>${esc(t(lang, `eng.drift.${d.problem}`, { app: prettyName(d.name) }))}</span></li>`).join('')}</ul>`;
  return `<section aria-labelledby="eng-h"><div class="head"><h2 id="eng-h">${esc(t(lang, 'eng.title'))}</h2></div>
<div class="surface set">${drift}
<details class="more"><summary>${icon('chevron')}${esc(t(lang, 'eng.open'))}</summary><div><p class="muted">${esc(t(lang, 'eng.text'))}</p>${open}
<p>${esc(t(lang, 'eng.login'))}</p>${snippet(cmd, lang)}</div></details></div></section>`;
}

export interface HomeData {
  lang: Lang;
  u: User;
  mine: App[];
  flash?: string;
  /** The signed-in person is an administrator (the administration itself is on the Settings page). */
  admin?: boolean;
  /** Last publications of each app (oldest first), for the history bars and the summary. */
  history?: Record<string, Publication[]>;
  /** Publications that went through, for each app (all of them, not only the last ones shown as bars). */
  versions?: Record<string, number>;
  /** The personal key just created (shown once). */
  fresh?: { token: string; expiresAt: string };
  /** Whether the engine (Coolify) answers: drives the status dot and a notice. */
  engineOk?: boolean;
}

/** A sentence under the greeting only when something is worth a look; when all is calm, nothing. */
function summary(lang: Lang, mine: App[], history: Record<string, Publication[]>): string {
  const failed = mine.filter((a) => { const h = history[a.name]; const last = h?.[h.length - 1]; return !!last?.result && last.result !== 'running'; });
  if (failed.length) {
    const text = failed.length === 1 ? t(lang, 'sum.err', { app: prettyName(failed[0].name) }) : t(lang, 'sum.err.many', { n: failed.length });
    // a moment worth an illustration: someone fixing a box under the lighthouse
    return `<div class="notice fix" role="status"><img class="art" src="/assets/img/da-sistemare.svg?v=6" alt="${esc(t(lang, 'art.fix'))}"><div class="grow"><p>${esc(text)}</p>
<div><a class="btn small" href="/portal/apps/${esc(failed[0].name)}/logs?type=build">${icon('hammer')}${esc(t(lang, 'sum.err.link'))}</a></div></div></div>`;
  }
  const down = mine.filter((a) => isDown(a));
  if (down.length) {
    const text = down.length === 1 ? t(lang, 'sum.down', { app: prettyName(down[0].name) }) : t(lang, 'sum.down.many', { n: down.length });
    return `<div class="notice fix" role="status"><img class="art" src="/assets/img/da-sistemare.svg?v=6" alt="${esc(t(lang, 'art.fix'))}"><div class="grow"><p>${esc(text)}</p>
<div class="row"><form class="inline" method="post" action="/portal/apps/${esc(down[0].name)}/restart"><button class="btn small">${icon('restart')}${esc(t(lang, 'act.restart'))}</button></form><a class="btn small quiet" href="/portal/apps/${esc(down[0].name)}/logs">${icon('doc')}${esc(t(lang, 'act.logs'))}</a></div></div></div>`;
  }
  return ''; // all calm: nothing to say (the lighthouse on each app already tells its state)
}

/** The one celebration: the very first app went online in the last two minutes. The lighthouse lights up. */
function firstAppNotice(lang: Lang, mine: App[], history: Record<string, Publication[]>, versions: Record<string, number>): string {
  if (mine.length !== 1) return '';
  const a = mine[0];
  const last = history[a.name]?.at(-1);
  const justNow = !!a.last_deploy_at && Date.now() - parseDate(a.last_deploy_at) < 120_000;
  if (!justNow || a.status !== 'active' || last?.result !== 'running' || (versions[a.name] ?? 0) !== 1) return '';
  const app = prettyName(a.name);
  return `<div class="notice celebrate" role="status"><img class="art" src="/assets/img/prima-app.svg?v=6" alt="${esc(t(lang, 'art.first'))}"><div class="grow"><h3>${esc(t(lang, 'first.title'))}</h3>
<p>${esc(t(lang, 'first.text', { app, url: a.url.replace(/^https?:\/\//, '') }))}</p>
<div><a class="btn primary" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(t(lang, 'first.open', { app }))}</a></div></div></div>`;
}

/** Notice shown after pausing an app, with a one-click way back. */
export function undoNotice(lang: Lang, text: string, app: string): string {
  return `<div class="notice plain" role="status">${icon('pause')}<p>${esc(text)}</p><form class="inline" method="post" action="/portal/apps/${esc(app)}/start" style="margin-left:auto"><button class="btn small">${esc(t(lang, 'act.undo'))}</button></form></div>`;
}

export function home({ lang, u, mine, flash = '', admin, history = {}, versions = {}, fresh, engineOk = true }: HomeData): string {
  const hasToken = !!u.token_prefix && !!u.token_expires_at && !u.revoked_at;
  const published = mine.length > 0;
  const connected = hasToken && (!!u.token_used_at || published); // an app published with the key means the AI is connected
  const done = [hasToken, connected, published].filter(Boolean).length;
  const phrase = t(lang, 'step3.phrase1');
  const say = (id: string) => `<div class="say"><span class="chip" id="${id}">«${esc(phrase)}»</span><button class="copy" type="button" data-copy="${id}" data-done="${esc(t(lang, 'copied'))}">${esc(t(lang, 'copy'))}</button></div>`;
  const keyForm = (primary: boolean) => `<form method="post" action="/portal/token"><button class="btn${primary ? ' primary' : ''}">${icon('key')}${esc(t(lang, hasToken ? 'step1.renew' : 'step1.button'))}</button></form>`;

  const task = (ok: boolean, now: boolean, title: string, body: string) =>
    `<div class="task${ok ? ' done' : now ? ' now' : ''}"><span class="tick">${ok ? icon('check') : ''}</span><span class="title">${esc(title)}</span>${now ? `<div class="body">${body}</div>` : ''}</div>`;
  const checklist = done < 3 ? `<section class="surface check" id="steps" aria-labelledby="steps-h">
<div class="head"><h2 id="steps-h">${esc(t(lang, 'steps.title'))}</h2><span class="muted">${esc(t(lang, 'steps.progress', { done }))}</span></div>
<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${done}"><span style="transform:scaleX(${(done / 3).toFixed(3)})"></span></div>
${task(hasToken, !hasToken, t(lang, 'step1.title'), `<p>${esc(t(lang, 'step1.text', { days: config.policy.tokenDays }))}</p><div>${keyForm(true)}</div>`)}
${task(connected, hasToken && !connected, t(lang, 'step2.title'), `<p>${esc(t(lang, 'step2.text'))}</p>${connectBlock(lang, { token: fresh?.token, hasToken })}<p>${esc(t(lang, 'step2.waiting'))}</p>`)}
${task(published, connected && !published, t(lang, 'step3.title'), `<p>${esc(t(lang, 'step3.text'))}</p>${say('say1')}`)}
</section>` : '';

  const list = published
    ? `<ul class="apps surface">${mine.map((a) => appRow(lang, a, history[a.name])).join('')}</ul>`
    : `<div class="surface empty"><img class="art" src="/assets/img/barca.svg?v=6" alt="${esc(t(lang, 'art.boat'))}"><div class="txt"><h2>${esc(t(lang, 'apps.empty.title'))}</h2><p class="muted">${esc(t(lang, 'apps.empty.text'))}</p>${say('say2')}</div></div>`;
  const keyInfo = hasToken ? `<p class="muted mono">${esc(t(lang, 'step1.active', { prefix: u.token_prefix!, date: day(u.token_expires_at) }))}</p>` : '';
  const extra = done === 3 ? `<details class="more" id="connect"><summary>${icon('chevron')}${esc(t(lang, 'more.connect'))}</summary><div>${keyInfo}<div>${keyForm(false)}</div>${connectBlock(lang, { hasToken, keyAbove: true })}</div></details>` : '';
  // the key just created: in the checklist, step 2 already shows how to connect (with the key in it)
  const tokenBox = (fresh ? tokenNotice(lang, fresh.token, fresh.expiresAt, done === 3) : '') + (engineOk === false ? engineNotice(lang) : '') + firstAppNotice(lang, mine, history, versions);
  const apps = `<section aria-labelledby="apps-h"><div class="head"><h2 id="apps-h">${esc(t(lang, 'apps.title'))}</h2></div>${list}${extra ? `<div style="margin-top:14px">${extra}</div>` : ''}</section>`;

  const name = u.name ?? u.email.split('@')[0];
  const where = config.network === 'local' ? t(lang, 'home.where.local') : config.network === 'lan' ? t(lang, 'home.where.lan') : t(lang, 'home.where.server', { domain: config.baseDomain });
  const bar = commandBar(lang, u, mine, { admin: !!admin, hasToken, connectId: done === 3 ? 'connect' : 'steps', history });
  const sub = published ? summary(lang, mine, history) : `<p class="muted">${esc(where)}</p>`;
  const body = `<div class="hello"><h1>${esc(t(lang, 'home.hello', { name }))}</h1>${sub}</div>${bar}${flash}${tokenBox}
<div class="stack">${checklist}${apps}</div>`;
  return page(lang, config.brand, body, { user: u, engineOk, search: true });
}

/** Every app and every person (administrators): lives on the Settings page, not on the home page. */
export function adminSection(lang: Lang, admin: AdminData): string {
    const abtn = (name: string, action: string, label: string, extraAttr = '') =>
      `<form class="inline" method="post" action="/portal/admin/apps/${esc(name)}/${action}"${extraAttr}>${action === 'delete' ? '<input type="hidden" name="confirm">' : ''}<button class="btn small${action === 'delete' ? ' danger' : ' quiet'}">${esc(label)}</button></form>`;
    const appRows = admin.apps.map((a) => `<tr><td><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a></td><td>${esc(a.owner)}</td><td><span class="state ${esc(a.status)}">${beacon(a.status)}${esc(t(lang, `status.${a.status}`))}</span></td>
<td><div class="row">${a.status === 'active' ? abtn(a.name, 'archive', t(lang, 'admin.archive')) : abtn(a.name, 'restore', t(lang, 'admin.restore'))}${abtn(a.name, 'delete', t(lang, 'admin.delete'), ` data-prompt="${esc(t(lang, 'admin.delete.prompt', { app: a.name }))}"`)}</div></td></tr>`).join('');
    const userRows = admin.users.map((x) => `<tr><td>${esc(x.email)}${x.name ? `<div class="muted">${esc(x.name)}</div>` : ''}</td><td>${esc(t(lang, `admin.role.${x.role}`))}</td>
<td class="mono">${x.token_prefix && !x.revoked_at ? `${esc(x.token_prefix)}… ${esc(day(x.token_expires_at))}` : esc(t(lang, 'admin.notoken'))}</td><td>${esc(x.active_apps)}</td>
<td><div class="row">${config.auth.mode === 'local' ? `<form class="inline" method="post" action="/portal/admin/password" data-confirm="${esc(t(lang, 'admin.newpw.confirm', { email: x.email }))}"><input type="hidden" name="email" value="${esc(x.email)}"><button class="btn small quiet">${esc(t(lang, 'admin.newpw'))}</button></form>` : ''}${x.token_prefix && !x.revoked_at ? `<form class="inline" method="post" action="/portal/admin/revoke"><input type="hidden" name="email" value="${esc(x.email)}"><button class="btn small danger">${esc(t(lang, 'admin.revoke'))}</button></form>` : ''}</div></td></tr>`).join('');
    const addUser = config.auth.mode === 'local' ? `<div class="surface add" id="adduser"><h3>${esc(t(lang, 'admin.adduser'))}</h3><p class="muted">${esc(t(lang, 'admin.adduser.text'))}</p>
<form class="form" method="post" action="/portal/admin/users"><label>${esc(t(lang, 'login.email'))}<input type="email" name="email" required></label>
<label>${esc(t(lang, 'login.password'))}<input type="password" name="password" minlength="10" autocomplete="new-password" required></label>
<label class="check-row"><input type="checkbox" name="admin" value="1"> ${esc(t(lang, 'admin.make_admin'))}</label><div><button class="btn">${esc(t(lang, 'admin.add'))}</button></div></form></div>` : '';
    return `<section class="admin" aria-labelledby="admin-h"><div class="head"><h2 id="admin-h">${esc(t(lang, 'admin.title'))}</h2><span class="muted">${esc(t(lang, 'admin.engine'))}: ${esc(admin.engine)}</span></div>
<h3>${esc(t(lang, 'admin.apps'))}</h3><div class="surface tbl"><table><thead><tr><th>${esc(t(lang, 'apps.col.app'))}</th><th>${esc(t(lang, 'admin.col.owner'))}</th><th>${esc(t(lang, 'apps.col.status'))}</th><th>${esc(t(lang, 'apps.col.actions'))}</th></tr></thead><tbody>${appRows}</tbody></table></div>
<h3>${esc(t(lang, 'admin.users'))}</h3><div class="surface tbl"><table><thead><tr><th>${esc(t(lang, 'admin.col.email'))}</th><th>${esc(t(lang, 'admin.col.role'))}</th><th>${esc(t(lang, 'admin.col.token'))}</th><th>${esc(t(lang, 'admin.col.apps'))}</th><th></th></tr></thead><tbody>${userRows}</tbody></table></div>${addUser}</section>`;
}

export const memLabel = (m: string) => m.replace(/^(\d+)\s*([mg])$/i, (_s, n, u) => `${n} ${u.toLowerCase() === 'g' ? 'GB' : 'MB'}`);
const gb = (lang: Lang, mb: number) => (mb / 1024).toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 1 });

function meter(label: string, used: number, total: number, text: string): string {
  const pct = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
  return `<div class="res"><div class="res-h"><b>${esc(label)}</b><span class="muted">${esc(text)}</span></div>
<div class="progress${pct > 0.85 ? ' high' : ''}" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}" aria-valuetext="${esc(text)}"><span style="transform:scaleX(${pct.toFixed(3)})"></span></div></div>`;
}

/** What the Check button found (null: not asked) and your certificate, when HTTPS uses it. */
export interface NetData { check: CheckLine[] | null; cert: CertInfo | null; id: string }

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Settings: where the portal and the apps open (this computer, the local network, the internet), whether there is
 *  HTTPS, a Check of the names and of the certificate, and the exact command to change it. Names and certificates
 *  are the user's: the page only explains, checks and gives the command. */
function networkSection(lang: Lang, wsl: boolean, net?: NetData): string {
  const n = config.network;
  const vars = { portal: config.publicUrl, example: appUrl('notes') };
  const ip = config.lanIp;
  const domain = n === 'local' ? 'app.tuaazienda.it' : config.baseDomain;
  const name = lang === 'it' ? 'app.tuaazienda.it' : 'apps.example.com';
  const hint = (key: string, v: Record<string, string | number> = {}) => `<p class="hint muted">${esc(t(lang, key, v))}</p>`;
  const line = (state: 'ok' | 'warn' | 'bad', text: string) => `<li class="summary${state === 'ok' ? ' ok' : ' warn'}">${icon(state === 'ok' ? 'ok' : 'alert')}<span>${esc(text)}</span></li>`;

  // HTTPS now
  let https = '';
  if (n !== 'local') {
    const c = net?.cert;
    https = config.https === 'off' ? hint('set.net.https.off')
      : config.https === 'letsencrypt' ? hint('set.net.https.le')
      : c && !c.placeholder ? (c.daysLeft < 30
        ? `<p class="summary warn">${icon('alert')}<span>${esc(t(lang, c.daysLeft < 0 ? 'set.net.https.own.expired' : 'set.net.https.own.soon', { until: isoDay(c.validTo), days: c.daysLeft }))}</span></p>`
        : hint('set.net.https.own.until', { until: isoDay(c.validTo) }))
      : hint('set.net.https.own');
  }

  // Check: on this machine (DNS and certificate as Apprua sees them) and from this device (the browser)
  let check = '';
  if (n !== 'local') {
    const lines = net?.check;
    const probe = `${config.appScheme}://verifica-${Math.random().toString(36).slice(2, 8)}.${config.baseDomain}/_apprua/ping`;
    const results = lines ? `<ul class="drift" aria-live="polite">${lines.map((l) => line(l.state, t(lang, `net.check.${l.key}`, l.vars ?? {}))).join('')}
<li class="summary" id="net-dev" data-url="${esc(probe)}" data-id="${esc(net!.id)}" data-ok="${esc(t(lang, 'net.check.device.ok'))}" data-bad="${esc(t(lang, 'net.check.device.bad'))}">${icon('globe')}<span>${esc(t(lang, 'net.check.device.wait'))}</span></li></ul>
<script>(function(){var e=document.getElementById('net-dev');if(!e)return;var c=new AbortController();setTimeout(function(){c.abort();},6000);
function done(ok){e.className='summary'+(ok?' ok':' warn');e.querySelector('span').textContent=ok?e.dataset.ok:e.dataset.bad;}
fetch(e.dataset.url,{cache:'no-store',signal:c.signal}).then(function(r){return r.json();}).then(function(j){done(j&&j.apprua===e.dataset.id);}).catch(function(){done(false);});})();</script>
<p class="hint muted">${esc(t(lang, 'net.check.note'))}</p>` : '';
    check = `<p><a class="btn" href="/settings?check=net#net-h">${esc(t(lang, 'set.net.check'))}</a></p>${results}`;
  }

  // How to change it: the name in the DNS (up to the user), then the command
  const ps = (args: string) => `powershell -ExecutionPolicy Bypass -File install\\windows\\install-apprua.ps1 ${args}`;
  const sh = (vars: string) => `sudo ${vars} bash install/install.sh`;
  const certPc = lang === 'it' ? '-Cert C:\\certificati\\cert.pem -CertKey C:\\certificati\\chiave.pem' : '-Cert C:\\certs\\cert.pem -CertKey C:\\certs\\key.pem';
  const certSrv = 'APPRUA_CERT=/root/cert.pem APPRUA_CERT_KEY=/root/key.pem';
  const dnsStep = hint('set.net.dns', { name: n === 'local' ? name : domain, ip: ip || t(lang, 'set.net.dns.thisip') });
  let change: string;
  if (wsl) {
    change = n === 'local'
      ? `${hint('set.net.to.lan')}<ol class="steps"><li>${dnsStep}</li><li>${esc(t(lang, 'set.net.run'))}${snippet(ps(`-Network lan -Domain ${name}`), lang)}</li></ol>
${hint('set.net.https.how', { name })}${snippet(ps(`-Network lan -Domain ${name} ${certPc}`), lang)}`
      : `${hint('set.net.rename')}${snippet(ps(`-Network lan -Domain ${name}`), lang)}
${hint(config.https === 'own' ? 'set.net.https.renew' : 'set.net.https.how', { name: domain })}${snippet(ps(`-Network lan ${certPc}`), lang)}
${config.https === 'own' ? `${hint('set.net.https.remove')}${snippet(ps('-Network lan -Https off'), lang)}` : ''}
${hint('set.net.change.pc.back')}${snippet(ps('-Network local'), lang)}`;
    change = `${hint('set.net.change.pc')}${change}`;
  } else {
    change = `${hint('set.net.change.server')}${dnsStep}
${hint('set.net.to.lan.server')}${snippet(sh(`APPRUA_NETWORK=lan APPRUA_DOMAIN=${n === 'lan' ? domain : name}`), lang)}
${hint(config.https === 'own' ? 'set.net.https.renew' : 'set.net.https.how', { name: n === 'local' ? name : domain })}${snippet(sh(`APPRUA_NETWORK=${n === 'internet' ? 'internet' : 'lan'} APPRUA_DOMAIN=${n === 'local' ? name : domain} ${certSrv}`), lang)}
${hint('set.net.to.internet')}${snippet(sh(`APPRUA_NETWORK=internet APPRUA_DOMAIN=${n === 'internet' ? domain : name}${config.https === 'own' && n === 'internet' ? ' APPRUA_HTTPS=letsencrypt' : ''}`), lang)}
${n !== 'local' ? `${hint('set.net.change.pc.back')}${snippet(sh('APPRUA_NETWORK=local'), lang)}` : ''}`;
  }
  const teamLocal = n === 'local' && config.profile === 'team' ? `<p class="summary warn">${icon('alert')}<span>${esc(t(lang, 'set.net.team.local'))}</span></p>` : '';
  return `<section aria-labelledby="net-h"><div class="head"><h2 id="net-h">${esc(t(lang, 'set.net.title'))}</h2></div>
<div class="surface set"><div class="res-h"><b>${esc(t(lang, `set.net.${n}`))}</b></div><p>${esc(t(lang, `set.net.${n}.text`, vars))}</p>
${https}${n === 'lan' && ip ? hint('set.net.ip', { ip, domain }) : ''}${n !== 'local' ? hint(gateOn() ? 'set.net.gate' : 'set.net.open') : ''}${teamLocal}${check}
<details class="more"><summary>${icon('chevron')}${esc(t(lang, 'set.net.change'))}</summary><div>${change}</div></details></div></section>`;
}

/** Settings (administrators): what the machine can hold, the rules, who Apprua is for. */
export function settingsPage(lang: Lang, u: User, r: Resources, flash = '', engineOk = true, admin?: AdminData): string {
  const team = config.profile === 'team';
  // ----- resources
  const disk = r.diskTotalMb !== null && r.diskFreeMb !== null
    ? meter(t(lang, 'set.res.disk'), r.diskTotalMb - r.diskFreeMb, r.diskTotalMb, t(lang, 'set.res.disk.text', { free: gb(lang, r.diskFreeMb), total: gb(lang, r.diskTotalMb) }))
    : `<div class="res-h"><b>${esc(t(lang, 'set.res.disk'))}</b><span class="muted">${esc(t(lang, 'set.res.disk.unknown'))}</span></div>`;
  const full = r.appsOn >= r.fitOn;
  const fit = `<div class="fit"><b>${esc(t(lang, 'set.res.fit', { mem: memLabel(config.policy.defaultMemory), n: r.fitOn, on: r.appsOn }))}</b>
${r.fitNew !== null ? `<p>${esc(t(lang, 'set.res.fitnew', { n: r.fitNew }))}</p>` : ''}<p>${esc(t(lang, 'set.res.note'))}</p></div>`;
  const vmGb = Math.round(r.memTotalMb / 1024);
  const suggest = r.hostMemoryGb ? Math.max(vmGb, Math.min(r.hostMemoryGb - 4, vmGb + 4)) : vmGb + 4;
  const more = r.wsl
    ? `<details class="more"${full ? ' open' : ''}><summary>${icon('chevron')}${esc(t(lang, 'set.res.more'))}</summary><div>
<p class="muted">${esc(r.hostMemoryGb ? t(lang, 'set.res.pc', { pc: r.hostMemoryGb, vm: vmGb }) : t(lang, 'set.res.vm', { vm: vmGb }))}</p>
<ol class="steps"><li>${esc(t(lang, 'set.res.step1'))}</li><li>${esc(t(lang, 'set.res.step2', { gb: suggest }))}${snippet(`powershell -ExecutionPolicy Bypass -File install\\windows\\install-apprua.ps1 -SetMemoryGB ${suggest}`, lang)}</li><li>${esc(t(lang, 'set.res.step3'))}</li></ol></div></details>`
    : `<p class="muted">${esc(t(lang, 'set.res.server'))}</p>`;
  const resources = `<section aria-labelledby="res-h"><div class="head"><h2 id="res-h">${esc(t(lang, 'set.res.title'))}</h2><span class="muted">${esc(t(lang, r.wsl || config.baseDomain === 'localhost' ? 'set.res.where.pc' : 'set.res.where.server'))}</span></div>
<div class="surface set">${meter(t(lang, 'set.res.mem'), r.memUsedMb, r.memTotalMb, t(lang, 'set.res.mem.text', { used: gb(lang, r.memUsedMb), total: gb(lang, r.memTotalMb) }))}${disk}
${fit}${full ? `<p class="summary warn">${icon('alert')}<span>${esc(t(lang, 'set.res.full'))}</span></p>` : ''}${more}
${r.wsl ? `<p class="muted">${esc(t(lang, 'set.res.startup'))}</p>` : ''}</div></section>`;

  // ----- rules
  const lk = lockedRules();
  const locked = (on: boolean, v: string) => (on ? `<span class="hint">${esc(t(lang, 'set.locked', { var: v }))}</span>` : '');
  const dis = (on: boolean) => (on ? ' disabled' : '');
  const pol = config.policy;
  const memOpts = MEMORY_CHOICES.filter((m) => memoryMb(m) <= pol.maxMemoryMb);
  if (!pol.memoryAuto && !memOpts.includes(pol.defaultMemory)) memOpts.push(pol.defaultMemory);
  const autoOpt = lk.memory ? '' : `<option value="auto"${pol.memoryAuto ? ' selected' : ''}>${esc(t(lang, 'set.memory.auto', { mem: memLabel(pol.memoryAuto ? pol.defaultMemory : autoAppMemory(undefined, pol.maxMemoryMb)) }))}</option>`;
  const memSel = `<label>${esc(t(lang, 'set.memory'))}<select name="memory"${dis(lk.memory)}>${autoOpt}${memOpts.map((m) => `<option value="${esc(m)}"${!pol.memoryAuto && m === pol.defaultMemory ? ' selected' : ''}>${esc(memLabel(m))}</option>`).join('')}</select>
<span class="hint">${esc(t(lang, pol.memoryAuto ? 'set.memory.hint.auto' : 'set.memory.hint'))}</span>${locked(lk.memory, 'DEFAULT_MEMORY')}</label>`;
  const months = (m: number) => `<option value="${m}"${config.policy.reviewMonths === m ? ' selected' : ''}>${esc(t(lang, `setup.review.${m}`))}</option>`;
  const teamRules = team ? `<label>${esc(t(lang, 'setup.quota'))}<input type="number" name="quota" min="1" max="100" value="${config.policy.defaultQuota}" required${dis(lk.quota)}>${locked(lk.quota, 'DEFAULT_QUOTA')}</label>
<label>${esc(t(lang, 'setup.review'))}<select name="review"${dis(lk.reviewMonths)}>${[6, 12, 0].map(months).join('')}</select><span class="hint">${esc(t(lang, 'setup.review.text'))}</span>${locked(lk.reviewMonths, 'REVIEW_MONTHS')}</label>` : '';
  const rules = `<section aria-labelledby="rules-h"><div class="head"><h2 id="rules-h">${esc(t(lang, 'set.rules.title'))}</h2></div>
<form class="surface set form" method="post" action="/settings/rules">${teamRules}${memSel}<div><button class="btn primary">${esc(t(lang, 'set.save'))}</button></div></form></section>`;

  // ----- who it is for
  const opt = (p: 'personal' | 'team', ic: string) => {
    const cur = config.profile === p;
    return `<label class="choice"><span class="ico">${icon(ic)}</span><span class="txt"><b>${esc(t(lang, p === 'personal' ? 'setup.me.title' : 'setup.team.title'))}</b>${cur ? `<span class="badge">${esc(t(lang, 'set.use.current'))}</span>` : ''}
<span>${esc(t(lang, p === 'personal' ? 'setup.me.text' : 'setup.team.text'))}</span></span><input type="radio" name="profile" value="${p}"${cur ? ' checked' : ''}></label>`;
  };
  const use = `<section aria-labelledby="use-h"><div class="head"><h2 id="use-h">${esc(t(lang, 'set.use.title'))}</h2></div>
<form class="surface set form" method="post" action="/settings/profile" data-confirm="${esc(t(lang, 'set.use.confirm'))}"><div class="choices">${opt('personal', 'user')}${opt('team', 'users')}</div>
<p class="hint muted">${esc(t(lang, 'set.use.hint'))}</p><div><button class="btn">${esc(t(lang, 'set.use.submit'))}</button></div></form></section>`;

  const body = `<div class="hello"><a class="back-link" href="/">${icon('chevron')}${esc(t(lang, 'set.back'))}</a><h1>${esc(t(lang, 'set.title'))}</h1></div>${flash}
<div class="stack">${resources}${networkSection(lang, r.wsl, admin?.net)}${rules}${use}${admin ? adminSection(lang, admin) + engineSection(lang, admin, r.wsl) + updatesSection(lang, admin, r.wsl) : ''}</div>`;
  return page(lang, `${t(lang, 'set.title')} · ${config.brand}`, body, { user: u, engineOk });
}

/** Example address used in texts (kept for callers that show where apps go online). */
export const exampleUrl = () => appUrl('my-app');
