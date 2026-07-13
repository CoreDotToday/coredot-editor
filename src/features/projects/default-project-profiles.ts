import type { DocumentReadiness } from "@/db/schema";
import { defineProjectProfile, type ProjectMetadataField, type ProjectProfile } from "./project-profile";
import {
  BUILTIN_TEMPLATE_KEYS,
  builtinTemplateKeys,
} from "@/features/templates/builtin-template-keys";

const commonMetadataFields = [
  { filterable: true, id: "owner", labels: { en: "Owner", ko: "소유자" }, type: "text" },
  { filterable: true, id: "dueDate", labels: { en: "Due date", ko: "기한" }, type: "date" },
  { filterable: true, id: "category", labels: { en: "Category", ko: "분류" }, type: "text" },
  { filterable: true, id: "tags", labels: { en: "Tags", ko: "태그" }, type: "tags" },
] as const satisfies readonly ProjectMetadataField[];

const readinessOrder = ["draft", "needs_review", "ready", "approved"] as const satisfies readonly DocumentReadiness[];

const progressiveTransitions: Record<DocumentReadiness, readonly DocumentReadiness[]> = {
  approved: ["ready"],
  draft: ["needs_review"],
  needs_review: ["draft", "ready"],
  ready: ["needs_review", "approved"],
};

function createReadiness(
  labels: readonly [string, string, string, string],
  transitions?: Record<DocumentReadiness, readonly DocumentReadiness[]>,
) {
  return readinessOrder.map((id, index) => ({
    id,
    labels: { en: ["Draft", "Needs review", "Ready", "Approved"][index]!, ko: labels[index]! },
    transitions: transitions?.[id] ?? readinessOrder.filter((candidate) => candidate !== id),
  }));
}

export const defaultProjectProfiles = [
  defineProjectProfile({
    defaultTemplateIds: [BUILTIN_TEMPLATE_KEYS.strategyReview],
    id: "default",
    labels: { en: { name: "General documents" }, ko: { name: "일반 문서" } },
    metadataFields: commonMetadataFields,
    readiness: createReadiness(["초안", "검토 필요", "준비 완료", "승인됨"]),
  }),
  defineProjectProfile({
    defaultTemplateIds: [BUILTIN_TEMPLATE_KEYS.contractReview],
    id: "legal-review",
    labels: { en: { name: "Legal review" }, ko: { name: "법률 검토" } },
    metadataFields: [
      ...commonMetadataFields,
      { filterable: true, id: "counterparty", labels: { en: "Counterparty", ko: "상대방" }, type: "text" },
      { filterable: true, id: "agreementType", labels: { en: "Agreement type", ko: "계약 유형" }, type: "text" },
    ],
    readiness: createReadiness(["초안", "법무 검토 필요", "서명 준비", "승인됨"], progressiveTransitions),
  }),
  defineProjectProfile({
    defaultTemplateIds: [BUILTIN_TEMPLATE_KEYS.marketResearch],
    id: "research-writing",
    labels: { en: { name: "Research writing" }, ko: { name: "리서치 작성" } },
    metadataFields: [
      ...commonMetadataFields,
      { filterable: true, id: "researchQuestion", labels: { en: "Research question", ko: "연구 질문" }, type: "text" },
      { filterable: true, id: "evidenceStatus", labels: { en: "Evidence status", ko: "근거 상태" }, options: ["missing", "partial", "verified"], type: "select" },
    ],
    readiness: createReadiness(["초안", "근거 검토 필요", "출판 준비", "승인됨"], progressiveTransitions),
  }),
] as const;

export function createProjectProfileRegistry(
  profiles: readonly ProjectProfile[],
  knownTemplateIds: readonly string[],
): ReadonlyMap<string, ProjectProfile> {
  const knownTemplates = new Set(knownTemplateIds);
  const registry = new Map<string, ProjectProfile>();
  for (const profile of profiles) {
    if (registry.has(profile.id)) {
      throw new Error(`Project Profile registry has duplicate Project Profile id: ${profile.id}`);
    }
    for (const templateId of profile.defaultTemplateIds) {
      if (!knownTemplates.has(templateId)) {
        throw new Error(`Project Profile ${profile.id} references unknown default template: ${templateId}`);
      }
    }
    registry.set(profile.id, profile);
  }
  return registry;
}

const profilesById = createProjectProfileRegistry(defaultProjectProfiles, builtinTemplateKeys);

export type ProjectProfileId = (typeof defaultProjectProfiles)[number]["id"];

export function getProjectProfile(id: string): ProjectProfile {
  const profile = profilesById.get(id);
  if (!profile) throw new Error(`Unknown Project Profile: ${id}`);
  return profile;
}
