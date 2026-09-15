export const APP_LOCALES = ["ko", "zh", "en"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const LOCALE_STORAGE_KEY = "puppetloom.locale";
export const LOCALE_CHANGE_EVENT = "puppetloom:locale-change";

export const LOCALE_LABELS: Record<AppLocale, string> = {
  ko: "한국어",
  zh: "中文",
  en: "English"
};

export const LOCALE_HTML_LANG: Record<AppLocale, string> = {
  ko: "ko",
  zh: "zh-CN",
  en: "en"
};

export const LOCALE_DATE: Record<AppLocale, string> = {
  ko: "ko-KR",
  zh: "zh-CN",
  en: "en-US"
};

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return value === "ko" || value === "zh" || value === "en";
}

export function readStoredLocale(): AppLocale {
  if (typeof window === "undefined") return "ko";
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return isAppLocale(stored) ? stored : "ko";
}

export function persistLocale(locale: AppLocale): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  window.dispatchEvent(new CustomEvent(LOCALE_CHANGE_EVENT, { detail: locale }));
}

export function formatMessage(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] === undefined ? match : String(values[key]));
}
