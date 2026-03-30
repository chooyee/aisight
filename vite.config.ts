import tailwindcss from "@tailwindcss/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    target: 'esnext' // or 'es2022'
  },
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "app"),
    },
  },
  plugins: [
    tailwindcss(),
    reactRouter(),
  ],
  ssr: {
    // Keep native addons server-side only — never bundle into client
    external: ["better-sqlite3", "playwright"],
    noExternal: [],
  },
});
