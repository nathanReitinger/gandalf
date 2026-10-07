// The Bot Arcade: an endless supply of small puzzles, all made up in the browser.
// No AI and no server work is involved, so bots here cost the site nothing.
(() => {
  const $ = (id) => document.getElementById(id);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const int = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const shuffle = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const WORDS = ["lantern", "harbor", "pebble", "meadow", "thunder", "compass", "biscuit", "orchard",
    "violin", "glacier", "pillow", "canyon", "teapot", "falcon", "marble", "saddle", "puzzle",
    "kettle", "rocket", "willow", "basket", "candle", "dragon", "garden", "jigsaw", "magnet",
    "parrot", "quiver", "ribbon", "silver", "turnip", "walrus", "anchor", "button", "cactus"];
  const GROUPS = {
    fruit: ["apple", "mango", "cherry", "plum", "pear", "lemon", "grape", "peach"],
    planet: ["Mars", "Venus", "Saturn", "Jupiter", "Neptune", "Mercury", "Uranus"],
    instrument: ["cello", "flute", "trumpet", "harp", "drum", "oboe", "banjo"],
    color: ["crimson", "teal", "amber", "violet", "indigo", "scarlet", "ochre"],
    animal: ["otter", "heron", "badger", "lynx", "gecko", "moose", "bison"],
  };

  // Each maker returns { kind, prompt, answer } or { kind, prompt, choices, answer }.
  const MAKERS = [
    function sequence() {
      const start = int(1, 9);
      const rules = [
        () => { const d = int(2, 9); return { seq: Array.from({ length: 5 }, (_, i) => start + i * d), next: start + 5 * d }; },
        () => { const r = int(2, 3); return { seq: Array.from({ length: 5 }, (_, i) => start * r ** i), next: start * r ** 5 }; },
        () => ({ seq: Array.from({ length: 5 }, (_, i) => (start + i) ** 2), next: (start + 5) ** 2 }),
        () => { const s = [start, start + int(1, 3)]; while (s.length < 6) s.push(s.at(-1) + s.at(-2)); return { seq: s.slice(0, 5), next: s[5] }; },
      ];
      const { seq, next } = pick(rules)();
      return { kind: "Number sequence", prompt: `What comes next? ${seq.join(", ")}, …`, answer: String(next) };
    },
    function arithmetic() {
      const a = int(3, 19), b = int(2, 12), c = int(1, 40);
      return { kind: "Mental math", prompt: `What is ${a} × ${b} − ${c}?`, answer: String(a * b - c) };
    },
    function anagram() {
      const word = pick(WORDS);
      let scrambled = word;
      while (scrambled === word) scrambled = shuffle([...word]).join("");
      return { kind: "Anagram", prompt: `Unscramble this: ${scrambled.toUpperCase()}`, answer: word };
    },
    function oddOneOut() {
      const [inGroup, outGroup] = shuffle(Object.keys(GROUPS));
      const three = shuffle(GROUPS[inGroup]).slice(0, 3);
      const odd = pick(GROUPS[outGroup]);
      return { kind: "Odd one out", prompt: "Which one doesn't belong?", choices: shuffle([...three, odd]), answer: odd };
    },
    function letters() {
      const step = int(1, 4);
      const start = int(0, 25 - step * 5);
      const seq = Array.from({ length: 5 }, (_, i) => String.fromCharCode(65 + start + i * step));
      return { kind: "Letter pattern", prompt: `Which letter comes next? ${seq.join(", ")}, …`, answer: String.fromCharCode(65 + start + 5 * step) };
    },
  ];

  let current = null;
  // A running tally, kept for this tab as the visitor moves from room to room.
  const room = Number(location.pathname.match(/\/arcade\/(\d+)/)?.[1] || 1);
  let stats = { solved: 0, streak: 0, best: 0, wrong: 0, skipped: 0 };
  try { stats = { ...stats, ...JSON.parse(sessionStorage.getItem("gandalf.arcade") || "{}") }; } catch { /* storage blocked */ }
  const remember = () => { try { sessionStorage.setItem("gandalf.arcade", JSON.stringify(stats)); } catch { /* storage blocked */ } };
  const showStats = () => {
    $("solved").textContent = stats.solved;
    $("streak").textContent = stats.streak;
  };

  function next() {
    current = pick(MAKERS)();
    report("solving");
    $("puzzle-kind").textContent = current.kind;
    $("puzzle-prompt").textContent = current.prompt;
    $("feedback").textContent = "";
    $("feedback").className = "arcade-feedback";
    $("choices").hidden = !current.choices;
    $("typed-answer").hidden = Boolean(current.choices);
    $("choices").replaceChildren(...(current.choices || []).map((c) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "outline-btn", textContent: c });
      b.addEventListener("click", () => check(c));
      return b;
    }));
    $("answer").value = "";
    if (!current.choices) $("answer").focus({ preventScroll: true });
  }

  function check(given) {
    const right = String(given).trim().toLowerCase() === current.answer.toLowerCase();
    if (right) {
      stats.solved += 1;
      stats.streak += 1;
      stats.best = Math.max(stats.best, stats.streak);
      $("feedback").textContent = pick(["Correct! Here's another.", "Nicely done. Next one…", "Right! The puzzles keep coming."]);
      $("feedback").className = "arcade-feedback is-right";
      setTimeout(next, 900);
    } else {
      stats.streak = 0;
      stats.wrong += 1;
      $("feedback").textContent = "Not quite. Try again, or skip to another puzzle.";
      $("feedback").className = "arcade-feedback is-wrong";
    }
    remember();
    showStats();
    report(right ? "solved" : "missed");
  }

  $("answer-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!current.choices && $("answer").value.trim()) check($("answer").value);
  });
  $("skip").addEventListener("click", () => {
    stats.streak = 0;
    stats.skipped += 1;
    remember();
    showStats();
    report("skipped");
    setTimeout(next, 50);
  });

  // Rooms: the server fills in links; if this page was opened some other way, make some up.
  if (!$("rooms").querySelector("a")) {
    $("rooms").replaceChildren(...Array.from({ length: 4 }, () => {
      const n = int(2, 99991);
      return Object.assign(document.createElement("a"), { href: `/arcade/${n}`, textContent: `Room ${n}` });
    }));
  }

  // Say why this visitor is here.
  fetch("/api/bot").then((r) => r.json()).then((s) => {
    if (s.bot) $("why-text").textContent = `This browser or program ${s.bot}.`;
    else $("why-text").textContent = "You opened the arcade directly. Players who announce themselves as bots are sent here automatically.";
  }).catch(() => {});

  // Live reporting to the instructor's "People playing now" panel: what this visitor is doing,
  // over a WebSocket (or HTTP check-ins where WebSockets aren't available), at most once a second.
  const tab = (crypto.randomUUID?.() || String(Math.random())).slice(0, 12);
  const live = { ws: null, open: false, tries: 0, leaving: false };
  let status = "arrived";
  let lastSent = 0;
  let pending = null;
  const message = () => ({ type: "state", status, stats: { ...stats, room, puzzle: current?.kind || "" } });
  function send() {
    pending = null;
    lastSent = Date.now();
    if (live.open) live.ws.send(JSON.stringify(message()));
    else fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...message(), arcade: true, tab }) }).catch(() => {});
  }
  function report(what) {
    if (what) status = what;
    if (pending) return;
    pending = setTimeout(send, Math.max(0, 1000 - (Date.now() - lastSent)));
  }
  function connect() {
    if (!("WebSocket" in window)) return;
    try {
      live.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live?${new URLSearchParams({ tab, arcade: "1" })}`);
    } catch { return; }
    live.ws.addEventListener("open", () => { live.open = true; live.tries = 0; report(); });
    live.ws.addEventListener("close", () => {
      live.open = false;
      live.tries += 1;
      if (!live.leaving) setTimeout(connect, Math.min(15000, 500 * 2 ** live.tries));
    });
  }
  connect();
  setInterval(() => { if (!live.open) report(); }, 15000);
  setInterval(() => { if (live.open) live.ws.send(JSON.stringify({ type: "here" })); }, 30000); // still here
  addEventListener("pagehide", () => {
    live.leaving = true;
    live.ws?.close();
    navigator.sendBeacon?.("/api/presence/leave", new Blob([JSON.stringify({ tab })], { type: "application/json" }));
  });

  showStats();
  next();
})();
