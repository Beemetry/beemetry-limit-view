import React from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, RefreshCw } from "lucide-react";

const HeaderBar = ({
  xDomain,
  initialStats,
  onResetZoom,
  onReloadData,
  isReloading,
}) => {
  const { t, i18n } = useTranslation();

  const currentLang = i18n.resolvedLanguage || i18n.language || "es";
  const isEs = currentLang.startsWith("es");

  const showReset =
    xDomain[0] !== initialStats.xMin || xDomain[1] !== initialStats.xMax;

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

        <div className="px-3 py-2 text-sm rounded-md bg-blue-50 text-blue-700 font-medium">
          Zoom X
        </div>

        {showReset && (
          <button
            onClick={onResetZoom}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 transition-colors"
          >
            <Maximize2 size={16} /> {t("header.resetView")}
          </button>
        )}

        <button
          onClick={onReloadData}
          className="flex items-center gap-2 bg-slate-800 text-white px-3 py-2 rounded-lg hover:bg-slate-700 transition-colors shadow-sm text-sm disabled:opacity-60 disabled:cursor-not-allowed"
          disabled={isReloading}
        >
          <RefreshCw size={16} className={isReloading ? "animate-spin" : ""} />
          {isReloading ? "Recargando..." : "Recargar datos"}
        </button>
      </div>
    </header>
  );
};

export default React.memo(HeaderBar);
