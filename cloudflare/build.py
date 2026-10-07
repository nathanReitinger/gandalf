"""Prepare the Cloudflare version: export the levels from ../levels.py and copy the page.

Run by `npm run deploy` and `npm run dev`; you don't need to run it yourself.
"""

import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GAME = HERE.parent
sys.path.insert(0, str(GAME))
sys.dont_write_bytecode = True

import answer_key  # noqa: E402
import levels  # noqa: E402

media = sorted(f for f in (GAME / "media").glob("*") if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))

data = {name: getattr(levels, name) for name in (
    "LEVELS", "KNOWN_TRICKS", "BLOCK_MESSAGES", "DEFENSE_LABELS", "BRIEF",
    "INPUT_CHECKER_SYSTEM", "INPUT_CHECKER_USER", "OUTPUT_CHECKER_SYSTEM", "OUTPUT_CHECKER_USER",
    "SIMPLE_CENSOR_SYSTEM", "SIMPLE_CENSOR_USER",
)}
# Banner pictures: media/1.jpg is level 1's, and so on.
data["IMAGES"] = {f.stem: f"/media/{f.name}" for f in media if f.stem.isdigit()}
(HERE / "src" / "levels.json").write_text(json.dumps(data, indent=1, ensure_ascii=False))
# The answer key stays on the server too; the worker hands it out only for the instructor password.
(HERE / "src" / "answer-key.json").write_text(
    json.dumps({"html": answer_key.render(), "real": answer_key.SOURCE.exists()}, ensure_ascii=False))
if levels.EXAMPLE_PASSWORDS:
    print("Note: no passwords.json, so this build uses the example passwords from passwords.example.json.")

# The site: the same page the laptop version serves, plus the level pictures.
dist = HERE / "dist"
shutil.rmtree(dist, ignore_errors=True)
shutil.copytree(GAME / "static", dist / "static", ignore=shutil.ignore_patterns("index.html", "arcade.html", "robots.txt"))
for page in ("index.html", "arcade.html", "robots.txt"):
    shutil.copy(GAME / "static" / page, dist / page)
(dist / "media").mkdir()
for f in media:
    shutil.copy(f, dist / "media" / f.name)
print(f"Exported {len(data['LEVELS'])} levels and copied the page with {len(media)} pictures.")
