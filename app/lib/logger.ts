import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const logDir = path.resolve("log");
fs.mkdirSync(logDir, { recursive: true });

const level = process.env.LOG_LEVEL ?? "info";

// Use pathToFileURL so pino worker threads get valid file:// URLs on Windows
// (require.resolve returns backslash paths which pino converts to invalid file://D:\... URLs)
const pinoPretty = pathToFileURL(require.resolve("pino-pretty")).href;
const pinoRoll = pathToFileURL(require.resolve("pino-roll")).href;

export const logger = pino(
  {
    level,
    // ISO timestamp + drop pid/hostname → readable JSON in the log file
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      bindings: () => ({}),
    },
  },
  pino.transport({
    targets: [
      // Console — colourised, human-readable
      {
        target: pinoPretty,
        options: {
          colorize: true,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
        },
        level,
      },
      // File — daily rotation: current → app.log, previous → app.YYYY-MM-DD.log
      {
        target: pinoRoll,
        options: {
          file: path.join(logDir, "app.log"),
          frequency: "daily",
          mkdir: true,
        },
        level,
      },
    ],
  })
);
