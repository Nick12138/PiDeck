import type { ReactNode } from "react";

/** Shared fixed header bar for top-level settings sections. */
export function SectionHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="min-w-0">
        <h1 className="text-sm font-semibold">{title}</h1>
        {subtitle && <p className="truncate text-[11px] text-muted">{subtitle}</p>}
      </div>
      {children && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">{children}</div>
      )}
    </header>
  );
}
