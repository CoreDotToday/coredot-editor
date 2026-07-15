import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiRunHistory } from "./AiRunHistory";

function hydrateServerMarkup(ui: ReactNode, beforeHydrate: () => void = () => undefined) {
  const container = document.createElement("div");
  try {
    container.innerHTML = renderToString(ui);
    document.body.append(container);
    beforeHydrate();
    const recoverableErrors: unknown[] = [];
    const view = render(ui, {
      container,
      hydrate: true,
      onRecoverableError: (error) => recoverableErrors.push(error),
    });

    return { container, recoverableErrors, view };
  } catch (error) {
    container.remove();
    throw error;
  }
}

describe("AiRunHistory", () => {
  it("hydrates with deterministic Korean UTC timestamps across Intl runtimes", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(Intl, "DateTimeFormat");
    let runtime: "browser" | "server" = "server";
    const divergentDateTimeFormat = function DivergentDateTimeFormat() {
      return {
        format: () => runtime === "server" ? "7월 15일 AM 12:01" : "7월 15일 오전 12:01",
      };
    } as unknown as typeof Intl.DateTimeFormat;
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      value: divergentDateTimeFormat,
    });

    const ui = (
      <AiRunHistory
        language="ko"
        runs={[{
          id: "run-1",
          commandType: "document_review",
          status: "completed",
          createdAt: new Date("2026-07-15T00:01:00.000Z"),
        }]}
      />
    );
    let container: HTMLElement | undefined;

    try {
      const hydrated = hydrateServerMarkup(ui, () => { runtime = "browser"; });
      container = hydrated.container;

      expect(hydrated.recoverableErrors).toEqual([]);
      expect(hydrated.view.getByText(/2026\. 7\. 15\. 00:01 UTC/)).toBeVisible();
    } finally {
      cleanup();
      container?.remove();
      if (originalDescriptor) {
        Object.defineProperty(Intl, "DateTimeFormat", originalDescriptor);
      } else {
        delete (Intl as Partial<typeof Intl>).DateTimeFormat;
      }
    }
  });

  it("renders English UTC timestamps with a stable 24-hour format", () => {
    const ui = (
      <AiRunHistory
        language="en"
        runs={[{
          id: "run-en",
          commandType: "document_review",
          status: "completed",
          createdAt: new Date("2026-07-15T00:01:00.000Z"),
        }]}
      />
    );
    let container: HTMLElement | undefined;

    try {
      const hydrated = hydrateServerMarkup(ui);
      container = hydrated.container;

      expect(hydrated.recoverableErrors).toEqual([]);
      expect(hydrated.view.getByText(/2026-07-15 00:01 UTC/)).toBeVisible();
    } finally {
      cleanup();
      container?.remove();
    }
  });

  it("renders invalid timestamps explicitly without hydration recovery", () => {
    const ui = (
      <AiRunHistory
        language="ko"
        runs={[{
          id: "run-invalid",
          commandType: "selection_rewrite",
          status: "failed",
          createdAt: new Date("not-a-timestamp"),
        }]}
      />
    );
    let container: HTMLElement | undefined;

    try {
      const hydrated = hydrateServerMarkup(ui);
      container = hydrated.container;

      expect(hydrated.recoverableErrors).toEqual([]);
      expect(hydrated.view.getByText("유효하지 않은 날짜")).toBeVisible();
      expect(container.querySelector("time")).toBeNull();
    } finally {
      cleanup();
      container?.remove();
    }
  });
});
