"use client";

import { useEffect, useId, useState } from "react";

import type { EditorLanguage } from "@/features/i18n/editor-language";

export type CollaborationAwareness = {
  readonly clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  off(event: "change", listener: () => void): void;
  on(event: "change", listener: () => void): void;
};

type CollaborationParticipantsProps = {
  awareness: CollaborationAwareness | null;
  className?: string;
  compactLimit?: number;
  language?: EditorLanguage;
};

type CanonicalIdentity = {
  color: string;
  displayName: string;
  principalId: string;
  sessionId: string;
};

type Participant = {
  color: string;
  current: boolean;
  displayName: string;
  principalId: string;
  sessionIds: Set<string>;
};

const MAX_CANONICAL_STATES = 64;
const MAX_SESSIONS_PER_PRINCIPAL = 8;
const MAX_IDENTITY_CODE_UNITS = 128;
const IDENTITY_FORMAT_CONTROLS = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const FALLBACK_COLORS = ["#1d4ed8", "#047857", "#7c3aed", "#b45309", "#be123c"] as const;
const WHITE = "#ffffff";

const labels = {
  en: {
    closeList: (count: number) => `Close participant list (${participantCount(count, "en")})`,
    compactList: "Current participants",
    currentUser: "current user",
    details: "Participant details",
    empty: "No participants are connected.",
    listAction: "List",
    openList: (count: number) => `Open participant list (${participantCount(count, "en")})`,
    region: "Document collaboration participants",
    sessionCount: (count: number) => `${count} ${count === 1 ? "session" : "sessions"}`,
    you: "You",
  },
  ko: {
    closeList: (count: number) => `참여자 목록 닫기 (${count}명)`,
    compactList: "현재 참여자",
    currentUser: "현재 사용자",
    details: "참여자 세부 목록",
    empty: "접속한 참여자가 없습니다.",
    listAction: "목록",
    openList: (count: number) => `참여자 목록 열기 (${count}명)`,
    region: "문서 공동 편집 참여자",
    sessionCount: (count: number) => `${count}개 세션`,
    you: "나",
  },
} as const;

export function CollaborationParticipants({
  awareness,
  className = "",
  compactLimit = 3,
  language = "ko",
}: CollaborationParticipantsProps) {
  const [, setAwarenessRevision] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  useEffect(() => {
    if (!awareness) return;
    const handleChange = () => setAwarenessRevision((revision) => revision + 1);
    awareness.on("change", handleChange);
    return () => awareness.off("change", handleChange);
  }, [awareness]);

  const participants = collectParticipants(awareness, language);
  const copy = labels[language];

  if (!awareness) {
    return (
      <section
        aria-label={copy.region}
        className={`text-xs text-slate-500 ${className}`.trim()}
      >
        <p>{copy.empty}</p>
      </section>
    );
  }

  const visibleLimit = Number.isSafeInteger(compactLimit)
    ? Math.min(8, Math.max(1, compactLimit))
    : 3;
  const compactParticipants = participants.slice(0, visibleLimit);
  const overflow = Math.max(0, participants.length - compactParticipants.length);

  return (
    <section
      aria-label={copy.region}
      className={`relative inline-flex items-center gap-2 ${className}`.trim()}
    >
      <ul aria-label={copy.compactList} className="flex -space-x-2" role="list">
        {compactParticipants.map((participant) => (
          <li key={participant.principalId}>
            <ParticipantAvatar copy={copy} participant={participant} />
          </li>
        ))}
      </ul>

      <button
        aria-controls={detailsId}
        aria-expanded={expanded}
        aria-label={expanded
          ? copy.closeList(participants.length)
          : copy.openList(participants.length)}
        className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-800"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {overflow > 0 ? `+${overflow}` : copy.listAction}
      </button>

      <ul
        aria-label={copy.details}
        className="absolute right-0 top-full z-30 mt-2 min-w-60 space-y-1 rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-800 shadow-lg"
        hidden={!expanded}
        id={detailsId}
      >
        {participants.map((participant) => {
          const sessionCount = participant.sessionIds.size;
          return (
            <li
              aria-label={participantDetailLabel(participant, copy)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5"
              key={participant.principalId}
            >
              <ParticipantAvatar copy={copy} decorative participant={participant} />
              <span>
                {participant.displayName}
                {participant.current ? ` (${copy.currentUser})` : ""}
                {` · ${copy.sessionCount(sessionCount)}`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ParticipantAvatar({
  copy,
  decorative = false,
  participant,
}: {
  copy: (typeof labels)[EditorLanguage];
  decorative?: boolean;
  participant: Participant;
}) {
  const sessionCount = participant.sessionIds.size;
  const accessibleName = [
    participant.displayName,
    participant.current ? copy.currentUser : null,
    copy.sessionCount(sessionCount),
  ].filter(Boolean).join(", ");

  return (
    <span
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : accessibleName}
      className="inline-flex size-8 items-center justify-center rounded-full border-2 text-xs font-bold uppercase shadow-sm ring-2 ring-white"
      data-participant-color={participant.color}
      role={decorative ? undefined : "img"}
      style={{
        backgroundColor: participant.color,
        borderColor: participant.color,
        color: WHITE,
      }}
    >
      {firstGrapheme(participant.displayName)}
    </span>
  );
}

function participantDetailLabel(
  participant: Participant,
  copy: (typeof labels)[EditorLanguage],
) {
  return `${participant.displayName}${participant.current ? ` (${copy.currentUser})` : ""} · ${copy.sessionCount(participant.sessionIds.size)}`;
}

function collectParticipants(
  awareness: CollaborationAwareness | null,
  language: EditorLanguage,
): Participant[] {
  if (!awareness) return [];
  const groups = new Map<string, Participant>();
  const allStates = awareness.getStates();
  const localState = allStates.get(awareness.clientID);
  const states = [
    ...(localState ? [[awareness.clientID, localState] as const] : []),
    ...[...allStates.entries()]
      .filter(([clientId]) => clientId !== awareness.clientID)
      .toSorted(([left], [right]) => left - right),
  ].slice(0, MAX_CANONICAL_STATES);
  let foundCanonicalLocalState = false;

  for (const [clientId, state] of states) {
    const identity = parseCanonicalIdentity(state);
    if (!identity) continue;
    const current = clientId === awareness.clientID;
    if (current) foundCanonicalLocalState = true;
    const existing = groups.get(identity.principalId);
    if (existing) {
      if (existing.sessionIds.size < MAX_SESSIONS_PER_PRINCIPAL) {
        existing.sessionIds.add(identity.sessionId);
      }
      existing.current ||= current;
      continue;
    }
    groups.set(identity.principalId, {
      color: getAccessibleParticipantColor(identity.color, identity.principalId),
      current,
      displayName: identity.displayName,
      principalId: identity.principalId,
      sessionIds: new Set([identity.sessionId]),
    });
  }

  if (!foundCanonicalLocalState) {
    const principalId = `__local_unverified__:${awareness.clientID}`;
    groups.set(principalId, {
      color: getAccessibleParticipantColor("", principalId),
      current: true,
      displayName: labels[language].you,
      principalId,
      sessionIds: new Set([principalId]),
    });
  }

  return [...groups.values()].toSorted(compareParticipants);
}

function parseCanonicalIdentity(state: Record<string, unknown>): CanonicalIdentity | null {
  if (!isRecord(state)) return null;
  const stateKeys = Object.keys(state).toSorted();
  if (
    stateKeys.join(",") !== "user"
    && stateKeys.join(",") !== "cursor,user"
  ) return null;
  if ("cursor" in state && state.cursor !== null && !isRecord(state.cursor)) return null;
  if (!isRecord(state.user)) return null;
  if (Object.keys(state.user).toSorted().join(",") !== "color,displayName,principalId,sessionId") {
    return null;
  }
  const { color, displayName, principalId, sessionId } = state.user;
  if (
    !isBoundedIdentityString(displayName)
    || !isBoundedIdentityString(principalId)
    || !isBoundedIdentityString(sessionId)
    || typeof color !== "string"
    || !/^#[0-9a-f]{6}$/i.test(color)
  ) return null;
  return { color, displayName, principalId, sessionId };
}

function isBoundedIdentityString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim().length > 0
    && value.length <= MAX_IDENTITY_CODE_UNITS
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    && !IDENTITY_FORMAT_CONTROLS.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareParticipants(left: Participant, right: Participant) {
  if (left.current !== right.current) return left.current ? -1 : 1;
  const nameComparison = compareText(left.displayName, right.displayName);
  return nameComparison || compareText(left.principalId, right.principalId);
}

function compareText(left: string, right: string) {
  const normalizedLeft = left.normalize("NFKC").toLocaleLowerCase("en");
  const normalizedRight = right.normalize("NFKC").toLocaleLowerCase("en");
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function firstGrapheme(value: string) {
  return Array.from(value.trim())[0] ?? "?";
}

export function getAccessibleParticipantColor(color: string, principalId: string) {
  const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : null;
  if (normalized && contrastRatio(normalized, WHITE) >= 4.5) return normalized;
  return FALLBACK_COLORS[stableHash(principalId) % FALLBACK_COLORS.length];
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function contrastRatio(left: string, right: string) {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (Math.max(leftLuminance, rightLuminance) + 0.05)
    / (Math.min(leftLuminance, rightLuminance) + 0.05);
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => (
    Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  ));
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function participantCount(count: number, language: "en" | "ko") {
  if (language === "ko") return `${count}명`;
  return `${count} ${count === 1 ? "participant" : "participants"}`;
}
