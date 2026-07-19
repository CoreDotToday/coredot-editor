import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  CollaborationParticipants,
  getAccessibleParticipantColor,
  type CollaborationAwareness,
} from "./CollaborationParticipants";

describe("CollaborationParticipants", () => {
  it("groups canonical sessions by Principal and labels the local Principal", async () => {
    const user = userEvent.setup();
    const awareness = new FakeAwareness(7, [
      [7, canonicalState("Alice", "#1d4ed8", "principal-a", "session-a1")],
      [8, canonicalState("Alice", "#1d4ed8", "principal-a", "session-a2")],
      [9, canonicalState("Bob", "#047857", "principal-b", "session-b1")],
    ]);

    render(
      <CollaborationParticipants
        awareness={awareness}
        compactLimit={1}
        language="ko"
      />,
    );

    const compactList = screen.getByRole("list", { name: "현재 참여자" });
    expect(within(compactList).getByRole("img", { name: /Alice.*현재 사용자.*2개 세션/ }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "참여자 목록 열기 (2명)" })).toHaveTextContent("+1");

    await user.click(screen.getByRole("button", { name: "참여자 목록 열기 (2명)" }));

    const details = screen.getByRole("list", { name: "참여자 세부 목록" });
    expect(within(details).getAllByRole("listitem").map((item) => item.getAttribute("aria-label"))).toEqual([
      "Alice (현재 사용자) · 2개 세션",
      "Bob · 1개 세션",
    ]);
  });

  it("keeps a current-user group when the local canonical identity is not available", async () => {
    const user = userEvent.setup();
    const awareness = new FakeAwareness(7, [
      [7, { user: { displayName: "unverified", token: "secret-token" } }],
      [9, canonicalState("Remote", "#000000", "principal-r", "session-r")],
    ]);

    render(
      <CollaborationParticipants
        awareness={awareness}
        compactLimit={1}
        language="en"
      />,
    );

    expect(screen.getByRole("img", { name: /You.*current user.*1 session/i })).toBeInTheDocument();
    expect(screen.queryByText(/unverified|secret-token/)).not.toBeInTheDocument();

    const disclosure = screen.getByRole("button", { name: "Open participant list (2 participants)" });
    disclosure.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("list", { name: "Participant details" })).toBeVisible();
  });

  it("ignores non-canonical states and never renders extra identity keys", async () => {
    const user = userEvent.setup();
    const awareness = new FakeAwareness(7, [
      [7, canonicalState("Me", "#000000", "principal-me", "session-me")],
      [8, {
        ...canonicalState("Injected", "#000000", "principal-injected", "session-injected"),
        email: "private@example.test",
      }],
      [9, {
        user: {
          ...canonicalState("Role Leak", "#000000", "principal-role", "session-role").user,
          role: "admin",
        },
      }],
      [10, canonicalState("Valid", "#000000", "principal-valid", "session-valid")],
      [11, canonicalState("Spoof\u202eresu", "#000000", "principal-bidi", "session-bidi")],
    ]);

    render(<CollaborationParticipants awareness={awareness} language="en" />);
    await user.click(screen.getByRole("button", { name: "Open participant list (2 participants)" }));

    expect(screen.getByRole("list", { name: "Participant details" })).toHaveTextContent("Me");
    expect(screen.getByRole("list", { name: "Participant details" })).toHaveTextContent("Valid");
    expect(document.body).not.toHaveTextContent(/Injected|private@example\.test|Role Leak|admin|Spoof/);
  });

  it("subscribes to Awareness changes and removes the listener on cleanup", async () => {
    const awareness = new FakeAwareness(7, [
      [7, canonicalState("Me", "#000000", "principal-me", "session-me")],
    ]);
    const { unmount } = render(
      <CollaborationParticipants awareness={awareness} language="en" />,
    );

    expect(awareness.listenerCount()).toBe(1);
    expect(screen.getByRole("button", { name: "Open participant list (1 participant)" }))
      .toBeInTheDocument();

    awareness.setState(8, canonicalState("Later", "#000000", "principal-later", "session-later"));
    awareness.emitChange();

    expect(await screen.findByRole("button", { name: "Open participant list (2 participants)" }))
      .toBeInTheDocument();

    unmount();
    expect(awareness.listenerCount()).toBe(0);
  });

  it("renders an explicit empty state while no provider Awareness is available", () => {
    render(<CollaborationParticipants awareness={null} language="ko" />);

    expect(screen.getByText("접속한 참여자가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps accepted and fallback colors above WCAG text and non-text contrast thresholds", () => {
    expect(getAccessibleParticipantColor("#000000", "principal-safe")).toBe("#000000");

    const first = getAccessibleParticipantColor("#ffffff", "principal-a");
    const repeated = getAccessibleParticipantColor("not-a-color", "principal-a");
    const second = getAccessibleParticipantColor("#ffffff", "principal-b");

    expect(first).toBe(repeated);
    expect(first).not.toBe(second);
    expect(contrastRatio(first, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(first, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(second, "#ffffff")).toBeGreaterThanOrEqual(4.5);

    const awareness = new FakeAwareness(7, [
      [7, canonicalState("Me", "#ffffff", "principal-a", "session-me")],
    ]);
    render(<CollaborationParticipants awareness={awareness} language="en" />);
    const avatar = screen.getByRole("img", { name: /Me.*current user/i });
    expect(avatar).toHaveAttribute("data-participant-color", first);
    expect(avatar).toHaveStyle({
      backgroundColor: first,
      borderColor: first,
      color: "#ffffff",
    });
  });
});

function canonicalState(
  displayName: string,
  color: string,
  principalId: string,
  sessionId: string,
) {
  return { user: { color, displayName, principalId, sessionId } };
}

class FakeAwareness implements CollaborationAwareness {
  readonly states: Map<number, Record<string, unknown>>;
  readonly #listeners = new Set<() => void>();

  constructor(
    readonly clientID: number,
    entries: Array<[number, Record<string, unknown>]>,
  ) {
    this.states = new Map(entries);
  }

  emitChange() {
    for (const listener of this.#listeners) listener();
  }

  getStates() {
    return this.states;
  }

  listenerCount() {
    return this.#listeners.size;
  }

  off(event: "change", listener: () => void) {
    if (event === "change") this.#listeners.delete(listener);
  }

  on(event: "change", listener: () => void) {
    if (event === "change") this.#listeners.add(listener);
  }

  setState(clientId: number, state: Record<string, unknown>) {
    this.states.set(clientId, state);
  }
}

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
