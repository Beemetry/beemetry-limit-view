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
  section1: "tramo_1",
  section2: "tramo_2",
  full: "completo",
};
const VIEW_MODES = {
  compare: "compare",
  diff2: "diff2",
  manualDiff: "manual_diff",
};
const NOISE_MODES = {
  raw: "raw",
  std: "std",
};
const THRESHOLD_MODES = {
  percent: "percent",
  offset: "offset",
};
const FULL_X_RANGE = {
  xMin: 0,
  xMax: 1620,
};
const SECTION_1_X_RANGE = {
  xMin: 0,
  xMax: 810,
};
const SECTION_2_X_RANGE = {
  xMin: 810,
  xMax: 1620,
};

const DEFAULT_CHART_TYPE = "tension";
const DEFAULT_RANGE_MODE = RANGE_MODES.section1;
const DEFAULT_THRESHOLD_RANGE_MODE = RANGE_MODES.full;
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
const DEFAULT_THRESHOLD_MODE = THRESHOLD_MODES.percent;
const MAX_CHART_POINTS = 4000;
const FLOOR_REFERENCE_PERCENT = 20;
const FLOOR_AT_REFERENCE_PERCENT = 5;
const MIN_POINTER_DELTA_X = 1;
const MIN_ZOOM_RATIO = 0.005;
const MONITOR_POLL_MS = 2000;
const THRESHOLD_CACHE_KEY = "beemetry-thresholds-cache";
const EMPTY_COMPARISON_INFO = {
  mode: VIEW_MODES.compare,
  latestFile: null,
  previousFile: null,
  selectedFiles: [],
  exportRows: [],
  differentialReady: false,
  message: null,
};

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

const getThresholdValueWithOffset = (value, offset) => {
  if (!Number.isFinite(value) || !Number.isFinite(offset)) {
    return null;
  }

  return Number((value + offset).toFixed(3));
};

const PERU_TIME_ZONE = "America/Lima";

const formatPeruDateTime = (isoValue) => {
  if (!isoValue) {
    return "--";
  }

  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: PERU_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatter.format(date);
};

const formatAlertTime = (isoValue) => {
  const fullDateTime = formatPeruDateTime(isoValue);
  if (fullDateTime === "--") {
    return "--:--:--";
  }
  const timePart = fullDateTime.split(" ")[1];
  return timePart || "--:--:--";
};

const getAlertTypeLabel = (typeValue) =>
  typeValue === "str" ? "Tension" : "Temperatura";

const getYBoundsFromPoints = (points, fallbackRange) => {
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  points.forEach((point) => {
    if (point.temperature == null || Number.isNaN(point.temperature)) {
      return;
    }

    minY = Math.min(minY, point.temperature);
    maxY = Math.max(maxY, point.temperature);
  });

  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return {
      yMin: fallbackRange.yMin,
      yMax: fallbackRange.yMax,
    };
  }

  const span = maxY - minY;
  const padding = span > 0 ? span * 0.12 : Math.max(Math.abs(maxY) * 0.08, 1);

  return {
    yMin: Number((minY - padding).toFixed(3)),
    yMax: Number((maxY + padding).toFixed(3)),
  };
};

const escapeExcelXml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const buildExcelCell = (value, type = "String", styleId = "") => {
  const styleAttr = styleId ? ` ss:StyleID="${styleId}"` : "";
  return `<Cell${styleAttr}><Data ss:Type="${type}">${escapeExcelXml(
    value
  )}</Data></Cell>`;
};

const buildDifferentialWorkbookXml = ({
  channelLabel,
  chartLabel,
  secondFile,
  firstFile,
  secondLabel,
  firstLabel,
  rows,
}) => {
  const headerRows = [
    ["Canal", channelLabel],
    ["Grafico", chartLabel],
    [`Archivo ${secondLabel}`, secondFile],
    [`Archivo ${firstLabel}`, firstFile],
    ["", ""],
    [
      "Distancia (m)",
      `${firstLabel}`,
      `Archivo ${firstLabel}`,
      `${secondLabel}`,
      `Archivo ${secondLabel}`,
      "Diferencial",
    ],
  ];

  const xmlRows = [
    ...headerRows.map((cells, index) => {
      const styleId = index === headerRows.length - 1 ? "header" : "meta";
      return `<Row>${cells
        .map((cell) => buildExcelCell(cell, "String", styleId))
        .join("")}</Row>`;
    }),
    ...rows.map((row) => {
      const distance = Number(row.distance);
      const previousValue = Number(row.previousValue);
      const latestValue = Number(row.latestValue);
      const differential = Number(row.differential);

      return `<Row>${[
        buildExcelCell(
          Number.isFinite(distance) ? distance.toFixed(6) : row.distance,
          "Number"
        ),
        buildExcelCell(
          Number.isFinite(previousValue)
            ? previousValue.toFixed(6)
            : row.previousValue,
          "Number"
        ),
        buildExcelCell(row.previousFile),
        buildExcelCell(
          Number.isFinite(latestValue) ? latestValue.toFixed(6) : row.latestValue,
          "Number"
        ),
        buildExcelCell(row.latestFile),
        buildExcelCell(
          Number.isFinite(differential)
            ? differential.toFixed(6)
            : row.differential,
          "Number"
        ),
      ].join("")}</Row>`;
    }),
  ].join("");

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40"
>
  <Styles>
    <Style ss:ID="meta">
      <Font ss:Bold="1" />
    </Style>
    <Style ss:ID="header">
      <Font ss:Bold="1" />
      <Interior ss:Color="#DBEAFE" ss:Pattern="Solid" />
    </Style>
  </Styles>
  <Worksheet ss:Name="Diferencial">
    <Table>
      ${xmlRows}
    </Table>
  </Worksheet>
</Workbook>`;
};

const buildStdWorkbookXml = ({
  channelLabel,
  chartLabel,
  fileIds,
  rows,
}) => {
  const headerRow = [
    "Distancia (m)",
    ...fileIds.map((_, index) => `Lectura ${index + 1}`),
    "Promedio (mu)",
    "Desviacion estandar (sigma)",
  ];

  const fileNameRow = [
    "Archivo",
    ...fileIds.map((fileId) => fileId),
    "",
    "",
  ];

  const headerRows = [
    ["Canal", channelLabel],
    ["Grafico", chartLabel],
    ["Modo", "Desviacion estandar (N)"],
    ["Total lecturas", String(fileIds.length)],
    ["", ""],
    fileNameRow,
    headerRow,
  ];

  const xmlRows = [
    ...headerRows.map((cells, index) => {
      const isColumnHeader = index === headerRows.length - 1;
      const styleId = isColumnHeader ? "header" : "meta";
      return `<Row>${cells
        .map((cell) => buildExcelCell(cell, "String", styleId))
        .join("")}</Row>`;
    }),
    ...rows.map((row) => {
      const distance = Number(row.distance);
      const mean = Number(row.meanValue);
      const sigma = Number(row.stdDev);
      const readingCells = fileIds.map((fileId) => {
        const readingValue = row.valuesByFile?.[fileId];
        return buildExcelCell(
          Number.isFinite(readingValue) ? readingValue.toFixed(6) : "",
          Number.isFinite(readingValue) ? "Number" : "String"
        );
      });

      return `<Row>${[
        buildExcelCell(
          Number.isFinite(distance) ? distance.toFixed(6) : row.distance,
          "Number"
        ),
        ...readingCells,
        buildExcelCell(Number.isFinite(mean) ? mean.toFixed(6) : "", "Number"),
        buildExcelCell(Number.isFinite(sigma) ? sigma.toFixed(6) : "", "Number"),
      ].join("")}</Row>`;
    }),
  ].join("");

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40"
>
  <Styles>
    <Style ss:ID="meta">
      <Font ss:Bold="1" />
    </Style>
    <Style ss:ID="header">
      <Font ss:Bold="1" />
      <Interior ss:Color="#DBEAFE" ss:Pattern="Solid" />
    </Style>
  </Styles>
  <Worksheet ss:Name="DesviacionEstandar">
    <Table>
      ${xmlRows}
    </Table>
  </Worksheet>
</Workbook>`;
};

const buildStdExportRows = ({ rawPoints, stdPoints, fileIds }) => {
  const rowsByDistance = new Map();

  rawPoints.forEach((point) => {
    if (
      !point ||
      !Number.isFinite(point.distance) ||
      point.temperature == null ||
      Number.isNaN(point.temperature) ||
      !point.fileId
    ) {
      return;
    }

    const key = Number(point.distance).toFixed(6);
    if (!rowsByDistance.has(key)) {
      rowsByDistance.set(key, {
        distance: Number(Number(point.distance).toFixed(6)),
        valuesByFile: {},
      });
    }

    rowsByDistance.get(key).valuesByFile[point.fileId] = Number(point.temperature);
  });

  return stdPoints
    .filter(
      (point) =>
        Number.isFinite(point?.distance) &&
        Number.isFinite(point?.temperature) &&
        Number.isFinite(point?.meanValue)
    )
    .map((point) => {
      const key = Number(point.distance).toFixed(6);
      const rowBase = rowsByDistance.get(key) || {
        distance: Number(Number(point.distance).toFixed(6)),
        valuesByFile: {},
      };

      // Ensure all requested file columns exist even if that point is missing.
      const normalizedValues = {};
      fileIds.forEach((fileId) => {
        const value = rowBase.valuesByFile[fileId];
        normalizedValues[fileId] = Number.isFinite(value) ? value : null;
      });

      return {
        distance: rowBase.distance,
        valuesByFile: normalizedValues,
        meanValue: Number(point.meanValue),
        stdDev: Number(point.temperature),
      };
    })
    .sort((a, b) => a.distance - b.distance);
};

const domainsAreEqual = (a, b) =>
  Math.abs(a[0] - b[0]) < 0.000001 && Math.abs(a[1] - b[1]) < 0.000001;

const buildStdSeriesFromAllFiles = (points) => {
  const samplesByDistance = new Map();

  points.forEach((point) => {
    if (
      point.temperature == null ||
      Number.isNaN(point.temperature) ||
      !Number.isFinite(point.distance)
    ) {
      return;
    }

    const key = point.distance.toFixed(6);
    if (!samplesByDistance.has(key)) {
      samplesByDistance.set(key, {
        distance: point.distance,
        values: [],
      });
    }
    samplesByDistance.get(key).values.push(point.temperature);
  });

  return Array.from(samplesByDistance.values())
    .map((entry) => {
      const n = entry.values.length;
      if (n === 0) {
        return null;
      }

      const mean = entry.values.reduce((sum, value) => sum + value, 0) / n;
      const variance =
        entry.values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
      const stdDev = Math.sqrt(variance);

      return {
        distance: entry.distance,
        temperature: stdDev,
        fileId: "std_sigma",
        meanValue: mean,
        rawValues: entry.values,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);
};

const buildStdSeriesFromDifferentialPoints = (points) =>
  points.map((point) => {
    const previousValue = Number(point.previousValue);
    const latestValue = Number(point.latestValue);
    if (
      !Number.isFinite(point?.distance) ||
      !Number.isFinite(previousValue) ||
      !Number.isFinite(latestValue)
    ) {
      return point;
    }

    const values = [previousValue, latestValue];
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    return {
      ...point,
      temperature: stdDev,
      meanValue: mean,
      rawValues: values,
    };
  });

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
  const [viewMode, setViewMode] = useState(VIEW_MODES.compare);
  const [channel, setChannel] = useState(DEFAULT_CHANNEL);
  const [rangeMode, setRangeMode] = useState(DEFAULT_RANGE_MODE);
  const [noiseMode, setNoiseMode] = useState(NOISE_MODES.raw);
  const [diffNoiseEnabled, setDiffNoiseEnabled] = useState(true);
  const [data, setData] = useState([]);
  const [latestFileId, setLatestFileId] = useState(null);
  const [comparisonInfo, setComparisonInfo] = useState(EMPTY_COMPARISON_INFO);
  const [manualReading1, setManualReading1] = useState("");
  const [manualReading2, setManualReading2] = useState("");
  const [fileVisibility, setFileVisibility] = useState({});
  const [hideUnselected, setHideUnselected] = useState(false);
  const [thresholdMode, setThresholdMode] = useState(DEFAULT_THRESHOLD_MODE);
  const [thresholdDirection, setThresholdDirection] = useState("up");
  const [thresholdName, setThresholdName] = useState("");
  const [thresholdInput, setThresholdInput] = useState(DEFAULT_THRESHOLD_INPUT);
  const [thresholdColor, setThresholdColor] = useState(THRESHOLD_COLORS[0]);
  const [thresholdSoundEnabled, setThresholdSoundEnabled] = useState(false);
  const [thresholdLevels, setThresholdLevels] = useState(loadCachedThresholds);
  const [thresholdsHydrated, setThresholdsHydrated] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [dismissedAlertIds, setDismissedAlertIds] = useState([]);
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
    (type, selectedRangeMode = DEFAULT_RANGE_MODE) => {
      const baseRange = CHART_TYPES[type] || CHART_TYPES.tension;
      if (selectedRangeMode === RANGE_MODES.full) {
        return {
          ...baseRange,
          xMin: FULL_X_RANGE.xMin,
          xMax: FULL_X_RANGE.xMax,
        };
      }
      if (selectedRangeMode === RANGE_MODES.section2) {
        return {
          ...baseRange,
          xMin: SECTION_2_X_RANGE.xMin,
          xMax: SECTION_2_X_RANGE.xMax,
        };
      }
      if (selectedRangeMode === RANGE_MODES.section1) {
        return {
          ...baseRange,
          xMin: SECTION_1_X_RANGE.xMin,
          xMax: SECTION_1_X_RANGE.xMax,
        };
      }
      return baseRange;
    },
    []
  );

  const currentTypeParam = chartType === "tension" ? "str" : "tem";
  const currentChannelId = CHANNELS[channel]?.id || CHANNELS[DEFAULT_CHANNEL].id;
  const isManualDifferentialView = viewMode === VIEW_MODES.manualDiff;
  const isDifferentialView =
    viewMode === VIEW_MODES.diff2 || isManualDifferentialView;
  const isStdCompareMode =
    !isDifferentialView && noiseMode === NOISE_MODES.std;

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
    if (!Array.isArray(data) || data.length === 0) {
      return [];
    }

    if (isDifferentialView) {
      return diffNoiseEnabled
        ? buildStdSeriesFromDifferentialPoints(data)
        : data;
    }
    if (isStdCompareMode) {
      return buildStdSeriesFromAllFiles(data);
    }
    return data;
  }, [data, diffNoiseEnabled, isDifferentialView, isStdCompareMode]);

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

  const processedFileIds = useMemo(() => {
    const ids = new Set();
    processedData.forEach((point) => {
      if (point.fileId) {
        ids.add(point.fileId);
      }
    });
    return Array.from(ids);
  }, [processedData]);

  const activeFileIds = useMemo(
    () => fileIds.filter((id) => fileVisibility[id] !== false),
    [fileIds, fileVisibility]
  );

  const activeReferenceFileId = useMemo(() => {
    if (isDifferentialView) {
      return fileIds[0] || null;
    }
    if (isStdCompareMode) {
      return processedFileIds[0] || null;
    }
    if (activeFileIds.length > 0) {
      return activeFileIds[activeFileIds.length - 1];
    }

    return latestFileId || fileIds[fileIds.length - 1] || null;
  }, [
    activeFileIds,
    fileIds,
    isDifferentialView,
    isStdCompareMode,
    latestFileId,
    processedFileIds,
  ]);

  const activeReferenceIndex = useMemo(() => {
    if (isDifferentialView) {
      return null;
    }
    if (isStdCompareMode) {
      return "Sigma";
    }
    const index = fileIds.findIndex((id) => id === activeReferenceFileId);
    return index >= 0 ? index + 1 : null;
  }, [activeReferenceFileId, fileIds, isDifferentialView, isStdCompareMode]);

  const sortedThresholdLevels = useMemo(
    () =>
      [...thresholdLevels].sort((a, b) => {
        const modeA =
          a.mode === THRESHOLD_MODES.offset
            ? THRESHOLD_MODES.offset
            : THRESHOLD_MODES.percent;
        const modeB =
          b.mode === THRESHOLD_MODES.offset
            ? THRESHOLD_MODES.offset
            : THRESHOLD_MODES.percent;

        if (modeA !== modeB) {
          return modeA.localeCompare(modeB);
        }

        const valueA =
          modeA === THRESHOLD_MODES.offset
            ? Number(a.offsetValue)
            : Number(a.percent);
        const valueB =
          modeB === THRESHOLD_MODES.offset
            ? Number(b.offsetValue)
            : Number(b.percent);

        if (
          Number.isFinite(valueA) &&
          Number.isFinite(valueB) &&
          valueA !== valueB
        ) {
          return valueA - valueB;
        }

        return String(a.id).localeCompare(String(b.id));
      }),
    [thresholdLevels]
  );

  const activeThresholdLevels = useMemo(
    () =>
      sortedThresholdLevels.filter((level) => {
        const levelChannelId = String(
          level.channelId || CHANNELS[DEFAULT_CHANNEL].id
        );
        const levelRangeMode = level.rangeMode || DEFAULT_THRESHOLD_RANGE_MODE;
        return (
          level.type === currentTypeParam &&
          levelChannelId === currentChannelId &&
          levelRangeMode === rangeMode
        );
      }),
    [currentChannelId, currentTypeParam, rangeMode, sortedThresholdLevels]
  );

  const visibleThresholdSeries = useMemo(() => {
    if (isDifferentialView) {
      return [];
    }
    const currentXMin = xDomain[0];
    const currentXMax = xDomain[1];
    const range = currentXMax - currentXMin || 1;
    const buffer = Math.min(range * 0.1, 100);
    const minVisible = currentXMin - buffer;
    const maxVisible = currentXMax + buffer;

    return activeThresholdLevels
      .map((level) => ({
        ...level,
        points: level.points.filter(
          (point) => point.distance >= minVisible && point.distance <= maxVisible
        ),
      }));
  }, [activeThresholdLevels, isDifferentialView, xDomain]);

  const soundThresholdCount = useMemo(
    () => activeThresholdLevels.filter((level) => level.soundEnabled).length,
    [activeThresholdLevels]
  );

  const dismissedAlertIdSet = useMemo(
    () => new Set(dismissedAlertIds),
    [dismissedAlertIds]
  );

  const visibleAlerts = useMemo(
    () => alerts.filter((alert) => !dismissedAlertIdSet.has(alert.id)),
    [alerts, dismissedAlertIdSet]
  );

  const syncPayload = useMemo(
    () =>
      thresholdLevels.map((level) => {
        const mode =
          level.mode === THRESHOLD_MODES.offset
            ? THRESHOLD_MODES.offset
            : THRESHOLD_MODES.percent;

        return {
        id: level.id,
        percent: mode === THRESHOLD_MODES.percent ? level.percent : null,
        offsetValue:
          mode === THRESHOLD_MODES.offset
            ? Number(level.offsetValue)
            : Number.isFinite(Number(level.offsetValue))
              ? Number(level.offsetValue)
              : null,
        floor: level.floor,
        color: level.color,
        sourceFileId: level.sourceFileId,
        sourceFileIndex: level.sourceFileIndex,
        rangeMode: level.rangeMode || DEFAULT_THRESHOLD_RANGE_MODE,
        soundEnabled: level.soundEnabled,
        channelId: String(level.channelId || CHANNELS[DEFAULT_CHANNEL].id),
        type: level.type,
        mode,
        direction: level.direction === "down" ? "down" : "up",
        thresholdLabel: level.thresholdLabel,
        points: level.points,
      };
      }),
    [thresholdLevels]
  );

  const computeYDomainForRange = useCallback(
    (rangeX) => {
      const [minX, maxX] = rangeX;
      const selectedFileSet = new Set(
        fileIds.filter((id) => fileVisibility[id] !== false)
      );
      const shouldApplyVisibilityFilter = hideUnselected && !isStdCompareMode;

      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      processedData.forEach((point) => {
        if (point.temperature == null || Number.isNaN(point.temperature)) {
          return;
        }
        if (point.distance < minX || point.distance > maxX) {
          return;
        }
        if (
          shouldApplyVisibilityFilter &&
          point.fileId &&
          !selectedFileSet.has(point.fileId)
        ) {
          return;
        }

        minY = Math.min(minY, point.temperature);
        maxY = Math.max(maxY, point.temperature);
      });

      if (!isDifferentialView) {
        thresholdLevels.forEach((level) => {
          const levelChannelId = String(
            level.channelId || CHANNELS[DEFAULT_CHANNEL].id
          );
        if (
          level.type !== currentTypeParam ||
            levelChannelId !== currentChannelId ||
            (level.rangeMode || DEFAULT_THRESHOLD_RANGE_MODE) !== rangeMode ||
            !Array.isArray(level.points)
        ) {
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
      }

      if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
        return [initialStats.yMin, initialStats.yMax];
      }

      const span = maxY - minY;
      const padding = span > 0 ? span * 0.12 : Math.max(Math.abs(maxY) * 0.08, 1);

      return [Number((minY - padding).toFixed(3)), Number((maxY + padding).toFixed(3))];
    },
    [
      currentChannelId,
      currentTypeParam,
      processedData,
      fileIds,
      fileVisibility,
      hideUnselected,
      initialStats.yMax,
      initialStats.yMin,
      isDifferentialView,
      isStdCompareMode,
      rangeMode,
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
    async (
      type,
      channelKey,
      selectedRangeMode = DEFAULT_RANGE_MODE,
      selectedViewMode = VIEW_MODES.compare,
      selectedReading1 = "",
      selectedReading2 = ""
    ) => {
      const channelInfo = CHANNELS[channelKey] || CHANNELS[DEFAULT_CHANNEL];
      const range = getRangeForChart(type, selectedRangeMode);
      setIsReloading(true);
      setDataError(null);

      try {
        const param = type === "tension" ? "str" : "tem";
        const searchParams = new URLSearchParams({
          type: param,
          min: String(range.xMin),
          max: String(range.xMax),
          ch: channelInfo.id,
          mode: selectedViewMode,
        });

        if (selectedViewMode === VIEW_MODES.manualDiff) {
          if (selectedReading1) {
            searchParams.set("file1", selectedReading1);
          }
          if (selectedReading2) {
            searchParams.set("file2", selectedReading2);
          }
        }

        const response = await fetch(
          `${getApiBase()}/api/ch1-data?${searchParams.toString()}`
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
        const scaleValue = (value) =>
          Number.isFinite(Number(value))
            ? Number((Number(value) / valueDivisor).toFixed(6))
            : value;
        const points =
          valueDivisor === 1
            ? rawPoints
            : rawPoints.map((point) => ({
                ...point,
                temperature:
                  point.temperature == null
                    ? null
                    : scaleValue(point.temperature),
                latestValue: scaleValue(point.latestValue),
                previousValue: scaleValue(point.previousValue),
                differential: scaleValue(point.differential),
              }));
        const latest = payload.latestFile || null;
        const previous = payload.previousFile || null;
        const exportRows = Array.isArray(payload.exportRows)
          ? payload.exportRows.map((row) => ({
              ...row,
              distance: Number(row.distance),
              previousValue: scaleValue(row.previousValue),
              latestValue: scaleValue(row.latestValue),
              differential: scaleValue(row.differential),
            }))
          : [];
        const nextComparisonInfo = {
          mode:
            payload.mode === VIEW_MODES.manualDiff
              ? VIEW_MODES.manualDiff
              : payload.mode === VIEW_MODES.diff2
                ? VIEW_MODES.diff2
                : VIEW_MODES.compare,
          latestFile: latest,
          previousFile: previous,
          selectedFiles: Array.isArray(payload.selectedFiles)
            ? payload.selectedFiles
            : [],
          exportRows,
          differentialReady: Boolean(payload.differentialReady),
          message:
            typeof payload.message === "string" && payload.message.trim()
              ? payload.message.trim()
              : null,
        };
        const nextRange = {
          ...range,
          ...getYBoundsFromPoints(points, range),
        };

        applyChartRange(nextRange);
        setData(points);
        setLatestFileId(latest);
        setComparisonInfo(nextComparisonInfo);
        if (selectedViewMode === VIEW_MODES.manualDiff) {
          setManualReading1((previousValue) =>
            previousValue === (previous || "") ? previousValue : previous || ""
          );
          setManualReading2((previousValue) =>
            previousValue === (latest || "") ? previousValue : latest || ""
          );
        }

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
        setComparisonInfo(EMPTY_COMPARISON_INFO);
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
    void fetchChartData(
      chartType,
      channel,
      rangeMode,
      viewMode,
      manualReading1,
      manualReading2
    );
  }, [
    chartType,
    channel,
    fetchChartData,
    manualReading1,
    manualReading2,
    rangeMode,
    viewMode,
  ]);

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
    setDismissedAlertIds((previous) => {
      if (previous.length === 0) {
        return previous;
      }
      const currentIds = new Set(alerts.map((alert) => alert.id));
      const next = previous.filter((id) => currentIds.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [alerts]);

  useEffect(() => {
    const nextDomain = computeYDomainForRange(xDomain);

    setYDomain((previous) =>
      domainsAreEqual(previous, nextDomain) ? previous : nextDomain
    );
  }, [computeYDomainForRange, xDomain]);

  useEffect(() => {
    let isDisposed = false;

    const loadThresholdsFromServer = async () => {
      try {
        const response = await fetch(`${getApiBase()}/api/thresholds`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }

        const payload = await response.json();
        if (isDisposed) {
          return;
        }

        const serverThresholds = Array.isArray(payload?.thresholds)
          ? payload.thresholds
          : [];
        setThresholdLevels(serverThresholds);

        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            THRESHOLD_CACHE_KEY,
            JSON.stringify(serverThresholds)
          );
        }
      } catch (error) {
        console.error("Error cargando umbrales desde backend", error);
      } finally {
        if (!isDisposed) {
          setThresholdsHydrated(true);
        }
      }
    };

    void loadThresholdsFromServer();

    return () => {
      isDisposed = true;
    };
  }, [getApiBase]);

  useEffect(() => {
    if (!thresholdsHydrated) {
      return;
    }

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
  }, [getApiBase, syncPayload, thresholdsHydrated]);

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
          void fetchChartData(
            chartType,
            channel,
            rangeMode,
            viewMode,
            manualReading1,
            manualReading2
          );
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
    manualReading1,
    manualReading2,
    playAlertTone,
    rangeMode,
    viewMode,
  ]);

  const handleReloadData = () => {
    void fetchChartData(
      chartType,
      channel,
      rangeMode,
      viewMode,
      manualReading1,
      manualReading2
    );
  };

  const handleChartTypeChange = (type) => {
    setChartType(type);
  };

  const handleViewModeChange = (event) => {
    const value = event.target.value;
    if (
      value === VIEW_MODES.compare ||
      value === VIEW_MODES.diff2 ||
      value === VIEW_MODES.manualDiff
    ) {
      setViewMode(value);
    }
  };

  const handleChannelChange = (event) => {
    setChannel(event.target.value);
  };

  const handleRangeModeChange = (event) => {
    const value = event.target.value;
    if (
      value === RANGE_MODES.section1 ||
      value === RANGE_MODES.section2 ||
      value === RANGE_MODES.full
    ) {
      setRangeMode(value);
    }
  };

  const handleNoiseModeChange = (event) => {
    const value = event.target.value;
    if (value === NOISE_MODES.raw || value === NOISE_MODES.std) {
      setNoiseMode(value);
    }
  };

  const handleThresholdModeChange = (value) => {
    if (
      value === THRESHOLD_MODES.percent ||
      value === THRESHOLD_MODES.offset
    ) {
      setThresholdMode(value);
    }
  };

  const handleThresholdDirectionChange = (value) => {
    if (value === "up" || value === "down") {
      setThresholdDirection(value);
    }
  };

  const handleDownloadDifferentialExcel = () => {
    if (
      typeof window === "undefined" ||
      !comparisonInfo.latestFile ||
      !comparisonInfo.previousFile ||
      comparisonInfo.exportRows.length === 0
    ) {
      return;
    }

    const channelLabel = CHANNELS[channel]?.label || CHANNELS[DEFAULT_CHANNEL].label;
    const chartLabel = CHART_TYPES[chartType]?.label || CHART_TYPES.tension.label;
    const isManualMode = comparisonInfo.mode === VIEW_MODES.manualDiff;
    const workbookXml = buildDifferentialWorkbookXml({
      channelLabel,
      chartLabel,
      secondFile: comparisonInfo.latestFile,
      firstFile: comparisonInfo.previousFile,
      secondLabel: isManualMode ? "Lectura 2" : "Ultima lectura",
      firstLabel: isManualMode ? "Lectura 1" : "Penultima lectura",
      rows: comparisonInfo.exportRows,
    });
    const blob = new Blob([workbookXml], {
      type: "application/vnd.ms-excel;charset=utf-8;",
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeType = chartType === "temperatura" ? "temperatura" : "tension";
    const safeChannel = (channelLabel || "canal")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "");
    const safeMode = isManualMode ? "manual" : "ultimas_2";

    link.href = url;
    link.download = `diferencial_${safeMode}_${safeChannel}_${safeType}.xls`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const handleDownloadStdExcel = () => {
    if (
      typeof window === "undefined" ||
      !isStdCompareMode ||
      fileIds.length === 0 ||
      processedData.length === 0
    ) {
      return;
    }

    const channelLabel = CHANNELS[channel]?.label || CHANNELS[DEFAULT_CHANNEL].label;
    const chartLabel = CHART_TYPES[chartType]?.label || CHART_TYPES.tension.label;
    const rows = buildStdExportRows({
      rawPoints: data,
      stdPoints: processedData,
      fileIds,
    });

    if (rows.length === 0) {
      return;
    }

    const workbookXml = buildStdWorkbookXml({
      channelLabel,
      chartLabel,
      fileIds,
      rows,
    });
    const blob = new Blob([workbookXml], {
      type: "application/vnd.ms-excel;charset=utf-8;",
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeType = chartType === "temperatura" ? "temperatura" : "tension";
    const safeChannel = (channelLabel || "canal")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "");

    link.href = url;
    link.download = `desviacion_estandar_${safeChannel}_${safeType}.xls`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const handleDownloadAlertSegments = (alert) => {
    if (
      typeof window === "undefined" ||
      !Array.isArray(alert?.segments) ||
      alert.segments.length === 0
    ) {
      return;
    }

    const lines = [
      [
        "iteracion",
        "canal",
        "tipo",
        "umbral",
        "direccion",
        "valor_umbral",
        "pico_valor",
        "pico_metro",
        "tramo_index",
        "inicio_m",
        "fin_m",
        "longitud_m",
        "pico_tramo",
        "fecha",
      ].join(","),
    ];
    const toCsvNumber = (value, digits = 3) =>
      Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "";

    alert.segments.forEach((segment, index) => {
      const startDistance = Number(segment?.startDistance);
      const endDistance = Number(segment?.endDistance);
      const safeStart = Number.isFinite(startDistance)
        ? Number(startDistance.toFixed(3))
        : "";
      const safeEnd = Number.isFinite(endDistance)
        ? Number(endDistance.toFixed(3))
        : "";
      const lengthMeters =
        Number.isFinite(startDistance) && Number.isFinite(endDistance)
          ? Number(Math.abs(endDistance - startDistance).toFixed(3))
          : "";

      lines.push(
        [
          `"${String(alert.fileId || "").replaceAll('"', '""')}"`,
          alert.channel,
          getAlertTypeLabel(alert.type),
          `"${String(alert.thresholdLabel || "").replaceAll('"', '""')}"`,
          alert.direction === "down" ? "baja" : "alta",
          toCsvNumber(alert.thresholdValue),
          toCsvNumber(alert.measuredValue),
          toCsvNumber(alert.distance),
          index + 1,
          safeStart,
          safeEnd,
          lengthMeters,
          toCsvNumber(segment?.peakValue ?? alert.measuredValue),
          `"${formatPeruDateTime(alert.createdAt)}"`,
        ].join(",")
      );
    });

    const csvContent = lines.join("\n");
    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeType = alert.type === "str" ? "tension" : "temperatura";
    const safeChannel = `canal_${alert.channel || "x"}`;
    const safeName = String(alert.thresholdLabel || "umbral")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "");

    link.href = url;
    link.download = `tramos_${safeChannel}_${safeType}_${safeName || "alarma"}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const handleDismissAlert = useCallback((alertId) => {
    setDismissedAlertIds((previous) => {
      if (previous.includes(alertId)) {
        return previous;
      }
      return [...previous, alertId];
    });
  }, []);

  const handleClearAlertsFromScreen = useCallback(() => {
    setDismissedAlertIds((previous) => {
      const next = new Set(previous);
      alerts.forEach((alert) => {
        if (alert?.id) {
          next.add(alert.id);
        }
      });
      return Array.from(next);
    });
  }, [alerts]);

  const handleManualReading1Change = (event) => {
    setManualReading1(event.target.value);
  };

  const handleManualReading2Change = (event) => {
    setManualReading2(event.target.value);
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

    const selectedMode =
      thresholdMode === THRESHOLD_MODES.offset
        ? THRESHOLD_MODES.offset
        : THRESHOLD_MODES.percent;

    const referencePoints = processedData
      .filter(
        (point) =>
          point.fileId === sourceFileId &&
          point.temperature != null &&
          !Number.isNaN(point.temperature)
      )
      .map((point) => ({
        distance: point.distance,
        thresholdValue:
          selectedMode === THRESHOLD_MODES.offset
            ? getThresholdValueWithOffset(point.temperature, parsed)
            : getThresholdValue(point.temperature, parsed),
      }))
      .filter((point) => Number.isFinite(point.thresholdValue));

    if (referencePoints.length === 0) {
      return;
    }

    const normalizedPercent =
      selectedMode === THRESHOLD_MODES.percent
        ? Number(parsed.toFixed(1))
        : null;
    const normalizedOffset =
      selectedMode === THRESHOLD_MODES.offset ? Number(parsed.toFixed(3)) : null;
    const normalizedName = thresholdName.trim();
    const alreadyExists = thresholdLevels.some(
      (level) =>
        String(level.channelId || CHANNELS[DEFAULT_CHANNEL].id) ===
          currentChannelId &&
        (level.mode || THRESHOLD_MODES.percent) === selectedMode &&
        (level.direction === "down" ? "down" : "up") === thresholdDirection &&
        (selectedMode === THRESHOLD_MODES.percent
          ? Number(level.percent) === normalizedPercent
          : Number(level.offsetValue) === normalizedOffset) &&
        level.sourceFileId === sourceFileId &&
        (level.rangeMode || DEFAULT_THRESHOLD_RANGE_MODE) === rangeMode &&
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
        offsetValue: normalizedOffset,
        mode: selectedMode,
        direction: thresholdDirection,
        floor:
          selectedMode === THRESHOLD_MODES.percent
            ? Number(getThresholdFloor(normalizedPercent).toFixed(2))
            : 0,
        color: thresholdColor,
        sourceFileId,
        sourceFileIndex: activeReferenceIndex,
        rangeMode,
        soundEnabled: thresholdSoundEnabled,
        channelId: currentChannelId,
        type: currentTypeParam,
        thresholdLabel:
          normalizedName ||
          (selectedMode === THRESHOLD_MODES.percent
            ? `Umbral al ${normalizedPercent.toFixed(1)}%`
            : `Umbral +${normalizedOffset.toFixed(3)}`),
        points: referencePoints,
      },
    ]);

    setThresholdName("");
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
          <span className="text-sm text-slate-600">Vista:</span>
          <select
            value={viewMode}
            onChange={handleViewModeChange}
            className="text-sm border border-slate-200 rounded-md px-3 py-2 bg-white shadow-sm min-w-[240px]"
          >
            <option value={VIEW_MODES.compare}>Comparar lecturas</option>
            <option value={VIEW_MODES.diff2}>
              Diferencial 2 ultimas lecturas
            </option>
            <option value={VIEW_MODES.manualDiff}>
              Diferencial manual entre lecturas
            </option>
          </select>
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
            <option value={RANGE_MODES.full}>Vista completa</option>
            <option value={RANGE_MODES.section1}>Tramo 1</option>
            <option value={RANGE_MODES.section2}>Tramo 2</option>
          </select>
        </div>
        {isDifferentialView && (
          <label className="flex items-center gap-2 text-xs text-slate-600 whitespace-nowrap">
            <input
              type="checkbox"
              className="accent-blue-600"
              checked={diffNoiseEnabled}
              onChange={(event) => setDiffNoiseEnabled(event.target.checked)}
            />
            Aplicar DE en diferencial
          </label>
        )}
        {!isDifferentialView && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">Filtro:</span>
            <select
              value={noiseMode}
              onChange={handleNoiseModeChange}
              className="text-sm border border-slate-200 rounded-md px-3 py-2 bg-white shadow-sm"
            >
              <option value={NOISE_MODES.raw}>Original</option>
              <option value={NOISE_MODES.std}>Desviacion estandar (N)</option>
            </select>
          </div>
        )}

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
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 min-h-[180px]">
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
                  onClick={handleClearAlertsFromScreen}
                  className="text-xs text-slate-400 hover:text-slate-700"
                >
                  Cerrar
                </button>
              </div>

              <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                {visibleAlerts.length === 0 ? (
                  <div className="text-xs text-slate-400 italic">
                    Sin alertas visibles por ahora
                  </div>
                ) : (
                  visibleAlerts.slice(0, 6).map((alert) => (
                    <div
                      key={alert.id}
                      className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold text-red-700">
                          {alert.thresholdLabel}
                        </div>
                        <button
                          onClick={() => handleDismissAlert(alert.id)}
                          className="text-red-400 hover:text-red-700 leading-none px-1"
                          title="Quitar alerta de pantalla"
                        >
                          X
                        </button>
                      </div>
                      <div className="text-slate-500">
                        Canal {alert.channel} | {getAlertTypeLabel(alert.type)} |{" "}
                        {formatAlertTime(alert.createdAt)}
                      </div>
                      <div className="text-slate-700">
                        Pico detectado:{" "}
                        <span className="font-semibold">
                          {Number(alert.measuredValue).toFixed(2)}
                        </span>{" "}
                        | Umbral:{" "}
                        <span className="font-semibold">
                          {alert.direction === "down" ? "<" : ">"}{" "}
                          {Number(alert.thresholdValue).toFixed(2)}
                        </span>
                      </div>
                      <div className="text-slate-700">
                        Ubicacion del pico:{" "}
                        <span className="font-semibold">
                          {Number(alert.distance).toFixed(2)} m
                        </span>
                      </div>
                      {Array.isArray(alert.segments) && alert.segments.length > 0 && (
                        <>
                          <div className="text-slate-600 mt-1">
                            Tramos detectados:{" "}
                            <span className="font-semibold">
                              {alert.segmentCount || alert.segments.length}
                            </span>
                          </div>
                          <div className="text-slate-600">
                            Vista rapida:{" "}
                            {alert.segments
                              .slice(0, 3)
                              .map(
                                (segment) =>
                                  `${Number(segment.startDistance).toFixed(2)}-${Number(
                                    segment.endDistance
                                  ).toFixed(2)} m`
                              )
                              .join(" | ")}
                            {alert.segments.length > 3 ? " | ..." : ""}
                          </div>
                          <button
                            onClick={() => handleDownloadAlertSegments(alert)}
                            className="mt-2 px-2 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                          >
                            Descargar tramos CSV
                          </button>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {soundPanelOpen ? (
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
                <div className="text-sm font-semibold text-slate-800">
                  Sonido de Alertas
                </div>
                <div className="text-xs text-slate-500">
                  Umbrales con sonido: {soundThresholdCount}
                </div>
                <div className="flex items-center justify-between mb-3">
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

          {viewMode === VIEW_MODES.diff2 && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-slate-800">
                    Diferencial entre las 2 ultimas lecturas
                  </div>
                  <div className="text-xs text-slate-500">
                    Archivo mas reciente:{" "}
                    <span className="font-medium text-slate-700">
                      {comparisonInfo.latestFile || "--"}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500">
                    Archivo penultimo:{" "}
                    <span className="font-medium text-slate-700">
                      {comparisonInfo.previousFile || "--"}
                    </span>
                  </div>
                  {comparisonInfo.message && (
                    <div className="text-xs text-amber-600">
                      {comparisonInfo.message}
                    </div>
                  )}
                </div>

                <button
                  onClick={handleDownloadDifferentialExcel}
                  disabled={comparisonInfo.exportRows.length === 0}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    comparisonInfo.exportRows.length > 0
                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                  }`}
                >
                  Descargar Excel
                </button>
              </div>
            </div>
          )}

          {isManualDifferentialView && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-4 space-y-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Lectura 1
                    </label>
                    <select
                      value={manualReading1}
                      onChange={handleManualReading1Change}
                      className="w-full text-sm border border-slate-200 rounded-md px-3 py-2 bg-white shadow-sm"
                    >
                      <option value="">Selecciona lectura 1</option>
                      {comparisonInfo.selectedFiles.map((fileId) => (
                        <option key={`manual-1-${fileId}`} value={fileId}>
                          {fileId}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Lectura 2
                    </label>
                    <select
                      value={manualReading2}
                      onChange={handleManualReading2Change}
                      className="w-full text-sm border border-slate-200 rounded-md px-3 py-2 bg-white shadow-sm"
                    >
                      <option value="">Selecciona lectura 2</option>
                      {comparisonInfo.selectedFiles.map((fileId) => (
                        <option key={`manual-2-${fileId}`} value={fileId}>
                          {fileId}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  onClick={handleDownloadDifferentialExcel}
                  disabled={comparisonInfo.exportRows.length === 0}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    comparisonInfo.exportRows.length > 0
                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                  }`}
                >
                  Descargar Excel
                </button>
              </div>

              <div className="space-y-1 text-xs text-slate-500">
                <div>
                  Resultado mostrado: <span className="font-medium">Lectura 2 - Lectura 1</span>
                </div>
                <div>
                  Lectura 1:{" "}
                  <span className="font-medium text-slate-700">
                    {comparisonInfo.previousFile || manualReading1 || "--"}
                  </span>
                </div>
                <div>
                  Lectura 2:{" "}
                  <span className="font-medium text-slate-700">
                    {comparisonInfo.latestFile || manualReading2 || "--"}
                  </span>
                </div>
                {comparisonInfo.message && (
                  <div className="text-amber-600">{comparisonInfo.message}</div>
                )}
              </div>
            </div>
          )}

          {!isDifferentialView && !isStdCompareMode && fileIds.length > 0 && (
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
          {!isDifferentialView && isStdCompareMode && fileIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-xs text-slate-600">
                Modo DE activo: sigma calculada con todas las lecturas (N ={" "}
                <span className="font-semibold text-slate-700">{fileIds.length}</span>
                ).
              </div>
              <button
                onClick={handleDownloadStdExcel}
                disabled={processedData.length === 0}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  processedData.length > 0
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-slate-100 text-slate-400 cursor-not-allowed"
                }`}
              >
                Descargar Excel DE
              </button>
            </div>
          )}

          <LimitsChart
            hasData={data.length > 0}
            visibleData={chartData}
            lineColor={CHANNELS[channel]?.color || CHANNELS[DEFAULT_CHANNEL].color}
            chartType={chartType}
            viewMode={viewMode}
            noiseMode={noiseMode}
            diffNoiseEnabled={diffNoiseEnabled}
            latestFileId={latestFileId}
            fileIds={fileIds}
            fileVisibility={fileVisibility}
            hideUnselected={hideUnselected}
            thresholdSeries={visibleThresholdSeries}
            activeReferenceFileId={activeReferenceFileId}
            activeReferenceIndex={activeReferenceIndex}
            comparisonInfo={comparisonInfo}
            rangeMode={rangeMode}
            zoomSelection={zoomSelection}
            xDomain={xDomain}
            yDomain={yDomain}
            chartContainerRef={chartContainerRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          />
        </div>

        {!isDifferentialView && (
          <ControlPanel
            thresholdMode={thresholdMode}
            onThresholdModeChange={handleThresholdModeChange}
            thresholdDirection={thresholdDirection}
            onThresholdDirectionChange={handleThresholdDirectionChange}
            thresholdName={thresholdName}
            onThresholdNameChange={setThresholdName}
            thresholdInput={thresholdInput}
            onThresholdInputChange={setThresholdInput}
            thresholdColor={thresholdColor}
            onThresholdColorChange={setThresholdColor}
            thresholdSoundEnabled={thresholdSoundEnabled}
            onThresholdSoundEnabledChange={setThresholdSoundEnabled}
            onThresholdInputKeyDown={handleThresholdInputKeyDown}
            onAddThreshold={handleAddThreshold}
            thresholdLevels={activeThresholdLevels}
            onRemoveThreshold={handleRemoveThreshold}
          />
        )}
      </div>
    </div>
  );
};

export default LimitsView;
