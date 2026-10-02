// UI translations. Messages live in locales/<lang>.json (outside of the
// code, since translations contain non-ASCII text). English is the
// fallback for missing keys.

import { readFileSync } from 'node:fs';

export const LANGUAGES = ['en', 'uk', 'de'] as const;
export const DEFAULT_LANGUAGE = 'en';

type Messages = Record<string, string>;

const catalogs = new Map<string, Messages>();

function catalog(lang: string): Messages {
  let c = catalogs.get(lang);
  if (!c) {
    const url = new URL(`../../locales/${lang}.json`, import.meta.url);
    c = JSON.parse(readFileSync(url, 'utf8')) as Messages;
    catalogs.set(lang, c);
  }
  return c;
}

export function isSupportedLanguage(lang: string): boolean {
  return (LANGUAGES as readonly string[]).includes(lang);
}

export type Translator = (key: string, params?: Record<string, string | number>) => string;

export function translator(lang: string): Translator {
  const primary = isSupportedLanguage(lang) ? catalog(lang) : catalog(DEFAULT_LANGUAGE);
  const fallback = catalog(DEFAULT_LANGUAGE);
  return (key, params) => {
    let msg = primary[key] ?? fallback[key] ?? key;
    if (params) {
      msg = msg.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
    }
    return msg;
  };
}

// Native name of a language, as shown in the language selector.
export function languageName(lang: string): string {
  return catalog(lang)['language.native'] ?? lang;
}

// Picks the best supported language from an Accept-Language header.
export function negotiateLanguage(header: string | undefined): string | null {
  if (!header) return null;
  const prefs = header.split(',').map((part) => {
    const [tag, ...rest] = part.trim().split(';');
    const q = rest.find((r) => r.trim().startsWith('q='));
    return { lang: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.trim().slice(2)) || 0 : 1 };
  }).sort((a, b) => b.q - a.q);
  for (const p of prefs) if (isSupportedLanguage(p.lang)) return p.lang;
  return null;
}
