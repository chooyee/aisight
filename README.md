# AISight

News scraping and intelligence extraction tool for Central Bank supervisors.

**Stack:** React Router v7 · Express · SQLite (Drizzle ORM) · Tailwind v4 · Gemini Flash/Pro · Tavily · Playwright

## Setup

```bash
cp .env.example .env
# Fill in GEMINI_API_KEY and TAVILY_API_KEY in .env

npm install
npx playwright install chromium
```

## Development

```bash
npm run dev        # tsx watch server.ts — hot-reloads via Vite middleware
```

Open [http://localhost:3000](http://localhost:3000).

## Production

```bash
npm run build      # react-router build → build/client + build/server
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
| `/chat` | Command interface — issue scraping commands, watch live progress |
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
