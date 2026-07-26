export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-border"
      }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`absolute left-0.5 top-0.5 size-3 rounded-full bg-surface-raised transition-transform ${
          checked ? "translate-x-3" : ""
        }`}
      />
    </button>
  );
}
