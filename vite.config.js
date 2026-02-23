import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { CHANNEL_DIRS, handleCh1ApiRequest } from "./ch1-data-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_ROOT = path.resolve(__dirname, "src", "Fibra Exportada");
const ROOT_DIR = path.resolve(__dirname);
const CWD_DIR = path.resolve(process.cwd());

const buildDataMiddleware = () => {
  return async (req, res, next) => {
    const urlString = req.originalUrl || req.url || "";

    const result = await handleCh1ApiRequest({
      method: req.method,
      urlString,
      host: "localhost",
      dataRoot: DATA_ROOT,
      logger: ({ channel, type, selectedCount, usedTodayFilter, todayKeys }) => {
        console.log(
          `[ch] ${urlString} channel=${channel} type=${type} selected=${selectedCount} todayFilter=${usedTodayFilter} todayKeys=${todayKeys.join(",")}`
        );
      },
    });

    if (!result.handled) {
      return next();
    }

    res.statusCode = result.statusCode;
    Object.entries(result.headers || {}).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    res.end(result.body);
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
  plugins: [react(), tailwindcss(), ch1ApiPlugin()],
  server: {
    host: true,
    allowedHosts: "all",
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
