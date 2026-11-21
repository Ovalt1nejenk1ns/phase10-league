"""Build the Phase 10 League results page from a score-sheet CSV.

Usage:
    python builder/build_site.py game-1.csv --game-label "Game 1"
    python builder/build_site.py nov-27-2026.csv --game-label "Thanksgiving" --date 2026-11-27

Writes results/<csv name>.html and saves the game to data/games.db (see db.py).

Writes results/<csv name>.html. The CSV comes from the scorekeeper's
"Download CSV" button (or the score sheet's Hand Log tab):
    Hand, Player, Made phase?, Points
"""

from __future__ import annotations

import argparse
import csv
import math
from datetime import date
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

from db import DB_PATH, save_game

HERE = Path(__file__).parent

# Player colors are handed out by final rank, so the champion always gets blue
# (which also colors the big hero card).
PALETTE = ["var(--blue)", "var(--red)", "var(--green)", "var(--orange)", "var(--purple)", "var(--teal)"]

PHASES = [
    "2 sets of 3",
    "1 set of 3 + 1 run of 4",
    "1 set of 4 + 1 run of 4",
    "1 run of 7",
    "1 run of 8",
    "1 run of 9",
    "2 sets of 4",
    "7 cards of one color",
    "1 set of 5 + 1 set of 2",
    "1 set of 5 + 1 set of 3",
]

SCOREKEEPER_URL = "../index.html"  # results pages live in results/, the app at the repo root
CHEATSHEET_URL = "https://claude.ai/artifact/T88gAY8HPyUFbGo6iuraC7"


# ---------------------------------------------------------------- data model

@dataclass
class Player:
    name: str
    made: list[bool] = field(default_factory=list)  # one entry per hand
    points: list[int] = field(default_factory=list)
    color: str = ""

    @property
    def total(self) -> int:
        return sum(self.points)

    @property
    def phases_done(self) -> int:
        return sum(self.made)  # True counts as 1, so sum() counts completions

    @property
    def cumulative(self) -> list[int]:
        running, out = 0, []
        for p in self.points:
            running += p
            out.append(running)
        return out

    @property
    def attempts(self) -> list[int]:
        """The phase number this player was trying in each hand."""
        done, out = 0, []
        for made in self.made:
            out.append(done + 1)
            done += made
        return out

    @property
    def misses(self) -> int:
        return self.made.count(False)

    @property
    def zero_hands(self) -> int:
        return self.points.count(0)

    def longest_streak(self) -> tuple[int, int]:
        """(length, start index) of the longest run of made phases."""
        best_len = best_start = cur_len = 0
        for i, made in enumerate(self.made):
            cur_len = cur_len + 1 if made else 0
            if cur_len > best_len:
                best_len, best_start = cur_len, i - cur_len + 1
        return best_len, best_start


# ------------------------------------------------------------------- loading

def parse_bool(text: str) -> bool:
    return text.strip().upper() in {"TRUE", "YES", "Y", "1", "X"}


def parse_points(text: str) -> int:
    text = text.strip()
    return int(float(text)) if text else 0  # blank = went out = 0 points


def load_players(csv_path: Path) -> list[Player]:
    players: dict[str, Player] = {}
    with csv_path.open(newline="", encoding="utf-8-sig") as f:  # -sig drops Excel's BOM
        for row in csv.DictReader(f):
            name = (row.get("Player") or "").strip()
            if not name:
                continue  # empty checkbox rows at the bottom of the sheet
            key = name.casefold()  # "liz" and "Liz " are the same person
            player = players.setdefault(key, Player(name=name.title()))
            # Hand number = how many rows this player has so far. The sheet's
            # Hand column is often blank, so it can't be trusted.
            player.made.append(parse_bool(row.get("Made phase?", "")))
            player.points.append(parse_points(row.get("Points", "")))

    if not players:
        raise SystemExit(f"No player rows found in {csv_path}")
    hand_counts = {len(p.made) for p in players.values()}
    if len(hand_counts) != 1:
        counts = ", ".join(f"{p.name}: {len(p.made)}" for p in players.values())
        raise SystemExit(f"Players have different numbers of hands ({counts}). Check the CSV.")
    return list(players.values())


# ------------------------------------------------------------------- results

def rank(players: list[Player]) -> list[Player]:
    # Sort key does both rules at once: most phases first, then fewest points.
    ranked = sorted(players, key=lambda p: (-p.phases_done, p.total))
    for player, color in zip(ranked, PALETTE * 2):
        player.color = color
    return ranked


def headline(ranked: list[Player]) -> dict:
    champ = ranked[0]
    runner = ranked[1] if len(ranked) > 1 else None
    tied = runner is not None and runner.phases_done == champ.phases_done
    # Markup.format() escapes each argument, so the <strong> tags stay real HTML
    # while player names are still treated as plain text.
    if tied:
        title = "takes the crown on the tiebreaker"
        blurb = Markup(
            "{c} and {r} both completed {n} phases, so the title went to the lowest score. "
            "{c} finished with <strong>{ct} points</strong> to {r}'s {rt}."
        ).format(c=champ.name, r=runner.name, n=champ.phases_done, ct=champ.total, rt=runner.total)
    elif runner:
        title = "takes the crown"
        blurb = Markup("{c} completed <strong>{n} phases</strong>, {d} ahead of {r}.").format(
            c=champ.name, n=champ.phases_done, d=champ.phases_done - runner.phases_done, r=runner.name)
    else:
        title, blurb = "takes the crown", ""
    return {"champ": champ, "runner": runner, "title": title, "blurb": blurb, "tiebreak": tied}


def names(group: list[Player]) -> str:
    n = [p.name for p in group]
    return n[0] if len(n) == 1 else ", ".join(n[:-1]) + " and " + n[-1]


def awards(players: list[Player], hands: int) -> list[dict]:
    out = []

    best = max(p.zero_hands for p in players)
    if best:
        who = [p for p in players if p.zero_hands == best]
        out.append({"big": best, "title": "Out the door", "color": who[0].color,
                    "text": f"{names(who)} finished {best} of {hands} hands with zero points."})

    streaks = {p.name: p.longest_streak() for p in players}
    top = max(players, key=lambda p: streaks[p.name][0])
    length, start = streaks[top.name]
    if length >= 2:
        first = top.attempts[start]
        out.append({"big": length, "title": "Hot streak", "color": top.color,
                    "text": f"{top.name} made {length} phases in a row, Phases {first} through "
                            f"{first + length - 1} in hands {start + 1} to {start + length}."})

    steady = min(players, key=lambda p: max(p.points))
    out.append({"big": max(steady.points), "title": "Steady hands", "color": steady.color,
                "text": f"{steady.name}'s worst single hand was {max(steady.points)} points."})

    worst = max(max(p.points) for p in players)
    hits = [(p, p.points.count(worst)) for p in players if worst in p.points]
    detail = ", ".join(f"{p.name} ×{n}" if n > 1 else p.name for p, n in hits)
    out.append({"big": worst, "title": "Ouch", "color": "var(--yellow-ink)",
                "text": f"Biggest single hand of the game ({detail})."})
    return out


def chart(players: list[Player], hands: int) -> dict:
    """Pre-compute SVG coordinates so the template only draws."""
    W, H, L, R, T, B = 900, 360, 48, 110, 16, 40
    top = max(50, math.ceil(max(p.total for p in players) / 50) * 50)
    step = 50 if top <= 400 else 100

    def x(i: int) -> float:
        return L + (W - L - R) * (i / max(hands - 1, 1))

    def y(v: float) -> float:
        return T + (H - T - B) * (1 - v / top)

    lines = []
    for p in players:
        pts = [(x(i), y(v)) for i, v in enumerate(p.cumulative)]
        path = " ".join(f"{'L' if i else 'M'}{px:.1f},{py:.1f}" for i, (px, py) in enumerate(pts))
        lines.append({"player": p, "path": path, "end": pts[-1]})

    # Nudge end labels apart so close totals don't print on top of each other.
    labels = sorted(({"player": l["player"], "y": l["end"][1]} for l in lines), key=lambda d: d["y"])
    for prev, cur in zip(labels, labels[1:]):
        cur["y"] = max(cur["y"], prev["y"] + 16)

    return {
        "W": W, "H": H, "L": L, "R": R, "B": B,
        "grid": [{"v": v, "y": y(v)} for v in range(0, top + 1, step)],
        "xticks": [{"n": i + 1, "x": x(i)} for i in range(hands)],
        "lines": lines,
        "labels": labels,
        "label_x": W - R + 10,
    }


# ------------------------------------------------------------------- render

def build(csv_path: Path, out_path: Path, league: str, game_label: str) -> Path:
    players = load_players(csv_path)
    ranked = rank(players)
    hands = len(ranked[0].made)

    env = Environment(
        loader=FileSystemLoader(HERE / "templates"),
        autoescape=select_autoescape(["html"]),  # a player named "<b>Al" can't break the page
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.globals["zip"] = zip  # Jinja has no zip() built in
    html = env.get_template("results.html").render(
        league=league,
        game_label=game_label,
        hands=hands,
        players=ranked,
        head=headline(ranked),
        awards=awards(ranked, hands),
        chart=chart(ranked, hands),
        phases=PHASES,
        scorekeeper_url=SCOREKEEPER_URL,
        cheatsheet_url=CHEATSHEET_URL,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", type=Path, help="Hand Log exported from the score sheet")
    ap.add_argument("--league", default="Kitchen Table", help="League name (default: %(default)s)")
    ap.add_argument("--game-label", default="Game 1", help='Shown in the header, e.g. "Thanksgiving 2026"')
    ap.add_argument("-o", "--out", type=Path, default=None, help="Default: results/<csv name>.html")
    ap.add_argument("--date", default=date.today().isoformat(), help="Date played, YYYY-MM-DD (default: today)")
    ap.add_argument("--no-db", action="store_true", help="Build the page without saving to data/games.db")
    args = ap.parse_args()

    out_path = args.out or HERE.parent / "results" / f"{args.csv.stem}.html"
    out = build(args.csv, out_path, args.league, args.game_label)
    print(f"Wrote {out}")
    if not args.no_db:
        save_game(load_players(args.csv), args.csv.stem, args.game_label, args.date)
        print(f'Saved "{args.game_label}" to {DB_PATH.relative_to(HERE.parent)}')


if __name__ == "__main__":
    main()
