import type { ReactNode } from "react";

/** Shared unframed heading for top-level settings sections. */
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
    <header
      className="flex min-h-16 shrink-0 items-start gap-3 px-6 pb-2 pt-3"
      data-settings-has-actions={children ? "" : undefined}
      data-settings-section-header
      data-tauri-drag-region
    >
      <div className="min-w-0">
        <h1 className="text-base font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>}
      </div>
      {children && (
        <div className="ml-auto flex shrink-0 items-center gap-2 pr-[50px]" data-settings-header-actions>
          {children}
        </div>
      )}
    </header>
  );
}
