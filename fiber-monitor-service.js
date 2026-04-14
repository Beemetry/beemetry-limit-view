import { watch, readFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  getModbusPublisherStatus,
  loadModbusAlarmBatch,
  startModbusEventPublisherFromEnv,
  stopModbusEventPublisher,
} from "./modbus-event-publisher.js";

export const API_PATHNAME = "/api/ch1-data";
export const MONITOR_STATE_PATHNAME = "/api/monitor-state";
export const THRESHOLDS_PATHNAME = "/api/thresholds";
export const CHANNEL_DIRS = {
  "1": "Fibra_Espesador_ch1",
  "2": "Fibra_Espesador_ch2",
  "3": "Fibra_Espesador_ch3",
};
export const FILES_PER_CHANNEL = 12;

const loadEnvFileIfPresent = () => {
  const envPath = path.resolve(process.cwd(), ".env");
  let rawText = "";
  try {
    rawText = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }

  rawText.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) {
      return;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  });
};

loadEnvFileIfPresent();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_MANUAL_ALERTS_CONTROL = false;
const DATE_IN_NAME_REGEX = /(\d{4}-\d{2}-\d{2})/;
const TIMESTAMP_IN_NAME_REGEX = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)/;
const ALERT_HISTORY_LIMIT = 100;
const WATCH_DEBOUNCE_MS = 400;
const ALERT_KEY_PERSIST_DEBOUNCE_MS = 300;
const MODBUS_EVENT_RANGE_SNAPSHOT_LIMIT = Math.max(
  1,
  Math.min(
    500,
    Number.parseInt(
      process.env.MODBUS_EVENT_RANGE_SNAPSHOT_LIMIT ||
        process.env.MODBUS_EVENT_PEAK_SNAPSHOT_LIMIT ||
        "80",
      10
    ) || 80
  )
);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PERSISTENCE_DIR = path.join(__dirname, "runtime-data");
const PERSISTED_THRESHOLDS_FILE = path.join(PERSISTENCE_DIR, "thresholds.json");
const PERSISTED_ALERT_KEYS_FILE = path.join(
  PERSISTENCE_DIR,
  "triggered-alert-keys.json"
);
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
  stateReady: false,
  stateReadyPromise: null,
  persistAlertKeysTimer: null,
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
const DEFAULT_THRESHOLD_CHANNEL_ID = "1";
const THRESHOLD_RANGE_MODES = new Set(["tramo_1", "tramo_2", "completo"]);
const DEFAULT_THRESHOLD_RANGE_MODE = "completo";

const normalizeDistanceKey = (value) => Number(value).toFixed(3);
const toFixed3 = (value) => Number(Number(value).toFixed(3));

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

const buildComparisonMetadata = (selectedFiles) => {
  const latestFile =
    selectedFiles.length > 0 ? selectedFiles[selectedFiles.length - 1] : null;
  const previousFile =
    selectedFiles.length > 1 ? selectedFiles[selectedFiles.length - 2] : null;

  return {
    latestFile,
    previousFile,
    selectedFiles,
  };
};

const buildDifferentialRows = ({
  previousFile,
  previousPoints,
  latestFile,
  latestPoints,
}) => {
  if (!previousFile || !latestFile) {
    return [];
  }

  const previousByDistance = new Map();
  previousPoints.forEach((point) => {
    if (
      Number.isFinite(point?.distance) &&
      Number.isFinite(point?.temperature) &&
      !previousByDistance.has(normalizeDistanceKey(point.distance))
    ) {
      previousByDistance.set(normalizeDistanceKey(point.distance), point.temperature);
    }
  });

  return latestPoints
    .map((point) => {
      if (!Number.isFinite(point?.distance) || !Number.isFinite(point?.temperature)) {
        return null;
      }

      const previousValue = previousByDistance.get(
        normalizeDistanceKey(point.distance)
      );
      if (!Number.isFinite(previousValue)) {
        return null;
      }

      const latestValue = Number(point.temperature.toFixed(6));
      const normalizedPreviousValue = Number(previousValue.toFixed(6));
      const differential = Number((latestValue - normalizedPreviousValue).toFixed(6));

      return {
        distance: Number(point.distance.toFixed(6)),
        previousValue: normalizedPreviousValue,
        latestValue,
        differential,
        previousFile,
        latestFile,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);
};

const buildComparisonPayload = async ({ dataDir, selectedFiles, range }) => {
  let combined = [];

  for (let index = 0; index < selectedFiles.length; index += 1) {
    const filename = selectedFiles[index];
    const fullPath = path.join(dataDir, filename);
    const filePoints = await parseFilePoints(fullPath, range);

    if (filePoints.length === 0) {
      continue;
    }

    const tagged = filePoints.map((point) => ({ ...point, fileId: filename }));
    combined = combined.concat(tagged);

    if (index < selectedFiles.length - 1) {
      combined.push({
        distance: filePoints[filePoints.length - 1].distance,
        temperature: null,
        fileId: filename,
      });
    }
  }

  const comparison = buildComparisonMetadata(selectedFiles);
  return {
    mode: "compare",
    points: combined,
    latestFile: comparison.latestFile,
    previousFile: comparison.previousFile,
    selectedFiles: comparison.selectedFiles,
  };
};

const buildDifferentialPayload = async ({
  dataDir,
  selectedFiles,
  range,
  mode = "diff2",
  firstFile = null,
  secondFile = null,
}) => {
  const comparison = buildComparisonMetadata(selectedFiles);
  const resolvedFirstFile =
    typeof firstFile === "string" && selectedFiles.includes(firstFile)
      ? firstFile
      : comparison.previousFile;
  const resolvedSecondFile =
    typeof secondFile === "string" && selectedFiles.includes(secondFile)
      ? secondFile
      : comparison.latestFile;

  if (!resolvedFirstFile || !resolvedSecondFile) {
    return {
      mode,
      points: [],
      latestFile: resolvedSecondFile,
      previousFile: resolvedFirstFile,
      selectedFiles: comparison.selectedFiles,
      exportRows: [],
      differentialReady: false,
      message:
        mode === "manual_diff"
          ? "Se necesitan al menos 2 lecturas para calcular el diferencial manual."
          : "Se necesitan al menos 2 lecturas para calcular el diferencial.",
    };
  }

  const previousPoints = await parseFilePoints(
    path.join(dataDir, resolvedFirstFile),
    range
  );
  const latestPoints = await parseFilePoints(
    path.join(dataDir, resolvedSecondFile),
    range
  );

  const exportRows = buildDifferentialRows({
    previousFile: resolvedFirstFile,
    previousPoints,
    latestFile: resolvedSecondFile,
    latestPoints,
  });

  return {
    mode,
    points: exportRows.map((row) => ({
      distance: row.distance,
      temperature: row.differential,
      fileId: `${row.previousFile}__${row.latestFile}`,
      previousValue: row.previousValue,
      latestValue: row.latestValue,
      previousFile: row.previousFile,
      latestFile: row.latestFile,
    })),
    latestFile: resolvedSecondFile,
    previousFile: resolvedFirstFile,
    selectedFiles: comparison.selectedFiles,
    exportRows,
    differentialReady: exportRows.length > 0,
    message:
      exportRows.length > 0
        ? null
        : mode === "manual_diff"
          ? "No se encontraron puntos coincidentes entre las lecturas seleccionadas dentro del tramo elegido."
          : "No se encontraron puntos coincidentes entre las 2 ultimas lecturas dentro del tramo seleccionado.",
  };
};

const sendTelegramAlert = async (message) => {
  if (
    !TELEGRAM_MANUAL_ALERTS_CONTROL ||
    !TELEGRAM_TOKEN ||
    !TELEGRAM_CHAT_ID ||
    typeof fetch !== "function"
  ) {
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
  direction: alert.direction,
  thresholdMode: alert.thresholdMode,
  thresholdOffset: alert.thresholdOffset,
  fileId: alert.fileId,
  thresholdId: alert.thresholdId,
  thresholdLabel: alert.thresholdLabel,
  thresholdRangeMode: alert.thresholdRangeMode,
  thresholdPercent: alert.thresholdPercent,
  measuredValue: alert.measuredValue,
  thresholdValue: alert.thresholdValue,
  distance: alert.distance,
  segmentCount: alert.segmentCount,
  segments: Array.isArray(alert.segments)
    ? alert.segments.map((segment) => ({
        startDistance: segment.startDistance,
        endDistance: segment.endDistance,
        peakDistance: segment.peakDistance,
        peakValue: segment.peakValue,
        peakThresholdValue: segment.peakThresholdValue,
      }))
    : [],
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

const normalizeThresholdRangeMode = (value) =>
  THRESHOLD_RANGE_MODES.has(value) ? value : DEFAULT_THRESHOLD_RANGE_MODE;

const normalizeThreshold = (item) => {
  const type = item?.type === "str" ? "str" : item?.type === "tem" ? "tem" : null;
  const channelId = String(item?.channelId || DEFAULT_THRESHOLD_CHANNEL_ID);
  const mode = item?.mode === "offset" ? "offset" : "percent";
  const direction = item?.direction === "down" ? "down" : "up";
  const percent = Number(item?.percent);
  const offsetValue = Number(item?.offsetValue);
  const floor = Number(item?.floor);
  const sourceFileIndex = Number(item?.sourceFileIndex);
  const rangeMode = normalizeThresholdRangeMode(item?.rangeMode);
  if (!type || !Object.prototype.hasOwnProperty.call(CHANNEL_DIRS, channelId)) {
    return null;
  }
  if (mode === "percent" && !Number.isFinite(percent)) {
    return null;
  }
  if (mode === "offset" && !Number.isFinite(offsetValue)) {
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
    channelId,
    type,
    mode,
    percent: mode === "percent" ? Number(percent.toFixed(1)) : null,
    offsetValue: mode === "offset" ? Number(offsetValue.toFixed(3)) : null,
    floor: Number.isFinite(floor) ? floor : 0,
    color: typeof item?.color === "string" ? item.color : "#2563eb",
    sourceFileId: typeof item?.sourceFileId === "string" ? item.sourceFileId : "",
    sourceFileIndex: Number.isFinite(sourceFileIndex) ? sourceFileIndex : null,
    rangeMode,
    soundEnabled: Boolean(item?.soundEnabled),
    points,
    thresholdLabel:
      typeof item?.thresholdLabel === "string" && item.thresholdLabel.trim()
        ? item.thresholdLabel.trim()
        : mode === "percent"
          ? `Umbral al ${Number(percent).toFixed(1)}%`
          : `Umbral +${Number(offsetValue).toFixed(3)}`,
    direction,
    lookup: buildThresholdLookup(points),
  };
};

const serializeThreshold = (threshold) => ({
  id: threshold.id,
  channelId: threshold.channelId,
  type: threshold.type,
  mode: threshold.mode,
  percent: threshold.percent,
  offsetValue: threshold.offsetValue,
  floor: threshold.floor,
  color: threshold.color,
  sourceFileId: threshold.sourceFileId,
  sourceFileIndex: threshold.sourceFileIndex,
  rangeMode: normalizeThresholdRangeMode(threshold.rangeMode),
  soundEnabled: threshold.soundEnabled,
  thresholdLabel: threshold.thresholdLabel,
  direction: threshold.direction,
  points: threshold.points.map((point) => ({
    distance: point.distance,
    thresholdValue: point.thresholdValue,
  })),
});

const readJsonFileOrDefault = async (filePath, fallbackValue) => {
  try {
    const rawText = await fs.readFile(filePath, "utf-8");
    return JSON.parse(rawText);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Error reading persisted JSON", filePath, error);
    }
    return fallbackValue;
  }
};

const writeJsonFile = async (filePath, payload) => {
  await fs.mkdir(PERSISTENCE_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
};

const getThresholdIdFromAlertKey = (alertKey) => {
  const lastSeparator = alertKey.lastIndexOf(":");
  if (lastSeparator === -1) {
    return null;
  }
  return alertKey.slice(lastSeparator + 1);
};

const pruneTriggeredAlertKeys = () => {
  const activeThresholdIds = new Set(monitorStore.thresholds.map((item) => item.id));
  monitorStore.triggeredAlertKeys = new Set(
    [...monitorStore.triggeredAlertKeys].filter((alertKey) =>
      activeThresholdIds.has(getThresholdIdFromAlertKey(alertKey))
    )
  );
};

const persistThresholdsToDisk = async () => {
  const payload = {
    updatedAt: new Date().toISOString(),
    thresholds: monitorStore.thresholds.map(serializeThreshold),
  };
  await writeJsonFile(PERSISTED_THRESHOLDS_FILE, payload);
};

const persistTriggeredAlertKeysToDisk = async () => {
  const payload = {
    updatedAt: new Date().toISOString(),
    keys: [...monitorStore.triggeredAlertKeys],
  };
  await writeJsonFile(PERSISTED_ALERT_KEYS_FILE, payload);
};

const schedulePersistTriggeredAlertKeys = () => {
  if (monitorStore.persistAlertKeysTimer) {
    clearTimeout(monitorStore.persistAlertKeysTimer);
  }

  monitorStore.persistAlertKeysTimer = setTimeout(() => {
    monitorStore.persistAlertKeysTimer = null;
    void persistTriggeredAlertKeysToDisk();
  }, ALERT_KEY_PERSIST_DEBOUNCE_MS);
};

const ensureStateReady = async () => {
  if (monitorStore.stateReady) {
    return;
  }
  if (monitorStore.stateReadyPromise) {
    await monitorStore.stateReadyPromise;
    return;
  }

  monitorStore.stateReadyPromise = (async () => {
    const [thresholdSnapshot, keySnapshot] = await Promise.all([
      readJsonFileOrDefault(PERSISTED_THRESHOLDS_FILE, {}),
      readJsonFileOrDefault(PERSISTED_ALERT_KEYS_FILE, {}),
    ]);

    const persistedThresholds = Array.isArray(thresholdSnapshot?.thresholds)
      ? thresholdSnapshot.thresholds
      : [];
    const persistedKeys = Array.isArray(keySnapshot?.keys)
      ? keySnapshot.keys.filter((item) => typeof item === "string")
      : [];

    monitorStore.thresholds = persistedThresholds
      .map(normalizeThreshold)
      .filter(Boolean);
    monitorStore.triggeredAlertKeys = new Set(persistedKeys);
    pruneTriggeredAlertKeys();
    monitorStore.stateReady = true;
  })();

  try {
    await monitorStore.stateReadyPromise;
  } finally {
    monitorStore.stateReadyPromise = null;
  }
};

const setThresholds = (thresholds) => {
  monitorStore.thresholds = thresholds.map(normalizeThreshold).filter(Boolean);
  pruneTriggeredAlertKeys();
};

const buildExceededRangesByThreshold = ({ filePoints, lookup, direction }) => {
  const isLowerDirection = direction === "down";
  const EPSILON = 0.0000001;
  const ranges = [];
  let activeRange = null;

  for (const point of filePoints) {
    const thresholdValue = lookup.get(normalizeDistanceKey(point.distance));
    if (!Number.isFinite(thresholdValue)) {
      if (activeRange) {
        ranges.push(activeRange);
        activeRange = null;
      }
      continue;
    }

    const measuredValue = Number(point.temperature);
    const exceeded = isLowerDirection
      ? measuredValue < thresholdValue
      : measuredValue > thresholdValue;
    if (!exceeded) {
      if (activeRange) {
        ranges.push(activeRange);
        activeRange = null;
      }
      continue;
    }

    const delta = isLowerDirection
      ? thresholdValue - measuredValue
      : measuredValue - thresholdValue;
    if (!activeRange) {
      activeRange = {
        startDistance: point.distance,
        endDistance: point.distance,
        maxDelta: delta,
        peakDistance: point.distance,
        peakMeasuredValue: measuredValue,
        peakThresholdValue: thresholdValue,
        valueMin: measuredValue,
        valueMax: measuredValue,
        minValueDistance: point.distance,
        maxValueDistance: point.distance,
        minValueThresholdValue: thresholdValue,
        maxValueThresholdValue: thresholdValue,
      };
      continue;
    }

    activeRange.endDistance = point.distance;
    if (measuredValue < activeRange.valueMin) {
      activeRange.valueMin = measuredValue;
      activeRange.minValueDistance = point.distance;
      activeRange.minValueThresholdValue = thresholdValue;
    }
    if (measuredValue > activeRange.valueMax) {
      activeRange.valueMax = measuredValue;
      activeRange.maxValueDistance = point.distance;
      activeRange.maxValueThresholdValue = thresholdValue;
    }
    const hasHigherDelta = delta > activeRange.maxDelta + EPSILON;
    const hasEqualDelta = Math.abs(delta - activeRange.maxDelta) <= EPSILON;
    const isMoreExtremeAtEqualDelta =
      hasEqualDelta &&
      ((isLowerDirection &&
        measuredValue < Number(activeRange.peakMeasuredValue)) ||
        (!isLowerDirection &&
          measuredValue > Number(activeRange.peakMeasuredValue)));

    if (hasHigherDelta || isMoreExtremeAtEqualDelta) {
      activeRange.maxDelta = delta;
      activeRange.peakDistance = point.distance;
      activeRange.peakMeasuredValue = measuredValue;
      activeRange.peakThresholdValue = thresholdValue;
    }
  }

  if (activeRange) {
    ranges.push(activeRange);
  }

  return ranges;
};

const resolveAlarmTypeCode = ({ variableType, direction }) => {
  if (variableType === "tem") {
    return direction === "down" ? 2 : 1;
  }
  return direction === "down" ? 4 : 3;
};

const toDistanceDm = (distanceMeters) =>
  Math.max(0, Math.min(0xffff, Math.round(Number(distanceMeters) * 10)));

const calculateSpatialResolutionCmX10 = (points) => {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }

  const deltas = [];
  for (let index = 1; index < points.length; index += 1) {
    const current = Number(points[index]?.distance);
    const previous = Number(points[index - 1]?.distance);
    const delta = current - previous;
    if (Number.isFinite(delta) && delta > 0) {
      deltas.push(delta);
    }
  }

  if (deltas.length === 0) {
    return null;
  }

  deltas.sort((left, right) => left - right);
  const medianDeltaMeters = deltas[Math.floor(deltas.length / 2)];
  // meters -> cm*10 (0.1 cm resolution)
  return Math.max(1, Math.min(0xffff, Math.round(medianDeltaMeters * 1000)));
};

const evaluateThresholdsForFile = async ({
  dataRoot,
  channel,
  type,
  filename,
}) => {
  const matchingThresholds = monitorStore.thresholds.filter(
    (threshold) =>
      threshold.type === type &&
      String(threshold.channelId || DEFAULT_THRESHOLD_CHANNEL_ID) === String(channel)
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

  const modbusAlarmCandidates = [];
  const detectedAt = new Date().toISOString();

  matchingThresholds.forEach((threshold) => {
    const alertKey = `${channel}:${type}:${filename}:${threshold.id}`;
    if (monitorStore.triggeredAlertKeys.has(alertKey)) {
      return;
    }

    const exceededRanges = buildExceededRangesByThreshold({
      filePoints,
      lookup: threshold.lookup,
      direction: threshold.direction,
    });

    if (exceededRanges.length === 0) {
      return;
    }

    const sortedRanges = exceededRanges.slice().sort((left, right) => {
      const deltaDifference = right.maxDelta - left.maxDelta;
      if (Math.abs(deltaDifference) > 0.0000001) {
        return deltaDifference;
      }

      if (threshold.direction === "down") {
        return left.peakMeasuredValue - right.peakMeasuredValue;
      }
      return right.peakMeasuredValue - left.peakMeasuredValue;
    });
    const overallPeakRange = sortedRanges[0] || null;

    if (!overallPeakRange) {
      return;
    }

    const globalPeakValue = overallPeakRange.peakMeasuredValue;
    const globalPeakDistance = overallPeakRange.peakDistance;
    const globalPeakThresholdValue = overallPeakRange.peakThresholdValue;

    const rangeSnapshots = sortedRanges
      .slice(0, MODBUS_EVENT_RANGE_SNAPSHOT_LIMIT)
      .map((item) => ({
        startDistance: toFixed3(item.startDistance),
        endDistance: toFixed3(item.endDistance),
        peakDistance: toFixed3(item.peakDistance),
        peakValue: toFixed3(item.peakMeasuredValue),
        peakThresholdValue: toFixed3(item.peakThresholdValue),
        minValue: toFixed3(item.valueMin),
        maxValue: toFixed3(item.valueMax),
      }))
      .sort((a, b) => a.startDistance - b.startDistance);
    const comparisonSymbol = threshold.direction === "down" ? "<" : ">";
    const rangeSummary = rangeSnapshots
      .slice(0, 3)
      .map((segment) => `${segment.startDistance.toFixed(2)}-${segment.endDistance.toFixed(2)} m`)
      .join(", ");

    monitorStore.triggeredAlertKeys.add(alertKey);
    schedulePersistTriggeredAlertKeys();

    const alert = {
      id: `${Date.now()}_${Math.random()}`,
      channel,
      type,
      fileId: filename,
      thresholdId: threshold.id,
      thresholdLabel: threshold.thresholdLabel,
      thresholdRangeMode: normalizeThresholdRangeMode(threshold.rangeMode),
      direction: threshold.direction,
      thresholdPercent: threshold.percent,
      thresholdMode: threshold.mode,
      thresholdOffset: threshold.offsetValue,
      measuredValue: toFixed3(globalPeakValue),
      thresholdValue: toFixed3(globalPeakThresholdValue),
      distance: toFixed3(globalPeakDistance),
      segmentCount: rangeSnapshots.length,
      segments: rangeSnapshots,
      createdAt: new Date().toISOString(),
      soundEnabled: threshold.soundEnabled,
      message:
        `Alerta ${type.toUpperCase()} | Canal ${channel} | ${threshold.thresholdLabel} | ` +
        `Lectura ${globalPeakValue.toFixed(2)} ${comparisonSymbol} ${globalPeakThresholdValue.toFixed(2)} ` +
        `en ${globalPeakDistance.toFixed(2)} m | Tramos: ${rangeSummary}`,
    };

    pushAlert(alert);

    const alarmType = resolveAlarmTypeCode({
      variableType: type,
      direction: threshold.direction,
    });
    sortedRanges.forEach((range) => {
      modbusAlarmCandidates.push({
        priorityDelta: range.maxDelta,
        alarmType,
        channelId: Number(channel),
        startDm: toDistanceDm(range.startDistance),
        endDm: toDistanceDm(range.endDistance),
        tempMax: type === "tem" ? range.valueMax : 0,
        tempMin: type === "tem" ? range.valueMin : 0,
        strainMax: type === "str" ? range.valueMax : 0,
        strainMin: type === "str" ? range.valueMin : 0,
        startAt: detectedAt,
        updatedAt: detectedAt,
      });
    });

    void sendTelegramAlert(alert.message);
  });

  if (modbusAlarmCandidates.length > 0) {
    const alarms = modbusAlarmCandidates
      .sort((left, right) => right.priorityDelta - left.priorityDelta)
      .map(({ priorityDelta, ...alarm }) => alarm);
    const spatialResCmX10 = calculateSpatialResolutionCmX10(filePoints);

    loadModbusAlarmBatch({
      scanAt: detectedAt,
      channelId: Number(channel),
      totalPointsRead: filePoints.length,
      spatialResCmX10,
      alarms,
    });
  }
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

const ensureMonitorStarted = async (dataRoot) => {
  await startModbusEventPublisherFromEnv();
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
  modbus: getModbusPublisherStatus(),
});

export const initializeFiberMonitorRuntime = async ({ dataRoot }) => {
  await ensureStateReady();
  await ensureMonitorStarted(dataRoot);
  return {
    thresholdCount: monitorStore.thresholds.length,
    modbus: getModbusPublisherStatus(),
  };
};

export const shutdownFiberMonitorRuntime = async () => {
  monitorStore.watchTimers.forEach((timer) => clearTimeout(timer));
  monitorStore.watchTimers.clear();

  monitorStore.watcherClosers.forEach((closeWatcher) => {
    try {
      closeWatcher();
    } catch {
      // ignore watcher close failures on shutdown
    }
  });
  monitorStore.watcherClosers = [];
  monitorStore.watchersStarted = false;

  if (monitorStore.persistAlertKeysTimer) {
    clearTimeout(monitorStore.persistAlertKeysTimer);
    monitorStore.persistAlertKeysTimer = null;
  }

  try {
    await persistTriggeredAlertKeysToDisk();
  } catch (error) {
    console.error("Persist alert keys on shutdown failed", error);
  }

  await stopModbusEventPublisher();
};

export const readFiberChannelData = async ({
  dataRoot,
  channel,
  type,
  range,
  mode = "compare",
  file1 = null,
  file2 = null,
  now = new Date(),
  logger = null,
}) => {
  await ensureStateReady();
  await ensureMonitorStarted(dataRoot);

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

  if (mode === "diff2") {
    return buildDifferentialPayload({
      dataDir,
      selectedFiles: selected,
      range,
    });
  }

  if (mode === "manual_diff") {
    return buildDifferentialPayload({
      dataDir,
      selectedFiles: selected,
      range,
      mode,
      firstFile: file1,
      secondFile: file2,
    });
  }

  return buildComparisonPayload({
    dataDir,
    selectedFiles: selected,
    range,
  });
};

export const handleFiberMonitorApiRequest = async ({
  method,
  urlString,
  host = "localhost",
  dataRoot,
  logger = null,
  bodyText = "",
}) => {
  await ensureStateReady();
  await ensureMonitorStarted(dataRoot);

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
    const viewModeParam = url.searchParams.get("mode");
    const mode =
      viewModeParam === "manual_diff"
        ? "manual_diff"
        : viewModeParam === "diff2"
          ? "diff2"
          : "compare";
    const file1Param = url.searchParams.get("file1");
    const file2Param = url.searchParams.get("file2");

    try {
      const payload = await readFiberChannelData({
        dataRoot,
        channel: channelParam,
        type: typeParam,
        range,
        mode,
        file1: file1Param,
        file2: file2Param,
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

  if (method === "GET") {
    return {
      handled: true,
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ok: true,
        thresholdCount: monitorStore.thresholds.length,
        thresholds: monitorStore.thresholds.map(serializeThreshold),
      }),
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
    await Promise.all([
      persistThresholdsToDisk(),
      persistTriggeredAlertKeysToDisk(),
    ]);

    return {
      handled: true,
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ok: true,
        thresholdCount: monitorStore.thresholds.length,
        thresholds: monitorStore.thresholds.map(serializeThreshold),
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

// Backward-compatibility exports while callers migrate to fiber-monitor naming.
export const readChannelData = readFiberChannelData;
export const handleApiRequest = handleFiberMonitorApiRequest;
export const handleCh1ApiRequest = handleFiberMonitorApiRequest;
