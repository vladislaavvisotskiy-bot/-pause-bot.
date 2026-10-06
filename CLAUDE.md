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
- **No screenshots unless asked** (explicit user instruction, don't render/send preview images on your own). Keep replies minimal: a few lines on what changed + the deploy reminder only if relevant. Skip visual preview renders unless the user asks to see something.

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
**PAUSE MOMENTS is now a wall (Threads-style).** Own sheets `config.SHEET_MOMENTS`/`SHEET_MOMENT_COMMENTS` ("Моменты"/"Моменты комментарии", auto-created), `sheets.create_moment/get_moments/delete_moment/add_moment_comment/get_moment_comments/delete_moment_comment`, API `/api/moments*` in `pauseapp.py`, UI `renderMomentsFeed/renderMomentCompose/renderMomentDetail` in `app.js`. Any registered client posts/comments (text and/or up to 4 photos, downscaled client-side); delete = admins only (`_require_any_admin`: main admin or any delegated admin). The old "Лента" sheet/`/api/feed` stays ONLY for the "Послания" tab (read-only now — its compose UI lived in the old Moments card and was removed; `/api/feed/delete` is now admin-gated).
3. Below the cards: nothing else — giveaway/leaderboard/feed all moved behind their cards, per explicit "don't duplicate" feedback given twice this session.

**Renaming done project-wide (PAUSE App only, not the main bot's own chat flow in `handlers/`)**: "Пауза в подарок" → **PAUSE DAY**, the standalone word "Розыгрыш" → **PAUSE GIFT**. Same spelling across ru/uz/en (brand terms aren't localized, same treatment as "Vip Pause Club.").

**Club status tier names** (also brand terms, same across locales, `config.CLUB_LEVELS`): PAUSE Guest. (0) → PAUSE Member. (1) → PAUSE Insider. (10) → Vip Pause Club. (25). Icons: door/key/crown unchanged; the 2nd tier's icon was replaced (was an unclear blob) with a sprout.

**Leaderboard permanently excludes** the owner's own test accounts: `config.LEADERBOARD_EXCLUDED_TG_IDS = {"7118369020", "614897018"}`, filtered in `sheets.get_club_leaderboard()`.

**Still open / explicitly deferred by the user:**
- No real photos for any `.pday-card` background yet — currently decorative gradients. When photos arrive: landscape ~4:3, ≥1600px long edge, JPEG, ≤300–500KB, subject centered (cropped via `background`/`cover`), dark/moody or we add a darkening overlay (text is light ivory).
- "Ближайшие события" and "PAUSE Care" tiles (in the 3-tile row) are pure UI stubs (toast "скоро") — no backend/content planned yet.
- Monthly big-prize PAUSE GIFT slide has no real mechanic (pool, draw date) — only the daily one (`sheets`/`pauseapp.py` giveaway functions) is real.
- **Paid delivery is live in PAUSE App for everyone** (`config.DELIVERY_FEES_ENABLED`, kill switch env `PAUSEAPP_DELIVERY_FEES=0`). Fee (`CLUB_DELIVERY_FEES`) sits in `O_DELIVERY_FEE` on ONE "carrier" row of the order batch (first non-petal row; if a petal covers the whole cart, an extra qty-0 row) and shares that row's payment state (col K). Debt includes it via `_row_amount`. Ops → "Доставки" (`/api/ops/delivery`, `sheets.get_delivery_overview`) shows accrued/paid/review/debt/unpaid. Not covered: orders via the chat bot (`handlers/`) and new-point (pending) orders — no fee there.

**Non-obvious gotchas hit this session, worth remembering:**
- Google Sheets `SUMIF`/`SUM` silently skip text-typed cells even if they look numeric — `append_order`/`append_orders_batch` now write `O_QTY` as a real `int`, not `str()`, because Sheet1's "Кол-во Заказов" column is a `SUMIF` over that column (this is why order counts could look "stuck" even with real confirmed orders — see `sheets.migrate_order_qty_to_numbers()` / `scripts/fix_order_qty.py` for the one-time historical-data fix, must be run somewhere with real Sheets credentials, not in this sandbox).
- `openProfileSubscreen(title, loaderFn)`'s `sub` container starts with a skeleton-block child already inside it — any `loaderFn` that renders synchronously (not through an async `api()` call) must do `sub.innerHTML = ""` itself first, or the skeleton lingers above the real content.
- `tg://user?id=...` deep links (Telegram "Написать" buttons) only resolve if the viewer's Telegram client already has that user cached locally — prefer the `https://t.me/<username>` form routed through `WebApp.openTelegramLink()` (see `openTelegramChat` in `app.js`), falling back to `tg://` only when no username is known.

## Mini App-only mode (prepared, OFF by default)
`BOT_MINIAPP_ONLY=1` (+ `WEBAPP_URL`) → clients get ONE button "Открыть PAUSE" in the bot (couriers also "Маршрут"); old buttons/texts are caught by `handlers/legacy.py` (first router) and answered with a warm rebrand message + app button (8 s cooldown per user); bot menu button → app; auto-broadcast on menu publish is disabled (manual "Рассылка" in Ops Center: `/api/ops/broadcast*`, `pauseapp._run_menu_broadcast`, log sheet "Рассылки меню"). Admins (`ADMIN_IDS`) keep the text bot. Registration (name/phone) stays in the bot. `sheets._CachedWs` caches Sheets reads for `SHEETS_READ_CACHE_SECONDS` (12 s; any write to a sheet invalidates it) — needed so mass app opens don't exhaust the Sheets read quota.
