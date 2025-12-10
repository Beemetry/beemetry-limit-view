// src/views/LimitsView.jsx
import React, {
  useState,
  useRef,
  useMemo,
  useCallback,
} from "react";
import {
  CHART_MARGINS,
  Y_AXIS_WIDTH,
  X_AXIS_HEIGHT,
  Y_POINTER_OFFSET,
} from "../config/chartConfig";
import HeaderBar from "../components/layout/HeaderBar";
import LimitsChart from "../components/chart/LimitsChart";
import ControlPanel from "../components/panel/ControlPanel";

const FIXED_X_MIN = 0;
const FIXED_X_MAX = 1620;
const FIXED_Y_MIN = -600;
const FIXED_Y_MAX = 600;

// === Helpers de decimación (LTTB) para performance ===

// Algoritmo Largest-Triangle-Three-Buckets sobre un segmento sin nulls
const lttbSegment = (segment, threshold) => {
  const dataLength = segment.length;
  if (threshold >= dataLength || threshold <= 0) {
    return segment;
  }

  const sampled = [];
  let sampledIndex = 0;

  const every = (dataLength - 2) / (threshold - 2);

  let a = 0; // primer punto
  let maxArea;
  let maxAreaPoint;
  let nextA;

  sampled[sampledIndex++] = segment[a];

  for (let i = 0; i < threshold - 2; i++) {
    // promedio del siguiente bucket
    let avgX = 0;
    let avgY = 0;
    let avgRangeStart = Math.floor((i + 1) * every) + 1;
    let avgRangeEnd = Math.floor((i + 2) * every) + 1;
    avgRangeEnd = avgRangeEnd < dataLength ? avgRangeEnd : dataLength;

    const avgRangeLength = avgRangeEnd - avgRangeStart || 1;
    for (let idx = avgRangeStart; idx < avgRangeEnd; idx++) {
      avgX += segment[idx].distance;
      avgY += segment[idx].temperature;
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    // rango del bucket actual
    let rangeOffs = Math.floor(i * every) + 1;
    let rangeTo = Math.floor((i + 1) * every) + 1;
    rangeTo = rangeTo < dataLength ? rangeTo : dataLength - 1;

    const pointAx = segment[a].distance;
    const pointAy = segment[a].temperature;

    maxArea = -1;

    for (let idx = rangeOffs; idx <= rangeTo; idx++) {
      const pointBx = segment[idx].distance;
      const pointBy = segment[idx].temperature;

      const area = Math.abs(
        (pointAx - avgX) * (pointBy - pointAy) -
          (pointAx - pointBx) * (avgY - pointAy)
      ) * 0.5;

      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = segment[idx];
        nextA = idx;
      }
    }

    sampled[sampledIndex++] = maxAreaPoint;
    a = nextA;
  }

  sampled[sampledIndex++] = segment[dataLength - 1];

  return sampled;
};

// Decimación por segmentos respetando los puntos "gap" (temperature === null)
const decimateVisibleData = (data, maxPoints) => {
  if (!data || data.length === 0) return data;

  // total de puntos válidos (no null)
  const nonNullTotal = data.reduce(
    (acc, d) => (d.temperature != null ? acc + 1 : acc),
    0
  );
  if (nonNullTotal <= maxPoints) return data;

  const segments = [];
  let currentSegment = [];

  // separa en segmentos contiguos sin nulls y puntos de gap
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    if (d.temperature == null || Number.isNaN(d.temperature)) {
      if (currentSegment.length > 0) {
        segments.push({ type: "line", points: currentSegment });
        currentSegment = [];
      }
      // mantenemos el punto null como gap explícito
      segments.push({ type: "gap", points: [d] });
    } else {
      currentSegment.push(d);
    }
  }
  if (currentSegment.length > 0) {
    segments.push({ type: "line", points: currentSegment });
  }

  const result = [];

  // aplica LTTB por segmento proporcional al tamaño
  segments.forEach((seg) => {
    if (seg.type === "gap") {
      // gaps se conservan tal cual para no unir archivos
      result.push(...seg.points);
      return;
    }

    const segLen = seg.points.length;
    if (segLen <= 3) {
      result.push(...seg.points);
      return;
    }

    const segThreshold = Math.max(
      3,
      Math.round((segLen / nonNullTotal) * maxPoints)
    );

    if (segLen <= segThreshold) {
      result.push(...seg.points);
    } else {
      const decimated = lttbSegment(seg.points, segThreshold);
      result.push(...decimated);
    }
  });

  return result;
};

const LimitsView = () => {
  // --- Estados principales ---
  const [data, setData] = useState([]);
  const [limits, setLimits] = useState([]);

  const [nextId, setNextId] = useState(100);

  const [initialStats, setInitialStats] = useState({
    xMin: FIXED_X_MIN,
    xMax: FIXED_X_MAX,
    yMin: FIXED_Y_MIN,
    yMax: FIXED_Y_MAX,
  });

  const [xDomain, setXDomain] = useState([FIXED_X_MIN, FIXED_X_MAX]);
  const [yDomain, setYDomain] = useState([FIXED_Y_MIN, FIXED_Y_MAX]);

  const [mode, setMode] = useState("zoom"); // 'zoom' | 'draw'
  const [editingId, setEditingId] = useState(null);

  const [drawingState, setDrawingState] = useState({
    isDrawing: false,
    startX: null,
    startY: null,
    endX: null,
    endY: null,
  });

  const [currentLimitForm, setCurrentLimitForm] = useState({
    start: 0,
    end: 0,
    threshold: 0,
    tolerance: 5,
    type: 3,
  });

  const chartContainerRef = useRef(null);
  const rafRef = useRef(null);
  const chartRectRef = useRef(null);
  const lastDrawCoordsRef = useRef(null);

  // --- OPTIMIZACIÓN DE DATOS (WINDOWING) ---
    // --- OPTIMIZACIÓN DE DATOS (WINDOWING) ---
  const visibleData = useMemo(() => {
    if (data.length === 0) return [];

    const currentXMin = xDomain[0];
    const currentXMax = xDomain[1];
    const range = currentXMax - currentXMin || 1;

    // Buffer más pequeño para no incluir TODO el dataset
    const buffer = Math.min(range * 0.1, 100); // 10% o máx 100 m

    const minVisible = currentXMin - buffer;
    const maxVisible = currentXMax + buffer;

    return data.filter(
      (d) =>
        ((d.distance >= minVisible && d.distance <= maxVisible) ||
          d.temperature === null)
    );
  }, [data, xDomain]);

  const MAX_CHART_POINTS = 8000; // ajustable

  const chartData = useMemo(() => {
    if (!visibleData || visibleData.length === 0) return [];
    return decimateVisibleData(visibleData, MAX_CHART_POINTS);
  }, [visibleData]);


  // --- Carga de archivos de datos ---
  const handleFileUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const readFile = (file) => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = e.target.result;
          const lines = text.trim().split("\n");
          const parsed = [];
          for (let i = 0; i < lines.length; i++) {
            const parts = lines[i].trim().split(",");
            if (parts.length >= 2) {
              const xVal = parseFloat(parts[0]);
              const yVal = parseFloat(parts[1]);
              if (!isNaN(xVal) && !isNaN(yVal)) {
                parsed.push({ distance: xVal, temperature: yVal });
              }
            }
          }
          parsed.sort((a, b) => a.distance - b.distance);
          resolve(parsed);
        };
        reader.readAsText(file);
      });
    };

    try {
      const allFilesData = await Promise.all(files.map(readFile));
      let combinedData = [];
      allFilesData.forEach((fileData, index) => {
        if (fileData.length > 0) {
          combinedData = combinedData.concat(fileData);
          if (index < allFilesData.length - 1) {
            const lastPoint = fileData[fileData.length - 1];
            combinedData.push({
              distance: lastPoint.distance,
              temperature: null,
            });
          }
        }
      });

      if (combinedData.length > 0) {
        setInitialStats({
          xMin: FIXED_X_MIN,
          xMax: FIXED_X_MAX,
          yMin: FIXED_Y_MIN,
          yMax: FIXED_Y_MAX,
        });
        setXDomain([FIXED_X_MIN, FIXED_X_MAX]);
        setYDomain([FIXED_Y_MIN, FIXED_Y_MAX]);
        setData(combinedData);
      }
    } catch (error) {
      console.error("Error:", error);
      alert("Error al procesar archivos.");
    }

    event.target.value = "";
  };

  // --- Carga de archivos de límites ---
  const handleLimitsUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const thresholdRegex = /<threshold>([\s\S]*?)<\/threshold>/g;
      const matches = [...text.matchAll(thresholdRegex)];

      const newLimits = [];
      let maxIdFound = 0;

      for (const match of matches) {
        const content = match[1];
        const getTagValue = (tag) => {
          const regex = new RegExp(`<${tag}>(.*?)<\/${tag}>`);
          const result = content.match(regex);
          return result ? result[1] : null;
        };

        const idStr = getTagValue("id");
        const startStr = getTagValue("pos_start");
        const endStr = getTagValue("pos_stop");
        const valStr = getTagValue("value");
        const tolStr = getTagValue("tolerance");
        const typeStr = getTagValue("type");

        if (idStr && startStr && endStr && valStr) {
          const customId = parseInt(idStr, 10);
          if (customId > maxIdFound) maxIdFound = customId;

          newLimits.push({
            id: Date.now() + Math.random(),
            customId,
            start: parseFloat(startStr),
            end: parseFloat(endStr),
            threshold: parseFloat(valStr),
            tolerance: tolStr ? parseInt(tolStr, 10) : 5,
            type: typeStr ? parseInt(typeStr, 10) : 3,
          });
        }
      }

      if (newLimits.length > 0) {
        setLimits(newLimits);
        if (maxIdFound >= nextId) setNextId(maxIdFound + 1);
      } else {
        alert("No se encontraron límites válidos.");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  // --- Coordenadas del gráfico ---
  const getChartCoordinates = useCallback(
    (e) => {
      const rect =
        chartRectRef.current ||
        (chartContainerRef.current &&
          chartContainerRef.current.getBoundingClientRect());

      if (!rect) return null;

      const gridLeft = CHART_MARGINS.left + Y_AXIS_WIDTH;
      const gridTop = CHART_MARGINS.top;
      const gridWidth =
        rect.width - CHART_MARGINS.left - CHART_MARGINS.right - Y_AXIS_WIDTH;
      const gridHeight =
        rect.height -
        CHART_MARGINS.top -
        CHART_MARGINS.bottom -
        X_AXIS_HEIGHT;

      const xPixel = e.clientX - rect.left - gridLeft;
      const yPixel = e.clientY - rect.top - gridTop - Y_POINTER_OFFSET;

      const [currentXMin, currentXMax] = xDomain;
      const [currentYMin, currentYMax] = yDomain;

      let xValue =
        currentXMin + (xPixel / gridWidth) * (currentXMax - currentXMin);
      let yValue =
        currentYMax - (yPixel / gridHeight) * (currentYMax - currentYMin);

      xValue = Math.max(currentXMin, Math.min(currentXMax, xValue));
      yValue = Math.max(currentYMin, Math.min(currentYMax, yValue));

      // Menos precisión = menos updates distintos
      const xRounded = Math.round(xValue); // 1 m
      const yRounded = Math.round(yValue * 10) / 10; // 0.1 uE

      return {
        x: xRounded,
        y: yRounded,
      };
    },
    [xDomain, yDomain]
  );

  // --- Mouse handlers ---
  const handleMouseDown = (e) => {
    e.preventDefault();

    if (chartContainerRef.current) {
      chartRectRef.current =
        chartContainerRef.current.getBoundingClientRect();
    }

    const coords = getChartCoordinates(e);
    if (!coords) return;

    lastDrawCoordsRef.current = coords;

    setDrawingState({
      isDrawing: true,
      startX: coords.x,
      startY: coords.y,
      endX: coords.x,
      endY: coords.y,
    });
  };


  const handleMouseMove = (e) => {
    if (!drawingState.isDrawing) return;
    if (rafRef.current) return;

    rafRef.current = requestAnimationFrame(() => {
      const coords = getChartCoordinates(e);
      if (coords) {
        const last = lastDrawCoordsRef.current;
        const dx = last ? Math.abs(coords.x - last.x) : Infinity;
        const dy = last ? Math.abs(coords.y - last.y) : Infinity;

        // 👇 Umbrales mínimos de movimiento para disparar re-render
        const MIN_DX = 0.5; // metros
        const MIN_DY = 0.5; // unidades de valor

        if (dx >= MIN_DX || dy >= MIN_DY) {
          lastDrawCoordsRef.current = coords;

          setDrawingState((prev) => ({
            ...prev,
            endX: coords.x,
            endY: mode === "draw" ? prev.startY : coords.y,
          }));
        }
      }
      rafRef.current = null;
    });
  };

    const handleMouseUp = () => {
    if (!drawingState.isDrawing) return;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    // 👇 limpiar cache
    chartRectRef.current = null;
    lastDrawCoordsRef.current = null;

    const { startX, endX, startY, endY } = drawingState;

    if (mode === "zoom") {
      const xDiff = Math.abs(endX - startX);
      const yDiff = Math.abs(endY - startY);

      if (
        xDiff > (initialStats.xMax - initialStats.xMin) * 0.005 ||
        yDiff > (initialStats.yMax - initialStats.yMin) * 0.005
      ) {
        const x1 = Math.min(startX, endX);
        const x2 = Math.max(startX, endX);
        const y1 = Math.min(startY, endY);
        const y2 = Math.max(startY, endY);

        setXDomain([x1, x2]);
        setYDomain([y1, y2]);
      }
      setDrawingState((prev) => ({ ...prev, isDrawing: false }));
      return;
    }

    if (mode === "draw") {
      const xMin = Math.min(startX, endX);
      const xMax = Math.max(startX, endX);
      const threshold = startY;

      setDrawingState((prev) => ({ ...prev, isDrawing: false }));

      if (Math.abs(xMax - xMin) > 0) {
        setCurrentLimitForm((prev) => ({
          ...prev,
          start: xMin,
          end: xMax,
          threshold: threshold,
        }));
        setEditingId(null);
      }
    }
  };

  const resetZoom = () => {
    setXDomain([initialStats.xMin, initialStats.xMax]);
    setYDomain([initialStats.yMin, initialStats.yMax]);
  };

  // --- Límites ---
  const handleSaveOrUpdateLimit = () => {
    if (editingId) {
      setLimits((prev) =>
        prev.map((l) =>
          l.id === editingId ? { ...l, ...currentLimitForm } : l
        )
      );
      setEditingId(null);
    } else {
      const newLimit = {
        id: Date.now(),
        customId: nextId,
        ...currentLimitForm,
      };
      setLimits((prev) => [...prev, newLimit]);
      setNextId((prev) => prev + 1);
    }

    setDrawingState({
      isDrawing: false,
      startX: null,
      startY: null,
      endX: null,
      endY: null,
    });
    setCurrentLimitForm({
      start: 0,
      end: 0,
      threshold: 0,
      tolerance: 5,
      type: 3,
    });
  };

  const handleEditLimit = (limit) => {
    setCurrentLimitForm({
      start: limit.start,
      end: limit.end,
      threshold: limit.threshold,
      tolerance: limit.tolerance,
      type: limit.type,
    });
    setEditingId(limit.id);
  };

  const handleDeleteLimit = (id) => {
    setLimits((prev) => prev.filter((l) => l.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setCurrentLimitForm({
        start: 0,
        end: 0,
        threshold: 0,
        tolerance: 5,
        type: 3,
      });
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setCurrentLimitForm({
      start: 0,
      end: 0,
      threshold: 0,
      tolerance: 5,
      type: 3,
    });
  };

  const handleExportLimits = () => {
    const content = limits
      .map(
        (l) => `<threshold>
<id>${l.customId}</id>
<type>${l.type}</type>
<refd>true</refd>
<pos_start>${l.start.toFixed(2)}</pos_start>
<pos_stop>${l.end.toFixed(2)}</pos_stop>
<value>${l.threshold.toFixed(2)}</value>
<tolerance>${l.tolerance}</tolerance>
</threshold>`
      )
      .join("\n\n");

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "limites_activos.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-800 font-sans overflow-hidden">
      <HeaderBar
        xDomain={xDomain}
        yDomain={yDomain}
        initialStats={initialStats}
        mode={mode}
        onModeChange={setMode}
        hasData={data.length > 0}
        onResetZoom={resetZoom}
        onDataFilesChange={handleFileUpload}
        onLimitsFileChange={handleLimitsUpload}
        canLoadLimits={data.length > 0}
      />

      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Gráfico */}
        <div className="flex-1 p-4 relative min-h-0 bg-slate-100">
          <LimitsChart
            data={data}
            visibleData={chartData}
            mode={mode}
            drawingState={drawingState}
            xDomain={xDomain}
            yDomain={yDomain}
            initialStats={initialStats}
            chartContainerRef={chartContainerRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            limits={limits}
            editingId={editingId}
          />
        </div>

        {/* Panel de control */}
        <ControlPanel
          nextId={nextId}
          setNextId={setNextId}
          drawingState={drawingState}
          mode={mode}
          currentLimitForm={currentLimitForm}
          setCurrentLimitForm={setCurrentLimitForm}
          editingId={editingId}
          onCancelEdit={handleCancelEdit}
          onSaveOrUpdateLimit={handleSaveOrUpdateLimit}
          limits={limits}
          onEditLimit={handleEditLimit}
          onDeleteLimit={handleDeleteLimit}
          onExportLimits={handleExportLimits}
        />
      </div>
    </div>
  );
};

export default LimitsView;