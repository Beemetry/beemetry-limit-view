// src/components/chart/LimitsChart.jsx
import React from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import { Upload } from "lucide-react";
import {
  CHART_MARGINS,
  Y_AXIS_WIDTH,
  X_AXIS_HEIGHT,
} from "../../config/chartConfig";

const RETURN_REFERENCE_DISTANCE = 1620;

const LimitsChart = ({
  data,
  visibleData,
  lineColor = "#3b82f6",
  chartType,
  latestFileId,
  fileIds = [],
  fileVisibility = {},
  hideUnselected = false,
  mode,
  drawingState,
  xDomain,
  yDomain,
  initialStats,
  chartContainerRef,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  limits,
  editingId,
}) => {
  const hasData = data.length > 0;
  const isTemperatureChart = chartType === "temperatura";
  const yLabel = isTemperatureChart ? "Temperatura C°" : "Tension (uE)";

  const groupedByFile = React.useMemo(() => {
    const map = {};
    (visibleData || []).forEach((d) => {
      const fid = d.fileId || "default";
      if (!map[fid]) map[fid] = [];
      map[fid].push(d);
    });
    return map;
  }, [visibleData]);

  const visibleOrder = React.useMemo(
    () => fileIds.filter((id) => fileVisibility[id] !== false),
    [fileIds, fileVisibility]
  );

  // Ultimo archivo visible (mas reciente dentro de los seleccionados)
  const activeTooltipFileId =
    visibleOrder.length > 0
      ? visibleOrder[visibleOrder.length - 1]
      : latestFileId || null;

  const activeIndexLabel = React.useMemo(() => {
    const idx = fileIds.findIndex((id) => id === activeTooltipFileId);
    return idx >= 0 ? idx + 1 : null;
  }, [activeTooltipFileId, fileIds]);

  const renderTooltip = React.useCallback(
    ({ active, payload, label }) => {
      if (!active || !payload || payload.length === 0) return null;

      const preferred = payload.find(
        (item) => item.payload?.fileId === activeTooltipFileId
      );
      const selected = preferred || payload[0];
      if (!selected) return null;

      const point = selected.payload || {};
      const xValue = Number.isFinite(point.distance)
        ? point.distance
        : Number(label);
      const inverseDistance =
        isTemperatureChart && Number.isFinite(xValue)
          ? RETURN_REFERENCE_DISTANCE - xValue
          : null;

      return (
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-md text-xs space-y-1">
          <div className="font-semibold text-slate-700">
            Archivo #{activeIndexLabel ?? "N/A"}
          </div>
          <div className="text-slate-600">
            X: {Number.isFinite(xValue) ? xValue.toFixed(2) : label}
          </div>
          {inverseDistance != null && (
            <div className="text-slate-600">
              Distancia aprox: {inverseDistance.toFixed(2)} m
            </div>
          )}
          <div className="text-slate-800">Valor: {selected.value}</div>
        </div>
      );
    },
    [activeTooltipFileId, activeIndexLabel, isTemperatureChart]
  );

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 h-full p-4 relative select-none flex flex-col">
      {!hasData ? (
        <div className="flex flex-col items-center justify-center text-slate-400 h-full">
          <Upload size={48} className="mb-4 opacity-50" />
          <p className="text-lg font-medium">No hay datos cargados</p>
          <p className="text-sm">Sube uno o varios archivos .txt para visualizar</p>
        </div>
      ) : (
        <>
          <h2 className="text-sm font-semibold text-slate-400 mb-2 uppercase tracking-wide flex justify-between absolute top-4 left-4 right-4 z-10 pointer-events-none">
            <span>
              Vista: {xDomain[0].toFixed(0)}m - {xDomain[1].toFixed(0)}m
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded shadow-sm ${
                mode === "draw"
                  ? "bg-red-100 text-red-600"
                  : "bg-blue-100 text-blue-600"
              }`}
            >
              {mode === "draw" ? "MODO DIBUJO" : "MODO ZOOM"}
            </span>
          </h2>

          <div
            ref={chartContainerRef}
            className={`w-full h-[520px] md:h-[600px] pt-6 ${
              mode === "draw" ? "cursor-crosshair" : "cursor-zoom-in"
            }`}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={visibleData} margin={CHART_MARGINS}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="distance"
                  type="number"
                  domain={xDomain}
                  allowDataOverflow={true}
                  height={X_AXIS_HEIGHT}
                  tickFormatter={(val) => val.toFixed(0)}
                  label={{
                    value: "Distancia (m)",
                    position: "insideBottomRight",
                    offset: -5,
                  }}
                />
                {isTemperatureChart && (
                  <XAxis
                    xAxisId="inverseTop"
                    dataKey="distance"
                    type="number"
                    orientation="top"
                    domain={xDomain}
                    allowDataOverflow={true}
                    height={24}
                    tickFormatter={(val) =>
                      (RETURN_REFERENCE_DISTANCE - val).toFixed(0)
                    }
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    axisLine={{ stroke: "#cbd5e1" }}
                    tickLine={{ stroke: "#cbd5e1" }}
                  />
                )}
                <YAxis
                  domain={yDomain}
                  allowDataOverflow={true}
                  width={Y_AXIS_WIDTH}
                  label={{
                    value: yLabel,
                    angle: -90,
                    position: "insideLeft",
                  }}
                />
                <RTooltip content={renderTooltip} />

                {Object.entries(groupedByFile).map(([fid, series]) => {
                  const isVisible = fileVisibility[fid] !== false;
                  if (hideUnselected && !isVisible) {
                    return null;
                  }

                  const isActive = activeTooltipFileId && fid === activeTooltipFileId;
                  const stroke = isActive ? "#ef4444" : lineColor;
                  const strokeOpacity = isVisible ? 1 : 0.25;
                  const showActiveDot =
                    activeTooltipFileId === fid || activeTooltipFileId == null;

                  return (
                    <Line
                      key={fid}
                      type="linear"
                      data={series}
                      dataKey="temperature"
                      stroke={stroke}
                      strokeWidth={isActive ? 2.5 : 2}
                      strokeOpacity={strokeOpacity}
                      dot={false}
                      activeDot={
                        showActiveDot
                          ? {
                              r: isActive ? 6 : 5,
                              strokeWidth: 1.5,
                              fill: "#ffffff",
                              stroke,
                            }
                          : false
                      }
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                  );
                })}

                {limits.map((limit) => (
                  <ReferenceLine
                    key={limit.id}
                    segment={[
                      { x: limit.start, y: limit.threshold },
                      { x: limit.end, y: limit.threshold },
                    ]}
                    stroke={editingId === limit.id ? "#3b82f6" : "#ef4444"}
                    strokeWidth={editingId === limit.id ? 3 : 2}
                    strokeDasharray="5 5"
                    label={{
                      value: `${limit.customId}`,
                      position: "top",
                      fill: "#ef4444",
                      fontSize: 10,
                    }}
                  />
                ))}

                {drawingState.isDrawing && (
                  <>
                    {mode === "draw" && (
                      <ReferenceLine
                        segment={[
                          {
                            x: drawingState.startX,
                            y: drawingState.startY,
                          },
                          {
                            x: drawingState.endX,
                            y: drawingState.startY,
                          },
                        ]}
                        stroke="#f59e0b"
                        strokeWidth={2}
                        strokeDasharray="3 3"
                      />
                    )}

                    <ReferenceArea
                      x1={Math.min(drawingState.startX, drawingState.endX)}
                      x2={Math.max(drawingState.startX, drawingState.endX)}
                      y1={
                        mode === "zoom"
                          ? Math.min(drawingState.startY, drawingState.endY)
                          : initialStats.yMin
                      }
                      y2={
                        mode === "zoom"
                          ? Math.max(drawingState.startY, drawingState.endY)
                          : drawingState.startY
                      }
                      fill={mode === "zoom" ? "#3b82f6" : "#f59e0b"}
                      fillOpacity={0.2}
                    />
                  </>
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
};

export default React.memo(LimitsChart);
