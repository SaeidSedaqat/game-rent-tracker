# Game Rent Tracker

A simple site for tracking PlayStation game rentals from the PlayBox rent list (Google Sheet).

- Pick your favorite games and choose Z2 (PS4), Z2 (PS5) or Z3 for each one
- See whether each game is free now, or when it will be, plus how many people are in the queue
- 🎲 picks a random game from your list that's free right now
- Your list is saved in your browser; the data updates automatically whenever the sheet changes
- New games added to the sheet are announced the next time you visit

Plain HTML/CSS/JS with no build step. To preview locally on Windows:

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

then open http://localhost:8080.
