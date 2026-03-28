import { type RouteConfig, index, route, layout, prefix } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),

  // Dashboard
  route("dashboard", "routes/dashboard._index.tsx"),

  // Chat
  route("chat", "routes/chat.tsx"),

  // Knowledge Graph
  route("graph", "routes/graph.tsx"),

  // Ops & Config (nested layout with tabs)
  layout("routes/ops.tsx", [
    index("routes/ops._index.tsx"),
    route("ops/sectors", "routes/ops.sectors.tsx"),
    route("ops/calendar", "routes/ops.calendar.tsx"),
    route("ops/extraction", "routes/ops.extraction.tsx"),
  ]),

  // API resource routes
  ...prefix("api", [
    route("articles", "routes/api.articles.ts"),
    route("entities", "routes/api.entities.ts"),
    route("graph", "routes/api.graph.ts"),
    route("crawl", "routes/api.crawl.ts"),
    route("chat/:sessionId", "routes/api.chat.$sessionId.ts"),
    ...prefix("config", [
      route("sectors", "routes/api.config.sectors.ts"),
      route("calendar", "routes/api.config.calendar.ts"),
      route("extraction", "routes/api.config.extraction.ts"),
    ]),
  ]),
] satisfies RouteConfig;
