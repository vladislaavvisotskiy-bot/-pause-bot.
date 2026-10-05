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

## Current state (PAUSE App → "Pause Club" screen)

The Club tab (`screen-club` in `pauseapp_static/index.html`) was redesigned to match a sent mockup, in this order top to bottom:

1. **`renderClubHero()`** → `#club-header` — big "PAUSE CLUB" title + tagline, the dark "status" card (`renderClubSelectCard`, reuses real club-level data from `/api/profile`), the 3-tile quick-link row (`renderClubTileRow` — PAUSE GIFT / Ближайшие события (stub) / PAUSE Care (stub)), and the "Сейчас в клубе" heading.
2. **`renderClubNowCards()`** → `#club-now-cards` — the card stack. All cards share the `.pday-card` look (dark radial-gradient "photo" background — no real photos yet — + `ICON_LEAF` watermark + eyebrow/heading/desc/CTA/stats). Current cards, top to bottom:
   - **`.pday-carousel`**: two swipeable slides (native `scroll-snap`, dot indicator, same technique as the "Мои послания" care-card viewer) —
     - slide 1: daily **PAUSE DAY** giveaway ("Дарим эмоции", green gradient). Tap → participant list (`buildGiveawayParticipants`, reuses `state.giveaway`).
     - slide 2: monthly **big-prize PAUSE GIFT** ("Большой приз месяца", gold gradient) — no backend yet, both stats are static stubs (`0 участников`, `30 дней`), tap → "Скоро" placeholder page. Copy was invented (referencing `config.CLUB_BENEFITS.ambassador`: "Алиса, телефоны").
   - **PAUSE TOP** (`.pday-card-top`, terracotta/`--accent-warm` gradient) — leaderboard teaser. Stat is **total registered clients from Sheet1** (`sheets.get_total_clients_count`, NOT the leaderboard's own top-10 size). Tap → `renderClubLeaderboard(root)` (parameterized, no longer renders inline — the old always-visible `#club-leaderboard` was removed as a duplicate).
   - **PAUSE MOMENTS** (`.pday-card-moments`, caramel gradient) — the feed. The "Опубликовать" button + filters + post list used to sit always-visible on the main screen (`#feed-compose-btn`/`#feed-filters`/`#feed-root`, all removed from `index.html`); now built on demand by `renderClubMomentsContent()` into whatever subscreen `openClubMoments()` opens (tracked via module var `clubMomentsRoot`).
   - Pattern for any **future card**: build it in `renderClubNowCards()`, give it a new `.pday-card-xxx` gradient (stay inside the single palette — only `--ink`/`--ivory`/`--accent-warm` tones, see `:root` in `styles.css`), wire its tap handler through `openProfileSubscreen(title, fn)` (generic full-screen overlay, works from anywhere, not Profile-specific despite the name).
**Cards are now admin-editable (data-driven).** The four cards above are the *default* set; real list lives in sheet `config.SHEET_CLUB_CARDS` ("Pause Club Карточки", auto-created) via `sheets.get_club_cards/add/update/delete/move/set_club_card_photo`, served at `GET /api/club/cards`, edited at `/api/ops/club/cards*` (main admin only) from "Операционный центр" → "Управление Pause Club" (`renderClubAdminList`/`renderClubCardEditor` in `app.js`). Built-in kinds (pday/biggift/top/moments) keep their tap behavior; empty text field = i18n default; `kind:"custom"` cards open a simple photo+text page. `carousel:true` on adjacent cards groups them into one swipe carousel. Photos = Telegram file_id via `MEDIA_CHAT_ID` (same as set photos). Admin-typed text is single-language (not localized). The "Pattern for any future card" note above is superseded by this.
3. Below the cards: nothing else — giveaway/leaderboard/feed all moved behind their cards, per explicit "don't duplicate" feedback given twice this session.

**Renaming done project-wide (PAUSE App only, not the main bot's own chat flow in `handlers/`)**: "Пауза в подарок" → **PAUSE DAY**, the standalone word "Розыгрыш" → **PAUSE GIFT**. Same spelling across ru/uz/en (brand terms aren't localized, same treatment as "Vip Pause Club.").

**Club status tier names** (also brand terms, same across locales, `config.CLUB_LEVELS`): PAUSE Guest. (0) → PAUSE Member. (1) → PAUSE Insider. (10) → Vip Pause Club. (25). Icons: door/key/crown unchanged; the 2nd tier's icon was replaced (was an unclear blob) with a sprout.

**Leaderboard permanently excludes** the owner's own test accounts: `config.LEADERBOARD_EXCLUDED_TG_IDS = {"7118369020", "614897018"}`, filtered in `sheets.get_club_leaderboard()`.

**Still open / explicitly deferred by the user:**
- No real photos for any `.pday-card` background yet — currently decorative gradients. When photos arrive: landscape ~4:3, ≥1600px long edge, JPEG, ≤300–500KB, subject centered (cropped via `background`/`cover`), dark/moody or we add a darkening overlay (text is light ivory).
- "Ближайшие события" and "PAUSE Care" tiles (in the 3-tile row) are pure UI stubs (toast "скоро") — no backend/content planned yet.
- Monthly big-prize PAUSE GIFT slide has no real mechanic (pool, draw date) — only the daily one (`sheets`/`pauseapp.py` giveaway functions) is real.
- Paid delivery (`CLUB_DELIVERY_FEES`) still gated to `config.PAUSEAPP_TEST_CLIENT_IDS` only — not live for real bot customers yet, by explicit design (separate future request to flip on).

**Non-obvious gotchas hit this session, worth remembering:**
- Google Sheets `SUMIF`/`SUM` silently skip text-typed cells even if they look numeric — `append_order`/`append_orders_batch` now write `O_QTY` as a real `int`, not `str()`, because Sheet1's "Кол-во Заказов" column is a `SUMIF` over that column (this is why order counts could look "stuck" even with real confirmed orders — see `sheets.migrate_order_qty_to_numbers()` / `scripts/fix_order_qty.py` for the one-time historical-data fix, must be run somewhere with real Sheets credentials, not in this sandbox).
- `openProfileSubscreen(title, loaderFn)`'s `sub` container starts with a skeleton-block child already inside it — any `loaderFn` that renders synchronously (not through an async `api()` call) must do `sub.innerHTML = ""` itself first, or the skeleton lingers above the real content.
- `tg://user?id=...` deep links (Telegram "Написать" buttons) only resolve if the viewer's Telegram client already has that user cached locally — prefer the `https://t.me/<username>` form routed through `WebApp.openTelegramLink()` (see `openTelegramChat` in `app.js`), falling back to `tg://` only when no username is known.
