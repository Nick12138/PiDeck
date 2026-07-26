import { useMemo } from "react";
import { useAppStore } from "../stores/app-store";
import { resolveLocale, translate, type Locale, type MessageKey } from "./index";

export type Translate = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string;

export function useLocale(): Locale {
  return useAppStore((state) => resolveLocale(state.desktopSettings?.language));
}

/** Translation function bound to the current UI language. */
export function useT(): Translate {
  const locale = useLocale();
  return useMemo<Translate>(
    () => (key, params) => translate(locale, key, params),
    [locale],
  );
}
