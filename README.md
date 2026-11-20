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
python builder/build_site.py ~/Downloads/thanksgiving.csv --game-label "Thanksgiving"
# then add a link to results/thanksgiving.html under "Past games" in index.html
git add . && git commit -m "Add Thanksgiving results" && git push
```

## Files

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The scorekeeper (plain HTML/JS, no build step) |
| `builder/build_site.py` | Reads a game CSV and renders a results page |
| `builder/templates/results.html` | Jinja2 template for results pages |
| `results/` | Built results pages |

The CSV columns are `Hand, Player, Made phase?, Points`, the same as the original score sheet's Hand Log tab, so either source works.

Not affiliated with Mattel, which owns the Phase 10 name.
