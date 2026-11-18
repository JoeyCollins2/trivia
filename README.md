# Confidence Trivia

The TV shows the questions. Each team answers on their own phone. There's no server or database to run: the phones connect straight to the host laptop over WebRTC (PeerJS).

## Put it online (one time, about 5 minutes)
It's a static site, so any free static host works. Pick one:

- **GitHub Pages:** Make a public repo, upload everything in this folder, then go to Settings → Pages → "Deploy from branch" → `main` / root. You'll get `https://<you>.github.io/<repo>/`.
- **Netlify Drop:** Go to app.netlify.com/drop and drag this folder in. Log in so the site sticks around.

## Game night
1. On the laptop that's hooked up to the TV, open `https://your-site/host.html`. Make it fullscreen (F11).
2. Pick a timer length and click **Create game**. The TV shows a QR code and a room code.
3. Each team scans the QR code and creates a team name. Teammates can tap an existing team to join it on a second phone.
4. Click **Start game** to begin. The host controls everything with the **Enter** key or the yellow button.

## Rules built in
- Every round, each team uses each confidence number (1–10) exactly once. A right answer earns that many points, and a wrong answer earns nothing.
- Answers are typed and auto-graded leniently: case, accents, "the" and small typos don't matter, but numbers must match exactly. Click ✓/✗ on the reveal screen to overrule the grader.
- After round 1, the team in last place picks the next category. There's also a **Skip to final question** button if you want fewer rounds.
- Final question: the TV shows only the category first. Teams secretly wager 0 up to their score, then the question appears. Teams are revealed lowest score first.

## New questions
Ask Claude for a new `questions.json`. Then either:
- On the host start screen, click **Load a different question file…** (no redeploy needed), or
- Replace `questions.json` on the site so it becomes the default.

Format:
```json
{
  "title": "Game Night #2",
  "rounds": [
    { "category": "Geography", "questions": [
      { "q": "What is the capital of Australia?", "a": "Canberra", "accept": ["optional", "other", "answers"] }
    ]}
  ],
  "final": { "category": "Space", "q": "…", "a": "Uranus" }
}
```
Rounds can have any number of questions. The confidence numbers always run from 1 to the question count.

## If something goes wrong
- **Phone dropped or locked:** Reopen the page. It reconnects to the same team automatically.
- **Host laptop refreshed:** Click **Resume** on the start screen. Scores are saved in the laptop's browser.
- **Practice on one computer:** Open `host.html?local=1`, then open the join link in other tabs.
