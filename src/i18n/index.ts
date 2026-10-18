import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en";
import zh from "./zh-TW";
import ja from "./ja";
void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "zh-TW": { translation: zh },
      ja: { translation: ja },
    },
    lng: "zh-TW",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    keySeparator: false,
  });
export default i18n;
