import { useCallback, useRef } from "react";

/**
 * WebKit can fire compositionend before the keydown of the key that commits an
 * IME composition, so `isComposing` alone misses that Enter. That committing
 * keydown is dispatched in the same task as the compositionend, so its
 * `timeStamp` differs from the compositionend's by only a couple of
 * milliseconds.
 *
 * Keep the grace tiny: it must be just large enough to absorb same-tick
 * dispatch jitter, but small enough that a *physically separate* keystroke the
 * user presses right after committing (e.g. an immediate Enter to send) is not
 * swallowed. A human cannot press two distinct keys much under ~30 ms apart,
 * so a 30 ms window reliably ate those fast send-Enters and turned them into
 * bare newlines (the textarea's default Enter). 5 ms catches the same-tick
 * commit key on WebKit while leaving a deliberate follow-up Enter alone.
 *
 * On Chromium (WebView2) the commit key is already flagged by `isComposing`
 * before compositionend, so this window provides no benefit there and only
 * risks false positives — hence the small value.
 */
const IME_COMMIT_GRACE_MS = 5;

export type ImeCompositionState = {
  composing: boolean;
  endedAt: number;
};

export type ImeKeyEventLike = {
  timeStamp: number;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
};

export function isImeKeyEvent(event: ImeKeyEventLike, state: ImeCompositionState): boolean {
  return (
    state.composing ||
    event.nativeEvent?.isComposing === true ||
    event.keyCode === 229 ||
    event.timeStamp - state.endedAt < IME_COMMIT_GRACE_MS
  );
}

/**
 * Track IME composition on a text field so key handlers can ignore keys that
 * belong to the composition (e.g. the Enter that commits pinyin as raw text).
 * Spread `onCompositionStart`/`onCompositionEnd` onto the field and gate the
 * `onKeyDown` handler with `isImeKey(event)`.
 */
export function useImeComposition() {
  const state = useRef<ImeCompositionState>({
    composing: false,
    endedAt: Number.NEGATIVE_INFINITY,
  });
  const onCompositionStart = useCallback(() => {
    state.current.composing = true;
  }, []);
  const onCompositionEnd = useCallback((event: { timeStamp: number }) => {
    state.current.composing = false;
    state.current.endedAt = event.timeStamp;
  }, []);
  const isImeKey = useCallback((event: ImeKeyEventLike) => isImeKeyEvent(event, state.current), []);
  return { onCompositionStart, onCompositionEnd, isImeKey };
}
