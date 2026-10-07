// Watches the game's files and publishes a new version to Cloudflare whenever they change.
// Runs in the background (see ../README.md, "Automatic updates"). Each change is built and
// checked first (npm test); nothing is published if a check fails. A macOS notification
// reports every result, and autodeploy.log keeps the details.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.dirname(HERE);
const STAMP = path.join(HERE, ".last-deploy");
const SITE = "https://gandalf.nathan-reitinger.workers.dev";
const QUIET_MS = 10000; // wait for edits to settle before publishing

// What the hosted site is built from. Everything else (the laptop app, logs, generated files) is ignored.
const WATCHED = [
  "levels.py", "passwords.json", "passwords.example.json", "ANSWER_KEY.md", "answer_key.py", "static", "media",
  "cloudflare/src", "cloudflare/wrangler.jsonc", "cloudflare/build.py", "cloudflare/check.mjs", "cloudflare/package.json",
];
const IGNORED = /(^|\/)(\.DS_Store|levels\.json|answer-key\.json|__pycache__)(\/|$)/;

const log = (line) => console.log(`${new Date().toLocaleString()}  ${line}`);

function notify(title, text) {
  const quote = (s) => JSON.stringify(String(s).slice(0, 180));
  spawn("osascript", ["-e", `display notification ${quote(text)} with title ${quote(title)}`]).on("error", () => {});
}

function filesUnder(rel) {
  const full = path.join(GAME, rel);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [rel];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((d) => filesUnder(path.join(rel, d.name)));
}

function fingerprint() {
  const hash = crypto.createHash("sha256");
  for (const rel of WATCHED.flatMap(filesUnder).filter((f) => !IGNORED.test(f)).sort()) {
    hash.update(rel).update(fs.readFileSync(path.join(GAME, rel)));
  }
  return hash.digest("hex");
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: HERE, env: process.env });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
    child.on("error", (e) => resolve({ ok: false, output: String(e) }));
  });
}

let busy = false;
let again = false;

async function publish(reason) {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    const print = fingerprint();
    const last = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, "utf8").trim() : "";
    if (print === last) {
      log(`No changes to publish (${reason}).`);
      return;
    }
    log(`Publishing (${reason})...`);
    for (const [label, cmd, args] of [
      ["build", "python3", ["build.py"]],
      ["checks", "node", ["check.mjs"]],
      ["deploy", "npx", ["wrangler", "deploy"]],
    ]) {
      const { ok, output } = await run(cmd, args);
      if (!ok) {
        const why = output.split("\n").find((l) => /FAIL|Error|error/.test(l)) || output.trim().split("\n").pop();
        log(`Stopped at ${label}. Nothing was published.\n${output}`);
        notify("Gandalf: not published", `The ${label} step failed: ${why.trim()}`);
        return;
      }
    }
    fs.writeFileSync(STAMP, print);
    log(`Published to ${SITE}`);
    notify("Gandalf updated", `The new version is live at ${SITE.replace("https://", "")}`);
  } finally {
    busy = false;
    if (again) {
      again = false;
      schedule("more changes");
    }
  }
}

let timer;
function schedule(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => publish(reason), QUIET_MS);
}

fs.watch(GAME, { recursive: true }, (event, file) => {
  if (!file) return;
  const rel = file.split(path.sep).join("/");
  if (IGNORED.test(rel)) return;
  if (WATCHED.some((w) => rel === w || rel.startsWith(`${w}/`))) schedule(`changed ${rel}`);
});

log(`Watching ${GAME} for changes.`);
publish("started");
