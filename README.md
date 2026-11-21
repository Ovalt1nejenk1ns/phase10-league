# Kitchen Table Phase 10 League

A phone-friendly Phase 10 scorekeeper, plus a Python builder that turns finished games into results pages.

**Play:** open the GitHub Pages site, add players, and enter each hand.

## How a game night works

1. Open the site and add players. Each hand, tap **Made phase?** for anyone who laid down their phase, and enter the points left in their hand. **Went out** sets 0.
2. Standings, the hand-by-hand grid and the points chart update after every saved hand. The game is saved in the browser, so a refresh or a locked phone loses nothing.
3. When someone finishes Phase 10, the game ends. Tap **Download CSV**.
4. Build the results page and push it:

```bash
pip install -r builder/requirements.txt
python builder/build_site.py ~/Downloads/thanksgiving.csv --game-label "Thanksgiving" --date 2026-11-27
# then add a link to results/thanksgiving.html under "Past games" in index.html
git add . && git commit -m "Add Thanksgiving results" && git push
```

The build also saves the game to the archive, `data/games.db`.

## Game archive (SQLite)

Every game you build is stored in `data/games.db`, so the full history lives in the repo, not just on one phone. Rebuilding the same CSV replaces that game instead of duplicating it.

```bash
python builder/db.py games      # every game, newest first, with the winner
python builder/db.py stats      # all-time wins, win %, phases made, points per hand
python builder/db.py sql "SELECT * FROM game_results WHERE player = 'Justin'"
python builder/db.py import old-game.csv --label "Summer 2026" --date 2026-07-04   # add a game without building a page
```

| Table / view | One row per |
|---|---|
| `players` | person (names match regardless of case) |
| `games` | game: `game_key` (the CSV name), `label`, `played_on` |
| `hands` | player per hand: `made_phase` (0/1), `points` |
| `game_results` (view) | player per game: `phases`, `points`, `place` |

You can also open `data/games.db` in [DB Browser for SQLite](https://sqlitebrowser.org/) or the VS Code SQLite extension.

## Files

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The scorekeeper (plain HTML/JS, no build step) |
| `builder/build_site.py` | Reads a game CSV, renders a results page and saves the game to the archive |
| `builder/db.py` | The SQLite archive: schema, import, `games`, `stats` and `sql` commands |
| `data/games.db` | The archive itself |
| `builder/templates/results.html` | Jinja2 template for results pages |
| `results/` | Built results pages |

The CSV columns are `Hand, Player, Made phase?, Points`, the same as the original score sheet's Hand Log tab, so either source works.

Not affiliated with Mattel, which owns the Phase 10 name.
