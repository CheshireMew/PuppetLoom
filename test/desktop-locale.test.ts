import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_LOCALES, LOCALE_CHANGE_EVENT, LOCALE_STORAGE_KEY, persistLocale, readStoredLocale } from "../apps/desktop/src/i18n/locale.ts";
import { messages } from "../apps/desktop/src/i18n/messages.ts";

describe("desktop locale preference", () => {
  afterEach(() => vi.unstubAllGlobals());

  function installStorage(stored?: string) {
    const values = new Map(stored === undefined ? [] : [[LOCALE_STORAGE_KEY, stored]]);
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value)
      },
      dispatchEvent
    });
    return { values, dispatchEvent };
  }

  it("uses Chinese on first launch and without a browser window", () => {
    vi.stubGlobal("window", undefined);
    expect(readStoredLocale()).toBe("zh");
    installStorage();
    expect(readStoredLocale()).toBe("zh");
  });

  it.each(["", "fr", "zh-CN", "invalid"])("falls back to Chinese for unsupported stored value %j", (stored) => {
    installStorage(stored);
    expect(readStoredLocale()).toBe("zh");
  });

  it.each(APP_LOCALES)("persists and restores an explicit %s choice", (locale) => {
    const { values, dispatchEvent } = installStorage();
    persistLocale(locale);
    expect(values.get(LOCALE_STORAGE_KEY)).toBe(locale);
    expect(readStoredLocale()).toBe(locale);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const event = dispatchEvent.mock.calls[0]![0] as CustomEvent;
    expect(event.type).toBe(LOCALE_CHANGE_EVENT);
    expect(event.detail).toBe(locale);
    installStorage(values.get(LOCALE_STORAGE_KEY));
    expect(readStoredLocale()).toBe(locale);
  });
});

describe("desktop locale catalogs", () => {
  it("keeps the same message keys for Korean, Chinese, English, and Japanese", () => {
    const keys = Object.keys(messages.ko).sort();
    for (const locale of APP_LOCALES) {
      expect(Object.keys(messages[locale]).sort()).toEqual(keys);
    }
  });

  it("fills every catalog entry", () => {
    for (const locale of APP_LOCALES) {
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
