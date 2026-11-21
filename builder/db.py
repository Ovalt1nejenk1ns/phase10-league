"""Game archive: every finished Phase 10 game, kept in data/games.db (SQLite).

build_site.py saves each game here automatically. You can also use it directly:

    python builder/db.py import game-1.csv --label "Game 1" --date 2026-11-14
    python builder/db.py games                 # every stored game, newest first
    python builder/db.py stats                 # all-time standings
    python builder/db.py sql "SELECT * FROM game_results WHERE place = 1"

Tables: players, games, hands (one row per player per hand). The game_results
view has each player's phases, points and finishing place in every game.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import date
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "games.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE      -- "liz" and "Liz" are the same person
);
CREATE TABLE IF NOT EXISTS games (
    id        INTEGER PRIMARY KEY,
    game_key  TEXT NOT NULL UNIQUE,               -- CSV file name without .csv, like results/<key>.html
    label     TEXT NOT NULL,                      -- e.g. "Thanksgiving 2026"
    played_on TEXT NOT NULL,                      -- YYYY-MM-DD
    saved_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS hands (
    game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    hand_no    INTEGER NOT NULL CHECK (hand_no >= 1),
    player_id  INTEGER NOT NULL REFERENCES players(id),
    made_phase INTEGER NOT NULL CHECK (made_phase IN (0, 1)),
    points     INTEGER NOT NULL CHECK (points >= 0),
    PRIMARY KEY (game_id, hand_no, player_id)
);
-- Rank inside each game: most phases first, then fewest points (same rule as the results page).
CREATE VIEW IF NOT EXISTS game_results AS
SELECT g.id AS game_id, g.label, g.played_on, p.name AS player,
       SUM(h.made_phase) AS phases, SUM(h.points) AS points, COUNT(*) AS hands,
       RANK() OVER (PARTITION BY g.id ORDER BY SUM(h.made_phase) DESC, SUM(h.points)) AS place
FROM hands h
JOIN games g   ON g.id = h.game_id
JOIN players p ON p.id = h.player_id
GROUP BY g.id, p.id;
"""


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row                # rows act like dicts: row["player"]
    conn.execute("PRAGMA foreign_keys = ON")      # off by default in SQLite, per connection
    conn.executescript(SCHEMA)
    return conn


def player_id(conn: sqlite3.Connection, name: str) -> int:
    conn.execute("INSERT OR IGNORE INTO players (name) VALUES (?)", (name,))
    return conn.execute("SELECT id FROM players WHERE name = ?", (name,)).fetchone()["id"]


def save_game(players, game_key: str, label: str, played_on: str, path: Path = DB_PATH) -> int:
    """Store one game (a list of build_site.Player). Saving the same game_key again replaces it,
    so rebuilding a results page after fixing a typo in the CSV never makes a duplicate."""
    conn = connect(path)
    try:
        with conn:                                # one transaction: all of the game or none of it
            conn.execute("DELETE FROM games WHERE game_key = ?", (game_key,))  # cascade removes its hands
            game_id = conn.execute(
                "INSERT INTO games (game_key, label, played_on) VALUES (?, ?, ?)",
                (game_key, label, played_on)).lastrowid
            rows = [(game_id, hand_no, player_id(conn, p.name), int(made), pts)
                    for p in players
                    for hand_no, (made, pts) in enumerate(zip(p.made, p.points), start=1)]
            conn.executemany("INSERT INTO hands VALUES (?, ?, ?, ?, ?)", rows)
        return game_id
    finally:
        conn.close()


# ------------------------------------------------------------------- CLI

def show(rows) -> None:
    rows = list(rows)
    if not rows:
        print("(no rows)")
        return
    cols = rows[0].keys()
    widths = [max(len(str(c)), *(len(str(r[c])) for r in rows)) for c in cols]
    print("  ".join(str(c).ljust(w) for c, w in zip(cols, widths)))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        print("  ".join(str(r[c]).ljust(w) for c, w in zip(cols, widths)))


STATS = """
SELECT player,
       COUNT(*)                                  AS games,
       SUM(place = 1)                            AS wins,
       ROUND(100.0 * SUM(place = 1) / COUNT(*))  AS win_pct,
       SUM(phases)                               AS phases_made,
       ROUND(1.0 * SUM(points) / SUM(hands), 1)  AS pts_per_hand
FROM game_results
GROUP BY player
ORDER BY wins DESC, pts_per_hand
"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    imp = sub.add_parser("import", help="add a game CSV to the archive")
    imp.add_argument("csv", type=Path)
    imp.add_argument("--label", help="default: the CSV file name")
    imp.add_argument("--date", default=date.today().isoformat(), help="YYYY-MM-DD (default: today)")
    sub.add_parser("games", help="list stored games")
    sub.add_parser("stats", help="all-time standings")
    q = sub.add_parser("sql", help="run your own query")
    q.add_argument("query")
    args = ap.parse_args()

    if args.cmd == "import":
        from build_site import load_players      # imported here so build_site can import this file
        label = args.label or args.csv.stem
        save_game(load_players(args.csv), args.csv.stem, label, args.date)
        print(f'Saved "{label}" to {DB_PATH}')
        return

    conn = connect()
    try:
        if args.cmd == "games":
            show(conn.execute("""SELECT label, played_on, COUNT(*) AS players, MAX(hands) AS hands,
                                        MAX(CASE WHEN place = 1 THEN player END) AS winner
                                 FROM game_results GROUP BY game_id ORDER BY played_on DESC"""))
        elif args.cmd == "stats":
            show(conn.execute(STATS))
        elif args.cmd == "sql":
            show(conn.execute(args.query))
    except sqlite3.Error as e:
        sys.exit(f"SQL error: {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
