import { describe, expect, it } from "vitest";
import { builtinTemplateKeys } from "@/features/templates/builtin-template-keys";
import {
  createDocumentFilterDefinitions,
  defineProjectProfile,
  getProjectReadinessOptions,
  isProjectReadinessTransitionAllowed,
  validateProjectDocumentState,
  validateProjectMetadata,
} from "./project-profile";
import {
  createProjectProfileRegistry,
  defaultProjectProfiles,
  getProjectProfile,
} from "./default-project-profiles";
import { resolveActiveProjectProfile } from "./active-project-profile";

describe("Project Profile", () => {
  it("derives a legal metadata filter from the same profile used by the editor", () => {
    const profile = getProjectProfile("legal-review");

    expect(profile.metadataFields.map((field) => field.id)).toContain("counterparty");
    expect(createDocumentFilterDefinitions(profile).map((filter) => filter.id)).toContain("counterparty");
  });

  it("rejects readiness transitions that reference a state outside the profile", () => {
    expect(() => defineProjectProfile({
      defaultTemplateIds: [],
      id: "invalid",
      labels: {
        en: { name: "Invalid" },
        ko: { name: "잘못됨" },
      },
      metadataFields: [],
      readiness: [{ id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: ["approved"] }],
    })).toThrow("unknown readiness transition");
  });

  it("defaults the server profile and fails fast for an unknown deployment profile", () => {
    expect(resolveActiveProjectProfile({}).id).toBe("default");
    expect(resolveActiveProjectProfile({ PROJECT_PROFILE_ID: "research-writing" }).id).toBe("research-writing");
    expect(() => resolveActiveProjectProfile({ PROJECT_PROFILE_ID: "missing-profile" }))
      .toThrow("Unknown Project Profile: missing-profile");
  });

  it("keeps every stable default template reference backed by a seeded builtin key", () => {
    const seededBuiltinKeys = new Set<string>(builtinTemplateKeys);

    for (const profile of defaultProjectProfiles) {
      expect(
        profile.defaultTemplateIds.filter((builtinKey) => !seededBuiltinKeys.has(builtinKey)),
        `${profile.id} references an unknown seeded builtin template`,
      ).toEqual([]);
    }
  });

  it("rejects duplicate profile identifiers while building the production registry", () => {
    const profile = getProjectProfile("default");

    expect(() => createProjectProfileRegistry([profile, profile], builtinTemplateKeys))
      .toThrow("duplicate Project Profile id");
  });

  it("rejects unknown builtin template references while building the production registry", () => {
    const profile = defineProjectProfile({
      defaultTemplateIds: ["missing-builtin-template"],
      id: "unknown-template",
      labels: { en: { name: "Unknown" }, ko: { name: "알 수 없음" } },
      metadataFields: [],
      readiness: [{ id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: [] }],
    });

    expect(() => createProjectProfileRegistry([profile], builtinTemplateKeys))
      .toThrow("unknown default template");
  });

  it("validates declared field types while preserving unknown legacy metadata", () => {
    const profile = getProjectProfile("legal-review");
    const result = validateProjectMetadata(
      profile,
      { counterparty: " Core Dot " },
      { legacyWorkflow: "keep-me" },
    );

    expect(result).toEqual({
      ok: true,
      value: { counterparty: "Core Dot", legacyWorkflow: "keep-me" },
    });
    expect(validateProjectMetadata(profile, { counterparty: 42 }, {})).toEqual({
      fieldId: "counterparty",
      ok: false,
      reason: "invalid_type",
    });
  });

  it("exposes only the current and allowed next readiness states", () => {
    const profile = getProjectProfile("legal-review");

    expect(getProjectReadinessOptions(profile, "draft").map((state) => state.id)).toEqual([
      "draft",
      "needs_review",
    ]);
    expect(isProjectReadinessTransitionAllowed(profile, "draft", "approved")).toBe(false);
  });

  it("rejects empty identifiers and labels in a profile definition", () => {
    const createProfile = () => ({
      defaultTemplateIds: [],
      id: "profile",
      labels: { en: { name: "Profile" }, ko: { name: "프로필" } },
      metadataFields: [
        { id: "owner", labels: { en: "Owner", ko: "소유자" }, type: "text" as const },
      ],
      readiness: [
        { id: "draft" as const, labels: { en: "Draft", ko: "초안" }, transitions: [] },
      ],
    });

    expect(() => defineProjectProfile({ ...createProfile(), id: " " })).toThrow("profile id");
    expect(() => defineProjectProfile({
      ...createProfile(),
      metadataFields: [{ ...createProfile().metadataFields[0]!, id: "" }],
    })).toThrow("metadata field id");
    expect(() => defineProjectProfile({
      ...createProfile(),
      labels: { ...createProfile().labels, ko: { name: " " } },
    })).toThrow("profile label");
    expect(() => defineProjectProfile({
      ...createProfile(),
      metadataFields: [{ ...createProfile().metadataFields[0]!, labels: { en: "", ko: "소유자" } }],
    })).toThrow("metadata field label");
  });

  it("rejects duplicate template defaults and select options", () => {
    const base = {
      defaultTemplateIds: ["template-a"],
      id: "profile",
      labels: { en: { name: "Profile" }, ko: { name: "프로필" } },
      metadataFields: [],
      readiness: [
        { id: "draft" as const, labels: { en: "Draft", ko: "초안" }, transitions: [] },
      ],
    };

    expect(() => defineProjectProfile({ ...base, defaultTemplateIds: ["template-a", "template-a"] }))
      .toThrow("duplicate default templates");
    expect(() => defineProjectProfile({
      ...base,
      metadataFields: [{
        id: "status",
        labels: { en: "Status", ko: "상태" },
        options: ["open", "open"],
        type: "select",
      }],
    })).toThrow("duplicate options");
  });

  it("requires draft to be the initial readiness state", () => {
    const base = {
      defaultTemplateIds: [],
      id: "profile",
      labels: { en: { name: "Profile" }, ko: { name: "프로필" } },
      metadataFields: [],
    };
    expect(() => defineProjectProfile({
      ...base,
      readiness: [{ id: "ready", labels: { en: "Ready", ko: "준비" }, transitions: [] }],
    })).toThrow("initial readiness state must be draft");
    expect(() => defineProjectProfile({
      ...base,
      readiness: [
        { id: "ready", labels: { en: "Ready", ko: "준비" }, transitions: ["draft"] },
        { id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: ["ready"] },
      ],
    })).toThrow("initial readiness state must be draft");
  });

  it("rejects impossible dates and bounded text or tags", () => {
    const profile = getProjectProfile("default");

    expect(validateProjectMetadata(profile, { dueDate: "2025-02-30" })).toEqual({
      fieldId: "dueDate",
      ok: false,
      reason: "invalid_type",
    });
    expect(validateProjectMetadata(profile, { owner: "x".repeat(2_001) })).toEqual({
      fieldId: "owner",
      ok: false,
      reason: "invalid_length",
    });
    expect(validateProjectMetadata(profile, { tags: Array.from({ length: 33 }, (_, index) => `tag-${index}`) }))
      .toEqual({ fieldId: "tags", ok: false, reason: "invalid_length" });
    expect(validateProjectMetadata(profile, { tags: ["x".repeat(65)] })).toEqual({
      fieldId: "tags",
      ok: false,
      reason: "invalid_length",
    });
  });

  it("allows incomplete draft metadata but requires declared fields before leaving draft", () => {
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "required-transition",
      labels: { en: { name: "Required" }, ko: { name: "필수" } },
      metadataFields: [
        { id: "owner", labels: { en: "Owner", ko: "소유자" }, maxLength: 12, required: true, type: "text" },
      ],
      readiness: [
        { id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: ["needs_review"] },
        { id: "needs_review", labels: { en: "Review", ko: "검토" }, transitions: ["draft"] },
      ],
    });

    expect(validateProjectDocumentState(profile, { metadataJson: {}, readiness: "draft" })).toEqual({
      ok: true,
      value: { metadataJson: {}, readiness: "draft" },
    });
    expect(validateProjectDocumentState(
      profile,
      { metadataJson: {}, readiness: "needs_review" },
      { metadataJson: {}, readiness: "draft" },
    )).toEqual({ ok: false, violation: { fieldId: "owner", ok: false, reason: "required" } });
    expect(validateProjectDocumentState(
      profile,
      { metadataJson: {}, readiness: "draft" },
      { metadataJson: {}, readiness: "needs_review" },
    )).toEqual({ ok: true, value: { metadataJson: {}, readiness: "draft" } });
  });

  it("enforces per-profile text and tag caps even for incomplete drafts", () => {
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "custom-caps",
      labels: { en: { name: "Caps" }, ko: { name: "제한" } },
      metadataFields: [
        { id: "summary", labels: { en: "Summary", ko: "요약" }, maxLength: 5, type: "text" },
        { id: "tags", itemMaxLength: 3, labels: { en: "Tags", ko: "태그" }, maxItems: 2, type: "tags" },
      ],
      readiness: [{ id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: [] }],
    });

    expect(validateProjectDocumentState(profile, { metadataJson: { summary: "123456" }, readiness: "draft" }))
      .toEqual({ ok: false, violation: { fieldId: "summary", ok: false, reason: "invalid_length" } });
    expect(validateProjectDocumentState(profile, { metadataJson: { tags: ["one", "two", "tri"] }, readiness: "draft" }))
      .toEqual({ ok: false, violation: { fieldId: "tags", ok: false, reason: "invalid_length" } });
    expect(validateProjectDocumentState(profile, { metadataJson: { tags: ["long"] }, readiness: "draft" }))
      .toEqual({ ok: false, violation: { fieldId: "tags", ok: false, reason: "invalid_length" } });
  });

  it("rejects unsafe or type-incompatible declarative field caps", () => {
    const profile = {
      defaultTemplateIds: [],
      id: "invalid-caps",
      labels: { en: { name: "Invalid" }, ko: { name: "잘못됨" } },
      readiness: [{ id: "draft" as const, labels: { en: "Draft", ko: "초안" }, transitions: [] }],
    };

    expect(() => defineProjectProfile({
      ...profile,
      metadataFields: [{ id: "summary", labels: { en: "Summary", ko: "요약" }, maxLength: 0, type: "text" }],
    })).toThrow("maxLength");
    expect(() => defineProjectProfile({
      ...profile,
      metadataFields: [{ id: "summary", labels: { en: "Summary", ko: "요약" }, maxLength: 2_001, type: "text" }],
    })).toThrow("maxLength");
    expect(() => defineProjectProfile({
      ...profile,
      metadataFields: [{ id: "tags", itemMaxLength: 0, labels: { en: "Tags", ko: "태그" }, maxItems: 33, type: "tags" }],
    })).toThrow(/maxItems|itemMaxLength/u);
    expect(() => defineProjectProfile({
      ...profile,
      metadataFields: [{ id: "score", labels: { en: "Score", ko: "점수" }, maxLength: 5, type: "number" } as never],
    })).toThrow("cannot define");
  });

  it("returns a deeply immutable profile snapshot", () => {
    const profile = getProjectProfile("legal-review");

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.defaultTemplateIds)).toBe(true);
    expect(Object.isFrozen(profile.labels)).toBe(true);
    expect(Object.isFrozen(profile.labels.ko)).toBe(true);
    expect(Object.isFrozen(profile.metadataFields)).toBe(true);
    expect(Object.isFrozen(profile.metadataFields[0])).toBe(true);
    expect(Object.isFrozen(profile.metadataFields[0]!.labels)).toBe(true);
    expect(Object.isFrozen(profile.readiness)).toBe(true);
    expect(Object.isFrozen(profile.readiness[0])).toBe(true);
    expect(Object.isFrozen(profile.readiness[0]!.transitions)).toBe(true);
  });
});
