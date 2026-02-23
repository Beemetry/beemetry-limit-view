import fs from "fs/promises";
import path from "path";

export const API_PATHNAME = "/api/ch1-data";
export const CHANNEL_DIRS = {
  "1": "Fibra_Espesador_ch1",
  "2": "Fibra_Espesador_ch2",
  "3": "Fibra_Espesador_ch3",
};
// cantidad de archivos recientes a leer por canal (modificar aqui si quieres mas)
export const FILES_PER_CHANNEL = 12;

const DATE_IN_NAME_REGEX = /(\d{4}-\d{2}-\d{2})/;
const TIMESTAMP_IN_NAME_REGEX = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)/;

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
  if (a.sortKey !== b.sortKey) return b.sortKey.localeCompare(a.sortKey);
  return b.name.localeCompare(a.name);
};

const sortChronological = (a, b) => {
  if (a.sortKey !== b.sortKey) return a.sortKey.localeCompare(b.sortKey);
  return a.name.localeCompare(b.name);
};

const parseFilePoints = async (filePath, range) => {
  try {
    const content = await fs.readFile(filePath, "utf-8");
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

export const readChannelData = async ({
  dataRoot,
  channel,
  type,
  range,
  now = new Date(),
  logger = null,
}) => {
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
  for (let i = 0; i < selected.length; i++) {
    const filename = selected[i];
    const fullPath = path.join(dataDir, filename);
    const filePoints = await parseFilePoints(fullPath, range);

    if (filePoints.length === 0) continue;

    const tagged = filePoints.map((point) => ({ ...point, fileId: filename }));
    combined = combined.concat(tagged);

    if (i < selected.length - 1) {
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

export const handleCh1ApiRequest = async ({
  method,
  urlString,
  host = "localhost",
  dataRoot,
  logger = null,
}) => {
  const url = new URL(urlString, `http://${host}`);

  if (url.pathname !== API_PATHNAME) {
    return { handled: false };
  }

  if (method !== "GET") {
    return {
      handled: true,
      statusCode: 405,
      body: "Method not allowed",
      headers: {},
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
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(payload),
    };
  } catch (error) {
    if (error?.code === "INVALID_CHANNEL") {
      return {
        handled: true,
        statusCode: 400,
        body: "Invalid channel",
        headers: {},
      };
    }

    console.error("API error", error);
    return {
      handled: true,
      statusCode: 500,
      body: "Error reading data directory",
      headers: {},
    };
  }
};
