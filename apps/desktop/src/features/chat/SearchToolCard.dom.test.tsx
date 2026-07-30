/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openChatLink: vi.fn() }));

vi.mock("./chat-link", () => ({ openChatLink: mocks.openChatLink }));

import { SearchToolCard } from "./SearchToolCard";

function middleClick(target: Element): void {
  fireEvent(target, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
}

beforeEach(() => {
  mocks.openChatLink.mockReset().mockReturnValue(true);
});

afterEach(cleanup);

describe("SearchToolCard link routing", () => {
  it("routes normal and middle clicks through the shared chat-link policy", async () => {
    const user = userEvent.setup();
    render(
      <SearchToolCard
        name="web_search"
        status="done"
        args={{ query: "PiDeck docs" }}
        result={{
          results: [
            {
              title: "PiDeck documentation",
              url: "https://example.com/docs",
              snippet: "Documentation",
            },
          ],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { expanded: false }));
    const link = screen.getByRole("link", { name: /PiDeck documentation/u });
    expect(link).toHaveAttribute("title", expect.stringContaining("Open in Dock browser"));

    await user.click(link);
    expect(mocks.openChatLink).toHaveBeenLastCalledWith(
      "https://example.com/docs",
      expect.objectContaining({ button: 0 }),
    );

    middleClick(link);
    expect(mocks.openChatLink).toHaveBeenLastCalledWith(
      "https://example.com/docs",
      expect.objectContaining({ button: 1 }),
    );
  });
});
