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

const LimitsChart = ({
  data,
  visibleData,
  lineColor = "#3b82f6",
  chartType,
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
  const yLabel =
    chartType === "temperatura" ? "Temperatura C°" : "Tension (uE)";

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
                <RTooltip
                  contentStyle={{
                    borderRadius: "8px",
                    border: "none",
                    boxShadow:
                      "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
                  }}
                  formatter={(value) => [value, "Valor"]}
                  labelFormatter={(label) => `X: ${label}`}
                />

                <Line
                  // datasets reinician X en cada archivo; usar "linear" evita el requerimiento de monotonicidad
                  type="linear"
                  dataKey="temperature"
                  stroke={lineColor}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 6 }}
                  isAnimationActive={false}
                  connectNulls={false}
                />

                {limits.map((limit) => (
                  <ReferenceLine
                    key={limit.id}
                    segment={[
                      { x: limit.start, y: limit.threshold },
                      { x: limit.end, y: limit.threshold },
                    ]}
                    stroke={
                      editingId === limit.id ? "#3b82f6" : "#ef4444"
                    }
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
                      x1={Math.min(
                        drawingState.startX,
                        drawingState.endX
                      )}
                      x2={Math.max(
                        drawingState.startX,
                        drawingState.endX
                      )}
                      y1={
                        mode === "zoom"
                          ? Math.min(
                              drawingState.startY,
                              drawingState.endY
                            )
                          : initialStats.yMin
                      }
                      y2={
                        mode === "zoom"
                          ? Math.max(
                              drawingState.startY,
                              drawingState.endY
                            )
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
