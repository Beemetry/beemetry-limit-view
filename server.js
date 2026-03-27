import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { handleCh1ApiRequest } from "./ch1-data-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_ROOT = path.join(__dirname, "src", "Fibra Exportada");
const PORT = process.env.CH1_API_PORT || 4174;

const readRequestBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", reject);
  });

const handleRequest = async (req, res) => {
  const bodyText =
    req.method === "POST" ? await readRequestBody(req) : "";

  const result = await handleCh1ApiRequest({
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
    console.log(`ch1 API running at http://localhost:${PORT}/api/ch1-data`);
    console.log(`Reading from: ${DATA_ROOT}`);
  });
