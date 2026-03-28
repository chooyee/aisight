import { createRequestHandler } from "@react-router/express";
import { installGlobals } from "@react-router/node";
import compression from "compression";
import express from "express";
import { pino } from "pino";
import pinoHttp from "pino-http";

installGlobals();

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

app.use(compression());
app.use(pinoHttp({ logger }));
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

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  logger.info({ port }, "AISight server started");
});
