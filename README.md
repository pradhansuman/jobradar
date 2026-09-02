# JobRadar ◈ — early job discovery from company career pages

An open-source MVP of a "Protocol Jobs"-style platform for job seekers in India: it pulls openings **directly from company-hosted career boards** (the pages recruiters publish to *first*), scores them against your CV, estimates competition signals, and pushes alert digests — plus a small browser extension that autofills application forms.

## Why this exists

Job boards like LinkedIn/Naukri index company postings hours to days after they go live on the company's own careers page. JobRadar watches the source, so your "first seen" timestamp typically beats the boards — the early window is where competition is lowest.

## What's inside

| Piece | What it does | Where |
|---|---|---|
| **Ingestion pipeline** | Pulls postings from Greenhouse & Lever public board APIs (8 boards seeded, add any slug/URL from the UI) + a generic scraper for careers pages embedding schema.org `JobPosting` JSON-LD. Runs on boot, then every 30 min. Dedupes by `sha1(company|title|url)`. | `server/sources.js`, `server/ingest.js` |
| **Matching engine** | Deterministic, explainable, no API key: skill-dictionary extraction (≈250 skills), skill recall (55%) + precision (20%) + TF-IDF cosine text similarity (25%) → 0–100 score per job vs your CV. | `server/match.js` |
| **Signals** | Estimated competition (first-seen age + direct-source), recruiter strictness (density of hard-requirement language), fit sensitivity. Labeled heuristics for prioritization — not insider data. | `server/match.js` |
| **ATS check** | Resume formatting heuristics: contact info, sections, bullets, length, dates → 0–100 + fix tips. Keyword-gap list per job (what the posting wants that your CV lacks). | `server/match.js` |
| **Alerts** | New jobs checked against keyword/location/minimum-score prefs → email digest (Resend) and/or WhatsApp (Meta Cloud API). Queued in an inspectable outbox; unconfigured channels are marked `skipped`, never silently lost. | `server/notify.js` |
| **Web UI** | Dark, responsive, no build step: live job feed with score rings & freshness badges, filters/search/sort-by-match, job detail with matched/missing skills + signals, CV Studio, alert prefs + outbox, pipeline admin (trigger ingest, verify & add boards). | `public/` |
| **Autofill extension** | MV3 Chrome/Edge extension: saves your profile locally, fills empty fields on application forms (Greenhouse/Lever/generic) in one click. Nothing leaves the browser. | `extension/` |

## Quickstart

```bash
npm install
npm start
# → http://localhost:8787  (first boot auto-ingests ~2,000+ real postings)
```

1. Open **CV Studio** → paste your resume text → save (skills + ATS score computed).
2. The **Jobs** feed now shows a match score on every posting; sort by *best match*.
3. Set **Alerts** preferences and hit *Send test digest now*.
4. Load the extension: `chrome://extensions` → Developer mode → *Load unpacked* → select `extension/`.

### Optional environment (`.env` — copy `.env.example`)

| Variable | Purpose |
|---|---|
| `PORT` | default 8787 |
| `ADMIN_TOKEN` | if set, ingest/board-admin endpoints require `x-admin-token` header |
| `INGEST_INTERVAL_MIN` | minutes between ingests (default 30) |
| `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `ALERT_TO_EMAIL` | email digests ([resend.com](https://resend.com), free tier works) |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `ALERT_TO_WHATSAPP` | WhatsApp digests (Meta Cloud API) |

CLI one-shot ingest + alert queue: `npm run ingest`.

## Deploying

Any Node 18+ host works (single service, SQLite file storage):

- **Render**: Web Service → build `npm install`, start `npm start`, add a persistent disk mounted at `data/` (or the DB resets on deploy).
- **Fly.io/Railway/VPS**: same; put a reverse proxy + auth in front before exposing publicly (MVP is single-tenant, no login).

### Production upgrade path

- **Database → Neon/Supabase Postgres**: the SQL is plain and isolated in `server/db.js`; swap `better-sqlite3` for `pg` (or Drizzle) and migrate the 6 tables (schema in `server/db.js`). Suggested: keep the same table/column names — everything else in the codebase talks to db.js only.
- **Scheduler → cron**: on Render, replace the in-process `setInterval` with a cron hitting `POST /api/ingest` (protect with `ADMIN_TOKEN`).
- **LLM resume tailoring**: the keyword-gap output is the prompt input; add a rewrite call where `server/match.js` returns gaps (deliberately left out of core so the MVP runs key-free).

## Honest limitations (by design, for now)

- Scores/signals are prioritization heuristics, not outcome predictions.
- Salary shows only when a source publishes it.
- Single-tenant, no auth — don't expose it raw to the internet.
- "Early" means earlier than job boards, not secret — recruiters see the same page.
- Extension fills simple text fields; Workday-style multi-step flows are on the roadmap.

## Verified

- `2,300+ live postings` ingested from 8 real boards (Postman, Stripe, Databricks, Canonical, GitLab, Meesho, CRED, Paytm) with 0 failures after fixes.
- CV → match → signals → alerts exercised end-to-end via API (see repo history).

MIT licensed. Built as a working reference of the "career-page-first discovery" model.
