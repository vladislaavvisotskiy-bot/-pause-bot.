# PAUSE delivery bot — working notes

Telegram bot + two Mini Apps on one aiohttp process:
- **PAUSE App** (`pauseapp.py`, `pauseapp_static/`) — client-facing ordering app, mounted at `/pauseapp`.
- **Маршрут** (`webapp.py`, `webapp_static/`) — courier/route-admin app, mounted at root/`/miniapp`.
- `sheets.py` — all Google Sheets I/O (both apps share it). `config.py` — sheet/column constants.
- No real Google Sheets credentials exist in this sandbox — verify sheets.py logic with small hand-rolled `FakeWs`/`FakeRequest` scripts in the scratchpad, not live calls.

## Usage economy (explicit standing instruction)

The user is on a Pro plan with a limited weekly quota shared across all Claude usage (chat + Claude Code, cloud + local). Work deliberately to spend less per task, without lowering the quality of what ships:

- **Stay scoped.** Touch only what the request requires. Don't audit, "while I'm here" refactor, or re-verify unrelated code unless asked.
- **Don't re-read after a successful Edit/Write.** The tool result already confirms the change landed — re-reading the file to double-check is wasted tokens unless you need to see surrounding context you don't already have.
- **Read narrowly.** Prefer `Grep` (with line numbers / limited context) or `Read` with `offset`/`limit` over reading whole large files (`sheets.py`, `webapp.py`, `webapp_static/app.js`, `pauseapp_static/app.js` are thousands of lines each) when you only need one function or section.
- **One pass of verification, not several.** Write the isolated test, run it once, fix what it finds, move on — don't re-run tests repeatedly "just to be sure" when nothing changed since the last green run.
- **No subagents for small/medium tasks.** This is a single, well-understood codebase — delegate to the Agent tool only for genuinely large, independent, multi-file investigations, never for routine bug fixes.
- **Batch related fixes into one commit/response** instead of back-and-forth micro-turns, when the user already described everything needed.
- **Ask only when truly blocked** (ambiguous requirement, destructive action, missing credential) — don't ask clarifying questions answerable by reading the code yourself.
- **Keep prose replies short.** Skip restating the request back, skip long preambles — state what changed and what's next.
