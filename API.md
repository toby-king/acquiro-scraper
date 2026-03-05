# Acquiro Scraper — API Reference

Base URL: `https://your-app.railway.app`

---

## Public endpoints

### `POST /scrape`

Scrape one or more sources and ingest listings into Bubble + Pinecone.

**Body**
```json
{ "sources": "rightbiz", "pages": 3 }
```
```json
{ "sources": ["rightbiz", "cogogo"], "pages": 3 }
```

| Field | Type | Description |
|---|---|---|
| `sources` | string or array | One or more source keys (see valid values below) |
| `pages` | integer | Number of pages to scrape per source (min 1) |

Valid source values: `rightbiz`, `cogogo`, `daltons`, `businessesforsale`

**Response `200`**
```json
{
  "pages": 3,
  "count": 75,
  "by_source": { "Rightbiz": 40, "CoGoGo": 35 },
  "listings": []
}
```

---

### `POST /api/generate-matches`

Generate matches for a single buyer and persist them to Bubble.

**Body**
```json
{ "user_id": "<bubble_user_id>" }
```

**Response `200` — matches found**
```json
{
  "matched": 3,
  "matches": [
    { "id": "<bubble_business_id>", "score": 0.8421 }
  ]
}
```

**Response `200` — no new matches**
```json
{ "message": "No new unseen matches found today above the threshold." }
```

**Response `404`** — no Buyer_Info found for this user.

---

## Admin endpoints

All admin endpoints require:
```
Authorization: Bearer <ADMIN_API_KEY>
```

Returns `401` if the key is wrong, `503` if `ADMIN_API_KEY` is not configured.

---

### `GET /admin/status`

Returns the current scheduler state.

**Response `200`**
```json
{
  "schedulerEnabled": true,
  "cronExpression": "0 2 * * *",
  "timezone": "Europe/London"
}
```

---

### `POST /admin/scheduler/enable`

Enable the daily cron job.

**Response `200`**
```json
{ "ok": true, "schedulerEnabled": true }
```

---

### `POST /admin/scheduler/disable`

Disable the daily cron job (the process keeps running but the job will not fire).

**Response `200`**
```json
{ "ok": true, "schedulerEnabled": false }
```

---

### `POST /admin/run-pipeline`

Trigger the full daily pipeline immediately (scrape all sources, then run matching for all active subscribers). Returns immediately — runs in the background.

**Response `202`**
```json
{ "ok": true, "message": "Pipeline started" }
```

---

### `POST /admin/run-scrape`

Trigger scraping only (all sources, `SCRAPE_PAGES` pages each). Returns immediately — runs in the background.

**Response `202`**
```json
{ "ok": true, "message": "Scrape started" }
```

---

### `POST /admin/run-matches`

Trigger matching only for all active subscribers. Returns immediately — runs in the background.

**Response `202`**
```json
{ "ok": true, "message": "Match run started" }
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BUBBLE_API_KEY` | — | Required |
| `OPENAI_API_KEY` | — | Required |
| `PINECONE_API_KEY` | — | Required |
| `PINECONE_INDEX_NAME` | — | Required |
| `ADMIN_API_KEY` | — | Required for admin endpoints |
| `SCRAPE_CRON` | `0 2 * * *` | Cron schedule for daily pipeline (Europe/London) |
| `SCRAPE_PAGES` | `20` | Pages per source in the daily pipeline |
| `PORT` | `3000` | Set automatically by Railway — do not override |
