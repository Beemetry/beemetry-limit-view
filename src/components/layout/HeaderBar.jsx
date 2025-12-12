import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  ZoomIn,
  MousePointer2,
  Maximize2,
  FileText,
  RefreshCw,
} from "lucide-react";

const HeaderBar = ({
  xDomain,
  yDomain,
  initialStats,
  mode,
  onModeChange,
  hasData,
  onResetZoom,
  onLimitsFileChange,
  canLoadLimits,
  onReloadData,
  isReloading,
}) => {
  const { t, i18n } = useTranslation();
  const limitsInputRef = useRef(null);

  const currentLang = i18n.resolvedLanguage || i18n.language || "es";
  const isEs = currentLang.startsWith("es");

  const showReset =
    xDomain[0] !== initialStats.xMin ||
    xDomain[1] !== initialStats.xMax ||
    yDomain[0] !== initialStats.yMin ||
    yDomain[1] !== initialStats.yMax;

  const toggleLanguage = () => {
    i18n.changeLanguage(isEs ? "en" : "es");
  };

  return (
    <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm z-10 flex-none h-16">
      <div className="flex items-center gap-3">
        <img
          src="/logo_vsg.svg"
          alt="Logo Beemetry"
          className="w-10 h-10 object-contain"
          loading="lazy"
        />
        <h1 className="text-xl font-bold text-slate-800">
          {t("header.title")}
        </h1>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={toggleLanguage}
          className="px-2 py-1 text-xs border border-slate-200 rounded-md hover:bg-slate-50"
        >
          {isEs ? "ES" : "EN"}
        </button>

        {showReset && (
          <button
            onClick={onResetZoom}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 transition-colors"
          >
            <Maximize2 size={16} /> {t("header.resetView")}
          </button>
        )}

        <div className="flex bg-slate-100 p-1 rounded-lg">
          <button
            onClick={() => onModeChange("zoom")}
            disabled={!hasData}
            className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all ${
              mode === "zoom"
                ? "bg-white shadow text-blue-600 font-medium"
                : "text-slate-500 hover:text-slate-700"
            } ${!hasData ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            <ZoomIn size={18} /> {t("header.zoom")}
          </button>
          <button
            onClick={() => onModeChange("draw")}
            disabled={!hasData}
            className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all ${
              mode === "draw"
                ? "bg-white shadow text-red-600 font-medium"
                : "text-slate-500 hover:text-slate-700"
            } ${!hasData ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            <MousePointer2 size={18} /> {t("header.createLimit")}
          </button>
        </div>

        <input
          type="file"
          accept=".txt,.xml"
          ref={limitsInputRef}
          className="hidden"
          onChange={onLimitsFileChange}
        />

        <div className="flex gap-2">
          <button
            onClick={onReloadData}
            className="flex items-center gap-2 bg-slate-800 text-white px-3 py-2 rounded-lg hover:bg-slate-700 transition-colors shadow-sm text-sm disabled:opacity-60 disabled:cursor-not-allowed"
            disabled={isReloading}
          >
            <RefreshCw
              size={16}
              className={isReloading ? "animate-spin" : ""}
            />
            {isReloading ? "Recargando..." : "Recargar datos"}
          </button>
          <button
            onClick={() => limitsInputRef.current?.click()}
            disabled={!canLoadLimits}
            className={`flex items-center gap-2 bg-indigo-600 text-white px-3 py-2 rounded-lg hover:bg-indigo-700 transition-colors shadow-sm text-sm ${
              !canLoadLimits ? "opacity-50 cursor-not-allowed" : ""
            }`}
          >
            <FileText size={16} /> {t("header.uploadLimits")}
          </button>
        </div>
      </div>
    </header>
  );
};

export default HeaderBar;
