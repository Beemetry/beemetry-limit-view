import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_ROOT = path.resolve(__dirname, "src", "Fibra Exportada");
const CHANNEL_DIRS = {
  "1": "Fibra_Espesador_ch1",
  "2": "Fibra_Espesador_ch2",
  "3": "Fibra_Espesador_ch3",
};
// cantidad de archivos recientes a leer por canal (ajusta aquí si quieres más)
const FILES_PER_CHANNEL = 17;
const ROOT_DIR = path.resolve(__dirname);
const CWD_DIR = path.resolve(process.cwd());

const parseFilePoints = async (filePath, range) => {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const lines = content.trim().split(/\r?\n/);
    const points = [];

    for (const line of lines) {
      const parts = line.trim().split(",");
      if (parts.length < 2) continue;
      const xVal = parseFloat(parts[0]);
      const yVal = parseFloat(parts[1]);
      if (Number.isNaN(xVal) || Number.isNaN(yVal)) continue;
      if (
        range &&
        ((range.min !== undefined && xVal < range.min) ||
          (range.max !== undefined && xVal > range.max))
      ) {
        continue;
      }
      points.push({ distance: xVal, temperature: yVal });
    }

    points.sort((a, b) => a.distance - b.distance);
    return points;
  } catch (error) {
    console.error("Error reading file", filePath, error);
    return [];
  }
};

const buildDataMiddleware = () => {
  return async (req, res, next) => {
    const urlString = req.originalUrl || req.url || "";
    if (!urlString.startsWith("/api/ch1-data")) {
      return next();
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end("Method not allowed");
      return;
    }

    const url = new URL(urlString, "http://localhost");
    const typeParam = url.searchParams.get("type") === "str" ? "str" : "tem";
    const min = parseFloat(url.searchParams.get("min"));
    const max = parseFloat(url.searchParams.get("max"));
    const hasRange = !Number.isNaN(min) && !Number.isNaN(max);
    const range = hasRange ? { min, max } : undefined;
    const channelParam = url.searchParams.get("ch") || "1";
    const channelDir = CHANNEL_DIRS[channelParam];

    if (!channelDir) {
      res.statusCode = 400;
      res.end("Invalid channel");
      return;
    }

    try {
      const dataDir = path.join(DATA_ROOT, channelDir);
      console.log("[ch] request", url.pathname, url.search, "->", channelDir);
      const files = await fs.promises.readdir(dataDir);
      const suffix = typeParam === "str" ? "#str.txt" : "#tem.txt";
      const filesWithTime = await Promise.all(
        files
          .filter((name) => name.endsWith(suffix))
          .map(async (name) => {
            const stat = await fs.promises.stat(path.join(dataDir, name));
            return { name, mtimeMs: stat.mtimeMs };
          })
      );

      const selected = filesWithTime
        .sort((a, b) => b.mtimeMs - a.mtimeMs) // más recientes primero
        .slice(0, FILES_PER_CHANNEL)
        .sort((a, b) => a.mtimeMs - b.mtimeMs) // luego cronológico
        .map((item) => item.name);
      const latestFileName =
        selected.length > 0 ? selected[selected.length - 1] : null;

      let combined = [];

      for (let i = 0; i < selected.length; i++) {
        const filename = selected[i];
        const fullPath = path.join(dataDir, filename);
        const filePoints = await parseFilePoints(fullPath, range);
        if (filePoints.length > 0) {
          const tagged = filePoints.map((p) => ({ ...p, fileId: filename }));
          combined = combined.concat(tagged);
          if (i < selected.length - 1) {
            combined.push({
              distance: filePoints[filePoints.length - 1].distance,
              temperature: null,
              fileId: filename,
            });
          }
        }
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ points: combined, latestFile: latestFileName }));
    } catch (error) {
      console.error("Middleware error", error);
      res.statusCode = 500;
      res.end("Error reading data directory");
    }
    return undefined;
  };
};

const ch1ApiPlugin = () => {
  const middleware = buildDataMiddleware();
  return {
    name: "ch1-api-middleware",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(), // Tailwind v4 plugin
    ch1ApiPlugin(),
  ],
  server: {
    fs: {
      allow: [
        DATA_ROOT,
        path.join(DATA_ROOT, CHANNEL_DIRS["1"]),
        path.join(DATA_ROOT, CHANNEL_DIRS["2"]),
        path.join(DATA_ROOT, CHANNEL_DIRS["3"]),
        ROOT_DIR,
        CWD_DIR,
      ],
    },
  },
  preview: {
    fs: {
      allow: [
        DATA_ROOT,
        path.join(DATA_ROOT, CHANNEL_DIRS["1"]),
        path.join(DATA_ROOT, CHANNEL_DIRS["2"]),
        path.join(DATA_ROOT, CHANNEL_DIRS["3"]),
        ROOT_DIR,
        CWD_DIR,
      ],
    },
  },
});
