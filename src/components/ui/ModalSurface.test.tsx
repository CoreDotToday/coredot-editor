import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isModalSurfaceActive,
  ModalSurface,
  subscribeToModalSurfaceActivity,
} from "./ModalSurface";

afterEach(() => {
  cleanup();
  for (const element of document.querySelectorAll("[data-modal-test-sibling]")) {
    element.remove();
  }
  document.body.style.overflow = "";
});

function SingleModalHarness() {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const preferredFocusRef = useRef<HTMLButtonElement>(null);

  return (
    <div data-testid="background">
      <button onClick={() => setIsOpen(true)} ref={triggerRef} type="button">
        Open details
      </button>
      {isOpen ? (
        <ModalSurface
          aria-describedby="details-description"
          aria-labelledby="details-title"
          initialFocusRef={preferredFocusRef}
          onClose={() => setIsOpen(false)}
          returnFocusRef={triggerRef}
        >
          <h2 id="details-title">Details</h2>
          <p id="details-description">Review the current document.</p>
          <button type="button">First action</button>
          <button ref={preferredFocusRef} type="button">Preferred action</button>
          <button onClick={() => setIsOpen(false)} type="button">Close details</button>
        </ModalSurface>
      ) : null}
    </div>
  );
}

function NestedModalHarness({
  onChildClose,
  onParentClose,
}: {
  onChildClose: () => void;
  onParentClose: () => void;
}) {
  const [isParentOpen, setIsParentOpen] = useState(false);
  const [isChildOpen, setIsChildOpen] = useState(false);
  const parentTriggerRef = useRef<HTMLButtonElement>(null);
  const childTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div data-testid="nested-background">
      <button onClick={() => setIsParentOpen(true)} ref={parentTriggerRef} type="button">
        Open parent
      </button>
      {isParentOpen ? (
        <ModalSurface
          aria-label="Parent dialog"
          onClose={() => {
            onParentClose();
            setIsParentOpen(false);
          }}
          returnFocusRef={parentTriggerRef}
        >
          <button onClick={() => setIsChildOpen(true)} ref={childTriggerRef} type="button">
            Open child
          </button>
          <button type="button">Parent last action</button>
          {isChildOpen ? (
            <ModalSurface
              aria-label="Child dialog"
              onClose={() => {
                onChildClose();
                setIsChildOpen(false);
              }}
              returnFocusRef={childTriggerRef}
              role="alertdialog"
            >
              <button type="button">Child first action</button>
              <button type="button">Child last action</button>
            </ModalSurface>
          ) : null}
        </ModalSurface>
      ) : null}
    </div>
  );
}

describe("ModalSurface", () => {
  it("renders in one shared portal with an accessible name, initial focus, activity updates, and focus restore", async () => {
    const user = userEvent.setup();
    const activityListener = vi.fn();
    const unsubscribe = subscribeToModalSurfaceActivity(activityListener);
    render(<SingleModalHarness />);
    const trigger = screen.getByRole("button", { name: "Open details" });

    expect(isModalSurfaceActive()).toBe(false);
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Details" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-describedby", "details-description");
    expect(document.querySelectorAll("[data-modal-surface-root]")).toHaveLength(1);
    expect(dialog.closest("[data-modal-surface-root]")).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Preferred action" })).toHaveFocus());
    expect(isModalSurfaceActive()).toBe(true);
    expect(activityListener).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close details" }));

    expect(screen.queryByRole("dialog", { name: "Details" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(isModalSurfaceActive()).toBe(false);
    expect(activityListener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("falls back to the first focusable control and wraps Tab in both directions", async () => {
    const user = userEvent.setup();
    const disabledInitialRef = { current: null as HTMLButtonElement | null };
    render(
      <>
        <button type="button">Outside</button>
        <ModalSurface
          aria-label="Focusable dialog"
          initialFocusRef={disabledInitialRef}
          onClose={vi.fn()}
        >
          <button disabled ref={(element) => { disabledInitialRef.current = element; }} type="button">
            Disabled preference
          </button>
          <button type="button">First</button>
          <input aria-label="Middle" />
          <button type="button">Last</button>
        </ModalSurface>
      </>,
    );
    const first = await screen.findByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    await waitFor(() => expect(first).toHaveFocus());
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();

    screen.getByText("Outside").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("skips controls hidden by their own or an ancestor's computed style", async () => {
    const user = userEvent.setup();
    const hiddenInitialRef = { current: null as HTMLButtonElement | null };
    render(
      <ModalSurface
        aria-label="Styled visibility dialog"
        initialFocusRef={hiddenInitialRef}
        onClose={vi.fn()}
      >
        <div style={{ display: "none" }}>
          <button ref={(element) => { hiddenInitialRef.current = element; }} type="button">
            Hidden preferred
          </button>
        </div>
        <button style={{ display: "none" }} type="button">Hidden by self display</button>
        <div style={{ visibility: "hidden" }}>
          <button type="button">Hidden by ancestor visibility</button>
        </div>
        <button style={{ visibility: "collapse" }} type="button">Hidden by self visibility</button>
        <button type="button">First visible</button>
        <button type="button">Last visible</button>
      </ModalSurface>,
    );
    const first = await screen.findByRole("button", { name: "First visible" });
    const last = screen.getByRole("button", { name: "Last visible" });

    await waitFor(() => expect(first).toHaveFocus());
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
  });

  it("focuses the surface and contains Tab when there are no focusable descendants", async () => {
    const user = userEvent.setup();
    render(
      <ModalSurface aria-label="Empty dialog" onClose={vi.fn()}>
        <p>Nothing interactive</p>
      </ModalSurface>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Empty dialog" });

    await waitFor(() => expect(dialog).toHaveFocus());
    await user.tab();
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toHaveFocus();
  });

  it("limits Escape, Tab, and backdrop closing to the topmost nested surface", async () => {
    const user = userEvent.setup();
    const onChildClose = vi.fn();
    const onParentClose = vi.fn();
    render(<NestedModalHarness onChildClose={onChildClose} onParentClose={onParentClose} />);
    const parentTrigger = screen.getByRole("button", { name: "Open parent" });

    await user.click(parentTrigger);
    const parent = await screen.findByRole("dialog", { name: "Parent dialog" });
    const childTrigger = await screen.findByRole("button", { name: "Open child" });
    await user.click(childTrigger);

    const child = await screen.findByRole("alertdialog", { name: "Child dialog" });
    const overlays = [...document.querySelectorAll<HTMLElement>("[data-modal-surface-overlay]")];
    expect(overlays).toHaveLength(2);
    expect(overlays[0]).toHaveAttribute("inert");
    expect(overlays[0]).toHaveAttribute("aria-hidden", "true");
    expect(overlays[1]).not.toHaveAttribute("inert");

    screen.getByText("Parent last action").focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Child first action" })).toHaveFocus();

    fireEvent.mouseDown(overlays[0]!);
    expect(onParentClose).not.toHaveBeenCalled();
    expect(child).toBeInTheDocument();
    fireEvent.mouseDown(child);
    expect(onChildClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(overlays[1]!);

    expect(onChildClose).toHaveBeenCalledTimes(1);
    expect(onParentClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog", { name: "Child dialog" })).not.toBeInTheDocument();
    expect(parent).toBeInTheDocument();
    expect(childTrigger).toHaveFocus();
    expect(overlays[0]).not.toHaveAttribute("inert");
    expect(overlays[0]).not.toHaveAttribute("aria-hidden");

    await user.click(childTrigger);
    await user.keyboard("{Escape}");
    expect(onChildClose).toHaveBeenCalledTimes(2);
    expect(onParentClose).not.toHaveBeenCalled();
    expect(childTrigger).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onParentClose).toHaveBeenCalledTimes(1);
    expect(parentTrigger).toHaveFocus();
  });

  it("reference-counts body isolation, isolates dynamic siblings, and restores prior values after the last close", async () => {
    const user = userEvent.setup();
    document.body.style.overflow = "scroll";
    const preIsolatedSibling = document.createElement("aside");
    preIsolatedSibling.dataset.modalTestSibling = "pre-isolated";
    preIsolatedSibling.setAttribute("inert", "");
    preIsolatedSibling.setAttribute("aria-hidden", "false");
    document.body.append(preIsolatedSibling);
    render(<NestedModalHarness onChildClose={vi.fn()} onParentClose={vi.fn()} />);
    const background = screen.getByTestId("nested-background").parentElement!;

    await user.click(screen.getByRole("button", { name: "Open parent" }));
    expect(background).toHaveAttribute("inert");
    expect(background).toHaveAttribute("aria-hidden", "true");
    expect(preIsolatedSibling).toHaveAttribute("inert");
    expect(preIsolatedSibling).toHaveAttribute("aria-hidden", "true");
    expect(document.body.style.overflow).toBe("hidden");

    const dynamicSibling = document.createElement("div");
    dynamicSibling.dataset.modalTestSibling = "dynamic";
    dynamicSibling.setAttribute("aria-hidden", "false");
    document.body.append(dynamicSibling);
    await waitFor(() => {
      expect(dynamicSibling).toHaveAttribute("inert");
      expect(dynamicSibling).toHaveAttribute("aria-hidden", "true");
    });

    await user.click(screen.getByRole("button", { name: "Open child" }));
    await user.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe("hidden");
    expect(background).toHaveAttribute("inert");
    expect(dynamicSibling).toHaveAttribute("inert");

    await user.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe("scroll");
    expect(background).not.toHaveAttribute("inert");
    expect(background).not.toHaveAttribute("aria-hidden");
    expect(dynamicSibling).not.toHaveAttribute("inert");
    expect(dynamicSibling).toHaveAttribute("aria-hidden", "false");
    expect(preIsolatedSibling).toHaveAttribute("inert");
    expect(preIsolatedSibling).toHaveAttribute("aria-hidden", "false");
  });

  it("leaves no portal, listeners, body locks, or activity state after a StrictMode mount cycle", async () => {
    const activityListener = vi.fn();
    const unsubscribe = subscribeToModalSurfaceActivity(activityListener);
    const { unmount } = render(
      <StrictMode>
        <ModalSurface aria-label="Strict dialog" onClose={vi.fn()}>
          <button type="button">Strict action</button>
        </ModalSurface>
      </StrictMode>,
    );

    expect(await screen.findByRole("dialog", { name: "Strict dialog" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-modal-surface-root]")).toHaveLength(1);
    expect(isModalSurfaceActive()).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");

    unmount();

    expect(isModalSurfaceActive()).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.querySelector("[data-modal-surface-root]")).toBeNull();
    expect(activityListener).toHaveBeenCalled();
    const callsAfterUnmount = activityListener.mock.calls.length;
    unsubscribe();
    render(
      <ModalSurface aria-label="After unsubscribe" onClose={vi.fn()}>
        <button type="button">Action</button>
      </ModalSurface>,
    );
    expect(await screen.findByRole("dialog", { name: "After unsubscribe" })).toBeInTheDocument();
    expect(activityListener).toHaveBeenCalledTimes(callsAfterUnmount);
  });
});
