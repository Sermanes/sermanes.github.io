import es from './es.json';
import en from './en.json';

export const languages = { es: 'Español', en: 'English' } as const;
export type Lang = keyof typeof languages;
export const defaultLang: Lang = 'es';

const dicts: Record<Lang, Record<string, string>> = { es, en };

export function getLangFromUrl(url: URL): Lang {
  const seg = url.pathname.split('/')[1];
  return seg in languages ? (seg as Lang) : defaultLang;
}

export function useTranslations(lang: Lang) {
  return function t(key: string): string {
    return dicts[lang][key] ?? dicts[defaultLang][key] ?? key;
  };
}

/** Strip a leading `/en` (non-default) locale prefix from a pathname. */
export function stripLangPrefix(pathname: string): string {
  for (const code of Object.keys(languages)) {
    if (code === defaultLang) continue;
    if (pathname === `/${code}`) return '/';
    if (pathname.startsWith(`/${code}/`)) return pathname.slice(code.length + 1);
  }
  return pathname;
}

/**
 * Build a locale-aware path. Default lang (es) has no prefix. Paths are
 * normalized to a single trailing slash to match Astro's directory build
 * format (and keep hreflang alternates consistent with internal links).
 */
export function localizePath(path: string, lang: Lang): string {
  let clean = path.startsWith('/') ? path : `/${path}`;
  if (!clean.endsWith('/')) clean += '/';
  return lang === defaultLang ? clean : `/${lang}${clean}`;
}
