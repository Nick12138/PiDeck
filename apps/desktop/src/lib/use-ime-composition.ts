import { useCallback, useRef } from "react";

/**
 * WebKit can fire compositionend before the keydown of the key that commits an
 * IME composition, so `isComposing` alone misses that Enter. Any key arriving
 * within this window of a compositionend is treated as part of the commit.
 */
const IME_COMMIT_GRACE_MS = 30;

export type ImeCompositionState = {
  composing: boolean;
  endedAt: number;
};

export type ImeKeyEventLike = {
  timeStamp: number;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
};

export function isImeKeyEvent(
  event: ImeKeyEventLike,
  state: ImeCompositionState,
): boolean {
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
  const isImeKey = useCallback(
    (event: ImeKeyEventLike) => isImeKeyEvent(event, state.current),
    [],
  );
  return { onCompositionStart, onCompositionEnd, isImeKey };
}
