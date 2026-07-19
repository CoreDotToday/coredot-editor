import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  CollaborationSessionSnapshot,
  CollaborationSessionStatus,
} from "@/features/collaboration/client/session-store";

import { CollaborationStatus } from "./CollaborationStatus";

const expectedMessages: Record<
  "en" | "ko",
  Record<CollaborationSessionStatus, RegExp>
> = {
  en: {
    authorization_expired: /authorization has expired/i,
    connecting: /connecting/i,
    fatal: /cannot continue synchronizing/i,
    offline_pending: /offline.*2 changes.*merge/i,
    read_only: /read-only/i,
    reconnecting: /reconnecting/i,
    storage_delayed: /storage is delayed.*2 changes/i,
    synced: /synchronized and durably saved/i,
  },
  ko: {
    authorization_expired: /접근 권한이 만료되었습니다/,
    connecting: /연결 중입니다/,
    fatal: /동기화를 계속할 수 없습니다/,
    offline_pending: /오프라인.*변경 2건.*병합/,
    read_only: /읽기 전용입니다/,
    reconnecting: /다시 연결하는 중입니다/,
    storage_delayed: /저장소 응답이 지연.*변경 2건/,
    synced: /동기화 및 영구 저장이 완료되었습니다/,
  },
};

describe("CollaborationStatus", () => {
  it.each(["ko", "en"] as const)(
    "announces all eight session states in %s",
    (language) => {
      const statuses = Object.keys(expectedMessages[language]) as CollaborationSessionStatus[];
      const { rerender } = render(
        <CollaborationStatus
          language={language}
          snapshot={snapshotFor(statuses[0])}
        />,
      );

      for (const status of statuses) {
        rerender(
          <CollaborationStatus
            language={language}
            snapshot={snapshotFor(status, status === "offline_pending" || status === "storage_delayed")}
          />,
        );

        const announcement = screen.getByRole("status");
        expect(announcement).toHaveAttribute("aria-live", "polite");
        expect(announcement).toHaveAttribute("data-collaboration-status", status);
        expect(announcement).toHaveTextContent(expectedMessages[language][status]);
      }
    },
  );

  it("announces the total number of updates awaiting local processing or durable acknowledgement", () => {
    render(
      <CollaborationStatus
        language="ko"
        snapshot={{
          ...snapshotFor("synced"),
          pendingDurableAcknowledgementChecksums: ["a".repeat(64), "b".repeat(64)],
          pendingLocalChecksums: ["c".repeat(64)],
          pendingLocalUpdateCount: 2,
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/변경 5건의 영구 저장을 확인/);
    expect(screen.getByRole("status")).not.toHaveTextContent("a".repeat(64));
    expect(screen.getByRole("status")).not.toHaveTextContent("b".repeat(64));
    expect(screen.getByRole("status")).not.toHaveTextContent("c".repeat(64));
  });
});

function snapshotFor(
  status: CollaborationSessionStatus,
  pending = false,
): CollaborationSessionSnapshot {
  return {
    hasCompletedInitialSync: status !== "connecting",
    pendingDurableAcknowledgementChecksums: pending ? ["a".repeat(64)] : [],
    pendingLocalChecksums: pending ? ["b".repeat(64)] : [],
    pendingLocalUpdateCount: 0,
    permission: status === "read_only" ? "read" : "write",
    status,
    transportSynced: status === "synced" || status === "read_only",
    writable: status === "synced" || status === "storage_delayed",
  };
}
