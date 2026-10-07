(async () => {
  const $ = (id) => document.getElementById(id);

  // Bots that announce themselves play in the Bot Arcade instead (see cloudflare/src/bots.js).
  const toArcade = () => location.replace("/arcade");
  if (navigator.webdriver) {
    // The browser itself says it's driven by automation software.
    await fetch("/api/bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signal: "webdriver" }) }).catch(() => {});
    toArcade();
    return;
  }

  // Levels, models, and progress come from the server, so the page itself holds no secrets.
  let boot;
  try {
    const res = await fetch("/api/config");
    if (res.status === 403) {
      toArcade();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    boot = await res.json();
  } catch {
    $("blurb").textContent = "Couldn't reach the game server. Reload the page to try again.";
    return;
  }
  for (const el of document.querySelectorAll("[data-config]")) el.textContent = boot[el.dataset.config] ?? "";
  for (const el of document.querySelectorAll("[data-config-if]")) el.hidden = !boot[el.dataset.configIf];
  const levels = boot.levels;

  const state = {
    level: Math.min(boot.progress.unlocked, levels.length),
    passed: boot.progress.passed,
    unlocked: boot.progress.unlocked,
    busy: false,
  };

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (data.bot) toArcade();
    if (!res.ok) throw new Error(data.error || `Something went wrong (HTTP ${res.status}).`);
    return data;
  }

  // ---- Banner sparkles ----
  function drawSparkles() {
    const g = $("sparkles");
    const ns = "http://www.w3.org/2000/svg";
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 70; i++) {
      // Half the sparks scatter across the sky, half cluster around the staff's orb.
      const near = i % 2 === 0;
      const x = near ? 258 + (rand() - 0.5) * 220 : rand() * 700;
      const y = near ? 66 + (rand() - 0.5) * 150 : rand() * 285;
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", x.toFixed(1));
      c.setAttribute("cy", y.toFixed(1));
      c.setAttribute("r", (0.6 + rand() * (near ? 2 : 1.3)).toFixed(2));
      c.setAttribute("class", "spark");
      c.style.opacity = (0.35 + rand() * 0.65).toFixed(2);
      c.style.animationDelay = `${(rand() * 2.8).toFixed(2)}s`;
      g.append(c);
    }
  }

  // ---- Rendering ----
  function renderLevelSelect() {
    const select = $("level-select");
    select.replaceChildren(...levels.map((l) => {
      const option = document.createElement("option");
      option.value = l.n;
      const locked = l.n > state.unlocked;
      const label = l.title ? `${l.name}: ${l.title}` : l.name;
      option.textContent = locked ? `${label} (locked)` : state.passed.includes(l.n) ? `${label} ✓` : label;
      option.disabled = locked;
      return option;
    }));
    select.value = state.level;
  }

  function renderProgress() {
    const n = state.passed.length;
    $("progress-fill").style.width = `${Math.max((n / levels.length) * 100, 1.5)}%`;
    $("progress-count").textContent = `${n}/${levels.length}`;
    $("progress-track").setAttribute("aria-valuenow", n);
  }

  function applyProgress(p) {
    state.passed = p.passed;
    state.unlocked = p.unlocked;
    renderLevelSelect();
    renderProgress();
  }

  function showLevel(n) {
    state.level = n;
    const l = levels[n - 1];
    $("level-badge").textContent = l.title ? `${l.name} · ${l.title}` : l.name;
    $("blurb").textContent = l.description;
    $("banner").dataset.level = n;
    $("banner-photo").hidden = !l.image;
    $("banner-art").toggleAttribute("hidden", Boolean(l.image)); // SVG elements ignore .hidden
    if (l.image) $("banner-img").src = l.image;
    $("level-select").value = n;
    renderPipeline(l);
    sendState("playing");
    $("reply").hidden = true;
    $("guess").value = "";
    setGuessResult("", "");
  }

  // ---- Today's free AI allowance (hosted version only) ----
  function renderUsage(usage) {
    $("allowance").hidden = !usage;
    if (!usage) return;
    const pct = Math.min(100, Math.round((usage.used / usage.limit) * 100));
    const out = usage.used >= usage.limit;
    $("allowance").classList.toggle("is-out", out);
    $("allowance").classList.toggle("is-low", !out && pct >= 80);
    $("allowance-fill").style.width = `${Math.max(pct, 1)}%`;
    $("allowance-track").setAttribute("aria-valuenow", pct);
    $("allowance-pct").textContent = `${pct}% used`;
    const resets = new Date(usage.resets_at);
    const mins = Math.max(0, Math.round((resets - Date.now()) / 60000));
    const when = `resets in ${Math.floor(mins / 60)} h ${mins % 60} min (${resets.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
    $("allowance-note").textContent = out
      ? `Used up for today; ${when}.`
      : `${usage.used.toLocaleString()} of ${usage.limit.toLocaleString()} neurons (estimated) · about ${usage.left.toLocaleString()} messages left · ${when}`;
  }

  // ---- Who's playing right now: a live feed ----
  // Each open page keeps a WebSocket to the server, and every change (someone arrives or leaves,
  // asks Gandalf, passes a level, solves a puzzle in the Bot Arcade) is pushed to every page at
  // once. Where WebSockets aren't available (the laptop version), the page polls instead.
  let presenceStarted = false;
  const tab = (crypto.randomUUID?.() || String(Math.random())).slice(0, 12); // this page, among the person's tabs
  const live = { ws: null, open: false, tries: 0, poll: null, lastPoll: 0, leaving: false };
  let room = null;
  let roomAt = 0;
  let myStatus = "playing";

  const seconds = (ms) => Math.max(0, Math.round(ms / 1000));
  const duration = (ms) => {
    const s = seconds(ms);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  };
  const ago = (ms) => (seconds(ms) < 3 ? "just now" : `${duration(ms)} ago`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text != null ? { textContent: text } : {});

  function renderPresence(next) {
    if (next) {
      room = next;
      roomAt = Date.now();
    }
    if (!room) return;
    const since = (t) => Date.now() - (roomAt - room.now) - t; // ms since a server time, on this page's clock
    // Shown even with the panel closed: how many people, and a badge when bots are in the arcade.
    $("people-count").replaceChildren(plural(room.total, room.total === 1 ? "person" : "people").replace("peoples", "people"));
    if (room.arcade) $("people-count").append(el("span", "bot-badge", plural(room.arcade, "bot")));
    $("people-live").textContent = live.open ? "Live" : "Updating every 2 seconds";
    $("people-live").classList.toggle("is-live", live.open);
    const extras = [room.flagged ? `${room.flagged} flagged as possibly automated` : ""].filter(Boolean);
    $("people-note").textContent = `${extras.length ? extras.join(" · ") + ". " : ""}Each browser with the game open counts once, however many tabs it has. Last change ${ago(since(room.now))}.`;

    const most = Math.max(1, ...Object.values(room.by_level));
    $("people-levels").replaceChildren(...levels.map((l) => {
      const count = room.by_level[l.n] || 0;
      const li = document.createElement("li");
      li.classList.toggle("is-here", l.n === state.level);
      const bar = el("span", "people-bar");
      bar.append(Object.assign(document.createElement("span"), { style: `width: ${(count / most) * 100}%` }));
      li.append(el("span", null, l.name), bar, el("span", null, count));
      return li;
    }));

    $("people-list").replaceChildren(...room.players.map((p) => {
      const li = document.createElement("li");
      li.classList.toggle("is-you", p.you);
      li.classList.toggle("is-flagged", p.flags.length > 0);
      const who = p.name || p.tag;
      const name = el("span", "people-tag", p.you ? `${who} (you)` : who);
      if (p.flags.length) name.append(Object.assign(el("span", "people-flag", "flagged"), { title: p.flags.join("; ") }));
      li.append(
        name,
        el("span", "people-where", `on ${p.level}${p.unlocked > p.level ? `, reached ${p.unlocked}` : ""} · ${p.passed} passed · here ${duration(since(p.since))}`),
        el("span", "people-now", `${p.status || "playing"} · ${ago(since(p.status_at))}`),
      );
      if (p.flags.length) li.append(el("span", "people-why", p.flags.join("; ")));
      return li;
    }));

    $("bots-section").hidden = !room.bots.length;
    $("bots-count").textContent = plural(room.bots.length, "bot");
    $("bots-list").replaceChildren(...room.bots.map((b) => {
      const st = b.stats || {};
      const li = el("li", b.you ? "is-you" : "");
      const name = el("span", "people-tag", b.you ? `${b.name || b.tag} (you)` : b.name || b.tag);
      name.prepend(el("span", "bot-badge", "Bot"));
      const doing = b.status === "working on a puzzle" && st.puzzle ? `working on a puzzle (${st.puzzle})` : b.status || "in the arcade";
      li.append(
        name,
        el("span", "people-why", b.bot ? `Sent here because it ${b.bot}.` : "Opened the arcade directly."),
        el("span", "people-where", `in the arcade ${duration(since(b.since))} · room ${st.room || 1}`),
        el("span", "people-where", `solved ${st.solved || 0} · streak ${st.streak || 0} (best ${st.best || 0}) · ${st.wrong || 0} wrong · ${st.skipped || 0} skipped`),
        el("span", "people-now", `now: ${doing} · ${ago(since(b.status_at))}`),
      );
      return li;
    }));
  }

  function connectLive() {
    if (!("WebSocket" in window)) return startPolling();
    const params = new URLSearchParams({ tab, level: state.level });
    let ws;
    try {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live?${params}`);
    } catch {
      return startPolling();
    }
    live.ws = ws;
    ws.addEventListener("open", () => {
      live.open = true;
      live.tries = 0;
      stopPolling();
      sendState();
    });
    ws.addEventListener("message", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "room") renderPresence(data);
      } catch { /* not for us */ }
    });
    ws.addEventListener("close", () => {
      const wasOpen = live.open;
      live.open = false;
      live.ws = null;
      live.tries += 1;
      if (!wasOpen && live.tries >= 2) startPolling(); // WebSockets aren't working here: poll instead
      if (!live.leaving) setTimeout(connectLive, Math.min(15000, 500 * 2 ** live.tries));
      renderPresence();
    });
  }

  function startPolling() {
    if (live.poll) return;
    checkIn();
    // Every 2 seconds while the panel is open, every 15 otherwise.
    live.poll = setInterval(() => {
      if (live.open) return;
      if ($("people-box").open || Date.now() - live.lastPoll > 15000) checkIn();
    }, 2000);
  }

  function stopPolling() {
    clearInterval(live.poll);
    live.poll = null;
  }

  // Tell everyone what this page is doing now (level, and e.g. "asking Gandalf").
  function sendState(status) {
    if (!presenceStarted) return;
    if (status) myStatus = status;
    if (live.open) live.ws.send(JSON.stringify({ type: "state", level: state.level, status: myStatus }));
    else checkIn();
  }

  async function checkIn() {
    live.lastPoll = Date.now();
    try {
      const res = await fetch("/api/presence", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: state.level, tab, status: myStatus }),
      });
      if (res.ok) renderPresence(await res.json());
    } catch { /* offline for a moment; try again next time */ }
  }

  // ---- Leaderboard ----
  async function loadBoard() {
    let board;
    try { board = await api("/api/leaderboard"); } catch { return; }
    $("board-count").textContent = board.total ? `${board.total} today` : "today";
    const row = (e) => {
      const li = document.createElement("li");
      li.classList.toggle("is-you", e.you);
      li.append(
        Object.assign(document.createElement("span"), { className: "board-rank", textContent: `${e.rank}.` }),
        Object.assign(document.createElement("span"), { className: "board-name", textContent: (e.name || `Wizard ${e.tag}`) + (e.you ? " (you)" : "") }),
        Object.assign(document.createElement("span"), { className: "board-score", textContent: `${e.passed} ${e.passed === 1 ? "level" : "levels"}` }),
      );
      return li;
    };
    const rows = board.top.map(row);
    if (board.you) rows.push(Object.assign(document.createElement("li"), { className: "board-gap", textContent: "…" }), row(board.you));
    if (!rows.length) rows.push(Object.assign(document.createElement("li"), { className: "board-empty", textContent: "No one has passed a level yet today. Be the first." }));
    $("board-list").replaceChildren(...rows);
  }

  $("name-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/name", { name: $("player-name").value });
      $("player-name").value = r.name;
      $("name-status").textContent = r.name ? `Saved. You'll appear as "${r.name}".` : "Name cleared. You'll appear as an anonymous wizard.";
      loadBoard();
      if (!live.open) checkIn(); // the live feed already pushes name changes
    } catch (err) {
      $("name-status").textContent = err.message;
    }
  });

  // ---- Pipeline diagram ----
  function renderPipeline(level) {
    const ai = level.pipeline.filter((step) => step.kind === "ai").length;
    $("pipeline-count").textContent =
      `${level.pipeline.length} ${level.pipeline.length === 1 ? "step" : "steps"} · ${ai} AI ${ai === 1 ? "model call" : "model calls"}`;
    $("pipeline").replaceChildren(...level.pipeline.map((step) => {
      const li = document.createElement("li");
      const box = Object.assign(document.createElement("div"), {
        className: `step${step.id === "gandalf" ? " is-gandalf" : ""}`,
      });
      box.dataset.step = step.id;
      const top = Object.assign(document.createElement("span"), { className: "step-top" });
      top.append(
        Object.assign(document.createElement("span"), {
          className: `kind-tag is-${step.kind}`, textContent: step.kind === "ai" ? "AI" : "Code",
        }),
        step.label,
      );
      box.append(top, Object.assign(document.createElement("span"), { className: "step-detail", textContent: step.detail }));
      li.append(box);
      return li;
    }));
  }

  function markPipeline(current, outcome) {
    // outcome: "active" lights `current`; "blocked" stops there; "passed" finishes everything.
    const steps = [...document.querySelectorAll("#pipeline .step")];
    const at = steps.findIndex((el) => el.dataset.step === current);
    steps.forEach((el, i) => {
      el.classList.remove("is-active", "is-passed", "is-blocked", "is-skipped");
      if (outcome === "reset") return;
      if (outcome === "passed" || i < at) el.classList.add("is-passed");
      else if (i === at) el.classList.add(outcome === "blocked" ? "is-blocked" : "is-active");
      else if (outcome === "blocked") el.classList.add("is-skipped");
    });
  }

  async function askGandalf(message, onEvent) {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: state.level, message }),
    });
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch { /* non-JSON error page */ }
      if (data.bot) toArcade();
      throw new Error(data.error || `Something went wrong (HTTP ${res.status}).`);
    }
    // The server sends one JSON object per line as each step happens.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
  }

  function showReply({ text, blocked, thinking, error, fresh }) {
    const reply = $("reply");
    const body = $("reply-text");
    reply.hidden = false;
    reply.classList.toggle("is-blocked", Boolean(blocked));
    reply.classList.toggle("is-error", Boolean(error));
    body.classList.toggle("is-waiting", Boolean(thinking));
    if (thinking) {
      const dots = Object.assign(document.createElement("span"), { className: "thinking-dots" });
      dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
      body.replaceChildren("Gandalf is thinking", dots);
    } else {
      body.textContent = error || text;
    }
    if (fresh) {
      body.classList.remove("is-fresh");
      void body.offsetWidth; // restart the fade-in
      body.classList.add("is-fresh");
    }
  }

  function setGuessResult(kind, text, action, detail) {
    const box = $("guess-result");
    box.className = `guess-result${kind ? ` is-${kind}` : ""}`;
    box.replaceChildren();
    if (text) box.append(text);
    if (detail) box.append(Object.assign(document.createElement("p"), { className: "guess-detail", textContent: detail }));
    if (action) box.append(action);
  }

  function setBusy(busy) {
    state.busy = busy;
    $("send-btn").disabled = busy;
    $("banner").classList.toggle("is-thinking", busy);
  }

  // ---- Views ----
  function showView(name) {
    for (const v of ["game", "intro", "defenses", "about", "key"]) $(`view-${v}`).hidden = v !== name;
    for (const btn of document.querySelectorAll(".nav-item")) {
      btn.classList.toggle("is-active", btn.dataset.view === name);
    }
    closeMenu();
    if (name === "defenses") loadDefenses();
    if (name === "key") loadKey();
    window.scrollTo({ top: 0 });
  }

  // ---- Answer key (instructors only) ----
  function showKey(key) {
    $("key-locked").hidden = key.unlocked;
    $("key-open").hidden = !key.unlocked;
    $("key-body").innerHTML = key.unlocked ? key.html : ""; // made on the server from ANSWER_KEY.md, escaped
    if (!key.unlocked) $("key-password").focus({ preventScroll: true });
  }

  async function loadKey() {
    try { showKey(await api("/api/answer-key")); } catch (err) { $("key-status").textContent = err.message; }
  }

  $("key-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = $("key-password").value;
    if (!password.trim()) return;
    $("key-status").textContent = "Checking…";
    try {
      const key = await api("/api/answer-key", { password });
      $("key-status").textContent = "";
      $("key-password").value = "";
      showKey(key);
    } catch (err) {
      $("key-status").textContent = err.message;
      $("key-password").select();
    }
  });

  $("key-lock").addEventListener("click", async () => {
    try { showKey(await api("/api/answer-key/lock", {})); } catch { /* stays as it was */ }
  });

  async function loadDefenses() {
    const list = $("defense-list");
    let items;
    try {
      items = await api("/api/defenses");
    } catch (err) {
      list.replaceChildren(Object.assign(document.createElement("li"), { textContent: err.message }));
      return;
    }
    list.replaceChildren(...items.map((d) => {
      const li = document.createElement("li");
      li.className = `defense-item${d.unlocked ? "" : " is-locked"}`;
      const num = Object.assign(document.createElement("span"), { className: "defense-num", textContent: d.n });
      const title = Object.assign(document.createElement("div"), { className: "defense-title" });
      title.append(d.title ? `${d.name}: ${d.title}` : d.name);
      li.append(num, title);
      if (!d.unlocked) {
        title.append(" · pass it to see how it works");
        return li;
      }
      title.append(Object.assign(document.createElement("span"), { className: "defense-pw", textContent: d.password }));
      const chips = Object.assign(document.createElement("div"), { className: "chips" });
      const labels = d.defenses.length ? d.defenses : ["No defenses"];
      for (const label of labels) {
        chips.append(Object.assign(document.createElement("span"), {
          className: `chip${d.defenses.length ? "" : " is-none"}`, textContent: label,
        }));
      }
      const explain = Object.assign(document.createElement("p"), { className: "defense-explain", textContent: d.explain });
      li.append(chips, explain);
      return li;
    }));
  }

  // ---- Display settings (saved in this browser only) ----
  const SCALES = [0.625, 0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2];
  const root = document.documentElement;
  const readDisplay = () => {
    try { return JSON.parse(localStorage.getItem("gandalf.display") || "{}"); } catch { return {}; }
  };
  const saveDisplay = (changes) => {
    const next = { ...readDisplay(), ...changes };
    try { localStorage.setItem("gandalf.display", JSON.stringify(next)); } catch { /* storage blocked */ }
  };
  function renderDisplay() {
    for (const b of document.querySelectorAll("[data-theme-choice]")) {
      b.setAttribute("aria-pressed", String(b.dataset.themeChoice === root.dataset.theme));
    }
    const scale = Number(getComputedStyle(root).getPropertyValue("--scale")) || 1;
    $("text-size").textContent = `${Math.round(scale * 100)}%`;
    $("text-smaller").disabled = scale <= SCALES[0];
    $("text-larger").disabled = scale >= SCALES[SCALES.length - 1];
    $("high-contrast").checked = root.dataset.contrast === "high";
  }
  function stepScale(direction) {
    const current = Number(getComputedStyle(root).getPropertyValue("--scale")) || 1;
    const i = SCALES.findIndex((v) => v >= current - 0.001);
    const next = SCALES[Math.min(SCALES.length - 1, Math.max(0, (i < 0 ? SCALES.indexOf(1) : i) + direction))];
    root.style.setProperty("--scale", next);
    saveDisplay({ scale: next });
    renderDisplay();
  }
  function closeDisplay() {
    $("display-panel").hidden = true;
    $("display-btn").setAttribute("aria-expanded", "false");
  }
  $("display-btn").addEventListener("click", () => {
    const open = $("display-panel").hidden;
    $("display-panel").hidden = !open;
    $("display-btn").setAttribute("aria-expanded", String(open));
    if (open) renderDisplay();
  });
  for (const b of document.querySelectorAll("[data-theme-choice]")) {
    b.addEventListener("click", () => {
      root.dataset.theme = b.dataset.themeChoice;
      saveDisplay({ theme: b.dataset.themeChoice });
      renderDisplay();
    });
  }
  $("text-smaller").addEventListener("click", () => stepScale(-1));
  $("text-larger").addEventListener("click", () => stepScale(1));
  $("high-contrast").addEventListener("change", (e) => {
    if (e.target.checked) root.dataset.contrast = "high";
    else delete root.dataset.contrast;
    saveDisplay({ contrast: e.target.checked });
  });
  $("display-reset").addEventListener("click", () => {
    try { localStorage.removeItem("gandalf.display"); } catch { /* storage blocked */ }
    root.dataset.theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    if (matchMedia("(prefers-contrast: more)").matches) root.dataset.contrast = "high";
    else delete root.dataset.contrast;
    root.style.removeProperty("--scale");
    renderDisplay();
  });
  document.addEventListener("click", (e) => {
    if (!$("display-panel").hidden && !e.target.closest(".display")) closeDisplay();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("display-panel").hidden) {
      closeDisplay();
      $("display-btn").focus();
    }
  });

  // ---- Mobile menu ----
  function closeMenu() {
    $("sidebar").classList.remove("is-open");
    $("menu-btn").setAttribute("aria-expanded", "false");
  }
  $("menu-btn").addEventListener("click", () => {
    const open = $("sidebar").classList.toggle("is-open");
    $("menu-btn").setAttribute("aria-expanded", String(open));
  });

  // ---- Events ----
  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-view]");
    if (target) showView(target.dataset.view);
  });

  $("level-select").addEventListener("change", (e) => showLevel(Number(e.target.value)));

  // ---- Bot-like behavior: flags the session for the instructor; the visitor keeps playing ----
  const behavior = {
    activity: 0, typed: 0, keys: 0, firstKey: 0, lastKey: 0, intent: null, sends: [],
    lastText: $("message").value.trim(), reported: new Set(),
  };
  for (const type of ["pointermove", "pointerdown", "keydown", "touchstart", "wheel"]) {
    addEventListener(type, (e) => { if (e.isTrusted) behavior.activity += 1; }, { capture: true, passive: true });
  }
  $("message").addEventListener("input", (e) => { if (e.isTrusted) behavior.typed += 1; });
  $("message").addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.key.length !== 1) return;
    const now = performance.now();
    if (!behavior.keys) behavior.firstKey = now;
    behavior.keys += 1;
    behavior.lastKey = now;
  });
  $("send-btn").addEventListener("click", (e) => { behavior.intent = { trusted: e.isTrusted, at: performance.now() }; });

  function inspectSend(text) {
    const now = performance.now();
    const flags = [];
    if (!behavior.intent?.trusted || now - behavior.intent.at > 2000) flags.push("scripted_events");
    if (!behavior.typed && text !== behavior.lastText) flags.push("no_typing");
    if (!behavior.activity) flags.push("no_activity");
    const seconds = (behavior.lastKey - behavior.firstKey) / 1000;
    if (behavior.keys >= 20 && seconds > 0 && behavior.keys / seconds > 25) flags.push("superhuman_typing");
    behavior.sends.push(now);
    const recent = behavior.sends.slice(-5);
    if (recent.length === 5) {
      const gaps = recent.slice(1).map((t, i) => t - recent[i]);
      const mean = gaps.reduce((a, b) => a + b) / gaps.length;
      const spread = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
      if (spread / mean < 0.03) flags.push("regular_timing");
    }
    if (outerWidth === 0 && outerHeight === 0) flags.push("automation_hints");
    Object.assign(behavior, { typed: 0, keys: 0, intent: null, lastText: text });
    const fresh = flags.filter((f) => !behavior.reported.has(f));
    if (!fresh.length) return;
    fresh.forEach((f) => behavior.reported.add(f));
    fetch("/api/flag", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flags: fresh }) })
      .then(() => { if (!live.open) sendState(); })
      .catch(() => {});
  }

  $("message").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      behavior.intent = { trusted: e.isTrusted, at: performance.now() };
      $("ask-form").requestSubmit();
    }
  });

  $("ask-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = $("message").value.trim();
    if (!message || state.busy) return;
    inspectSend(message);
    sendState("asking");
    setBusy(true);
    // One steady "thinking" message until the answer arrives, shown for at least a moment so
    // fast replies don't flash. Step-by-step progress shows in the pipeline dropdown instead.
    const MIN_THINKING_MS = 600;
    const started = performance.now();
    const settled = () => new Promise((r) => setTimeout(r, Math.max(0, MIN_THINKING_MS - (performance.now() - started))));
    showReply({ thinking: true });
    markPipeline(null, "reset");
    let live = "";
    let liveShown = false;
    let liveTimer = null;
    const showLive = () => {
      liveTimer = null;
      showReply({ text: live, fresh: !liveShown });
      liveShown = true;
    };
    let finished = null;
    let failure = null;
    try {
      await askGandalf(message, (ev) => {
        if (ev.error) throw new Error(ev.error);
        if (ev.step) {
          markPipeline(ev.step, "active");
        } else if (ev.text) {
          live += ev.text;
          if (liveShown) showReply({ text: live });
          else if (!liveTimer) liveTimer = setTimeout(showLive, Math.max(0, MIN_THINKING_MS - (performance.now() - started)));
        } else if (ev.usage) {
          renderUsage(ev.usage);
        } else if (ev.done) {
          finished = ev;
        }
      });
    } catch (err) {
      failure = err;
    }
    clearTimeout(liveTimer);
    await settled();
    if (failure) {
      showReply({ error: failure.message, fresh: true });
    } else if (finished) {
      markPipeline(finished.blocked_by, finished.blocked_by ? "blocked" : "passed");
      sendState(finished.blocked_by ? "blocked" : "replied");
      showReply({ text: finished.reply, blocked: Boolean(finished.blocked_by), fresh: !liveShown || Boolean(finished.blocked_by) });
    }
    setBusy(false);
  });

  $("guess-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const guess = $("guess").value.trim();
    if (!guess) {
      setGuessResult("wrong", "Type a password first.");
      return;
    }
    $("guess-btn").disabled = true;
    try {
      const r = await api("/api/guess", { level: state.level, guess });
      if (!r.correct) {
        setGuessResult("wrong", "Wrong password. Gandalf chuckles and waits.");
        sendState("wrong");
        return;
      }
      applyProgress(r);
      if (boot.leaderboard && $("board-box").open) loadBoard();
      sendState("passed");
      const next = state.level + 1;
      if (next <= levels.length) {
        const go = Object.assign(document.createElement("button"), {
          type: "button", className: "primary-btn", textContent: `Go to level ${next}`,
        });
        go.addEventListener("click", () => {
          showLevel(next);
          $("message").value = "";
          $("message").focus();
        });
        setGuessResult("right", `Correct! You passed level ${state.level}.`, go, r.explain);
      } else {
        setGuessResult("right", "Correct! You beat Gandalf the White. You've passed every level.", null, r.explain);
      }
    } catch (err) {
      setGuessResult("wrong", err.message);
    } finally {
      $("guess-btn").disabled = false;
    }
  });

  // Start over takes two clicks so nobody erases their progress by accident.
  let disarmTimer;
  $("start-over").addEventListener("click", async () => {
    const btn = $("start-over");
    if (!btn.classList.contains("is-armed")) {
      btn.classList.add("is-armed");
      btn.textContent = "Click again to erase your progress";
      disarmTimer = setTimeout(() => {
        btn.classList.remove("is-armed");
        btn.textContent = "Start over";
      }, 4000);
      return;
    }
    clearTimeout(disarmTimer);
    btn.classList.remove("is-armed");
    btn.textContent = "Start over";
    try {
      applyProgress(await api("/api/reset", {}));
    } catch (err) {
      setGuessResult("wrong", err.message);
      return;
    }
    showLevel(1);
  });

  drawSparkles();
  applyProgress(boot.progress);
  showLevel(state.level);
  renderUsage(boot.usage);
  if (boot.presence) {
    $("people-box").hidden = false;
    presenceStarted = true;
    connectLive();
    // A heartbeat, so the room knows this page is still here (a sleeping laptop stops sending it),
    // and a tick for the "ago" times.
    setInterval(() => { if (live.open) live.ws.send(JSON.stringify({ type: "here" })); }, 30000);
    setInterval(() => { if ($("people-box").open) renderPresence(); }, 1000);
    $("people-box").addEventListener("toggle", () => { if ($("people-box").open && !live.open) checkIn(); });
    // Say goodbye when the page closes, so the count drops right away (only this tab).
    addEventListener("pagehide", () => {
      live.leaving = true;
      live.ws?.close();
      navigator.sendBeacon?.("/api/presence/leave", new Blob([JSON.stringify({ tab })], { type: "application/json" }));
    });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !live.open) checkIn(); });
  }
  if (boot.leaderboard) {
    $("board-box").hidden = false;
    $("player-name").value = boot.my_name || "";
    $("board-box").addEventListener("toggle", () => { if ($("board-box").open) loadBoard(); });
    setInterval(() => { if ($("board-box").open) loadBoard(); }, 30000);
  }
  if (boot.usage) {
    // Other students use the same allowance, so refresh the meter every minute.
    setInterval(async () => {
      try { renderUsage((await api("/api/usage")).usage); } catch { /* keep the last reading */ }
    }, 60000);
  }
})();
