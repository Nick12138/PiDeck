import {
  en,
  piWorkingVariants as enPiWorkingVariants,
  type MessageKey,
} from "./en";
import { zh, piWorkingVariants as zhPiWorkingVariants } from "./zh";

export type { MessageKey } from "./en";
export type AppLanguage = "system" | "en" | "zh";
export type Locale = "en" | "zh";

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, zh };

/** Playful "Pi is working" statuses; the UI shows one at random per request. */
export function piWorkingVariants(locale: Locale): readonly string[] {
  return locale === "zh" ? zhPiWorkingVariants : enPiWorkingVariants;
}

export function resolveLocale(language: AppLanguage | undefined): Locale {
  if (language === "en" || language === "zh") return language;
  const system = typeof navigator !== "undefined" ? (navigator.language ?? "") : "";
  return system.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  let text = DICTIONARIES[locale][key] ?? en[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Keeps the document language in sync so a11y tools and fonts behave. */
export function applyLanguage(language: AppLanguage | undefined): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = resolveLocale(language) === "zh" ? "zh-CN" : "en";
}
