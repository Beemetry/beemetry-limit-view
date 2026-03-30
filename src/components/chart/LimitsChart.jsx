import React from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
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
  hasData,
  visibleData,
  lineColor = "#3b82f6",
  chartType,
  viewMode,
  latestFileId,
  fileIds = [],
  fileVisibility = {},
  hideUnselected = false,
  thresholdSeries = [],
  activeReferenceFileId,
  activeReferenceIndex,
  comparisonInfo,
  zoomSelection,
  xDomain,
  yDomain,
  chartContainerRef,
  onMouseDown,
  onMouseMove,
  onMouseUp,
}) => {
  const isTemperatureChart = chartType === "temperatura";
  const isDifferentialView = viewMode === "diff2";
  const isManualDifferentialView = viewMode === "manual_diff";
  const isAnyDifferentialView = isDifferentialView || isManualDifferentialView;
  const yLabel = isDifferentialView
    ? isTemperatureChart
      ? "Diferencial Temperatura (C)"
      : "Diferencial Tension (uE)"
    : isManualDifferentialView
      ? isTemperatureChart
        ? "Diferencial Manual Temperatura (C)"
        : "Diferencial Manual Tension (uE)"
      : isTemperatureChart
      ? "Temperatura (C)"
      : "Tension (uE)";

  const groupedByFile = React.useMemo(() => {
    const map = {};
    (visibleData || []).forEach((point) => {
      const fid = point.fileId || "default";
      if (!map[fid]) {
        map[fid] = [];
      }
      map[fid].push(point);
    });
    return map;
  }, [visibleData]);

  const visibleOrder = React.useMemo(
    () => fileIds.filter((id) => fileVisibility[id] !== false),
    [fileIds, fileVisibility]
  );

  const tooltipFileId =
    activeReferenceFileId ||
    (visibleOrder.length > 0
      ? visibleOrder[visibleOrder.length - 1]
      : latestFileId || null);

  const renderTooltip = React.useCallback(
    ({ active, payload, label }) => {
      if (!active || !payload || payload.length === 0) {
        return null;
      }

      const actualPayload = payload.filter((item) => item.dataKey === "temperature");
      const thresholdPayload = payload.filter(
        (item) => item.dataKey === "thresholdValue"
      );
      const preferred = actualPayload.find(
        (item) => item.payload?.fileId === tooltipFileId
      );
      const selected = preferred || actualPayload[0];
      if (!selected) {
        return null;
      }

      const point = selected.payload || {};
      const xValue = Number.isFinite(point.distance)
        ? point.distance
        : Number(label);
      const inverseDistance =
        isTemperatureChart && Number.isFinite(xValue)
          ? RETURN_REFERENCE_DISTANCE - xValue
          : null;
      const latestValue = Number(point.latestValue);
      const previousValue = Number(point.previousValue);
      const resultLabel = isManualDifferentialView
        ? "Resultado (Lectura 2 - Lectura 1)"
        : "Resultado (ultima - penultima)";
      const firstReadingLabel = isManualDifferentialView
        ? "Lectura 1"
        : "Penultima lectura";
      const secondReadingLabel = isManualDifferentialView
        ? "Lectura 2"
        : "Ultima lectura";
      const firstFileLabel = isManualDifferentialView
        ? "Archivo lectura 1"
        : "Archivo penultimo";
      const secondFileLabel = isManualDifferentialView
        ? "Archivo lectura 2"
        : "Archivo mas reciente";

      return (
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-md text-xs space-y-1">
          <div className="font-semibold text-slate-700">
            {isAnyDifferentialView ? "Diferencial" : activeReferenceIndex ?? "N/A"}
          </div>
          <div className="text-slate-600">
            Distancia aproximada:{" "}
            {Number.isFinite(xValue) ? xValue.toFixed(2) : label} m
          </div>
          <div className="text-slate-800">
            {isAnyDifferentialView
              ? resultLabel
              : isTemperatureChart
                ? "Temperatura (Y)"
                : "Tension (Y)"}
            :{" "}
            {Number.isFinite(Number(selected.value))
              ? Number(selected.value).toFixed(3)
              : selected.value}
          </div>
          {isAnyDifferentialView && (
            <>
              <div className="text-slate-700">
                {secondReadingLabel}:{" "}
                {Number.isFinite(latestValue) ? latestValue.toFixed(3) : "--"}
              </div>
              <div className="text-slate-700">
                {firstReadingLabel}:{" "}
                {Number.isFinite(previousValue) ? previousValue.toFixed(3) : "--"}
              </div>
              <div className="text-slate-500 break-all">
                {secondFileLabel}: {point.latestFile || comparisonInfo?.latestFile || "--"}
              </div>
              <div className="text-slate-500 break-all">
                {firstFileLabel}:{" "}
                {point.previousFile || comparisonInfo?.previousFile || "--"}
              </div>
            </>
          )}
          {inverseDistance != null && (
            <div className="text-slate-600">
              Distancia de retorno: {inverseDistance.toFixed(2)} m
            </div>
          )}
          {thresholdPayload.length > 0 && (
            <div className="pt-1 border-t border-slate-100 space-y-1">
              {thresholdPayload.map((item) => (
                <div
                  key={`${item.name}-${item.color}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="flex items-center gap-2 text-slate-700">
                    <span
                      className="w-2 h-2 rounded-full block"
                      style={{ backgroundColor: item.color }}
                    />
                    {item.name}:
                  </span>
                  <span className="font-medium text-slate-700">
                    {Number.isFinite(item.value) ? item.value.toFixed(2) : item.value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    },
    [
      activeReferenceIndex,
      comparisonInfo?.latestFile,
      comparisonInfo?.previousFile,
      isDifferentialView,
      isAnyDifferentialView,
      isManualDifferentialView,
      isTemperatureChart,
      tooltipFileId,
    ]
  );

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 h-full p-4 relative select-none flex flex-col">
      {!hasData ? (
        <div className="flex flex-col items-center justify-center text-slate-400 h-full">
          <Upload size={48} className="mb-4 opacity-50" />
          <p className="text-lg font-medium">No hay datos cargados</p>
          <p className="text-sm">Usa Recargar para consultar nuevas lecturas</p>
        </div>
      ) : (
        <>
          <h2 className="text-sm font-semibold text-slate-400 mb-2 uppercase tracking-wide flex justify-between absolute top-4 left-4 right-4 z-10 pointer-events-none">
            <span>
              Vista: {xDomain[0].toFixed(0)}m - {xDomain[1].toFixed(0)}m
            </span>
            <span className="text-xs px-2 py-0.5 rounded shadow-sm bg-blue-100 text-blue-600">
              ZOOM HORIZONTAL
            </span>
          </h2>

          <div
            ref={chartContainerRef}
            className="w-full h-[520px] md:h-[600px] pt-6 cursor-ew-resize"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
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
                  tickFormatter={(value) => value.toFixed(0)}
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
                    tickFormatter={(value) =>
                      (RETURN_REFERENCE_DISTANCE - value).toFixed(0)
                    }
                    label={{
                      value: "Retorno (m)",
                      position: "insideTopRight",
                      offset: 0,
                    }}
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

                  const isActive = tooltipFileId && fid === tooltipFileId;
                  const stroke = isAnyDifferentialView
                    ? "#0f766e"
                    : isActive
                      ? "#ef4444"
                      : lineColor;
                  const strokeOpacity = isVisible ? 1 : 0.25;
                  const showActiveDot = tooltipFileId === fid || tooltipFileId == null;

                  return (
                    <Line
                      key={fid}
                      type="linear"
                      data={series}
                      dataKey="temperature"
                      stroke={stroke}
                      strokeWidth={isAnyDifferentialView ? 2.25 : isActive ? 2.25 : 1.9}
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

                {thresholdSeries.map((level) => (
                  <Line
                    key={level.id}
                    type="linear"
                    data={level.points}
                    dataKey="thresholdValue"
                    name={level.thresholdLabel}
                    stroke={level.color}
                    strokeWidth={1.75}
                    strokeDasharray="6 4"
                    dot={false}
                    activeDot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                ))}

                {zoomSelection.isSelecting && (
                  <ReferenceArea
                    x1={Math.min(zoomSelection.startX, zoomSelection.endX)}
                    x2={Math.max(zoomSelection.startX, zoomSelection.endX)}
                    y1={yDomain[0]}
                    y2={yDomain[1]}
                    fill="#3b82f6"
                    fillOpacity={0.14}
                    strokeOpacity={0}
                  />
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
