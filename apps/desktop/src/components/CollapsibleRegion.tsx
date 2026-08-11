import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const COLLAPSE_UNMOUNT_DELAY_MS = 180;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function CollapsibleRegion({
  open,
  id,
  children,
}: {
  open: boolean;
  id?: string;
  children: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const presentRef = useRef(open);
  const openRef = useRef(open);
  const frameRef = useRef<number | null>(null);
  const unmountTimerRef = useRef<number | null>(null);
  const shouldRender = open || present;

  useLayoutEffect(() => {
    openRef.current = open;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (unmountTimerRef.current !== null) {
      window.clearTimeout(unmountTimerRef.current);
      unmountTimerRef.current = null;
    }

    if (open) {
      const wasPresent = presentRef.current;
      if (!wasPresent) {
        presentRef.current = true;
        setPresent(true);
      }
      if (wasPresent || prefersReducedMotion()) {
        setExpanded(true);
      } else {
        setExpanded(false);
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = null;
            if (openRef.current) setExpanded(true);
          });
        });
      }
    } else {
      setExpanded(false);
      if (presentRef.current) {
        if (prefersReducedMotion()) {
          presentRef.current = false;
          setPresent(false);
        } else {
          unmountTimerRef.current = window.setTimeout(() => {
            unmountTimerRef.current = null;
            if (openRef.current) return;
            presentRef.current = false;
            setPresent(false);
          }, COLLAPSE_UNMOUNT_DELAY_MS);
        }
      }
    }

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    };
  }, [open]);

  return (
    <div
      id={id}
      data-collapsible-region
      data-state={expanded ? "open" : "closed"}
      className="collapsible-region"
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      onTransitionEnd={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.propertyName !== "grid-template-rows" ||
          openRef.current
        ) {
          return;
        }
        if (unmountTimerRef.current !== null) {
          window.clearTimeout(unmountTimerRef.current);
          unmountTimerRef.current = null;
        }
        presentRef.current = false;
        setPresent(false);
      }}
    >
      {shouldRender && (
        <div className="collapsible-region__clip">
          <div className="collapsible-region__content">{children}</div>
        </div>
      )}
    </div>
  );
}
