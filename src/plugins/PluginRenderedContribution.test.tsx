import { createContext, StrictMode, useContext, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRenderedContribution } from "./PluginRenderedContribution";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PluginRenderedContribution", () => {
  it("preserves parent React context and survives StrictMode setup and cleanup", async () => {
    const ParentContext = createContext("DEFAULT");

    function ContextReader() {
      return <p>{useContext(ParentContext)}</p>;
    }

    const view = render(
      <StrictMode>
        <ParentContext.Provider value="PROVIDED">
          <PluginRenderedContribution
            contributionId="plugin.context"
            contributionType="settingsSection"
            render={() => <ContextReader />}
          />
        </ParentContext.Provider>
      </StrictMode>,
    );

    expect(await screen.findByText("PROVIDED")).toBeInTheDocument();
    expect(() => view.unmount()).not.toThrow();
  });

  it("recovers when a failed contribution receives healthy output under the same id", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reactCaughtErrors: unknown[] = [];
    let shouldThrow = true;

    function TransientContribution() {
      if (shouldThrow) throw new Error("PRIVATE_TRANSIENT_DATA");
      return <p>Recovered contribution</p>;
    }

    const view = render(
      <PluginRenderedContribution
        contributionId="plugin.transient"
        contributionType="workspacePanel"
        render={() => <TransientContribution />}
      />,
      { onCaughtError: (error) => reactCaughtErrors.push(error) },
    );

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("Editor plugin contribution failed.", {
        contributionId: "plugin.transient",
        contributionType: "workspacePanel",
      });
    });
    expect(reactCaughtErrors).toHaveLength(1);
    expect(reactCaughtErrors.map(String).join(" ")).not.toContain("PRIVATE_TRANSIENT_DATA");
    expect(reactCaughtErrors.map((error) => error instanceof Error ? error.message : String(error))).toEqual([
      "Editor plugin render failed.",
    ]);

    shouldThrow = false;
    view.rerender(
      <PluginRenderedContribution
        contributionId="plugin.transient"
        contributionType="workspacePanel"
        render={() => <TransientContribution />}
      />,
    );

    expect(await screen.findByText("Recovered contribution")).toBeInTheDocument();
  });

  it("recovers when contribution identity changes with a stable render callback", async () => {
    let shouldThrow = true;
    const reactCaughtErrors: unknown[] = [];
    const renderContribution = () => {
      if (shouldThrow) throw "PRIVATE_PRIMITIVE_DATA";
      return <p>New contribution identity</p>;
    };

    const view = render(
      <PluginRenderedContribution
        contributionId="plugin.old"
        contributionType="settingsSection"
        render={renderContribution}
      />,
      { onCaughtError: (error) => reactCaughtErrors.push(error) },
    );

    shouldThrow = false;
    view.rerender(
      <PluginRenderedContribution
        contributionId="plugin.new"
        contributionType="settingsSection"
        render={renderContribution}
      />,
    );

    expect(await screen.findByText("New contribution identity")).toBeInTheDocument();
    expect(reactCaughtErrors).toHaveLength(1);
    expect(reactCaughtErrors.map(String).join(" ")).not.toContain("PRIVATE_PRIMITIVE_DATA");
    expect(reactCaughtErrors.map((error) => error instanceof Error ? error.message : String(error))).toEqual([
      "Editor plugin render failed.",
    ]);
  });

  it("preserves healthy contribution state when its render callback changes", async () => {
    const user = userEvent.setup();

    function Counter() {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount((value) => value + 1)}>Count {count}</button>;
    }

    const view = render(
      <PluginRenderedContribution
        contributionId="plugin.stateful"
        contributionType="settingsSection"
        render={() => <Counter />}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Count 0" }));
    expect(screen.getByRole("button", { name: "Count 1" })).toBeInTheDocument();

    view.rerender(
      <PluginRenderedContribution
        contributionId="plugin.stateful"
        contributionType="settingsSection"
        render={() => <Counter />}
      />,
    );

    expect(screen.getByRole("button", { name: "Count 1" })).toBeInTheDocument();
  });
});
