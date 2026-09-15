import { APP_LOCALES, LOCALE_LABELS } from "./locale.js";
import { useLocale } from "./LocaleProvider.js";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const { locale, setLocale, t } = useLocale();
  return (
    <div className={`language-switcher ${compact ? "is-compact" : ""}`} data-testid="language-switcher" role="group" aria-label={t("language")}>
      {APP_LOCALES.map((item) => (
        <button
          key={item}
          type="button"
          className={item === locale ? "is-active" : ""}
          aria-pressed={item === locale}
          onClick={() => setLocale(item)}
        >
          {LOCALE_LABELS[item]}
        </button>
      ))}
    </div>
  );
}
