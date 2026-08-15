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

  it("keeps the PI sidebar toggle mounted when the sidebar is collapsed", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "pideck.sidebar.collapsed" ? "1" : null),
      setItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).toContain('data-sidebar-brand-toggle="true"');
    expect(html).toContain('data-sidebar-collapsed-toggle-slot="true"');
    expect(html).toContain("h-12 w-14 items-center justify-center");
    expect(html).toContain("translate-x-0.5 translate-y-[3px]");
    expect(html).toContain("width:0");
    expect(html).toContain('data-sidebar-collapsed="true"');
    expect(html).not.toContain("New conversation");
    expect(html).not.toContain("Recent conversations");
  });

  it("renders the PI sidebar toggle instead of an edge handle when expanded", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "pideck.sidebar.width.v1" ? "300" : null,
      setItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-sidebar-brand-toggle="true"');
    expect(html).not.toContain("group/sidebar-edge");
    expect(html).not.toContain('data-sidebar-collapsed="true"');
  });
});
