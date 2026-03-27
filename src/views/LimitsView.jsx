import React, {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
} from "react";
import { CHART_MARGINS, Y_AXIS_WIDTH } from "../config/chartConfig";
import HeaderBar from "../components/layout/HeaderBar";
import LimitsChart from "../components/chart/LimitsChart";
import ControlPanel from "../components/panel/ControlPanel";

const CHART_TYPES = {
  tension: {
    key: "tension",
    label: "Grafico Tension",
    xMin: 0,
    xMax: 810,
    yMin: -1600,
    yMax: 1600,
  },
  temperatura: {
    key: "temperatura",
    label: "Grafico Temperatura",
    xMin: 810,
    xMax: 1620,
    yMin: -50,
    yMax: 150,
  },
};
const RANGE_MODES = {
  default: "correspondiente",
  full: "completo",
};
const NOISE_MODES = {
  raw: "raw",
  std: "std",
};
const FULL_X_RANGE = {
  xMin: 0,
  xMax: 1620,
};

const DEFAULT_CHART_TYPE = "tension";
const DEFAULT_RANGE = CHART_TYPES[DEFAULT_CHART_TYPE];
const DEFAULT_CHANNEL = "1";
const CHANNELS = {
  "1": { id: "1", label: "Canal 1", color: "#7c3aed" },
  "2": { id: "2", label: "Canal 2", color: "#22c55e" },
  "2_div5": {
    id: "2",
    label: "Canal 2 (/5)",
    color: "#22c55e",
    valueDivisor: 5,
  },
  "3": { id: "3", label: "Canal 3", color: "#b45309" },
};
const THRESHOLD_COLORS = [
  "#2563eb",
  "#f59e0b",
  "#14b8a6",
  "#ec4899",
  "#6366f1",
  "#f97316",
];
const DEFAULT_THRESHOLD_INPUT = "20";
const MAX_CHART_POINTS = 4000;
const FLOOR_REFERENCE_PERCENT = 20;
const FLOOR_AT_REFERENCE_PERCENT = 5;
const MIN_POINTER_DELTA_X = 1;
const MIN_ZOOM_RATIO = 0.005;
const MONITOR_POLL_MS = 2000;
const THRESHOLD_CACHE_KEY = "beemetry-thresholds-cache";

const lttbSegment = (segment, threshold) => {
  const dataLength = segment.length;
  if (threshold >= dataLength || threshold <= 0) {
    return segment;
  }

  const sampled = [];
  let sampledIndex = 0;
  const every = (dataLength - 2) / (threshold - 2);
  let a = 0;
  let maxArea;
  let maxAreaPoint;
  let nextA;

  sampled[sampledIndex++] = segment[a];

  for (let index = 0; index < threshold - 2; index += 1) {
    let avgX = 0;
    let avgY = 0;
    let avgRangeStart = Math.floor((index + 1) * every) + 1;
    let avgRangeEnd = Math.floor((index + 2) * every) + 1;
    avgRangeEnd = avgRangeEnd < dataLength ? avgRangeEnd : dataLength;

    const avgRangeLength = avgRangeEnd - avgRangeStart || 1;
    for (let avgIndex = avgRangeStart; avgIndex < avgRangeEnd; avgIndex += 1) {
      avgX += segment[avgIndex].distance;
      avgY += segment[avgIndex].temperature;
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    let rangeOffs = Math.floor(index * every) + 1;
    let rangeTo = Math.floor((index + 1) * every) + 1;
    rangeTo = rangeTo < dataLength ? rangeTo : dataLength - 1;

    const pointAx = segment[a].distance;
    const pointAy = segment[a].temperature;
    maxArea = -1;

    for (let pointIndex = rangeOffs; pointIndex <= rangeTo; pointIndex += 1) {
      const pointBx = segment[pointIndex].distance;
      const pointBy = segment[pointIndex].temperature;
      const area = Math.abs(
        (pointAx - avgX) * (pointBy - pointAy) -
          (pointAx - pointBx) * (avgY - pointAy)
      ) * 0.5;

      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = segment[pointIndex];
        nextA = pointIndex;
      }
    }

    sampled[sampledIndex++] = maxAreaPoint;
    a = nextA;
  }

  sampled[sampledIndex++] = segment[dataLength - 1];
  return sampled;
};

const decimateVisibleData = (data, maxPoints) => {
  if (!data || data.length === 0) {
    return data;
  }

  const nonNullTotal = data.reduce(
    (accumulator, point) =>
      point.temperature != null ? accumulator + 1 : accumulator,
    0
  );

  if (nonNullTotal <= maxPoints) {
    return data;
  }

  const segments = [];
  let currentSegment = [];

  for (let index = 0; index < data.length; index += 1) {
    const point = data[index];
    if (point.temperature == null || Number.isNaN(point.temperature)) {
      if (currentSegment.length > 0) {
        segments.push({ type: "line", points: currentSegment });
        currentSegment = [];
      }
      segments.push({ type: "gap", points: [point] });
    } else {
      currentSegment.push(point);
    }
  }

  if (currentSegment.length > 0) {
    segments.push({ type: "line", points: currentSegment });
  }

  const result = [];

  segments.forEach((segment) => {
    if (segment.type === "gap") {
      result.push(...segment.points);
      return;
    }

    const segmentLength = segment.points.length;
    if (segmentLength <= 3) {
      result.push(...segment.points);
      return;
    }

    const segmentThreshold = Math.max(
      3,
      Math.round((segmentLength / nonNullTotal) * maxPoints)
    );

    if (segmentLength <= segmentThreshold) {
      result.push(...segment.points);
      return;
    }

    result.push(...lttbSegment(segment.points, segmentThreshold));
  });

  return result;
};

const getThresholdFloor = (percent) =>
  (FLOOR_AT_REFERENCE_PERCENT * percent) / FLOOR_REFERENCE_PERCENT;

const getThresholdValue = (value, percent) => {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = percent / 100;
  const margin = Math.max(getThresholdFloor(percent), Math.abs(value) * factor);
  return Number((value + margin).toFixed(3));
};

const formatAlertTime = (isoValue) => {
  if (!isoValue) {
    return "--:--:--";
  }

  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }

  return date.toLocaleTimeString();
};

const domainsAreEqual = (a, b) =>
  Math.abs(a[0] - b[0]) < 0.000001 && Math.abs(a[1] - b[1]) < 0.000001;

const applyStdNoiseReduction = (points) => {
  const samplesByDistance = new Map();

  points.forEach((point) => {
    if (
      point.temperature == null ||
      Number.isNaN(point.temperature) ||
      !Number.isFinite(point.distance)
    ) {
      return;
    }

    const key = point.distance.toFixed(3);
    if (!samplesByDistance.has(key)) {
      samplesByDistance.set(key, []);
    }
    samplesByDistance.get(key).push(point.temperature);
  });

  const statsByDistance = new Map();
  samplesByDistance.forEach((samples, key) => {
    if (samples.length < 2) {
      return;
    }

    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance =
      samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      samples.length;
    const stdDev = Math.sqrt(variance);

    statsByDistance.set(key, { mean, stdDev });
  });

  return points.map((point) => {
    if (
      point.temperature == null ||
      Number.isNaN(point.temperature) ||
      !Number.isFinite(point.distance)
    ) {
      return point;
    }

    const key = point.distance.toFixed(3);
    const stats = statsByDistance.get(key);
    if (!stats || !Number.isFinite(stats.stdDev) || stats.stdDev === 0) {
      return point;
    }

    const lower = stats.mean - stats.stdDev;
    const upper = stats.mean + stats.stdDev;
    const filtered = Math.min(upper, Math.max(lower, point.temperature));
    if (Math.abs(filtered - point.temperature) < 0.000001) {
      return point;
    }

    return {
      ...point,
      temperature: Number(filtered.toFixed(3)),
    };
  });
};

const loadCachedThresholds = () => {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(THRESHOLD_CACHE_KEY);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const LimitsView = () => {
  const [chartType, setChartType] = useState(DEFAULT_CHART_TYPE);
  const [channel, setChannel] = useState(DEFAULT_CHANNEL);
  const [rangeMode, setRangeMode] = useState(RANGE_MODES.default);
  const [noiseMode, setNoiseMode] = useState(NOISE_MODES.raw);
  const [data, setData] = useState([]);
  const [latestFileId, setLatestFileId] = useState(null);
  const [fileVisibility, setFileVisibility] = useState({});
  const [hideUnselected, setHideUnselected] = useState(false);
  const [thresholdInput, setThresholdInput] = useState(DEFAULT_THRESHOLD_INPUT);
  const [thresholdColor, setThresholdColor] = useState(THRESHOLD_COLORS[0]);
  const [thresholdSoundEnabled, setThresholdSoundEnabled] = useState(false);
  const [thresholdLevels, setThresholdLevels] = useState(loadCachedThresholds);
  const [alerts, setAlerts] = useState([]);
  const [alertsPanelOpen, setAlertsPanelOpen] = useState(true);
  const [soundPanelOpen, setSoundPanelOpen] = useState(true);
  const [soundMuted, setSoundMuted] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [dataError, setDataError] = useState(null);
  const [initialStats, setInitialStats] = useState({
    xMin: DEFAULT_RANGE.xMin,
    xMax: DEFAULT_RANGE.xMax,
    yMin: DEFAULT_RANGE.yMin,
    yMax: DEFAULT_RANGE.yMax,
  });
  const [xDomain, setXDomain] = useState([
    DEFAULT_RANGE.xMin,
    DEFAULT_RANGE.xMax,
  ]);
  const [yDomain, setYDomain] = useState([
    DEFAULT_RANGE.yMin,
    DEFAULT_RANGE.yMax,
  ]);
  const [zoomSelection, setZoomSelection] = useState({
    isSelecting: false,
    startX: null,
    endX: null,
  });

  const chartContainerRef = useRef(null);
  const rafRef = useRef(null);
  const chartRectRef = useRef(null);
  const lastPointerXRef = useRef(null);
  const isReloadingRef = useRef(false);
  const latestFileRef = useRef(null);
  const seenAlertIdsRef = useRef(new Set());
  const soundPanelOpenRef = useRef(true);
  const soundMutedRef = useRef(false);
  const audioContextRef = useRef(null);

  const getApiBase = useCallback(
    () => import.meta.env.VITE_CH1_API || window.location.origin,
    []
  );

  const getRangeForChart = useCallback(
    (type, selectedRangeMode = RANGE_MODES.default) => {
      const baseRange = CHART_TYPES[type] || CHART_TYPES.tension;
      if (selectedRangeMode === RANGE_MODES.full) {
        return {
          ...baseRange,
          xMin: FULL_X_RANGE.xMin,
          xMax: FULL_X_RANGE.xMax,
        };
      }
      return baseRange;
    },
    []
  );

  const currentTypeParam = chartType === "tension" ? "str" : "tem";

  const applyChartRange = useCallback((range) => {
    const yMin = range.yMin ?? DEFAULT_RANGE.yMin;
    const yMax = range.yMax ?? DEFAULT_RANGE.yMax;

    setInitialStats({
      xMin: range.xMin,
      xMax: range.xMax,
      yMin,
      yMax,
    });
    setXDomain([range.xMin, range.xMax]);
    setYDomain([yMin, yMax]);
    setZoomSelection({
      isSelecting: false,
      startX: null,
      endX: null,
    });
  }, []);

  const processedData = useMemo(() => {
    if (noiseMode === NOISE_MODES.std) {
      return applyStdNoiseReduction(data);
    }
    return data;
  }, [data, noiseMode]);

  const visibleData = useMemo(() => {
    if (processedData.length === 0) {
      return [];
    }

    const currentXMin = xDomain[0];
    const currentXMax = xDomain[1];
    const range = currentXMax - currentXMin || 1;
    const buffer = Math.min(range * 0.1, 100);
    const minVisible = currentXMin - buffer;
    const maxVisible = currentXMax + buffer;

    return processedData.filter(
      (point) =>
        (point.distance >= minVisible && point.distance <= maxVisible) ||
        point.temperature === null
    );
  }, [processedData, xDomain]);

  const chartData = useMemo(() => {
    if (!visibleData || visibleData.length === 0) {
      return [];
    }

    return decimateVisibleData(visibleData, MAX_CHART_POINTS);
  }, [visibleData]);

  const fileIds = useMemo(() => {
    const ids = new Set();
    data.forEach((point) => {
      if (point.fileId) {
        ids.add(point.fileId);
      }
    });
    return Array.from(ids);
  }, [data]);

  const activeFileIds = useMemo(
    () => fileIds.filter((id) => fileVisibility[id] !== false),
    [fileIds, fileVisibility]
  );

  const activeReferenceFileId = useMemo(() => {
    if (activeFileIds.length > 0) {
      return activeFileIds[activeFileIds.length - 1];
    }

    return latestFileId || fileIds[fileIds.length - 1] || null;
  }, [activeFileIds, fileIds, latestFileId]);

  const activeReferenceIndex = useMemo(() => {
    const index = fileIds.findIndex((id) => id === activeReferenceFileId);
    return index >= 0 ? index + 1 : null;
  }, [activeReferenceFileId, fileIds]);

  const sortedThresholdLevels = useMemo(
    () =>
      [...thresholdLevels].sort((a, b) => {
        if (a.percent !== b.percent) {
          return a.percent - b.percent;
        }
        return String(a.id).localeCompare(String(b.id));
      }),
    [thresholdLevels]
  );

  const visibleThresholdSeries = useMemo(() => {
    const currentXMin = xDomain[0];
    const currentXMax = xDomain[1];
    const range = currentXMax - currentXMin || 1;
    const buffer = Math.min(range * 0.1, 100);
    const minVisible = currentXMin - buffer;
    const maxVisible = currentXMax + buffer;

    return sortedThresholdLevels
      .filter((level) => level.type === currentTypeParam)
      .map((level) => ({
        ...level,
        points: level.points.filter(
          (point) => point.distance >= minVisible && point.distance <= maxVisible
        ),
      }));
  }, [currentTypeParam, sortedThresholdLevels, xDomain]);

  const soundThresholdCount = useMemo(
    () => thresholdLevels.filter((level) => level.soundEnabled).length,
    [thresholdLevels]
  );

  const syncPayload = useMemo(
    () =>
      thresholdLevels.map((level) => ({
        id: level.id,
        percent: level.percent,
        floor: level.floor,
        color: level.color,
        sourceFileId: level.sourceFileId,
        sourceFileIndex: level.sourceFileIndex,
        soundEnabled: level.soundEnabled,
        type: level.type,
        thresholdLabel: level.thresholdLabel,
        points: level.points,
      })),
    [thresholdLevels]
  );

  const computeYDomainForRange = useCallback(
    (rangeX) => {
      const [minX, maxX] = rangeX;
      const selectedFileSet = new Set(
        fileIds.filter((id) => fileVisibility[id] !== false)
      );

      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      processedData.forEach((point) => {
        if (point.temperature == null || Number.isNaN(point.temperature)) {
          return;
        }
        if (point.distance < minX || point.distance > maxX) {
          return;
        }
        if (hideUnselected && point.fileId && !selectedFileSet.has(point.fileId)) {
          return;
        }

        minY = Math.min(minY, point.temperature);
        maxY = Math.max(maxY, point.temperature);
      });

      thresholdLevels.forEach((level) => {
        if (level.type !== currentTypeParam || !Array.isArray(level.points)) {
          return;
        }

        level.points.forEach((point) => {
          if (point.distance < minX || point.distance > maxX) {
            return;
          }

          minY = Math.min(minY, point.thresholdValue);
          maxY = Math.max(maxY, point.thresholdValue);
        });
      });

      if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
        return [initialStats.yMin, initialStats.yMax];
      }

      const span = maxY - minY;
      const padding = span > 0 ? span * 0.12 : Math.max(Math.abs(maxY) * 0.08, 1);

      return [Number((minY - padding).toFixed(3)), Number((maxY + padding).toFixed(3))];
    },
    [
      currentTypeParam,
      processedData,
      fileIds,
      fileVisibility,
      hideUnselected,
      initialStats.yMax,
      initialStats.yMin,
      thresholdLevels,
    ]
  );

  const ensureAudioContext = useCallback(async () => {
    if (typeof window === "undefined") {
      return null;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextClass();
    }

    if (audioContextRef.current.state === "suspended") {
      try {
        await audioContextRef.current.resume();
      } catch {
        return audioContextRef.current;
      }
    }

    return audioContextRef.current;
  }, []);

  const playAlertTone = useCallback(async () => {
    const context = await ensureAudioContext();
    if (!context) {
      return;
    }

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;

    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.35);
  }, [ensureAudioContext]);

  const fetchChartData = useCallback(
    async (type, channelKey, selectedRangeMode = RANGE_MODES.default) => {
      const channelInfo = CHANNELS[channelKey] || CHANNELS[DEFAULT_CHANNEL];
      const range = getRangeForChart(type, selectedRangeMode);
      setIsReloading(true);
      setDataError(null);

      try {
        const param = type === "tension" ? "str" : "tem";
        const response = await fetch(
          `${getApiBase()}/api/ch1-data?type=${param}&min=${range.xMin}&max=${range.xMax}&ch=${channelInfo.id}`
        );
        const rawText = await response.text();

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${rawText || ""}`.trim());
        }

        let payload;
        try {
          payload = JSON.parse(rawText);
        } catch {
          throw new Error(
            `Respuesta no es JSON. Snippet: ${rawText.slice(0, 180)}`
          );
        }

        const rawPoints = Array.isArray(payload.points) ? payload.points : [];
        const valueDivisor =
          Number(channelInfo.valueDivisor) > 0 ? channelInfo.valueDivisor : 1;
        const points =
          valueDivisor === 1
            ? rawPoints
            : rawPoints.map((point) => ({
                ...point,
                temperature:
                  point.temperature == null
                    ? null
                    : Number((point.temperature / valueDivisor).toFixed(6)),
              }));
        const latest = payload.latestFile || null;

        applyChartRange(range);
        setData(points);
        setLatestFileId(latest);

        const newIds = new Set();
        points.forEach((point) => {
          if (point.fileId) {
            newIds.add(point.fileId);
          }
        });

        setFileVisibility((previous) => {
          const next = {};
          Array.from(newIds).forEach((id) => {
            next[id] = previous[id] !== undefined ? previous[id] : true;
          });
          return next;
        });
      } catch (error) {
        console.error("Error cargando datos", error);
        setData([]);
        setLatestFileId(null);
        setFileVisibility({});
        setDataError(
          `No se pudieron cargar los datos. Usa Recargar. Detalle: ${error?.message || "desconocido"}`
        );
      } finally {
        setIsReloading(false);
      }
    },
    [applyChartRange, getApiBase, getRangeForChart]
  );

  useEffect(() => {
    void fetchChartData(chartType, channel, rangeMode);
  }, [chartType, channel, fetchChartData, rangeMode]);

  useEffect(() => {
    isReloadingRef.current = isReloading;
  }, [isReloading]);

  useEffect(() => {
    latestFileRef.current = latestFileId;
  }, [latestFileId]);

  useEffect(() => {
    soundPanelOpenRef.current = soundPanelOpen;
  }, [soundPanelOpen]);

  useEffect(() => {
    soundMutedRef.current = soundMuted;
  }, [soundMuted]);

  useEffect(() => {
    const isFullRange =
      Math.abs(xDomain[0] - initialStats.xMin) < 0.000001 &&
      Math.abs(xDomain[1] - initialStats.xMax) < 0.000001;

    const nextDomain = isFullRange
      ? [initialStats.yMin, initialStats.yMax]
      : computeYDomainForRange(xDomain);

    setYDomain((previous) =>
      domainsAreEqual(previous, nextDomain) ? previous : nextDomain
    );
  }, [computeYDomainForRange, initialStats.xMax, initialStats.xMin, initialStats.yMax, initialStats.yMin, xDomain]);

  useEffect(() => {
    const syncThresholds = async () => {
      try {
        await fetch(`${getApiBase()}/api/thresholds`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            thresholds: syncPayload,
          }),
        });
      } catch (error) {
        console.error("Error sincronizando umbrales", error);
      }
    };

    void syncThresholds();
  }, [getApiBase, syncPayload]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(
        THRESHOLD_CACHE_KEY,
        JSON.stringify(syncPayload)
      );
    } catch (error) {
      console.error("Error guardando cache de umbrales", error);
    }
  }, [syncPayload]);

  useEffect(() => {
    let isDisposed = false;

    const pollMonitor = async () => {
      try {
        const response = await fetch(`${getApiBase()}/api/monitor-state`, {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }

        const payload = await response.json();
        if (isDisposed) {
          return;
        }

        const nextAlerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
        setAlerts(nextAlerts);

        const newAlerts = nextAlerts.filter(
          (alert) => !seenAlertIdsRef.current.has(alert.id)
        );
        newAlerts.forEach((alert) => {
          seenAlertIdsRef.current.add(alert.id);
        });

        if (
          newAlerts.some((alert) => alert.soundEnabled) &&
          soundPanelOpenRef.current &&
          !soundMutedRef.current
        ) {
          void playAlertTone();
        }

        const monitorChannelId =
          CHANNELS[channel]?.id || CHANNELS[DEFAULT_CHANNEL].id;
        const currentKey = `${monitorChannelId}:${currentTypeParam}`;
        const nextLatestFile = payload?.versions?.[currentKey]?.latestFile || null;
        if (
          nextLatestFile &&
          nextLatestFile !== latestFileRef.current &&
          !isReloadingRef.current
        ) {
          latestFileRef.current = nextLatestFile;
          void fetchChartData(chartType, channel, rangeMode);
        }
      } catch (error) {
        console.error("Error leyendo monitor", error);
      }
    };

    void pollMonitor();
    const interval = setInterval(() => {
      void pollMonitor();
    }, MONITOR_POLL_MS);

    return () => {
      isDisposed = true;
      clearInterval(interval);
    };
  }, [
    channel,
    chartType,
    currentTypeParam,
    fetchChartData,
    getApiBase,
    playAlertTone,
    rangeMode,
  ]);

  const handleReloadData = () => {
    void fetchChartData(chartType, channel, rangeMode);
  };

  const handleChartTypeChange = (type) => {
    setChartType(type);
  };

  const handleChannelChange = (event) => {
    setChannel(event.target.value);
  };

  const handleRangeModeChange = (event) => {
    const value = event.target.value;
    if (value === RANGE_MODES.default || value === RANGE_MODES.full) {
      setRangeMode(value);
    }
  };

  const handleNoiseModeChange = (event) => {
    const value = event.target.value;
    if (value === NOISE_MODES.raw || value === NOISE_MODES.std) {
      setNoiseMode(value);
    }
  };

  const toggleFileVisibility = (fileId) => {
    setFileVisibility((previous) => ({
      ...previous,
      [fileId]: previous[fileId] === false ? true : false,
    }));
  };

  const handleAddThreshold = () => {
    const parsed = Number(thresholdInput);
    const sourceFileId = activeReferenceFileId;
    if (!Number.isFinite(parsed) || parsed <= 0 || !sourceFileId) {
      return;
    }

    const referencePoints = processedData
      .filter(
        (point) =>
          point.fileId === sourceFileId &&
          point.temperature != null &&
          !Number.isNaN(point.temperature)
      )
      .map((point) => ({
        distance: point.distance,
        thresholdValue: getThresholdValue(point.temperature, parsed),
      }))
      .filter((point) => Number.isFinite(point.thresholdValue));

    if (referencePoints.length === 0) {
      return;
    }

    const normalizedPercent = Number(parsed.toFixed(1));
    const alreadyExists = thresholdLevels.some(
      (level) =>
        level.percent === normalizedPercent &&
        level.sourceFileId === sourceFileId &&
        level.type === currentTypeParam
    );
    if (alreadyExists) {
      return;
    }

    const uniqueKey = `${Date.now()}_${thresholdLevels.length}`;
    const nextPaletteColor =
      THRESHOLD_COLORS[(thresholdLevels.length + 1) % THRESHOLD_COLORS.length];

    setThresholdLevels((previous) => [
      ...previous,
      {
        id: uniqueKey,
        percent: normalizedPercent,
        floor: Number(getThresholdFloor(normalizedPercent).toFixed(2)),
        color: thresholdColor,
        sourceFileId,
        sourceFileIndex: activeReferenceIndex,
        soundEnabled: thresholdSoundEnabled,
        type: currentTypeParam,
        thresholdLabel: `Umbral al ${normalizedPercent.toFixed(1)}%`,
        points: referencePoints,
      },
    ]);

    setThresholdColor(nextPaletteColor);
    if (thresholdSoundEnabled) {
      void ensureAudioContext();
    }
  };

  const handleRemoveThreshold = (id) => {
    setThresholdLevels((previous) =>
      previous.filter((level) => level.id !== id)
    );
  };

  const handleThresholdInputKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAddThreshold();
    }
  };

  const getChartXValue = useCallback(
    (event) => {
      const rect =
        chartRectRef.current ||
        (chartContainerRef.current &&
          chartContainerRef.current.getBoundingClientRect());

      if (!rect) {
        return null;
      }

      const gridLeft = CHART_MARGINS.left + Y_AXIS_WIDTH;
      const gridWidth =
        rect.width - CHART_MARGINS.left - CHART_MARGINS.right - Y_AXIS_WIDTH;
      const xPixel = event.clientX - rect.left - gridLeft;
      const [currentXMin, currentXMax] = xDomain;

      let xValue =
        currentXMin + (xPixel / gridWidth) * (currentXMax - currentXMin);
      xValue = Math.max(currentXMin, Math.min(currentXMax, xValue));

      return Math.round(xValue);
    },
    [xDomain]
  );

  const handleMouseDown = (event) => {
    event.preventDefault();

    if (chartContainerRef.current) {
      chartRectRef.current = chartContainerRef.current.getBoundingClientRect();
    }

    const xValue = getChartXValue(event);
    if (xValue == null) {
      return;
    }

    lastPointerXRef.current = xValue;
    setZoomSelection({
      isSelecting: true,
      startX: xValue,
      endX: xValue,
    });
  };

  const handleMouseMove = (event) => {
    if (!zoomSelection.isSelecting || rafRef.current) {
      return;
    }

    rafRef.current = requestAnimationFrame(() => {
      const xValue = getChartXValue(event);
      if (xValue != null) {
        const lastPointerX = lastPointerXRef.current;
        const delta =
          lastPointerX != null ? Math.abs(xValue - lastPointerX) : Infinity;

        if (delta >= MIN_POINTER_DELTA_X) {
          lastPointerXRef.current = xValue;
          setZoomSelection((previous) => ({
            ...previous,
            endX: xValue,
          }));
        }
      }

      rafRef.current = null;
    });
  };

  const handleMouseUp = () => {
    if (!zoomSelection.isSelecting) {
      return;
    }

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    chartRectRef.current = null;
    lastPointerXRef.current = null;

    const { startX, endX } = zoomSelection;
    const nextSelection = {
      isSelecting: false,
      startX: null,
      endX: null,
    };

    if (startX == null || endX == null) {
      setZoomSelection(nextSelection);
      return;
    }

    if (
      Math.abs(endX - startX) >
      (initialStats.xMax - initialStats.xMin) * MIN_ZOOM_RATIO
    ) {
      setXDomain([Math.min(startX, endX), Math.max(startX, endX)]);
    }

    setZoomSelection(nextSelection);
  };

  const resetZoom = () => {
    setXDomain([initialStats.xMin, initialStats.xMax]);
    setYDomain([initialStats.yMin, initialStats.yMax]);
    setZoomSelection({
      isSelecting: false,
      startX: null,
      endX: null,
    });
  };

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 text-slate-800 font-sans overflow-y-auto">
      <HeaderBar
        xDomain={xDomain}
        initialStats={initialStats}
        onResetZoom={resetZoom}
        onReloadData={handleReloadData}
        isReloading={isReloading}
      />

      <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-3 flex-none flex-wrap">
        <span className="text-sm text-slate-600">Selecciona grafico:</span>
        <div className="flex gap-2">
          <button
            onClick={() => handleChartTypeChange("tension")}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              chartType === "tension"
                ? "bg-blue-600 text-white shadow"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            Grafico Tension
          </button>
          <button
            onClick={() => handleChartTypeChange("temperatura")}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              chartType === "temperatura"
                ? "bg-blue-600 text-white shadow"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            Grafico Temperatura
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-600">Canal:</span>
          <select
            value={channel}
            onChange={handleChannelChange}
            className="text-sm border border-slate-200 rounded-md px-3 py-2 bg-white shadow-sm"
          >
            {Object.entries(CHANNELS).map(([channelKey, channelOption]) => (
              <option key={channelKey} value={channelKey}>
                {channelOption.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-600">Tramo:</span>
          <select
            value={rangeMode}
            onChange={handleRangeModeChange}
            className="text-sm border border-slate-200 rounded-md px-3 py-2 bg-white shadow-sm"
          >
            <option value={RANGE_MODES.default}>Correspondiente</option>
            <option value={RANGE_MODES.full}>Completo 0 - 1620</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-600">Ruido:</span>
          <select
            value={noiseMode}
            onChange={handleNoiseModeChange}
            className="text-sm border border-slate-200 rounded-md px-3 py-2 bg-white shadow-sm"
          >
            <option value={NOISE_MODES.raw}>Original</option>
            <option value={NOISE_MODES.std}>Desviacion estandar (N)</option>
          </select>
        </div>

        {dataError ? (
          <span className="ml-auto text-sm text-red-600">{dataError}</span>
        ) : (
          <span className="ml-auto text-xs text-slate-500">
            {isReloading
              ? "Cargando datos..."
              : `Datos cargados desde carpeta ${CHANNELS[channel]?.label || "Canal 1"}`}
          </span>
        )}
      </div>

      <div className="flex flex-col flex-1 overflow-y-auto min-h-0">
        <div className="flex-1 p-4 relative min-h-0 bg-slate-100 space-y-3">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {alertsPanelOpen ? (
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">
                      Alertas Detectadas
                    </div>
                    <div className="text-xs text-slate-500">
                      Se actualizan cuando entra un archivo nuevo en cualquier canal
                    </div>
                  </div>
                  <button
                    onClick={() => setAlertsPanelOpen(false)}
                    className="text-xs text-slate-400 hover:text-slate-700"
                  >
                    Cerrar
                  </button>
                </div>

                <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                  {alerts.length === 0 ? (
                    <div className="text-xs text-slate-400 italic">
                      Sin alertas activas por ahora
                    </div>
                  ) : (
                    alerts.slice(0, 6).map((alert) => (
                      <div
                        key={alert.id}
                        className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs"
                      >
                        <div className="font-semibold text-red-700">
                          {alert.thresholdLabel}
                        </div>
                        <div className="text-slate-500">
                          Canal {alert.channel} |{" "}
                          {alert.type === "str" ? "Tension" : "Temperatura"} |{" "}
                          {formatAlertTime(alert.createdAt)}
                        </div>
                        <div className="text-slate-700">
                          Lectura {Number(alert.measuredValue).toFixed(2)} &gt;{" "}
                          {Number(alert.thresholdValue).toFixed(2)} en{" "}
                          {Number(alert.distance).toFixed(2)} m
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAlertsPanelOpen(true)}
                className="justify-self-start px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm text-slate-700 shadow-sm"
              >
                Mostrar alertas
              </button>
            )}

            {soundPanelOpen ? (
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">
                      Sonido de Alertas
                    </div>
                    <div className="text-xs text-slate-500">
                      Umbrales con sonido: {soundThresholdCount}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setSoundPanelOpen(false);
                      setSoundMuted(true);
                    }}
                    className="text-xs text-slate-400 hover:text-slate-700"
                  >
                    Cerrar
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-xs px-3 py-1 rounded-full ${
                      soundMuted
                        ? "bg-slate-100 text-slate-500"
                        : "bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    {soundMuted ? "Silenciado" : "Activo"}
                  </span>
                  <button
                    onClick={() => setSoundMuted((previous) => !previous)}
                    className="px-3 py-2 rounded-md bg-slate-800 text-white text-xs"
                  >
                    {soundMuted ? "Reactivar sonido" : "Silenciar sonido"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setSoundPanelOpen(true);
                  setSoundMuted(false);
                }}
                className="justify-self-start px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm text-slate-700 shadow-sm"
              >
                Mostrar sonido
              </button>
            )}
          </div>

          {fileIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap gap-2">
                {fileIds.map((fileId, index) => {
                  const isOn = fileVisibility[fileId] !== false;
                  const isReference = fileId === activeReferenceFileId;

                  return (
                    <button
                      key={fileId}
                      onClick={() => toggleFileVisibility(fileId)}
                      className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                        isOn
                          ? isReference
                            ? "bg-red-50 border-red-200 text-red-700"
                            : "bg-blue-50 border-blue-200 text-blue-700"
                          : "bg-slate-100 border-slate-200 text-slate-400"
                      }`}
                      title={fileId}
                    >
                      Archivo {index + 1}
                    </button>
                  );
                })}
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  className="accent-blue-600"
                  checked={hideUnselected}
                  onChange={(event) => setHideUnselected(event.target.checked)}
                />
                Ocultar no seleccionados
              </label>
            </div>
          )}

          <LimitsChart
            hasData={data.length > 0}
            visibleData={chartData}
            lineColor={CHANNELS[channel]?.color || CHANNELS[DEFAULT_CHANNEL].color}
            chartType={chartType}
            latestFileId={latestFileId}
            fileIds={fileIds}
            fileVisibility={fileVisibility}
            hideUnselected={hideUnselected}
            thresholdSeries={visibleThresholdSeries}
            activeReferenceFileId={activeReferenceFileId}
            activeReferenceIndex={activeReferenceIndex}
            zoomSelection={zoomSelection}
            xDomain={xDomain}
            yDomain={yDomain}
            initialStats={initialStats}
            chartContainerRef={chartContainerRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          />
        </div>

        <ControlPanel
          thresholdInput={thresholdInput}
          onThresholdInputChange={setThresholdInput}
          thresholdColor={thresholdColor}
          onThresholdColorChange={setThresholdColor}
          thresholdSoundEnabled={thresholdSoundEnabled}
          onThresholdSoundEnabledChange={setThresholdSoundEnabled}
          onThresholdInputKeyDown={handleThresholdInputKeyDown}
          onAddThreshold={handleAddThreshold}
          thresholdLevels={sortedThresholdLevels}
          onRemoveThreshold={handleRemoveThreshold}
          activeReferenceIndex={activeReferenceIndex}
          selectedFileCount={activeFileIds.length}
        />
      </div>
    </div>
  );
};

export default LimitsView;
