import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import {
  handleFiberMonitorApiRequest,
  initializeFiberMonitorRuntime,
  shutdownFiberMonitorRuntime,
} from "./fiber-monitor-service.js";
import { readRequestBody } from "./http-body-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_ROOT = path.resolve(
  process.env.FIBER_MONITOR_DATA_ROOT ||
    path.join(__dirname, "src", "Fibra Exportada")
);
const PORT = process.env.FIBER_MONITOR_PORT || process.env.CH1_API_PORT || 4174;

const handleRequest = async (req, res) => {
  const bodyText = req.method === "POST" ? await readRequestBody(req) : "";

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

const startServer = async () => {
  const runtime = await initializeFiberMonitorRuntime({ dataRoot: DATA_ROOT });
  console.log(
    `[runtime] thresholds=${runtime.thresholdCount} modbus=${runtime.modbus.online ? "online" : runtime.modbus.enabled ? "enabled (pending)" : "disabled"}`
  );
  if (runtime.modbus.enabled) {
    console.log(
      `[runtime] modbus host=${runtime.modbus.host} port=${runtime.modbus.port} unitId=${runtime.modbus.unitId}`
    );
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  server.listen(PORT, () => {
    console.log(`Fiber monitor API running at http://localhost:${PORT}/api/ch1-data`);
    console.log(`Reading from: ${DATA_ROOT}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\n[shutdown] signal=${signal}`);

    server.close(async () => {
      await shutdownFiberMonitorRuntime();
      process.exit(0);
    });

    setTimeout(async () => {
      await shutdownFiberMonitorRuntime();
      process.exit(1);
    }, 5000).unref();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
};

void startServer();
