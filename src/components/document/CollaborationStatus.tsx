"use client";

import type { CollaborationSessionSnapshot } from "@/features/collaboration/client/session-store";
import type { EditorLanguage } from "@/features/i18n/editor-language";

type CollaborationStatusProps = {
  className?: string;
  language?: EditorLanguage;
  snapshot: CollaborationSessionSnapshot;
};

const STATUS_DOT_CLASSES: Record<CollaborationSessionSnapshot["status"], string> = {
  authorization_expired: "bg-amber-500",
  connecting: "bg-sky-500",
  fatal: "bg-rose-600",
  offline_pending: "bg-amber-500",
  read_only: "bg-slate-500",
  reconnecting: "bg-sky-500",
  storage_delayed: "bg-amber-500",
  synced: "bg-emerald-600",
};

export function CollaborationStatus({
  className = "",
  language = "ko",
  snapshot,
}: CollaborationStatusProps) {
  const pendingCount = snapshot.pendingLocalUpdateCount
    + snapshot.pendingLocalChecksums.length
    + snapshot.pendingDurableAcknowledgementChecksums.length;
  const message = getStatusMessage(language, snapshot.status, pendingCount);

  return (
    <span
      aria-atomic="true"
      aria-live="polite"
      className={`inline-flex min-w-0 items-center gap-2 text-xs text-slate-600 ${className}`.trim()}
      data-collaboration-status={snapshot.status}
      role="status"
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${STATUS_DOT_CLASSES[snapshot.status]}`}
      />
      <span>{message}</span>
    </span>
  );
}

function getStatusMessage(
  language: EditorLanguage,
  status: CollaborationSessionSnapshot["status"],
  pendingCount: number,
) {
  if (language === "en") return getEnglishStatusMessage(status, pendingCount);
  return getKoreanStatusMessage(status, pendingCount);
}

function getKoreanStatusMessage(
  status: CollaborationSessionSnapshot["status"],
  pendingCount: number,
) {
  switch (status) {
    case "authorization_expired":
      return "접근 권한이 만료되었습니다. 다시 인증하는 중입니다.";
    case "connecting":
      return "공동 편집에 연결 중입니다.";
    case "fatal":
      return "동기화를 계속할 수 없습니다. 페이지를 새로 고치거나 관리자에게 문의하세요.";
    case "offline_pending":
      return pendingCount > 0
        ? `오프라인입니다. 변경 ${pendingCount}건이 이 탭에 남아 있으며 다시 연결되면 병합됩니다.`
        : "오프라인입니다. 다시 연결되면 변경 사항을 병합합니다.";
    case "read_only":
      return "읽기 전용입니다. 접근 권한 또는 문서 형식이 변경되었습니다.";
    case "reconnecting":
      return "연결이 끊겨 다시 연결하는 중입니다.";
    case "storage_delayed":
      return pendingCount > 0
        ? `저장소 응답이 지연되고 있습니다. 변경 ${pendingCount}건의 영구 저장을 기다리는 중입니다.`
        : "저장소 응답이 지연되고 있습니다. 영구 저장을 확인하는 중입니다.";
    case "synced":
      return pendingCount > 0
        ? `동기화되었습니다. 변경 ${pendingCount}건의 영구 저장을 확인하는 중입니다.`
        : "동기화 및 영구 저장이 완료되었습니다.";
  }
}

function getEnglishStatusMessage(
  status: CollaborationSessionSnapshot["status"],
  pendingCount: number,
) {
  const changes = `${pendingCount} ${pendingCount === 1 ? "change" : "changes"}`;
  switch (status) {
    case "authorization_expired":
      return "Your authorization has expired. Reauthenticating.";
    case "connecting":
      return "Connecting to collaboration.";
    case "fatal":
      return "Cannot continue synchronizing. Refresh the page or contact an administrator.";
    case "offline_pending":
      return pendingCount > 0
        ? `You are offline. ${changes} remain in this tab and will merge after reconnecting.`
        : "You are offline. Changes will merge after reconnecting.";
    case "read_only":
      return "This document is read-only because access or its schema changed.";
    case "reconnecting":
      return "The connection was interrupted. Reconnecting.";
    case "storage_delayed":
      return pendingCount > 0
        ? `Storage is delayed. Waiting to durably save ${changes}.`
        : "Storage is delayed. Confirming durable storage.";
    case "synced":
      return pendingCount > 0
        ? `Synchronized. Confirming durable storage for ${changes}.`
        : "Synchronized and durably saved.";
  }
}
