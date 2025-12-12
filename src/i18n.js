// src/i18n.js
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

const resources = {
  es: {
    translation: {
      "header.title": "Sistema de Monitoreo - BEEMETRY",
      "header.resetView": "Resetear Vista",
      "header.zoom": "Zoom",
      "header.createLimit": "Crear Límite",
      "header.uploadData": "Datos TXT",
      "header.uploadLimits": "Límites",
      "header.mode.zoom": "MODO ZOOM",
      "header.mode.draw": "MODO DIBUJO",
    },
  },
  en: {
    translation: {
      "header.title": "Monitoring System",
      "header.resetView": "Reset view",
      "header.zoom": "Zoom",
      "header.createLimit": "Create limit",
      "header.uploadData": "TXT Data",
      "header.uploadLimits": "Limits",
      "header.mode.zoom": "ZOOM MODE",
      "header.mode.draw": "DRAW MODE",
    },
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "es",
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;