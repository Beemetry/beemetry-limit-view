import React from "react";
import { Activity, Plus, Trash2 } from "lucide-react";

const ControlPanel = ({
  thresholdInput,
  onThresholdInputChange,
  thresholdColor,
  onThresholdColorChange,
  thresholdSoundEnabled,
  onThresholdSoundEnabledChange,
  onThresholdInputKeyDown,
  onAddThreshold,
  thresholdLevels,
  onRemoveThreshold,
  activeReferenceIndex,
  selectedFileCount,
}) => {
  const hasThresholds = thresholdLevels.length > 0;

  return (
    <div className="bg-white border-t border-slate-300 shadow-xl z-20 overflow-y-auto flex flex-col max-h-[420px]">
      <div className="flex-1 p-4 grid grid-cols-12 gap-6 min-h-0">
        <div className="col-span-3 flex flex-col gap-4">
          <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-500 uppercase mb-3">
              <Activity size={14} /> Referencia Activa
            </label>
            <div className="text-3xl font-semibold text-slate-800 text-center">
              {activeReferenceIndex ?? "--"}
            </div>
            <p className="text-[11px] text-slate-500 mt-2 text-center">
              Ultima lectura activa entre los archivos seleccionados
            </p>
            <p className="text-[11px] text-slate-400 mt-1 text-center">
              Archivos seleccionados: {selectedFileCount}
            </p>
          </div>
        </div>

        <div className="col-span-4 bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-bold text-slate-800 uppercase">
              Nuevo Umbral
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              El umbral queda fijo sobre la ultima lectura activa al pulsar
              Agregar.
            </p>
          </div>

          <div className="grid grid-cols-[1fr_110px] gap-3">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase">
                Porcentaje
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  className="w-full text-sm px-3 py-2 rounded border border-slate-200 bg-white pr-8"
                  value={thresholdInput}
                  onChange={(event) =>
                    onThresholdInputChange(event.target.value)
                  }
                  onKeyDown={onThresholdInputKeyDown}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                  %
                </span>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase">
                Color
              </label>
              <input
                type="color"
                className="w-full h-10 rounded border border-slate-200 bg-white cursor-pointer"
                value={thresholdColor}
                onChange={(event) => onThresholdColorChange(event.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              className="accent-blue-600"
              checked={thresholdSoundEnabled}
              onChange={(event) =>
                onThresholdSoundEnabledChange(event.target.checked)
              }
            />
            Agregar sonido
          </label>

          <button
            onClick={onAddThreshold}
            className="h-10 px-4 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={14} /> Agregar
          </button>
        </div>

        <div className="col-span-5 flex flex-col h-full overflow-hidden">
          <div className="flex items-center justify-between mb-2 flex-none">
            <h3 className="text-sm font-bold text-slate-800">
              Umbrales Activos ({thresholdLevels.length})
            </h3>
          </div>

          <div className="flex-1 overflow-y-auto pr-2 space-y-2 border border-slate-100 rounded-lg bg-slate-50 p-2 min-h-0">
            {!hasThresholds ? (
              <div className="h-full flex items-center justify-center text-slate-400 text-xs italic">
                Sin umbrales configurados
              </div>
            ) : (
              thresholdLevels.map((level) => (
                <div
                  key={level.id}
                  className="flex items-center justify-between p-3 rounded border bg-white shadow-sm text-xs border-slate-200"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="w-3 h-3 rounded-full block"
                      style={{ backgroundColor: level.color }}
                    />
                    <div className="space-y-1">
                      <div className="font-semibold text-slate-800">
                        {level.thresholdLabel}
                      </div>
                      <div className="text-slate-500">
                        Piso minimo: {level.floor.toFixed(2)}
                      </div>
                      <div className="text-slate-400">
                        Base: lectura #{level.sourceFileIndex ?? "--"}
                        {level.soundEnabled ? " | sonido" : ""}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => onRemoveThreshold(level.id)}
                    className="p-1 hover:bg-red-50 text-slate-400 hover:text-red-600 rounded"
                    title="Eliminar umbral"
                  >
                    <Trash2 size={14} />
                  </button>
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
