import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { handleFiberMonitorApiRequest } from "./fiber-monitor-service.js";
import { readRequestBody } from "./http-body-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_ROOT = path.join(__dirname, "src", "Fibra Exportada");
const PORT = process.env.FIBER_MONITOR_PORT || process.env.CH1_API_PORT || 4174;

const handleRequest = async (req, res) => {
  const bodyText =
    req.method === "POST" ? await readRequestBody(req) : "";

  const result = await handleFiberMonitorApiRequest({
    method: req.method,
    urlString: req.url || "",
    host: req.headers.host || "localhost",
    dataRoot: DATA_ROOT,
    bodyText,
    logger: ({ channel, type, selectedCount, usedTodayFilter, todayKeys }) => {
      console.log(
        `[ch] channel=${channel} type=${type} selected=${selectedCount} todayFilter=${usedTodayFilter} todayKeys=${todayKeys.join(",")}`
      );
    },
  });

  if (!result.handled) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  res.statusCode = result.statusCode;
  Object.entries(result.headers || {}).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  res.end(result.body);
};

http
  .createServer((req, res) => {
    void handleRequest(req, res);
  })
  .listen(PORT, () => {
    console.log(`Fiber monitor API running at http://localhost:${PORT}/api/ch1-data`);
    console.log(`Reading from: ${DATA_ROOT}`);
  });
