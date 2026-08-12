import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarLayout } from "./Sidebar";
import type { NavPage } from "../lib/stores/app-store";

describe("Sidebar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each<NavPage>(["chat", "packages", "settings"])(
    "keeps the conversation workspace mounted on the %s page",
    (page) => {
      const html = renderToStaticMarkup(
        createElement(SidebarLayout, { page, setPage: vi.fn() }),
      );

      expect(html).toContain("New conversation");
      expect(html).toContain("Workspaces");
      expect(html).toContain("Recent conversations");
      expect(html).toContain("Settings");
      expect(html).not.toContain(">Chat<");
      expect(html).not.toContain(">Packages<");
    },
  );

  it("keeps only the hover edge control mounted when the sidebar is collapsed", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "pideck.sidebar.collapsed" ? "1" : null),
      setItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).toContain("width:0");
    expect(html).toContain('data-sidebar-collapsed="true"');
    expect(html).not.toContain("New conversation");
    expect(html).not.toContain("Recent conversations");
  });

  it("renders the collapse handle anchored to the sidebar width when expanded", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "pideck.sidebar.width.v1" ? "300" : null,
      setItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    // The expanded handle must be present and fixed-positioned at left:<width>px
    // so it docks on the sidebar's right edge regardless of ancestor positioning.
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/position:\s*fixed[^}]*left:\s*300/);
    expect(html).not.toContain('data-sidebar-collapsed="true"');
  });
});
