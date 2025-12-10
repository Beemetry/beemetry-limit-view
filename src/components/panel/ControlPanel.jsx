// src/components/panel/ControlPanel.jsx
import React from "react";
import {
  Settings,
  Activity,
  Save,
  Download,
  Pencil,
  Trash2,
} from "lucide-react";

const ControlPanel = ({
  nextId,
  setNextId,
  drawingState,
  mode,
  currentLimitForm,
  setCurrentLimitForm,
  editingId,
  onCancelEdit,
  onSaveOrUpdateLimit,
  limits,
  onEditLimit,
  onDeleteLimit,
  onExportLimits,
}) => {
  const isSaveDisabled =
    currentLimitForm.start === 0 && currentLimitForm.end === 0;

  return (
    <div className="h-72 bg-white border-t border-slate-300 shadow-xl z-20 overflow-hidden flex flex-col">
      <div className="flex-1 p-4 grid grid-cols-12 gap-6 overflow-hidden">
        {/* Columna 1: Config + Info */}
        <div className="col-span-2 flex flex-col gap-4">
          <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-500 uppercase mb-3">
              <Settings size={14} /> ID Inicial
            </label>
            <input
              type="number"
              className="w-full text-slate-800 text-lg font-mono bg-white px-3 py-2 rounded border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none text-center"
              value={nextId}
              onChange={(e) => setNextId(Number(e.target.value))}
            />
            <p className="text-[10px] text-slate-400 mt-2 text-center">
              Siguiente ID automático
            </p>
          </div>

          {/* Panel de estado */}
          <div className="bg-slate-800 text-white p-3 rounded-lg shadow-md flex-1 flex flex-col justify-center">
            <h4 className="text-[10px] font-bold uppercase mb-2 text-slate-300 flex items-center gap-2">
              <Activity size={12} />{" "}
              {drawingState.isDrawing ? "Creando Límite" : "Info Cursor"}
            </h4>
            {drawingState.isDrawing ? (
              <div className="space-y-1 text-xs font-mono">
                <div className="flex justify-between border-b border-slate-600 pb-1 mb-1">
                  <span className="text-slate-400">Inicio:</span>
                  <span className="font-bold">
                    {Math.min(
                      drawingState.startX,
                      drawingState.endX
                    ).toFixed(0)}
                    m
                  </span>
                </div>
                <div className="flex justify-between border-b border-slate-600 pb-1 mb-1">
                  <span className="text-slate-400">Fin:</span>
                  <span className="font-bold">
                    {Math.max(
                      drawingState.startX,
                      drawingState.endX
                    ).toFixed(0)}
                    m
                  </span>
                </div>
                <div className="flex justify-between text-yellow-400 pt-1">
                  <span>Trigger:</span>
                  <span className="font-bold">
                    {drawingState.startY.toFixed(1)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-400 italic text-center">
                {mode === "draw"
                  ? "Haz click y arrastra en el gráfico para crear un límite."
                  : "Usa el mouse para hacer zoom en una zona."}
              </div>
            )}
          </div>
        </div>

        {/* Columna 2: Formulario */}
        <div className="col-span-4 bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col justify-between relative">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 absolute top-4 left-4">
            <span
              className={`w-2 h-2 rounded-full block ${
                editingId ? "bg-blue-500" : "bg-red-500"
              }`}
            ></span>
            {editingId ? "EDITANDO LÍMITE" : "NUEVO LÍMITE"}
          </h3>

          {editingId && (
            <button
              onClick={onCancelEdit}
              className="absolute top-4 right-4 text-xs text-slate-400 hover:text-slate-600 underline"
            >
              Cancelar
            </button>
          )}

          <div className="grid grid-cols-3 gap-3 mt-6">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase">
                Inicio
              </label>
              <input
                type="number"
                className="w-full text-sm px-2 py-1 rounded border"
                value={currentLimitForm.start}
                onChange={(e) =>
                  setCurrentLimitForm({
                    ...currentLimitForm,
                    start: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase">
                Fin
              </label>
              <input
                type="number"
                className="w-full text-sm px-2 py-1 rounded border"
                value={currentLimitForm.end}
                onChange={(e) =>
                  setCurrentLimitForm({
                    ...currentLimitForm,
                    end: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase">
                Trigger
              </label>
              <input
                type="number"
                step="0.1"
                className="w-full text-sm px-2 py-1 rounded border"
                value={currentLimitForm.threshold}
                onChange={(e) =>
                  setCurrentLimitForm({
                    ...currentLimitForm,
                    threshold: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase">
                Tolerancia
              </label>
              <input
                type="number"
                className="w-full text-sm px-2 py-1 rounded border"
                value={currentLimitForm.tolerance}
                onChange={(e) =>
                  setCurrentLimitForm({
                    ...currentLimitForm,
                    tolerance: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase">
                Tipo
              </label>
              <input
                type="number"
                className="w-full text-sm px-2 py-1 rounded border"
                value={currentLimitForm.type}
                onChange={(e) =>
                  setCurrentLimitForm({
                    ...currentLimitForm,
                    type: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={onSaveOrUpdateLimit}
                disabled={isSaveDisabled}
                className={`w-full h-8 text-white text-xs font-bold uppercase rounded flex items-center justify-center gap-1 shadow-sm ${
                  editingId
                    ? "bg-blue-600 hover:bg-blue-700"
                    : "bg-red-600 hover:bg-red-700"
                } ${isSaveDisabled ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                <Save size={14} />
                {editingId ? "Actualizar" : "Guardar"}
              </button>
            </div>
          </div>
        </div>

        {/* Columna 3: Lista de límites */}
        <div className="col-span-6 flex flex-col h-full overflow-hidden">
          <div className="flex items-center justify-between mb-2 flex-none">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              Límites Activos ({limits.length})
            </h3>
            {limits.length > 0 && (
              <button
                onClick={onExportLimits}
                className="text-xs flex items-center gap-1 bg-slate-800 text-white px-2 py-1 rounded hover:bg-slate-700 transition-colors"
              >
                <Download size={12} /> Exportar
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto pr-2 space-y-2 border border-slate-100 rounded-lg bg-slate-50 p-2 min-h-0">
            {limits.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-400 text-xs italic">
                Sin límites configurados
              </div>
            ) : (
              limits.map((l) => (
                <div
                  key={l.id}
                  className={`flex items-center justify-between p-2 rounded border bg-white shadow-sm text-xs ${
                    editingId === l.id
                      ? "border-blue-500 ring-1 ring-blue-200"
                      : "border-slate-200"
                  }`}
                >
                  <div className="flex gap-4 items-center">
                    <span className="font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">
                      ID {l.customId}
                    </span>
                    <span className="text-slate-500">
                      Rango:{" "}
                      <span className="font-mono text-slate-800">
                        {l.start.toFixed(0)}-{l.end.toFixed(0)}m
                      </span>
                    </span>
                    <span className="text-slate-500">
                      Trig:{" "}
                      <span className="font-bold text-red-600">
                        {l.threshold.toFixed(1)}
                      </span>
                    </span>
                    <span className="text-slate-400">
                      Typ:{l.type} Tol:{l.tolerance}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => onEditLimit(l)}
                      className="p-1 hover:bg-blue-50 text-slate-400 hover:text-blue-600 rounded"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => onDeleteLimit(l.id)}
                      className="p-1 hover:bg-red-50 text-slate-400 hover:text-red-600 rounded"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default React.memo(ControlPanel);