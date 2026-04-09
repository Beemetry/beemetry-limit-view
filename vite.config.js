import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  CHANNEL_DIRS,
  handleFiberMonitorApiRequest,
} from "./fiber-monitor-service.js";
import { readRequestBody } from "./http-body-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_ROOT = path.resolve(
  process.env.FIBER_MONITOR_DATA_ROOT ||
    path.join(__dirname, "src", "Fibra Exportada")
);
const ROOT_DIR = path.resolve(__dirname);
const CWD_DIR = path.resolve(process.cwd());

const buildDataMiddleware = () => {
  return async (req, res, next) => {
    const urlString = req.originalUrl || req.url || "";
    const bodyText = req.method === "POST" ? await readRequestBody(req) : "";

    const result = await handleFiberMonitorApiRequest({
      method: req.method,
      urlString,
      host: "localhost",
      dataRoot: DATA_ROOT,
      bodyText,
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

const fiberMonitorApiPlugin = () => {
  const middleware = buildDataMiddleware();
  return {
    name: "fiber-monitor-api-middleware",
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
  plugins: [react(), tailwindcss(), fiberMonitorApiPlugin()],
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
