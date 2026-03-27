import { watch } from "fs";
import fs from "fs/promises";
import path from "path";

export const API_PATHNAME = "/api/ch1-data";
export const MONITOR_STATE_PATHNAME = "/api/monitor-state";
export const THRESHOLDS_PATHNAME = "/api/thresholds";
export const CHANNEL_DIRS = {
  "1": "Fibra_Espesador_ch1",
  "2": "Fibra_Espesador_ch2",
  "3": "Fibra_Espesador_ch3",
};
export const FILES_PER_CHANNEL = 12;

const TELEGRAM_TOKEN = "8439005950:AAEdVzasE49fdLiDJt0sdnZUX9Y3b_Yw6p4_";
const TELEGRAM_CHAT_ID = "-5155804898_";
const DATE_IN_NAME_REGEX = /(\d{4}-\d{2}-\d{2})/;
const TIMESTAMP_IN_NAME_REGEX = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)/;
const ALERT_HISTORY_LIMIT = 100;
const WATCH_DEBOUNCE_MS = 400;
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};

const monitorStore = {
  dataRoot: null,
  watchersStarted: false,
  watcherClosers: [],
  watchTimers: new Map(),
  thresholds: [],
  alerts: [],
  versions: {},
  lastProcessedFileByKey: new Map(),
  triggeredAlertKeys: new Set(),
};

const pad2 = (value) => String(value).padStart(2, "0");

const formatLocalDateKey = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const formatUtcDateKey = (date) =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate()
  )}`;

const getTodayDateKeys = (now = new Date()) =>
  [...new Set([formatLocalDateKey(now), formatUtcDateKey(now)])];

const getDateKeyFromName = (filename) => {
  const match = filename.match(DATE_IN_NAME_REGEX);
  return match ? match[1] : null;
};

const getSortKeyFromName = (filename) => {
  const match = filename.match(TIMESTAMP_IN_NAME_REGEX);
  return match ? match[1] : filename;
};

const sortRecentFirst = (a, b) => {
  if (a.sortKey !== b.sortKey) {
    return b.sortKey.localeCompare(a.sortKey);
  }
  return b.name.localeCompare(a.name);
};

const sortChronological = (a, b) => {
  if (a.sortKey !== b.sortKey) {
    return a.sortKey.localeCompare(b.sortKey);
  }
  return a.name.localeCompare(b.name);
};

const getMonitorKey = (channel, type) => `${channel}:${type}`;

const normalizeDistanceKey = (value) => Number(value).toFixed(3);

const getFileTypeFromName = (filename) => {
  if (!filename || !filename.endsWith(".txt")) {
    return null;
  }
  if (filename.endsWith("#str.txt")) {
    return "str";
  }
  if (filename.endsWith("#tem.txt")) {
    return "tem";
  }
  return null;
};

const parseFilePoints = async (filePath, range) => {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split(/\r?\n/);
    const points = [];

    for (const line of lines) {
      const parts = line.trim().split(",");
      if (parts.length < 2) {
        continue;
      }

      const xVal = parseFloat(parts[0]);
      const yVal = parseFloat(parts[1]);
      if (Number.isNaN(xVal) || Number.isNaN(yVal)) {
        continue;
      }

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

const selectRecentFiles = (files, typeParam, now = new Date()) => {
  const suffix = typeParam === "str" ? "#str.txt" : "#tem.txt";
  const allCandidates = files
    .filter((name) => name.endsWith(suffix))
    .map((name) => ({
      name,
      dateKey: getDateKeyFromName(name),
      sortKey: getSortKeyFromName(name),
    }));

  const todayKeys = new Set(getTodayDateKeys(now));
  const todayCandidates = allCandidates.filter(
    (item) => item.dateKey && todayKeys.has(item.dateKey)
  );
  const pool = todayCandidates.length > 0 ? todayCandidates : allCandidates;

  const selected = pool
    .slice()
    .sort(sortRecentFirst)
    .slice(0, FILES_PER_CHANNEL)
    .sort(sortChronological)
    .map((item) => item.name);

  return {
    selected,
    usedTodayFilter: todayCandidates.length > 0,
    todayKeys: [...todayKeys],
  };
};

const sendTelegramAlert = async (message) => {
  if (typeof fetch !== "function") {
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    });
  } catch (error) {
    console.error("Telegram alert error", error);
  }
};

const sanitizeAlertForClient = (alert) => ({
  id: alert.id,
  channel: alert.channel,
  type: alert.type,
  fileId: alert.fileId,
  thresholdId: alert.thresholdId,
  thresholdLabel: alert.thresholdLabel,
  thresholdPercent: alert.thresholdPercent,
  measuredValue: alert.measuredValue,
  thresholdValue: alert.thresholdValue,
  distance: alert.distance,
  createdAt: alert.createdAt,
  soundEnabled: alert.soundEnabled,
  message: alert.message,
});

const pushAlert = (alert) => {
  monitorStore.alerts = [alert, ...monitorStore.alerts].slice(0, ALERT_HISTORY_LIMIT);
};

const buildThresholdLookup = (points) => {
  const lookup = new Map();
  points.forEach((point) => {
    lookup.set(normalizeDistanceKey(point.distance), point.thresholdValue);
  });
  return lookup;
};

const normalizeThreshold = (item) => {
  const type = item?.type === "str" ? "str" : item?.type === "tem" ? "tem" : null;
  const percent = Number(item?.percent);
  const floor = Number(item?.floor);
  const sourceFileIndex = Number(item?.sourceFileIndex);
  if (!type || !Number.isFinite(percent)) {
    return null;
  }

  const points = Array.isArray(item?.points)
    ? item.points
        .map((point) => ({
          distance: Number(point?.distance),
          thresholdValue: Number(point?.thresholdValue),
        }))
        .filter(
          (point) =>
            Number.isFinite(point.distance) && Number.isFinite(point.thresholdValue)
        )
    : [];

  if (points.length === 0) {
    return null;
  }

  return {
    id: String(item?.id || `${Date.now()}_${Math.random()}`),
    type,
    percent: Number(percent.toFixed(1)),
    floor: Number.isFinite(floor) ? floor : 0,
    color: typeof item?.color === "string" ? item.color : "#2563eb",
    sourceFileId: typeof item?.sourceFileId === "string" ? item.sourceFileId : "",
    sourceFileIndex: Number.isFinite(sourceFileIndex) ? sourceFileIndex : null,
    soundEnabled: Boolean(item?.soundEnabled),
    points,
    thresholdLabel:
      typeof item?.thresholdLabel === "string" && item.thresholdLabel.trim()
        ? item.thresholdLabel.trim()
        : `Umbral al ${Number(percent).toFixed(1)}%`,
    lookup: buildThresholdLookup(points),
  };
};

const setThresholds = (thresholds) => {
  monitorStore.thresholds = thresholds.map(normalizeThreshold).filter(Boolean);
  monitorStore.triggeredAlertKeys.clear();
};

const evaluateThresholdsForFile = async ({
  dataRoot,
  channel,
  type,
  filename,
}) => {
  const matchingThresholds = monitorStore.thresholds.filter(
    (threshold) => threshold.type === type
  );

  if (matchingThresholds.length === 0) {
    return;
  }

  const channelDir = CHANNEL_DIRS[channel];
  if (!channelDir) {
    return;
  }

  const fullPath = path.join(dataRoot, channelDir, filename);
  const filePoints = await parseFilePoints(fullPath);
  if (filePoints.length === 0) {
    return;
  }

  matchingThresholds.forEach((threshold) => {
    const alertKey = `${channel}:${type}:${filename}:${threshold.id}`;
    if (monitorStore.triggeredAlertKeys.has(alertKey)) {
      return;
    }

    let maxHit = null;
    for (const point of filePoints) {
      const thresholdValue = threshold.lookup.get(
        normalizeDistanceKey(point.distance)
      );
      if (!Number.isFinite(thresholdValue)) {
        continue;
      }

      if (point.temperature > thresholdValue) {
        const delta = point.temperature - thresholdValue;
        if (!maxHit || delta > maxHit.delta) {
          maxHit = {
            distance: point.distance,
            measuredValue: point.temperature,
            thresholdValue,
            delta,
          };
        }
      }
    }

    if (!maxHit) {
      return;
    }

    monitorStore.triggeredAlertKeys.add(alertKey);

    const alert = {
      id: `${Date.now()}_${Math.random()}`,
      channel,
      type,
      fileId: filename,
      thresholdId: threshold.id,
      thresholdLabel: threshold.thresholdLabel,
      thresholdPercent: threshold.percent,
      measuredValue: Number(maxHit.measuredValue.toFixed(3)),
      thresholdValue: Number(maxHit.thresholdValue.toFixed(3)),
      distance: Number(maxHit.distance.toFixed(3)),
      createdAt: new Date().toISOString(),
      soundEnabled: threshold.soundEnabled,
      message:
        `Alerta ${type.toUpperCase()} | Canal ${channel} | ${threshold.thresholdLabel} | ` +
        `Lectura ${maxHit.measuredValue.toFixed(2)} > ${maxHit.thresholdValue.toFixed(2)} ` +
        `en ${maxHit.distance.toFixed(2)} m`,
    };

    pushAlert(alert);
    void sendTelegramAlert(alert.message);
  });
};

const processWatchedFile = async ({ dataRoot, channel, filename }) => {
  const type = getFileTypeFromName(filename);
  if (!type) {
    return;
  }

  const key = getMonitorKey(channel, type);
  const lastProcessed = monitorStore.lastProcessedFileByKey.get(key);
  if (lastProcessed === filename) {
    return;
  }

  const channelDir = CHANNEL_DIRS[channel];
  const fullPath = path.join(dataRoot, channelDir, filename);

  try {
    await fs.access(fullPath);
  } catch {
    return;
  }

  monitorStore.lastProcessedFileByKey.set(key, filename);
  monitorStore.versions[key] = {
    latestFile: filename,
    updatedAt: new Date().toISOString(),
  };

  await evaluateThresholdsForFile({
    dataRoot,
    channel,
    type,
    filename,
  });
};

const scheduleWatchedFile = ({ dataRoot, channel, filename }) => {
  const type = getFileTypeFromName(filename);
  if (!type) {
    return;
  }

  const timerKey = `${channel}:${type}:${filename}`;
  const existingTimer = monitorStore.watchTimers.get(timerKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    monitorStore.watchTimers.delete(timerKey);
    void processWatchedFile({ dataRoot, channel, filename });
  }, WATCH_DEBOUNCE_MS);

  monitorStore.watchTimers.set(timerKey, timer);
};

const ensureMonitorStarted = (dataRoot) => {
  if (monitorStore.watchersStarted) {
    return;
  }

  monitorStore.dataRoot = dataRoot;
  Object.entries(CHANNEL_DIRS).forEach(([channel, dirName]) => {
    const dirPath = path.join(dataRoot, dirName);

    try {
      const watcher = watch(dirPath, (eventType, filename) => {
        if (!filename || (eventType !== "rename" && eventType !== "change")) {
          return;
        }

        scheduleWatchedFile({
          dataRoot,
          channel,
          filename: String(filename),
        });
      });

      monitorStore.watcherClosers.push(() => watcher.close());
    } catch (error) {
      console.error("Watcher init error", dirPath, error);
    }
  });

  monitorStore.watchersStarted = true;
};

const getMonitorStatePayload = () => ({
  versions: monitorStore.versions,
  alerts: monitorStore.alerts.map(sanitizeAlertForClient),
  thresholdCount: monitorStore.thresholds.length,
});

export const readChannelData = async ({
  dataRoot,
  channel,
  type,
  range,
  now = new Date(),
  logger = null,
}) => {
  ensureMonitorStarted(dataRoot);

  const channelDir = CHANNEL_DIRS[channel];
  if (!channelDir) {
    const error = new Error("Invalid channel");
    error.code = "INVALID_CHANNEL";
    throw error;
  }

  const dataDir = path.join(dataRoot, channelDir);
  const files = await fs.readdir(dataDir);
  const { selected, usedTodayFilter, todayKeys } = selectRecentFiles(
    files,
    type,
    now
  );

  if (logger) {
    logger({
      channel,
      type,
      selectedCount: selected.length,
      usedTodayFilter,
      todayKeys,
    });
  }

  let combined = [];
  for (let index = 0; index < selected.length; index += 1) {
    const filename = selected[index];
    const fullPath = path.join(dataDir, filename);
    const filePoints = await parseFilePoints(fullPath, range);

    if (filePoints.length === 0) {
      continue;
    }

    const tagged = filePoints.map((point) => ({ ...point, fileId: filename }));
    combined = combined.concat(tagged);

    if (index < selected.length - 1) {
      combined.push({
        distance: filePoints[filePoints.length - 1].distance,
        temperature: null,
        fileId: filename,
      });
    }
  }

  const latestFile = selected.length > 0 ? selected[selected.length - 1] : null;
  return { points: combined, latestFile };
};

export const handleApiRequest = async ({
  method,
  urlString,
  host = "localhost",
  dataRoot,
  logger = null,
  bodyText = "",
}) => {
  ensureMonitorStarted(dataRoot);

  const url = new URL(urlString, `http://${host}`);

  if (
    url.pathname !== API_PATHNAME &&
    url.pathname !== MONITOR_STATE_PATHNAME &&
    url.pathname !== THRESHOLDS_PATHNAME
  ) {
    return { handled: false };
  }

  if (method === "OPTIONS") {
    return {
      handled: true,
      statusCode: 204,
      headers: JSON_HEADERS,
      body: "",
    };
  }

  if (url.pathname === API_PATHNAME) {
    if (method !== "GET") {
      return {
        handled: true,
        statusCode: 405,
        body: "Method not allowed",
        headers: JSON_HEADERS,
      };
    }

    const typeParam = url.searchParams.get("type") === "str" ? "str" : "tem";
    const min = parseFloat(url.searchParams.get("min"));
    const max = parseFloat(url.searchParams.get("max"));
    const hasRange = !Number.isNaN(min) && !Number.isNaN(max);
    const range = hasRange ? { min, max } : undefined;
    const channelParam = url.searchParams.get("ch") || "1";

    try {
      const payload = await readChannelData({
        dataRoot,
        channel: channelParam,
        type: typeParam,
        range,
        logger,
      });

      return {
        handled: true,
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      };
    } catch (error) {
      if (error?.code === "INVALID_CHANNEL") {
        return {
          handled: true,
          statusCode: 400,
          body: "Invalid channel",
          headers: JSON_HEADERS,
        };
      }

      console.error("API error", error);
      return {
        handled: true,
        statusCode: 500,
        body: "Error reading data directory",
        headers: JSON_HEADERS,
      };
    }
  }

  if (url.pathname === MONITOR_STATE_PATHNAME) {
    if (method !== "GET") {
      return {
        handled: true,
        statusCode: 405,
        body: "Method not allowed",
        headers: JSON_HEADERS,
      };
    }

    return {
      handled: true,
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(getMonitorStatePayload()),
    };
  }

  if (method !== "POST") {
    return {
      handled: true,
      statusCode: 405,
      body: "Method not allowed",
      headers: JSON_HEADERS,
    };
  }

  try {
    const payload = bodyText ? JSON.parse(bodyText) : {};
    const thresholds = Array.isArray(payload?.thresholds) ? payload.thresholds : [];
    setThresholds(thresholds);

    return {
      handled: true,
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ok: true,
        thresholdCount: monitorStore.thresholds.length,
      }),
    };
  } catch (error) {
    console.error("Threshold config error", error);
    return {
      handled: true,
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ok: false,
        error: "Invalid JSON payload",
      }),
    };
  }
};

export const handleCh1ApiRequest = handleApiRequest;
