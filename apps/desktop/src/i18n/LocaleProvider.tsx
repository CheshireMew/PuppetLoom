import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { formatMessage, LOCALE_CHANGE_EVENT, LOCALE_HTML_LANG, persistLocale, readStoredLocale, type AppLocale } from "./locale.js";
import { messages, type MessageKey } from "./messages.js";

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: Translate;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function applyHtmlLang(locale: AppLocale): void {
  document.documentElement.lang = LOCALE_HTML_LANG[locale];
}

export function LocaleProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<AppLocale>(() => readStoredLocale());

  useEffect(() => {
    applyHtmlLang(locale);
    const onStorage = (event: StorageEvent) => {
      if (event.key === "puppetloom.locale" && event.newValue && event.newValue !== locale) {
        if (event.newValue === "ko" || event.newValue === "zh" || event.newValue === "en") setLocaleState(event.newValue);
      }
    };
    const onLocal = (event: Event) => {
      const next = (event as CustomEvent<AppLocale>).detail;
      if (next && next !== locale) setLocaleState(next);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(LOCALE_CHANGE_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LOCALE_CHANGE_EVENT, onLocal);
    };
  }, [locale]);

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale: (next) => {
      persistLocale(next);
      applyHtmlLang(next);
      setLocaleState(next);
    },
    t: (key, values) => formatMessage(messages[locale][key], values)
  }), [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used inside LocaleProvider");
  return value;
}
