import { type RouteConfig, index, route, prefix } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),

  // Dashboard
  route("dashboard", "routes/dashboard._index.tsx"),
  route("articles/:id", "routes/articles.$id.tsx"),

  // Chat
  route("chat", "routes/chat.tsx"),

  // Knowledge Graph
  route("graph", "routes/graph.tsx"),

  // Entities
  route("entities", "routes/entities.tsx"),
  route("entities/:id", "routes/entities.$id.tsx"),

  // Ops & Config (nested layout with tabs)
  route("ops", "routes/ops.tsx", [
    index("routes/ops._index.tsx"),
    route("sectors", "routes/ops.sectors.tsx"),
    route("calendar", "routes/ops.calendar.tsx"),
    route("extraction", "routes/ops.extraction.tsx"),
    route("research", "routes/ops.research.tsx"),
  ]),

  // API resource routes
  ...prefix("api", [
    route("articles", "routes/api.articles.ts"),
    route("articles/:id", "routes/api.articles.$id.ts"),
    route("entities", "routes/api.entities.ts"),
    route("entities/:id", "routes/api.entities.$id.ts"),
    route("entities/:id/affiliations", "routes/api.entities.$id.affiliations.ts"),
    route("entities/:id/research", "routes/api.entities.$id.research.ts"),
    route("graph", "routes/api.graph.ts"),
    route("graph/chat", "routes/api.graph.chat.ts"),
    route("crawl", "routes/api.crawl.ts"),
    route("research/runs", "routes/api.research.runs.ts"),
    route("research/runs/:id", "routes/api.research.runs.$id.ts"),
    route("chat/:sessionId", "routes/api.chat.$sessionId.ts"),
    ...prefix("config", [
      route("sectors", "routes/api.config.sectors.ts"),
      route("calendar", "routes/api.config.calendar.ts"),
      route("extraction", "routes/api.config.extraction.ts"),
    ]),
  ]),
] satisfies RouteConfig;
