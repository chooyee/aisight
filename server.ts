import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import pinoHttp from "pino-http";
import { logger } from "./app/lib/logger.js";
import { runMigrations } from "./app/lib/db/migrate.js";

const app = express();

app.use(compression());
app.use(
  pinoHttp({
    logger,
    // Skip static assets, Vite HMR, and successful 304s — only log app routes
    autoLogging: {
      ignore: (req) => {
        const url = req.url ?? "";
        return (
          // Vite dev / HMR internals
          url.startsWith("/@") ||
          url.startsWith("/__") ||
          url.startsWith("/node_modules/") ||
          url.startsWith("/app/") ||
          // Static assets by extension
          /\.(js|ts|tsx|jsx|css|map|ico|png|svg|woff2?)(\?|$)/.test(url)
        );
      },
    },
    // Downgrade successful responses to debug so they stay out of the log file
    customLogLevel: (_req, res) => {
      if (res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "debug";
    },
  })
);
app.disable("x-powered-by");

const viteDevServer =
  process.env.NODE_ENV === "production"
    ? undefined
    : await import("vite").then((vite) =>
        vite.createServer({ server: { middlewareMode: true } })
      );

app.use(
  viteDevServer ? viteDevServer.middlewares : express.static("build/client")
);

app.all(
  "*",
  createRequestHandler({
    // @ts-ignore — build output type
    build: viteDevServer
      ? () => viteDevServer.ssrLoadModule("virtual:react-router/server-build")
      : await import("./build/server/index.js"),
  })
);

await runMigrations();

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  logger.info({ port }, "AISight server started");
});
