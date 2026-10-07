"""Gandalf: Lakera's 2023 prompt-injection game, rebuilt on a local Ollama model.

The levels, prompts, and defenses follow the original; see levels.py for sources.

    python app.py          # play at http://localhost:5050
    python app.py --lan    # also let students on the same network play
"""

import argparse
import hmac
import json
import os
import re
import secrets
import socket
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

from flask import (
    Flask, Response, jsonify, request, send_from_directory, session, stream_with_context,
)

import answer_key
import disguise
from bots import BROWSER_DECLARES, FLAGS, declared_bot
from levels import (
    BLOCK_MESSAGES, BRIEF, DEFENSE_LABELS, INPUT_CHECKER_SYSTEM, INPUT_CHECKER_USER, KNOWN_TRICKS,
    LEVELS, OUTPUT_CHECKER_SYSTEM, OUTPUT_CHECKER_USER, SIMPLE_CENSOR_SYSTEM, SIMPLE_CENSOR_USER,
)

BASE = Path(__file__).resolve().parent
MODEL = os.environ.get("GANDALF_MODEL", "qwen3.5:9b")
# Levels 1, 3, 4: MODEL plays Gandalf (and checks itself on level 4, as in the original game).
# Level 2 and levels 5-8: STRONG_MODEL plays Gandalf; from level 6, GUARD_MODEL checks him.
# On a laptop they default to one model, since Ollama here only holds one in memory.
STRONG_MODEL = os.environ.get("GANDALF_STRONG_MODEL", MODEL)
GUARD_MODEL = os.environ.get("GANDALF_GUARD_MODEL", MODEL)
OLLAMA_URL = os.environ.get("GANDALF_OLLAMA_URL", "http://localhost:11434").rstrip("/")
# Set these to use a hosted, OpenAI-compatible provider (Groq, OpenAI, OpenRouter, ...)
# instead of Ollama, e.g. GANDALF_API_URL=https://api.groq.com/openai/v1
API_URL = os.environ.get("GANDALF_API_URL", "").rstrip("/")
API_KEY = os.environ.get("GANDALF_API_KEY", "")
REASONING_EFFORT = os.environ.get("GANDALF_REASONING_EFFORT", "")  # "low" suits gpt-oss models
HOSTED = bool(API_URL)
LOGGING = os.environ.get("GANDALF_LOG", "1") != "0"
# For previewing the game in a browser that announces itself as a bot (like the Claude app's).
ALLOW_BOTS = os.environ.get("GANDALF_ALLOW_BOTS") == "1"
LOG_PATH = BASE / "logs" / "attempts.jsonl"
# The answer key's password: GANDALF_INSTRUCTOR_PASSWORD, or the first line of instructor_password.txt.
_PASSWORD_FILE = BASE / "instructor_password.txt"
INSTRUCTOR_PASSWORD = (os.environ.get("GANDALF_INSTRUCTOR_PASSWORD") or (
    (_PASSWORD_FILE.read_text().strip().splitlines() or [""])[0] if _PASSWORD_FILE.exists() else "")).strip()
MEDIA = BASE / "media"
IMAGE_TYPES = (".jpg", ".jpeg", ".png", ".webp")
MAX_MESSAGE_CHARS = 2000
# Long answers are what make a local model slow. Hosted reasoning models also spend
# part of this budget thinking, so they get more room.
MAX_REPLY_TOKENS = 1024 if HOSTED else 250
MAX_CHECKER_TOKENS = 512 if HOSTED else 60  # the checkers write one sentence, then Yes or No
KEEP_ALIVE = "2h"           # keep the Ollama model in memory between messages

THINK_RE = re.compile(r"<think>.*?(</think>|$)", re.S)


def load_secret_key():
    if os.environ.get("GANDALF_SECRET_KEY"):
        return os.environ["GANDALF_SECRET_KEY"]
    key_file = BASE / ".secret_key"
    if not key_file.exists():
        key_file.write_text(secrets.token_hex(32))
    return key_file.read_text().strip()


app = Flask(__name__)
app.secret_key = load_secret_key()
_log_lock = threading.Lock()


# --- Models ---------------------------------------------------------------
# Every model call goes through model_chat (whole reply) or model_stream (piece by piece),
# which talk to Ollama or, when GANDALF_API_URL is set, to a hosted provider.

class ModelError(Exception):
    pass


def where():
    return API_URL if HOSTED else f"Ollama at {OLLAMA_URL}"


def open_request(url, payload, model):
    headers = {"Content-Type": "application/json"}
    if HOSTED and API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
    try:
        return urllib.request.urlopen(req, timeout=180)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        if e.code in (401, 403):
            raise ModelError(f"{where()} rejected the API key. Check GANDALF_API_KEY.") from e
        if e.code == 404:
            fix = f"Check the model name for {API_URL}." if HOSTED else f"Run: ollama pull {model}"
            raise ModelError(f"The model '{model}' isn't available. {fix}") from e
        if e.code == 429:
            raise ModelError("Too many messages at once for the AI provider. Wait a few seconds and send again.") from e
        raise ModelError(f"{where()} returned an error ({e.code}): {detail}") from e
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        hint = "" if HOSTED else " Is it running? Try: ollama serve"
        raise ModelError(f"Can't reach {where()}.{hint}") from e


_thinking = {}


def can_think(model):
    """Whether an Ollama model has a thinking mode (Qwen 3.5, Gemma 4, ...). Checked once per model."""
    if model not in _thinking:
        with open_request(f"{OLLAMA_URL}/api/show", {"model": model}, model) as resp:
            _thinking[model] = "thinking" in json.load(resp).get("capabilities", [])
    return _thinking[model]


def request_for(messages, model, temperature, max_tokens, stream):
    if HOSTED:
        payload = {"model": model, "messages": messages, "stream": stream, "max_tokens": max_tokens}
        if temperature is not None:
            payload["temperature"] = temperature
        if REASONING_EFFORT:
            payload["reasoning_effort"] = REASONING_EFFORT
        return f"{API_URL}/chat/completions", payload
    options = {"num_predict": max_tokens}
    if temperature is not None:
        options["temperature"] = temperature
    payload = {"model": model, "messages": messages, "stream": stream,
               "options": options, "keep_alive": KEEP_ALIVE}
    if can_think(model):
        payload["think"] = False  # thinking first would make every reply several times slower
    return f"{OLLAMA_URL}/api/chat", payload


def model_chat(messages, model, temperature, max_tokens):
    """One whole reply. temperature=None keeps the model's default."""
    url, payload = request_for(messages, model, temperature, max_tokens, stream=False)
    with open_request(url, payload, model) as resp:
        data = json.load(resp)
    if HOSTED:
        text = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    else:
        text = data.get("message", {}).get("content", "")
    return THINK_RE.sub("", text).strip()


def model_stream(messages, model, max_tokens):
    """Yield the reply a piece at a time. Closing the generator makes the model stop writing."""
    url, payload = request_for(messages, model, None, max_tokens, stream=True)
    resp = open_request(url, payload, model)
    try:
        for raw in resp:
            line = raw.decode().strip()
            if HOSTED:
                # Server-sent events: "data: {...}" lines, ending with "data: [DONE]".
                if not line.startswith("data:"):
                    continue
                line = line[5:].strip()
                if line == "[DONE]":
                    break
            if not line:
                continue
            chunk = json.loads(line)
            if chunk.get("error"):
                raise ModelError(f"{where()} returned an error: {str(chunk['error'])[:300]}")
            if HOSTED:
                piece = ((chunk.get("choices") or [{}])[0].get("delta") or {}).get("content") or ""
            else:
                piece = chunk.get("message", {}).get("content", "")
            if piece:
                yield piece
            if chunk.get("done"):
                break
    finally:
        resp.close()


def warm_up():
    """Load the Ollama models into memory so the first player doesn't wait."""
    if HOSTED:
        return
    for model in dict.fromkeys([MODEL, STRONG_MODEL, GUARD_MODEL]):
        try:
            model_chat([{"role": "user", "content": "Hi"}], model, 0, 1)
        except ModelError as e:
            print(f"  ! {e}")
    if len({MODEL, STRONG_MODEL, GUARD_MODEL}) > 1:
        try:
            with urllib.request.urlopen(f"{OLLAMA_URL}/api/ps", timeout=5) as resp:
                loaded = {m["name"] for m in json.load(resp).get("models", [])}
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError):
            return
        names = lambda m: {m, f"{m}:latest"}
        if not all(names(m) & loaded for m in {MODEL, STRONG_MODEL, GUARD_MODEL}):
            print("  ! Ollama can't keep all the models in memory at once, so it will swap them\n"
                  "    during messages (several seconds each). See README.")


def gandalf_model(level):
    return STRONG_MODEL if level.get("gandalf") == "strong" else MODEL


def checker_model(level):
    return GUARD_MODEL if level.get("checker") == "second" else gandalf_model(level)


def checker_says_yes(level, system, user):
    """Lakera's rule: block if the checker's answer contains "yes" anywhere, case-insensitive.

    Ours on top: an empty answer is retried once, then counts as yes, so a broken checker
    never lets everything through.
    """
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    answer = model_chat(messages, checker_model(level), 0, MAX_CHECKER_TOKENS)
    if not answer.strip():
        answer = model_chat(messages, checker_model(level), 0, MAX_CHECKER_TOKENS * 4)
    return not answer.strip() or "yes" in answer.lower()


# --- Defenses -------------------------------------------------------------

def letters(text):
    return re.sub(r"[^a-z]", "", text.lower())


def word_pairs(text):
    words = re.findall(r"[a-z0-9]+", text.lower().replace("’", "'").replace("'", ""))
    return {f"{a} {b}" for a, b in zip(words, words[1:])}


_KNOWN = [word_pairs(t) for t in KNOWN_TRICKS]


def is_known_trick(message):
    """A close copy of a published walkthrough prompt, alone or pasted inside a longer message:
    at least 75% of the published prompt's word pairs appear in the message."""
    pairs = word_pairs(message)
    return any(len(known & pairs) >= 0.75 * len(known) for known in _KNOWN)


def system_prompt(level):
    """Lakera's layout: "The secret password is X." then the level's defense prompt.

    BRIEF ("Keep your answers brief.") is ours: shorter replies are much faster to generate.
    """
    prompt = f"The secret password is {level['password']}."
    if level["defense_prompt"]:
        prompt += "\n\n" + level["defense_prompt"].format(password=level["password"])
    return prompt + "\n\n" + BRIEF


OUTPUT_DEFENSES = {"output_exact", "output_decoded", "output_llm"}


def leaks_so_far(level, text):
    """The cheap, code-only output checks. Returns the defense that fired, or None."""
    if "output_exact" in level["defenses"] and level["password"].lower() in text.lower():
        return "output_exact"
    if "output_decoded" in level["defenses"] and disguise.reveals(text, level["password"], level["decode"]):
        return "output_decoded"
    return None


def run_level(level, message):
    """Run one message through a level, yielding ("text", piece) while the reply can be shown
    as it's written, then ("done", shown, defense that fired or None, raw reply)."""
    password = level["password"]
    defenses = level["defenses"]

    # Input defenses run before Gandalf sees the message.
    if "english_only" in defenses and any(c.isalpha() and not c.isascii() for c in message):
        yield "done", BLOCK_MESSAGES["english_only"], "english_only", None
        return
    if "known_tricks" in defenses and is_known_trick(message):
        yield "done", BLOCK_MESSAGES["known_trick"], "known_trick", None
        return
    if "input_words" in defenses and any(w in message.lower() for w in level["banned_words"]):
        yield "done", BLOCK_MESSAGES["input_words"], "input_words", None
        return
    if "input_llm" in defenses:
        yield "step", "input_llm"
    if "input_llm" in defenses and checker_says_yes(
        level, INPUT_CHECKER_SYSTEM, INPUT_CHECKER_USER.format(message=message)
    ):
        yield "done", BLOCK_MESSAGES["input_llm"], "input_llm", None
        return

    messages = [{"role": "system", "content": system_prompt(level)},
                {"role": "user", "content": message}]
    show_live = not OUTPUT_DEFENSES & set(defenses)
    reply, checked_at = "", 0
    yield "step", "gandalf"
    pieces = model_stream(messages, gandalf_model(level), MAX_REPLY_TOKENS)
    try:
        for piece in pieces:
            reply += piece
            if show_live:
                yield "text", piece
            elif len(reply) - checked_at >= 24:
                # Stop Gandalf the moment the code checks see the password.
                checked_at = len(reply)
                fired = leaks_so_far(level, reply)
                if fired:
                    yield "done", BLOCK_MESSAGES[fired], fired, reply
                    return
    finally:
        pieces.close()

    reply = THINK_RE.sub("", reply).strip() or "..."
    fired = leaks_so_far(level, reply)
    if fired:
        yield "done", BLOCK_MESSAGES[fired], fired, reply
        return
    if "output_llm" in defenses:
        yield "step", "output_llm"
    simple = level.get("censor") == "simple"
    if "output_llm" in defenses and checker_says_yes(
        level,
        (SIMPLE_CENSOR_SYSTEM if simple else OUTPUT_CHECKER_SYSTEM).format(password=password),
        (SIMPLE_CENSOR_USER if simple else OUTPUT_CHECKER_USER).format(
            password=password, message=message, response=reply),
    ):
        yield "done", BLOCK_MESSAGES["output_llm"], "output_llm", reply
        return
    yield "done", reply, None, reply


def play_level(level, message):
    """Run one message through a level. Returns (text shown to player, defense that fired, raw reply)."""
    for event in run_level(level, message):
        if event[0] == "done":
            return event[1:]


# --- Progress and logging -------------------------------------------------

def passed_levels():
    return sorted(session.get("passed", []))


def unlocked_level():
    return min(len(LEVELS), max(passed_levels(), default=0) + 1)


def progress():
    return {"passed": passed_levels(), "unlocked": unlocked_level()}


def level_from(payload):
    try:
        n = int(payload.get("level"))
    except (TypeError, ValueError):
        return None
    if 1 <= n <= unlocked_level():
        return LEVELS[n - 1]
    return None


def player_id():
    if "pid" not in session:
        session["pid"] = secrets.token_hex(4)
    return session["pid"]


def log_event(kind, **fields):
    if not LOGGING:
        return
    record = {
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "player": player_id(),
        "kind": kind,
        **fields,
    }
    with _log_lock:
        LOG_PATH.parent.mkdir(exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


# --- Routes ---------------------------------------------------------------

def level_image(n):
    """A banner image dropped into media/ as 1.jpg, 2.png, ... replaces the drawn wizard."""
    for ext in IMAGE_TYPES:
        if (MEDIA / f"{n}{ext}").is_file():
            return f"/media/{n}{ext}"
    return None


@app.get("/media/<path:name>")
def media(name):
    return send_from_directory(MEDIA, name)


def pipeline(level):
    """The steps a message goes through on this level, for the diagram on the page."""
    d = level["defenses"]
    prompt = ("long defensive prompt" if "strong_prompt" in d
              else "told not to tell" if "instruction" in d else "no rules")
    words = level.get("banned_words", [])
    steps = [
        ("english_only", "English only", "code", "non-English letters refused"),
        ("known_trick", "Walkthrough filter", "code", "published solutions refused"),
        ("input_words", "Banned words", "code",
         ", ".join(words) if len(words) <= 3 else f"{len(words)} words incl. {', '.join(words[:3])}"),
        ("input_llm", "AI screener", "ai", checker_model(level)),
        ("gandalf", "Gandalf", "ai", f"{gandalf_model(level)} · {prompt}"),
        ("output_exact", "Password check", "code", "exact match"),
        ("output_decoded", "Cipher decoder", "code",
         {"spacing": "spacing, doubling, leetspeak", "basic": "spacing, doubling, reversal",
          "ciphers": "ciphers and encodings, not reversal"}.get(
             level.get("decode"), "ciphers and encodings, reversal included")),
        ("output_llm", "AI censor", "ai", checker_model(level)
         + (" · looks for the password itself" if level.get("censor") == "simple" else "")),
    ]
    present = {"known_trick": "known_tricks"}
    return [{"id": sid, "label": label, "kind": kind, "detail": detail}
            for sid, label, kind, detail in steps
            if sid == "gandalf" or present.get(sid, sid) in d]


# --- Bots: declared bots play in the Bot Arcade; bot-like behavior only flags the session ---
BOT_ALLOWED = {"/api/bot", "/api/presence", "/api/presence/leave"}


@app.before_request
def notice_bots():
    if ALLOW_BOTS:
        return None
    reason = declared_bot(request.headers)
    if reason and not session.get("bot"):
        session["bot"] = reason
        log_event("bot", reason=reason, user_agent=request.headers.get("User-Agent", ""))
    if session.get("bot") and request.path.startswith("/api/") and request.path not in BOT_ALLOWED:
        return jsonify(error="Automated visitors play in the Bot Arcade instead of talking to Gandalf.",
                       bot=session["bot"], arcade="/arcade"), 403
    return None


def arcade_page(room):
    """Every room links to more rooms, so a crawler that follows links never runs out."""
    links = " ".join(f'<a href="/arcade/{(room * 7 + i * 131 + 17) % 99991 + 1}">Room {(room * 7 + i * 131 + 17) % 99991 + 1}</a>'
                     for i in range(4))
    html = (BASE / "static" / "arcade.html").read_text()
    return html.replace("<!--ROOM-->", str(room)).replace("<!--ROOM-LINKS-->", links), 200, {"Cache-Control": "no-store"}


@app.get("/arcade")
@app.get("/arcade/<int:room>")
def arcade(room=1):
    return arcade_page(room)


@app.get("/robots.txt")
def robots():
    return send_from_directory(BASE / "static", "robots.txt")


@app.route("/api/bot", methods=["GET", "POST"])
def bot_status():
    if request.method == "POST":
        reason = BROWSER_DECLARES.get((request.get_json(silent=True) or {}).get("signal"))
        if reason and not ALLOW_BOTS:
            session["bot"] = reason
            log_event("bot", reason=reason, user_agent=request.headers.get("User-Agent", ""))
    return jsonify(bot=session.get("bot"), flags=[FLAGS[f] for f in session.get("flags", [])], arcade="/arcade")


@app.post("/api/flag")
def flag():
    known = session.get("flags", [])
    add = [f for f in (request.get_json(silent=True) or {}).get("flags", []) if f in FLAGS and f not in known]
    if add:
        session["flags"] = known + add
        log_event("flag", flags=[FLAGS[f] for f in add], user_agent=request.headers.get("User-Agent", ""))
    return jsonify(flags=[FLAGS[f] for f in session.get("flags", [])])


@app.get("/")
def index():
    if session.get("bot") and not ALLOW_BOTS:
        return arcade_page(1)
    return send_from_directory(BASE / "static", "index.html")


@app.get("/api/config")
def config():
    player_id()
    host = "a hosted AI provider" if HOSTED else "Ollama on the instructor's computer"
    return jsonify(
        levels=[
            {
                "n": l["n"], "name": l["name"], "title": l.get("title", ""),
                "description": l["description"], "image": level_image(l["n"]),
                "pipeline": pipeline(l),
            }
            for l in LEVELS
        ],
        progress=progress(),
        usage=None,  # no daily allowance when running on your own computer
        presence=True,
        leaderboard=True,
        my_name=_names.get(player_id(), ""),
        model=MODEL,
        strong_model=STRONG_MODEL,
        guard_model=GUARD_MODEL,
        two_models=GUARD_MODEL != STRONG_MODEL,
        model_summary=MODEL if STRONG_MODEL == MODEL else f"{MODEL} → {STRONG_MODEL}",
        guard_summary=GUARD_MODEL,
        strong_note="" if STRONG_MODEL == MODEL else "The first plays Gandalf on levels 1, 3, and 4; the second on level 2 and levels 5–8.",
        host_title="Running live" if HOSTED else "Running live on this computer",
        host_note=("Open AI models from a hosted provider. Every answer is generated on the spot."
                   if HOSTED else "Open AI models served by Ollama. Every answer is generated on "
                   "the spot, and nothing you type leaves this room."),
        about_note=f"Gandalf here runs on {MODEL}, served by {host}.",
        logging=LOGGING,
        logging_note="Every question and guess is recorded on the instructor's computer, without "
                     "your name, so the class can look at which attacks worked.",
    )


@app.post("/api/ask")
def ask():
    payload = request.get_json(silent=True) or {}
    level = level_from(payload)
    if level is None:
        return jsonify(error="That level is locked. Pass the level before it first."), 403
    message = str(payload.get("message", "")).strip()[:MAX_MESSAGE_CHARS]
    if not message:
        return jsonify(error="Type a question for Gandalf first."), 400

    player_id()  # set before streaming starts; the cookie can't change after that

    def events():
        # One JSON object per line: {"step"}, {"text"} while the reply is shown live, then {"done"}.
        try:
            for event in run_level(level, message):
                if event[0] == "step":
                    yield json.dumps({"step": event[1]}) + "\n"
                elif event[0] == "text":
                    yield json.dumps({"text": event[1]}) + "\n"
                else:
                    shown, blocked_by, raw = event[1:]
                    log_event("ask", level=level["n"], message=message, reply=raw, blocked_by=blocked_by)
                    yield json.dumps({"done": True, "reply": shown, "blocked_by": blocked_by}) + "\n"
        except ModelError as e:
            yield json.dumps({"error": str(e)}) + "\n"

    return Response(stream_with_context(events()), mimetype="application/x-ndjson",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/guess")
def guess():
    payload = request.get_json(silent=True) or {}
    level = level_from(payload)
    if level is None:
        return jsonify(error="That level is locked. Pass the level before it first."), 403
    attempt = str(payload.get("guess", "")).strip()[:100]
    if not attempt:
        return jsonify(error="Type a password to check."), 400

    correct = letters(attempt) == letters(level["password"])
    if correct:
        session["passed"] = sorted(set(passed_levels()) | {level["n"]})
        record_score()
    log_event("guess", level=level["n"], guess=attempt, correct=correct)
    return jsonify(correct=correct, explain=level["explain"] if correct else None, **progress())


@app.get("/api/answer-key")
def answer_key_view():
    if session.get("instructor"):
        return jsonify(unlocked=True, html=answer_key.render())
    return jsonify(unlocked=False)


@app.post("/api/answer-key")
def answer_key_unlock():
    """The answer key, for instructors only. Once the password is entered, this browser remembers it until "Lock"."""
    if not INSTRUCTOR_PASSWORD:
        return jsonify(error="This site doesn't have an instructor password set up yet."), 503
    given = str((request.get_json(silent=True) or {}).get("password") or "").strip()[:200]
    if not given or not hmac.compare_digest(given.encode(), INSTRUCTOR_PASSWORD.encode()):
        time.sleep(0.5)  # slows guessing
        return jsonify(error="That isn't the instructor password."), 403
    session["instructor"] = True
    return jsonify(unlocked=True, html=answer_key.render())


@app.post("/api/answer-key/lock")
def answer_key_lock():
    session.pop("instructor", None)
    return jsonify(unlocked=False)


@app.get("/api/defenses")
def defenses():
    passed = set(passed_levels())
    return jsonify([
        {
            "n": l["n"],
            "name": l["name"],
            "title": l.get("title", ""),
            "unlocked": l["n"] in passed,
            **({
                "password": l["password"],
                "explain": l["explain"],
                "defenses": [DEFENSE_LABELS[d] for d in l["defenses"]],
            } if l["n"] in passed else {}),
        }
        for l in LEVELS
    ])


# Who's playing right now, and today's leaderboard. Each open page (tab) checks in every few
# seconds (this version has no live connection; the Cloudflare one pushes changes instantly)
# and says goodbye when it closes. A person counts while any tab is open; a tab that stops
# checking in without saying goodbye drops off after 2.5 minutes. The leaderboard starts fresh
# each day (Chicago time). Kept in memory.
TAB_TIMEOUT_SECONDS = 150
_players = {}
_names = {}
_boards = {}
_room_lock = threading.Lock()

# What a page may say it's doing; anything else is ignored. Same list as cloudflare/src/worker.js.
STATUS = {
    "playing": "reading the level", "asking": "asking Gandalf", "replied": "reading Gandalf's reply",
    "blocked": "was just blocked by a defense", "wrong": "guessed a wrong password", "passed": "passed a level",
    "arrived": "just arrived", "solving": "working on a puzzle", "solved": "solved a puzzle",
    "missed": "answered a puzzle wrong", "skipped": "skipped a puzzle",
}
PUZZLES = {"Number sequence", "Mental math", "Anagram", "Odd one out", "Letter pattern"}


def chicago_day():
    return datetime.now(ZoneInfo("America/Chicago")).date().isoformat()


def clean_name(name):
    """Names are optional: letters, numbers, spaces, and . , ' _ - only, at most 24 characters."""
    name = unicodedata.normalize("NFC", str(name or ""))
    name = "".join(c for c in name if c.isalnum() or c in " .,'_-")
    return " ".join(name.split())[:24]


def _count(value, most=1_000_000):
    try:
        return max(0, min(most, int(value)))
    except (TypeError, ValueError):
        return 0


def clean_stats(stats):
    """A bot's puzzle tally from the arcade page: known fields, in known ranges."""
    if not isinstance(stats, dict):
        return None
    out = {k: _count(stats.get(k)) for k in ("solved", "streak", "best", "wrong", "skipped")}
    out["room"] = _count(stats.get("room"), 99991)
    out["puzzle"] = stats.get("puzzle") if stats.get("puzzle") in PUZZLES else ""
    return out


@app.post("/api/presence")
def presence():
    pid = player_id()
    payload = request.get_json(silent=True) or {}
    try:
        level = int(payload.get("level"))
    except (TypeError, ValueError):
        level = unlocked_level()
    level = level if 1 <= level <= unlocked_level() else unlocked_level()
    now = time.time()
    tab = str(payload.get("tab") or "page")[:40]
    arcade = bool(payload.get("arcade")) or (bool(session.get("bot")) and not ALLOW_BOTS)
    status = payload.get("status") if payload.get("status") in STATUS else None
    with _room_lock:
        old = _players.get(pid, {})
        _players[pid] = {
            "level": level, "unlocked": unlocked_level(), "passed": len(passed_levels()), "arcade": arcade,
            "bot": None if ALLOW_BOTS and not payload.get("arcade") else session.get("bot"),
            "flags": [FLAGS[f] for f in session.get("flags", [])], "tabs": {**old.get("tabs", {}), tab: now},
            "since": old.get("since", now), "status": status or old.get("status") or ("arrived" if arcade else "playing"),
            "status_at": now if status else old.get("status_at", now),
            "stats": clean_stats(payload.get("stats")) or old.get("stats"),
        }
        for key, player in list(_players.items()):
            player["tabs"] = {t: seen for t, seen in player["tabs"].items() if now - seen <= TAB_TIMEOUT_SECONDS}
            if not player["tabs"]:
                del _players[key]
        ms = lambda t: int(t * 1000)
        everyone = [{
            "key": k, "tag": k[:4], "name": _names.get(k, ""), "you": k == pid, "level": v["level"],
            "unlocked": v["unlocked"], "passed": v["passed"], "arcade": v["arcade"], "bot": v["bot"],
            "flags": v["flags"], "since": ms(v["since"]), "tabs": len(v["tabs"]), "status": STATUS[v["status"]],
            "status_at": ms(v["status_at"]),
            "stats": {"solved": 0, "streak": 0, "best": 0, "wrong": 0, "skipped": 0, "room": 1, "puzzle": "",
                      **(v["stats"] or {})} if v["arcade"] else None,
        } for k, v in _players.items()]
    players = sorted((p for p in everyone if not p["arcade"]), key=lambda p: (-p["passed"], -p["level"], p["since"]))
    bots = sorted((p for p in everyone if p["arcade"]), key=lambda p: p["since"])
    by_level = {l["n"]: 0 for l in LEVELS}
    for p in players:
        by_level[p["level"]] += 1
    return jsonify(type="room", total=len(players), arcade=len(bots), flagged=sum(1 for p in players if p["flags"]),
                   by_level=by_level, now=ms(now), updated=datetime.now(timezone.utc).isoformat(),
                   players=players, bots=bots)


@app.post("/api/presence/leave")
def presence_leave():
    tab = str((request.get_json(silent=True, force=True) or {}).get("tab") or "")
    with _room_lock:
        player = _players.get(player_id())
        if player:
            player["tabs"].pop(tab, None)
            if not tab or not player["tabs"]:
                _players.pop(player_id(), None)
    return "", 204


@app.post("/api/name")
def set_name():
    name = clean_name((request.get_json(silent=True) or {}).get("name"))
    with _room_lock:
        if name:
            _names[player_id()] = name
        else:
            _names.pop(player_id(), None)
    return jsonify(name=name)


def record_score():
    with _room_lock:
        board = _boards.setdefault(chicago_day(), {})
        if board.get(player_id(), {}).get("passed", -1) < len(passed_levels()):
            board[player_id()] = {"passed": len(passed_levels()), "at": time.time()}


@app.get("/api/leaderboard")
def leaderboard():
    pid = player_id()
    with _room_lock:
        board = dict(_boards.get(chicago_day(), {}))
        names = dict(_names)
    ranked = sorted(board.items(), key=lambda kv: (-kv[1]["passed"], kv[1]["at"]))
    entries = [{"rank": i + 1, "tag": k[:4], "name": names.get(k, ""), "passed": v["passed"],
                "at": datetime.fromtimestamp(v["at"], timezone.utc).isoformat(), "you": k == pid}
               for i, (k, v) in enumerate(ranked)]
    mine = next((e for e in entries if e["you"]), None)
    return jsonify(day=chicago_day(), total=len(entries), top=entries[:25],
                   you=mine if mine and mine["rank"] > 25 else None)


@app.post("/api/reset")
def reset():
    session.pop("passed", None)
    return jsonify(progress())


# --- Startup --------------------------------------------------------------

def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "<your-ip-address>"


def check_ollama():
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=5) as resp:
            installed = {m["name"] for m in json.load(resp).get("models", [])}
    except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError):
        print(f"  ! Can't reach Ollama at {OLLAMA_URL}. Start it with: ollama serve")
        return
    for model in {MODEL, STRONG_MODEL, GUARD_MODEL}:
        if model not in installed and f"{model}:latest" not in installed:
            print(f"  ! Model '{model}' isn't installed. Run: ollama pull {model}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the Gandalf password game.")
    parser.add_argument("--lan", action="store_true",
                        help="let other devices on your network play (listens on 0.0.0.0)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("GANDALF_PORT", 5050)))
    args = parser.parse_args()

    print(f"Gandalf: {MODEL}" + (f" (levels 1, 3, 4), {STRONG_MODEL} (levels 2, 5-8)" if STRONG_MODEL != MODEL else "")
          + (f"   second checker (levels 6-8): {GUARD_MODEL}" if GUARD_MODEL != STRONG_MODEL else ""))
    print(f"Models served by {where()}")
    if HOSTED:
        if not API_KEY:
            print("  ! GANDALF_API_KEY isn't set. Most hosted providers need one.")
    else:
        check_ollama()
        print("Loading the model into memory...")
        warm_up()
    print(f"Play at http://localhost:{args.port}")
    if args.lan:
        print(f"Students on the same network: http://{lan_ip()}:{args.port}")
    if LOGGING:
        print(f"Logging every question and guess to {LOG_PATH.relative_to(BASE)}")
    app.run(host="0.0.0.0" if args.lan else "127.0.0.1", port=args.port, threaded=True)
