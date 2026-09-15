import { describe, expect, it } from "vitest";
import { APP_LOCALES } from "../apps/desktop/src/i18n/locale.ts";
import { messages } from "../apps/desktop/src/i18n/messages.ts";

describe("desktop locale catalogs", () => {
  it("keeps the same message keys for Korean, Chinese, and English", () => {
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
