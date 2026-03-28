# AISight Codemap — React Router v7 + Express for First-Timers

This document walks you through how the codebase is wired together, starting from "a request arrives" and ending at "the browser shows something". Read it top-to-bottom the first time.

---

## 1. How the server starts (`server.ts`)

```
npm run dev
  └─ tsx watch server.ts
```

`server.ts` is a plain Express app. It is **not** generated or hidden — you own it completely.

```ts
// server.ts

// 1. Create an Express app
const app = express();
app.use(compression());
app.use(pinoHttp({ logger }));  // HTTP request logging

// 2. In dev: hand all assets to Vite's dev server
//    In prod: serve the pre-built files from build/client/
const viteDevServer = await import("vite").then(vite =>
  vite.createServer({ server: { middlewareMode: true } })
);
app.use(viteDevServer.middlewares);

// 3. Hand ALL remaining requests to React Router
app.all("*", createRequestHandler({ build: ... }));

// 4. Run DB migrations before accepting traffic
await runMigrations();

// 5. Start listening
app.listen(3000);
```

**Key insight:** React Router is just an Express middleware. Every HTTP request goes through Express first, then React Router handles it. This means you can add any Express middleware (auth, rate limiting, etc.) *before* React Router sees the request.

---

## 2. How routes are declared (`app/routes.ts`)

In Next.js, files in `app/` automatically become routes. **React Router v7 does not do this.** You explicitly list every route in one file:

```ts
// app/routes.ts

export default [
  index("routes/_index.tsx"),            // GET /  → redirects to /dashboard
  route("dashboard", "routes/dashboard._index.tsx"),  // GET /dashboard
  route("chat", "routes/chat.tsx"),       // GET /chat

  // layout() = a wrapper component that wraps child routes
  layout("routes/ops.tsx", [
    route("ops/sectors",    "routes/ops.sectors.tsx"),
    route("ops/calendar",   "routes/ops.calendar.tsx"),
    route("ops/extraction", "routes/ops.extraction.tsx"),
  ]),

  // prefix() = group routes under a URL prefix
  ...prefix("api", [
    route("crawl",              "routes/api.crawl.ts"),
    route("chat/:sessionId",    "routes/api.chat.$sessionId.ts"),
    route("articles",           "routes/api.articles.ts"),
    route("graph",              "routes/api.graph.ts"),
    route("graph/chat",         "routes/api.graph.chat.ts"),  // LLM Q&A on the graph
  ]),
] satisfies RouteConfig;
```

The **file name** in `routes/` is just a file name — it has no routing meaning. What matters is the string you pass to `route("path", "file")`. The path is the URL; the file is the code.

---

## 3. The three kinds of files in `app/routes/`

### Kind 1 — Page route (has a UI)

Has a `loader` **and** a `default` export (the React component).

```ts
// app/routes/dashboard._index.tsx

// loader runs on the SERVER before the page renders
export async function loader({ request }: LoaderFunctionArgs) {
  const db = getDb();
  const rows = await db.select().from(articles)...;
  return { articles: rows };  // this becomes the component's data
}

// The React component runs on both server (SSR) and browser
export default function Dashboard() {
  const { articles } = useLoaderData<typeof loader>();  // reads what loader returned
  return <div>...</div>;
}
```

**What happens when you visit `/dashboard`:**
1. Express receives `GET /dashboard`
2. React Router finds the matching route file
3. `loader()` runs **on the server** — it can query the database directly
4. The return value is serialised to JSON
5. React renders the component on the server with that data (SSR)
6. HTML is sent to the browser
7. React "hydrates" in the browser (attaches event listeners)
8. `useLoaderData()` gives the component the same data, now in the browser

### Kind 2 — Resource route (API endpoint, no UI)

Has a `loader` and/or `action` but **no default export**. It just returns data or performs mutations.

```ts
// app/routes/api.crawl.ts

// action handles POST/PUT/DELETE/PATCH
export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json();
  const runId = await runPipeline({ query: body.query });
  return Response.json({ runId });  // just returns JSON
}

// No "export default function ..." here — that's what makes it a resource route
```

`loader` handles GET. `action` handles everything else.

### Kind 3 — Layout route (wraps child routes)

Has only a `default` export that renders `<Outlet />`. The `<Outlet />` is where child routes render.

```ts
// app/routes/ops.tsx

export default function Ops() {
  return (
    <AppShell>
      <div>
        <h1>Ops & Configuration</h1>
        {/* Tabs for /ops/sectors, /ops/calendar, /ops/extraction */}
        <nav>...</nav>

        {/* The matched child route renders HERE */}
        <Outlet />
      </div>
    </AppShell>
  );
}
```

When you visit `/ops/sectors`, React Router renders:
```
<Ops>           ← ops.tsx (the layout)
  <OprsSectors> ← ops.sectors.tsx (the child)
</Ops>
```

---

## 4. The three entry files you rarely touch

```
app/
  root.tsx          ← The outermost HTML shell
  entry.server.tsx  ← How the server renders HTML
  entry.client.tsx  ← How the browser hydrates
```

### `root.tsx` — The HTML document

This wraps every page. It owns the `<html>`, `<head>`, and `<body>` tags.

```ts
// app/root.tsx

export function Layout({ children }) {
  return (
    <html>
      <head>
        <Meta />   {/* React Router injects <title>, <meta> tags here */}
        <Links />  {/* React Router injects <link rel="stylesheet"> here */}
      </head>
      <body>
        {children}  {/* every page renders here */}
        <Scripts /> {/* React Router injects the JS bundles here */}
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;  // render the matched route
}
```

The `links` export at the top of `root.tsx` is how the Google Fonts `<link>` and `app.css` get into every page's `<head>`.

### `entry.server.tsx` — Server-side rendering

Called by React Router for every SSR request. It uses React's `renderToPipeableStream` to stream HTML to the browser. It checks `isbot()` — if the request is from a search engine crawler, it waits for the full page before responding (`onAllReady`). For browsers it sends HTML as soon as the shell is ready (`onShellReady`). You almost never modify this file.

### `entry.client.tsx` — Browser hydration

Runs once in the browser when the page loads. `hydrateRoot` takes the server-rendered HTML and attaches React's event handlers to it. You almost never modify this file.

---

## 5. How data flows: loader → component

The pattern used in every page route:

```
URL params / query string
        ↓
   loader() runs on server
   (can use getDb(), fetch, etc.)
        ↓
   return { data }
        ↓
   useLoaderData() in component
        ↓
   renders in browser
```

Example from the dashboard:

```ts
// Server side — runs in Node.js, full DB access
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const sector = url.searchParams.get("sector");  // reads ?sector=banking
  const db = getDb();
  const rows = await db.select().from(articles).where(eq(articles.sector, sector));
  return { articles: rows };  // serialised to JSON, sent to browser
}

// Browser side — reads what loader returned
export default function Dashboard() {
  const { articles } = useLoaderData<typeof loader>();
  // articles is already here — no useEffect, no fetch() needed
  return <div>{articles.map(a => <p>{a.title}</p>)}</div>;
}
```

**Why this is better than `useEffect` + `fetch`:** The data is already in the HTML when the page loads. No loading spinners, no extra round trips.

---

## 6. How mutations work: `action` + `useFetcher`

When you submit a form or click a delete button, the data flows like this:

```
User interaction (form submit / button click)
        ↓
   useFetcher submits FormData to the same route's action()
        ↓
   action() runs on server (DB write, etc.)
        ↓
   React Router re-runs loader() automatically
        ↓
   component re-renders with fresh data
```

From `ops.sectors.tsx`:

```tsx
// The action handles all operations via an "intent" field
export async function action({ request }) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") { await db.insert(sectors)... }
  if (intent === "delete") { await db.delete(sectors)... }
  if (intent === "toggle") { await db.update(sectors)... }
}

// In the component — useFetcher submits without navigating away
const fetcher = useFetcher();

<fetcher.Form method="post">
  <input type="hidden" name="intent" value="delete" />
  <input type="hidden" name="id" value={sector.id} />
  <button type="submit">Delete</button>
</fetcher.Form>
```

`useFetcher` is like `fetch()` but React-Router-aware: it automatically invalidates and re-runs the loader after the action succeeds, so your list refreshes without a page reload.

---

## 7. How real-time works: the SSE pattern

The chat page needs live updates while the pipeline runs. This uses Server-Sent Events (SSE) — a one-way stream from server to browser.

**The flow:**

```
1. User types query → POST /api/crawl
         ↓
2. action() creates a DB record, calls runPipeline() (non-blocking, runs in background)
   returns { sessionId } immediately
         ↓
3. chat.tsx sets sessionId state → triggers useSSEStream(sessionId)
         ↓
4. useSSEStream opens: new EventSource("/api/chat/SESSION_ID")
         ↓
5. api.chat.$sessionId.ts loader() returns a ReadableStream with SSE headers
         ↓
6. Meanwhile, orchestrator.ts processes articles and calls:
   pipelineEmitter.emit(sessionId, { type: "progress", message: "..." })
         ↓
7. pipelineEmitter listener in the SSE route handler writes to the ReadableStream
         ↓
8. Browser receives events, useSSEStream appends them to state → UI updates
```

The `pipelineEmitter` in `app/lib/sse/emitter.ts` is the glue — a Node.js EventEmitter that lives in the same process as everything else:

```ts
// app/lib/sse/emitter.ts
export const pipelineEmitter = new PipelineEmitter();

// orchestrator calls:
pipelineEmitter.emit(sessionId, { type: "progress", stage: "scrape", message: "..." });

// SSE route listens:
pipelineEmitter.on(sessionId, (event) => {
  controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ...\n\n`));
});
```

**Why this works:** Express + React Router is one Node.js process. The pipeline code and the SSE response handler share the same memory, so an in-process EventEmitter connects them directly.

---

## 8. The `~` path alias

Throughout the codebase you'll see:

```ts
import { getDb } from "~/lib/db/client";
import { AppShell } from "~/components/layout/AppShell";
```

`~` is just an alias for the `app/` folder, configured in `vite.config.ts`:

```ts
resolve: {
  alias: { "~": path.resolve(__dirname, "app") }
}
```

So `~/lib/db/client` means `app/lib/db/client.ts`.

---

## 9. Why `better-sqlite3` and `playwright` are in `ssr.external`

```ts
// vite.config.ts
ssr: {
  external: ["better-sqlite3", "playwright"],
}
```

These are native Node.js addons (compiled C++ binaries). Vite cannot bundle them — they must be loaded at runtime by Node.js directly. Marking them `external` tells Vite: "don't try to bundle this, just leave the `require()` call as-is."

They also only ever run on the server. The DB and Playwright are never shipped to the browser.

---

## 10. Reading a route file quickly

When you open any file in `app/routes/`, scan for these exports in order:

| Export | What it means |
|--------|---------------|
| `export async function loader` | Server-side data fetching (GET) |
| `export async function action` | Server-side mutation handler (POST/PUT/DELETE) |
| `export default function` | React component (the UI) — present = page route, absent = resource route |
| `export const links` | `<link>` tags to inject in `<head>` for this route |
| `export const meta` | `<title>` and `<meta>` tags for this route |

If a file has no `export default` — it's an API endpoint. If it has one — it's a page.

---

## 11. The full request lifecycle in one picture

```
Browser: GET /dashboard?sector=banking
    │
    ▼
Express (server.ts)
  → pino logs the request
  → compression middleware
  → createRequestHandler hands off to React Router
    │
    ▼
React Router matches route: "routes/dashboard._index.tsx"
    │
    ▼
loader() runs on Node.js
  → reads ?sector=banking from URL
  → getDb() → SQLite query
  → returns { articles: [...] }
    │
    ▼
entry.server.tsx renders HTML
  → root.tsx wraps everything in <html><head>...<body>
  → Dashboard component renders with loader data
  → HTML streamed back to browser
    │
    ▼
Browser receives HTML (page appears immediately)
    │
    ▼
entry.client.tsx runs
  → hydrateRoot() attaches React to the server-rendered HTML
  → page is now interactive
```

---

## 12. Where to look when something breaks

| Symptom | Where to look |
|---------|--------------|
| Server won't start | `server.ts` — check Express middleware order |
| Route returns 404 | `app/routes.ts` — is the route declared? |
| Page loads but data is missing | The `loader()` function in that route file |
| Form submit does nothing | The `action()` function in that route file |
| DB error | `app/lib/db/schema.ts` + `app/lib/db/client.ts` |
| SSE stream not updating | `app/lib/sse/emitter.ts` + `app/routes/api.chat.$sessionId.ts` |
| Graph page crashes on load | `app/routes/graph.tsx` — Cytoscape SSR guard (`mounted` state) |
| Graph shows no events/nodes | Check `api.graph.ts` loader — events are derived via `articleEntities` join |
| Graph chat returns empty answers | `api.graph.chat.ts` — check `GEMINI_API_KEY`; web search requires `TAVILY_API_KEY` |
| Chat highlight doesn't work | `cyInstanceRef` in `GraphCanvas` must be mounted before chat sends a message |
| CSS not applying | `app/styles/app.css` — Tailwind v4 uses `@import "tailwindcss"` not config file |
| `~/` import not found | `vite.config.ts` resolve alias + `tsconfig.json` paths |

---

## 13. The knowledge graph page in detail

The graph page (`app/routes/graph.tsx`) is the most complex page. Here's how it's structured:

```
GraphPage (exported default)
  │
  ├─ loader()          ← SSR: queries entities, relationships, events, articleEntities
  │                       builds GraphNode[] + GraphEdge[] + involvement edges
  │
  ├─ GraphCanvas       ← Cytoscape.js, loaded client-side only via import()
  │    └─ useEffect    ← initialises cy, registers "tap" handler, exposes cyInstanceRef
  │
  ├─ Legend            ← Collapsible overlay (bottom-left of canvas)
  │
  ├─ NodeDetail        ← Shown in right sidebar when a node is tapped
  │    └─ for events: shows eventType badge, date, article link
  │
  └─ ChatPanel         ← LLM chat in right sidebar
       ├─ POST /api/graph/chat  ← sends { question, enableWebSearch }
       └─ onHighlight()         ← calls cy.nodes('#id').addClass('highlighted')
```

### Two node types

| Node type | Shape | Coloured by |
|-----------|-------|-------------|
| `entity` | Ellipse (circle) | `entityType`: company=blue, regulator=amber, person=green, instrument=purple |
| `event` | Diamond | `eventType`: regulation=orange, enforcement=red, earnings=green, … |

### Two edge types

| Edge | Style | Meaning |
|------|-------|---------|
| `relationship` | Solid line with arrow | Direct entity↔entity relationship from LLM extraction |
| `involvement` | Dashed line | Entity and event appeared in the same article (derived at query time) |

### Why involvement edges are derived, not stored

There is no `entityEvents` join table. Instead, `articleEntities` links entities to articles, and `events` links events to articles. The loader does an in-memory join:

```ts
// articleId → Set<entityId>
const articleToEntities = new Map(...)
// articleId → Set<eventId>
const articleToEvents = new Map(...)

// For each article, cross-join its entities and events
for (const [articleId, entIds] of articleToEntities) {
  const evIds = articleToEvents.get(articleId)
  // entity × event → one "involved_in" edge each
}
```

This keeps the schema simple — no extra migration needed when adding events.

### How graph chat highlights nodes

1. User asks a question in `ChatPanel`
2. `POST /api/graph/chat` returns `{ highlightEntityIds: [...], highlightEventIds: [...] }`
3. `ChatPanel` calls `onHighlight(entityIds, eventIds)` (passed as a prop)
4. `GraphPage.handleHighlight` has a ref to the Cytoscape instance (`cyRef`)
5. It calls `cy.nodes('#id').addClass('highlighted')` for each matched node
6. The `.highlighted` CSS class in the Cytoscape stylesheet gives those nodes a yellow border + overlay

---

## 14. Graph chat API (`/api/graph/chat`)

This is a resource route with only an `action` (POST only):

```
POST /api/graph/chat
Body: { question: string, enableWebSearch?: boolean }

Pipeline:
  1. Keyword-tokenise the question (words > 2 chars)
  2. LIKE-search entities by name for each keyword
  3. Fetch relationships, events, riskSignals for matched entities
  4. (optional) Tavily web search if enableWebSearch + TAVILY_API_KEY set
  5. Build a structured context prompt
  6. Call Gemini Tier 2 (gemini-3-flash-preview)
  7. Return { answer, context: { counts }, highlightEntityIds, highlightEventIds }
```

The response metadata (`context.entitiesFound`, `context.webResultsUsed`, etc.) is shown as small pill tags below the assistant message bubble in the chat UI.
