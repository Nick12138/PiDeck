import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

interface SelectOption {
  value: string;
  label: ReactNode;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  align?: "left" | "right";
  maxWidth?: number;
}

export function Select({
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false,
  className = "",
  triggerClassName = "",
  align = "left",
  maxWidth,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className={`relative min-w-0 ${className}`}
      style={maxWidth ? { maxWidth } : undefined}
    >
      <button
        type="button"
        className={`flex h-8 w-full items-center gap-1 rounded-md border border-border bg-surface px-2 text-xs text-foreground outline-none transition-colors hover:bg-surface-overlay/60 focus-visible:border-focus disabled:cursor-default disabled:opacity-40 ${triggerClassName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ""}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`theme-floating-surface absolute z-50 mt-1 min-w-full rounded-md border border-border bg-surface-raised py-1 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`flex h-8 w-full items-center gap-1.5 whitespace-nowrap px-2.5 text-left text-xs transition-colors hover:bg-surface-overlay ${
                  isSelected ? "font-medium text-foreground" : "text-muted"
                }`}
                onClick={() => {
                  setOpen(false);
                  onChange(option.value);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {isSelected && (
                  <span className="flex shrink-0 items-center justify-center">
                    <Check size={16} strokeWidth={2.5} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
