# AISight

News scraping and intelligence extraction tool for Central Bank supervisors.

**Stack:** React Router v7 - Express - SQLite (Drizzle ORM) - Tailwind v4 - Gemini Flash/Pro - Tavily - Playwright

## Setup

```bash
cp .env.example .env
# Fill in GEMINI_API_KEY and TAVILY_API_KEY in .env

npm install
npx playwright install chromium
```

## Development

```bash
npm run dev        # tsx watch server.ts - hot-reloads via Vite middleware
```

Open [http://localhost:3000](http://localhost:3000).

## How To Use The System

Use this flow for normal operations:

1. Configure monitoring scope first:
   - Go to `/ops/sectors` and add or update sectors and keywords to monitor.
   - Go to `/ops/calendar` and configure fiscal calendars for tracked entities.
   - Go to `/ops/extraction` and define extraction items for custom risk/event fields.
2. Start a collection run:
   - Open `/chat`.
   - Submit a crawl query (for example: `Basel III capital requirements banks APAC`).
   - Monitor live pipeline progress in the chat stream while scraping/extraction runs.
3. Review extracted intelligence:
   - Open `/dashboard` to review article feed, events, entities, and risk signals.
   - Use filters/date ranges to focus on the reporting period you need.
4. Investigate relationships:
   - Open `/graph` to inspect entity-event relationships in the knowledge graph.
   - Click nodes for details, then use graph chat for cross-article reasoning and follow-up questions.
5. Iterate:
   - Refine sectors, extraction items, or queries based on results, then run another crawl.

Recommended first run:
- Set up one sector with a small keyword set.
- Run one targeted query from `/chat`.
- Validate outcomes on `/dashboard` and `/graph` before scaling up query volume.

## Production

```bash
npm run build      # react-router build -> build/client + build/server
npm start          # NODE_ENV=production node server.js
```

## Database

```bash
npm run db:generate   # generate migration SQL from schema changes
npm run db:migrate    # apply pending migrations
npm run db:studio     # open Drizzle Studio (web UI for the DB)
```

Migrations run automatically on server startup.

## Routes

| Path | Description |
|------|-------------|
| `/dashboard` | Chronological article feed with risk signals |
| `/chat` | Command interface - issue scraping commands, watch live progress |
| `/graph` | Cytoscape.js knowledge graph of entity relationships |
| `/ops/sectors` | Manage monitored sectors and keywords |
| `/ops/calendar` | Configure entity-specific fiscal calendars |
| `/ops/extraction` | Define custom extraction items (e.g. Basel risk mapping) |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crawl` | POST | Trigger pipeline: `{ query, maxResults?, dayRange? }` |
| `/api/chat/:sessionId` | GET | SSE stream of pipeline progress events |
| `/api/articles` | GET | List articles (`?from=&to=&sector=&page=&limit=`) |
| `/api/entities` | GET | List entities (`?sector=&type=`) |
| `/api/graph` | GET | Cytoscape nodes + edges JSON |
| `/api/config/sectors` | GET/POST/PUT/DELETE | Sector CRUD |
| `/api/config/calendar` | GET/POST/PUT/DELETE | Fiscal calendar CRUD |
| `/api/config/extraction` | GET/POST/PUT/DELETE | Extraction item CRUD |
