import { useTranslation } from 'react-i18next';
import { supportedLanguages, languageLabels, writeLanguageCookie, type SupportedLanguage } from '../i18n';

/**
 * Minimal language picker for the header.
 *
 * Today the list holds English alone, so the control is effectively a label —
 * it is here now so that adding a language is a dictionary + one array entry in
 * `i18n.ts`, not a new component. The cookie is written before `changeLanguage`
 * so a reload mid-switch still lands in the language the user just picked.
 *
 * Styling follows the header's other controls: muted text, a bordered surface
 * background, accent focus ring. Native <select> on purpose — it gets keyboard
 * and screen-reader behaviour for free and there is no custom listbox to trap
 * focus in behind MobileNav's overlay.
 */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { i18n, t } = useTranslation();

  const current = (
    supportedLanguages as readonly string[]
  ).includes(i18n.language)
    ? (i18n.language as SupportedLanguage)
    : 'en';

  function handleChange(lng: SupportedLanguage) {
    writeLanguageCookie(lng);
    void i18n.changeLanguage(lng);
  }

  return (
    <label className={`inline-flex items-center ${className}`}>
      <span className="sr-only">{t('lang.label')}</span>
      <select
        value={current}
        onChange={(e) => handleChange(e.target.value as SupportedLanguage)}
        aria-label={t('lang.label')}
        className="bg-bg-secondary border border-border rounded-lg px-2 py-1.5 text-sm text-text-muted hover:text-text-primary focus:outline-none focus:border-accent-primary transition-colors cursor-pointer"
      >
        {supportedLanguages.map((lng) => (
          <option key={lng} value={lng}>
            {languageLabels[lng]}
          </option>
        ))}
      </select>
    </label>
  );
}
