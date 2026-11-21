// Phase 10 Scorekeeper: all state lives in localStorage, so a refresh mid-game loses nothing.
"use strict";

// ------------------------------------------------------------------ auto-save to the Game Night server
// When this page is served by game-night-server, every save also goes to its SQLite database.
// On GitHub Pages there's no /api, the health check fails, and this quietly does nothing.
const Sync = (() => {
  let enabled = false, sending = false;
  const queue = new Map(), failed = new Map();   // keyed by game id, so two games never overwrite each other
  const ready = fetch("/api/health", { cache: "no-store" })
    .then((r) => r.ok && (r.headers.get("content-type") || "").includes("json"))
    .then((ok) => { enabled = Boolean(ok); if (enabled) show("Connected to the game server"); })
    .catch(() => {});

  function show(text, bad = false) {
    const el = document.getElementById("syncStatus");
    if (el) { el.textContent = text; el.style.color = bad ? "var(--red, #c00)" : ""; }
  }

  // Each save sends the whole game, so a later save also fixes any earlier one that failed.
  async function save(id, gameType, state) {
    await ready;
    if (!enabled || !id) return;
    queue.set(id, JSON.stringify({ game_type: gameType, state }));  // newer state for the same game replaces older
    flush();
  }

  async function flush() {
    if (sending) return;            // the running loop picks up anything queued meanwhile
    sending = true;
    while (queue.size) {
      const [id, body] = queue.entries().next().value;
      queue.delete(id);
      try {
        const r = await fetch(`/api/games/${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body,
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        failed.delete(id);
        show("✓ Saved to the game server");
      } catch (err) {
        failed.set(id, body);
        show(`Not saved to the server yet (${err.message}). It will retry on the next save.`, true);
      }
    }
    sending = false;
  }

  const retry = () => { failed.forEach((body, id) => queue.has(id) || queue.set(id, body)); flush(); };
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) retry(); });

  return { save, ready: () => ready.then(() => enabled) };
})();

// crypto.randomUUID() only works on https or localhost. Over http://klisby it's undefined,
// so build an id from the time plus random letters instead.
const newGameId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const STORE_KEY = "phase10-league:current";
const PALETTE = ["var(--blue)", "var(--red)", "var(--green)", "var(--orange)", "var(--purple)", "var(--teal)"];
const PHASES = [
  "2 sets of 3", "1 set of 3 + 1 run of 4", "1 set of 4 + 1 run of 4", "1 run of 7", "1 run of 8",
  "1 run of 9", "2 sets of 4", "7 cards of one color", "1 set of 5 + 1 set of 2", "1 set of 5 + 1 set of 3",
];

// state = { label, players: ["Justin", ...], hands: [[{made, pts}, ...one per player], ...] }
let state = load();
if (state && !state.id) state.id = newGameId("p10"); // games started before auto-save
let draft = [];          // the hand being entered: [{made, pts}] per player

const $ = (id) => document.getElementById(id);
// Names go into innerHTML, so escape them. Without this, a name like "<img onerror=...>" runs as code.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ storage
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
}
function save() {
  if (state) Sync.save(state.id, "phase10", state);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { toast("Couldn't save in this browser. Export a CSV to be safe."); }
}

// ------------------------------------------------------------------ scoring (mirrors builder/build_site.py)
function computePlayers() {
  const players = state.players.map((name, i) => {
    const made = state.hands.map((h) => h[i].made);
    const pts = state.hands.map((h) => h[i].pts);
    let run = 0, done = 0;
    const cum = [], attempts = [];
    made.forEach((m, k) => { attempts.push(done + 1); done += m ? 1 : 0; run += pts[k]; cum.push(run); });
    return { name, seat: i, made, pts, cum, attempts, phases: done, total: run, misses: made.filter((m) => !m).length };
  });
  // Rank: most phases first, then fewest points. Colors follow rank once a hand is in; seat order before that.
  const ranked = [...players].sort((a, b) => b.phases - a.phases || a.total - b.total);
  const order = state.hands.length ? ranked : players;
  order.forEach((p, i) => { p.color = PALETTE[i % PALETTE.length]; });
  return { players, ranked };
}
const isOver = (ranked) => ranked.length > 0 && ranked[0].phases >= 10;

// ------------------------------------------------------------------ setup view
function renderSetup() {
  $("setup").classList.remove("hidden");
  $("game").classList.add("hidden");
  const list = $("nameList");
  if (!list.children.length) ["", "", ""].forEach(addNameRow);
  $("gameLabel").value ||= "";
}
function addNameRow(value = "") {
  const n = $("nameList").children.length + 1;
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<input type="text" id="name${n}" aria-label="Player ${n} name" placeholder="Player ${n}" maxlength="20" value="${esc(value)}">
    <button class="iconbtn" type="button" aria-label="Remove player ${n}">×</button>`;
  row.querySelector("button").onclick = () => row.remove();
  $("nameList").appendChild(row);
}
function startGame() {
  const names = [...$("nameList").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  const lower = names.map((n) => n.toLowerCase());
  if (names.length < 2) return ($("setupErr").textContent = "Add at least two players.");
  if (new Set(lower).size !== names.length) return ($("setupErr").textContent = "Two players have the same name. Add an initial to tell them apart.");
  const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  state = { id: newGameId("p10"), label: $("gameLabel").value.trim() || today, players: names, hands: [] };
  save();
  render();
}

// ------------------------------------------------------------------ game view
function render() {
  if (!state) return renderSetup();
  $("setup").classList.add("hidden");
  $("game").classList.remove("hidden");

  const { players, ranked } = computePlayers();
  const over = isOver(ranked);
  const handNo = state.hands.length + 1;

  // hero
  const leader = ranked[0];
  $("gameEyebrow").textContent = `${state.label} · ${state.hands.length} ${state.hands.length === 1 ? "hand" : "hands"} played`;
  if (!state.hands.length) {
    $("headline").textContent = "Shuffle up";
    $("subline").textContent = `${players.length} players, everyone starting on Phase 1. Enter the first hand below.`;
  } else if (over) {
    const tied = ranked[1] && ranked[1].phases === leader.phases;
    $("headline").innerHTML = `<em style="color:${leader.color}">${esc(leader.name)}</em> takes the crown${tied ? " on the tiebreaker" : ""}`;
    $("subline").innerHTML = tied
      ? `${esc(leader.name)} and ${esc(ranked[1].name)} both completed ${leader.phases} phases. ${esc(leader.name)} wins with <strong>${leader.total} points</strong> to ${ranked[1].total}.`
      : `${esc(leader.name)} finished Phase 10 with <strong>${leader.total} points</strong>.`;
  } else {
    $("headline").innerHTML = `<em style="color:${leader.color}">${esc(leader.name)}</em> leads after hand ${state.hands.length}`;
    $("subline").innerHTML = `On Phase ${leader.phases + 1} with <strong>${leader.total} points</strong>.`;
  }
  $("heroCard").style.setProperty("--champ", leader.color);
  document.querySelectorAll("#heroCard [data-n]").forEach((el) => (el.textContent = over ? leader.phases : leader.phases + 1));
  $("heroRibbon").textContent = over ? "Champion" : state.hands.length ? "Leader" : "Phase";

  // entry vs game over
  $("entrySection").classList.toggle("hidden", over);
  $("overSection").classList.toggle("hidden", !over);
  $("undoBtn").disabled = !state.hands.length;
  if (over) {
    $("banner").style.setProperty("--champ", leader.color);
    $("banner").innerHTML = `<div class="eyebrow" style="color:#fff;opacity:.85;margin:0">Game over</div>
      <h2>${esc(leader.name)} wins</h2>
      <div>Download the CSV to keep this game, then start a new one.</div>
      <div class="row" style="margin-top:8px"><button class="btn small" style="border-color:#fff;color:#fff" type="button" onclick="undoHand()">Undo last hand</button></div>`;
  } else {
    $("entryTitle").textContent = `Hand ${handNo}`;
    if (draft.length !== players.length) draft = players.map(() => ({ made: false, pts: "" }));
    renderEntry(players);
  }

  renderPodium(ranked);
  renderLadder(players);
  renderChart(players);
}

function renderEntry(players) {
  $("entryRows").innerHTML = players.map((p, i) => {
    const phase = p.phases + 1;
    const d = draft[i];
    return `<div class="erow" style="--c:${p.color}">
      <div><div class="pname">${esc(p.name)}</div><div class="ptask">Phase ${phase}: ${PHASES[phase - 1]}</div></div>
      <button type="button" class="toggle" aria-pressed="${d.made}" data-made="${i}">${d.made ? "✓ Made it" : "Made phase?"}</button>
      <div class="pts">
        <input type="number" inputmode="numeric" min="0" step="5" id="pts${i}" aria-label="${esc(p.name)} points" placeholder="Points" value="${d.pts}">
        <div class="quick"><button type="button" data-out="${i}">Went out</button><button type="button" data-add="${i}" data-v="5">+5</button><button type="button" data-add="${i}" data-v="10">+10</button><button type="button" data-add="${i}" data-v="15">+15</button><button type="button" data-add="${i}" data-v="25">+25</button></div>
      </div>
    </div>`;
  }).join("");
}

function renderPodium(ranked) {
  const sfx = (n) => (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");
  $("podium").innerHTML = ranked.map((p, i) => `
    <article class="pcard" style="--c:${p.color}">
      <div style="display:flex;justify-content:space-between;align-items:end;gap:10px">
        <div class="name">${esc(p.name)}</div><div class="place">${i + 1}${sfx(i + 1)}</div>
      </div>
      <span class="tag">${p.phases >= 10 ? "Finished Phase 10" : "On Phase " + (p.phases + 1)}</span>
      <dl class="stats num">
        <dt>Phases completed</dt><dd>${p.phases} of 10</dd>
        <dt>Total points</dt><dd>${p.total}</dd>
        <dt>Phases missed</dt><dd>${p.misses}</dd>
      </dl>
    </article>`).join("");
}

function renderLadder(players) {
  const n = state.hands.length;
  $("ladderSection").classList.toggle("hidden", !n);
  const grid = $("ladder");
  grid.style.setProperty("--hands", n || 1);
  let html = "<div></div>";
  for (let h = 1; h <= n; h++) html += `<div class="hh">Hand ${h}</div>`;
  players.forEach((p) => {
    html += `<div class="who" style="color:${p.color}">${esc(p.name)}</div>`;
    p.made.forEach((m, k) => {
      html += `<div class="chip ${m ? "made" : "miss"}" style="--c:${p.color}" title="Hand ${k + 1}: Phase ${p.attempts[k]} ${m ? "made" : "missed"}, ${p.pts[k]} points">${p.attempts[k]}<small>${p.pts[k]}</small></div>`;
    });
  });
  grid.innerHTML = html;
}

function renderChart(players) {
  const n = state.hands.length;
  $("raceSection").classList.toggle("hidden", n < 2);
  if (n < 2) return;
  const svg = $("chart"), W = 900, H = 360, L = 48, R = 110, T = 16, B = 40;
  const top = Math.max(50, Math.ceil(Math.max(...players.map((p) => p.total)) / 50) * 50);
  const step = top <= 400 ? 50 : 100;
  const x = (i) => L + (W - L - R) * (i / (n - 1)), y = (v) => T + (H - T - B) * (1 - v / top);
  let s = "";
  for (let v = 0; v <= top; v += step) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let i = 0; i < n; i++) s += `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${i + 1}</text>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Hand</text>`;
  players.forEach((p) => {
    const d = p.cum.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    s += `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(n - 1)}" cy="${y(p.total)}" r="5" fill="${p.color}"/>`;
  });
  const labels = players.map((p) => ({ p, y: y(p.total) })).sort((a, b) => a.y - b.y);
  labels.forEach((l, i) => { if (i && l.y - labels[i - 1].y < 16) l.y = labels[i - 1].y + 16; });
  labels.forEach(({ p, y: ly }) => (s += `<text x="${W - R + 10}" y="${ly + 4}" style="fill:${p.color};font-weight:700">${esc(p.name)} ${p.total}</text>`));
  svg.innerHTML = s;
  $("chartKey").innerHTML = players.map((p) => `<span style="--c:${p.color}">${esc(p.name)}</span>`).join("");
}

// ------------------------------------------------------------------ hand entry
$("entryRows").addEventListener("click", (e) => {
  const t = e.target;
  if (t.dataset.made !== undefined) {
    const d = draft[+t.dataset.made];
    d.made = !d.made;
    t.setAttribute("aria-pressed", d.made);
    t.textContent = d.made ? "✓ Made it" : "Made phase?";
  } else if (t.dataset.out !== undefined) {
    setPts(+t.dataset.out, 0);
  } else if (t.dataset.add !== undefined) {
    const i = +t.dataset.add;
    setPts(i, (Number(draft[i].pts) || 0) + Number(t.dataset.v));
  }
});
$("entryRows").addEventListener("input", (e) => {
  const m = e.target.id.match(/^pts(\d+)$/);
  if (m) draft[+m[1]].pts = e.target.value;
});
function setPts(i, v) { draft[i].pts = v; $("pts" + i).value = v; }

$("entryForm").addEventListener("submit", (e) => {
  e.preventDefault(); // GitHub Pages has no server to submit to
  const errs = [];
  const hand = draft.map((d, i) => {
    const raw = String(d.pts).trim();
    const pts = Number(raw);
    if (raw === "") errs.push(`${state.players[i]} needs points (tap "Went out" for 0).`);
    else if (!Number.isInteger(pts) || pts < 0 || pts % 5) errs.push(`${state.players[i]}'s points should be 0 or a multiple of 5.`);
    return { made: d.made, pts };
  });
  if (!hand.some((h) => h.pts === 0) && !errs.length) errs.push("Someone has to go out with 0 points to end a hand.");
  if (errs.length) return ($("entryErr").textContent = errs[0]);
  $("entryErr").textContent = "";
  state.hands.push(hand);
  draft = [];
  save();
  render();
  toast(`Hand ${state.hands.length} saved`);
});

function undoHand() {
  if (!state.hands.length) return;
  confirmThen(`Remove hand ${state.hands.length}? Its scores will go back into the entry form.`, () => {
    draft = state.hands.pop().map((h) => ({ made: h.made, pts: h.pts }));
    save();
    render();
  });
}
$("undoBtn").onclick = undoHand;

// ------------------------------------------------------------------ export / new game
function toCSV() {
  // Same columns as the score sheet's Hand Log, so builder/build_site.py reads it directly.
  const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  const lines = ["Hand,Player,Made phase?,Points"];
  state.hands.forEach((hand, h) => hand.forEach((r, i) => lines.push([h + 1, q(state.players[i]), r.made ? "TRUE" : "FALSE", r.pts].join(","))));
  return lines.join("\n") + "\n";
}
const fileName = () => (state.label || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".csv";
$("exportBtn").onclick = () => {
  const url = URL.createObjectURL(new Blob([toCSV()], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName() });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("copyBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(toCSV()); toast("CSV copied"); }
  catch { toast("Copy was blocked. Use Download CSV instead."); }
};
$("newBtn").onclick = () => confirmThen("Start a new game? This one is cleared from this browser, so download the CSV first if you want to keep it.", () => {
  const names = state.players;
  state = null; draft = [];
  try { localStorage.removeItem(STORE_KEY); } catch {}
  $("nameList").innerHTML = "";
  names.forEach(addNameRow); // same players again, ready to edit
  $("gameLabel").value = "";
  render();
});

// ------------------------------------------------------------------ small UI helpers
function confirmThen(text, onYes) {
  $("confirmText").textContent = text;
  $("confirmDlg").classList.remove("hidden");
  $("confirmYes").focus();
  $("confirmYes").onclick = () => { $("confirmDlg").classList.add("hidden"); onYes(); };
  $("confirmNo").onclick = () => $("confirmDlg").classList.add("hidden");
}
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

$("addName").onclick = () => addNameRow();
$("startGame").onclick = startGame;
$("phaseList").innerHTML = PHASES.map((t, i) => {
  const c = ["var(--red)", "var(--blue)", "var(--green)", "var(--yellow)"][i % 4];
  return `<li><span class="n" style="background:${c};${i % 4 === 3 ? "color:#1b1d24" : ""}">${i + 1}</span><span>${t}</span></li>`;
}).join("");

render();
