import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DocumentMetadataPanel } from "./DocumentMetadataPanel";
import type { DocumentMetadata, DocumentReadiness } from "@/db/schema";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import {
  defineProjectProfile,
  validateProjectMetadata,
  type ProjectProfile,
} from "@/features/projects/project-profile";

describe("DocumentMetadataPanel", () => {
  it("edits readiness and common metadata fields", async () => {
    const user = userEvent.setup();
    const handleMetadataFieldChange = vi.fn();
    const handleReadinessChange = vi.fn();

    function Harness() {
      const [readiness, setReadiness] = useState<DocumentReadiness>("draft");
      const [metadata, setMetadata] = useState<DocumentMetadata>({ owner: "Legal" });

      return (
        <DocumentMetadataPanel
          metadata={metadata}
          onMetadataFieldChange={(key, value) => {
            handleMetadataFieldChange(key, value);
            setMetadata((current) => {
              const next = { ...current };
              if (value === undefined) delete next[key];
              else next[key] = value;
              return next;
            });
          }}
          onReadinessChange={(next) => {
            handleReadinessChange(next);
            setReadiness(next);
          }}
          readiness={readiness}
        />
      );
    }

    render(<Harness />);

    await user.selectOptions(screen.getByRole("combobox", { name: "준비 상태" }), "ready");
    await user.clear(screen.getByRole("textbox", { name: "소유자" }));
    await user.type(screen.getByRole("textbox", { name: "소유자" }), "Finance");

    expect(handleReadinessChange).toHaveBeenCalledWith("ready");
    expect(handleMetadataFieldChange).toHaveBeenLastCalledWith("owner", "Finance");
  });

  it("renders fields and allowed readiness transitions from a Project Profile", () => {
    render(
      <DocumentMetadataPanel
        metadata={{}}
        onMetadataFieldChange={vi.fn()}
        onReadinessChange={vi.fn()}
        profile={getProjectProfile("legal-review")}
        readiness="draft"
      />,
    );

    expect(screen.getByRole("textbox", { name: "상대방" })).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
      "draft",
      "needs_review",
    ]);
  });

  it("renders select metadata options declared by the Project Profile", () => {
    render(
      <DocumentMetadataPanel
        metadata={{ evidenceStatus: "partial" }}
        onMetadataFieldChange={vi.fn()}
        onReadinessChange={vi.fn()}
        profile={getProjectProfile("research-writing")}
        readiness="draft"
      />,
    );

    expect(screen.getByRole("combobox", { name: "근거 상태" })).toHaveValue("partial");
    expect(screen.getByRole("option", { name: "verified" })).toBeInTheDocument();
  });

  it("emits booleans and finite numbers with their declared metadata types", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "typed-fields",
      labels: { en: { name: "Typed fields" }, ko: { name: "타입 필드" } },
      metadataFields: [
        { id: "billable", labels: { en: "Billable", ko: "청구 가능" }, type: "boolean" },
        { id: "estimate", labels: { en: "Estimate", ko: "예상치" }, type: "number" },
      ],
      readiness: [
        { id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: [] },
      ],
    });

    function Harness() {
      const [metadata, setMetadata] = useState<DocumentMetadata>({ billable: false });
      return (
        <DocumentMetadataPanel
          metadata={metadata}
          onMetadataFieldChange={(key, value) => {
            handleChange(key, value);
            setMetadata((current) => {
              const next = { ...current };
              if (value === undefined) delete next[key];
              else next[key] = value;
              return next;
            });
          }}
          onReadinessChange={vi.fn()}
          profile={profile}
          readiness="draft"
        />
      );
    }

    render(<Harness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "청구 가능" }), "true");
    await user.type(screen.getByRole("spinbutton", { name: "예상치" }), "12.5");

    expect(handleChange).toHaveBeenLastCalledWith("estimate", 12.5);
  });

  it("renders unset and explicit false boolean metadata as distinct values", () => {
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "required-boolean",
      labels: { en: { name: "Boolean" }, ko: { name: "불리언" } },
      metadataFields: [
        { id: "billable", labels: { en: "Billable", ko: "청구 가능" }, required: true, type: "boolean" },
      ],
      readiness: [{ id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: [] }],
    });
    const { rerender } = render(
      <DocumentMetadataPanel
        metadata={{}}
        onMetadataFieldChange={vi.fn()}
        onReadinessChange={vi.fn()}
        profile={profile}
        readiness="draft"
      />,
    );
    const input = screen.getByRole("combobox", { name: "청구 가능" });

    expect(input).toHaveValue("");
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("aria-required", "true");

    rerender(
      <DocumentMetadataPanel
        metadata={{ billable: false }}
        onMetadataFieldChange={vi.fn()}
        onReadinessChange={vi.fn()}
        profile={profile}
        readiness="draft"
      />,
    );
    expect(screen.getByRole("combobox", { name: "청구 가능" })).toHaveValue("false");
  });

  it("lets a user select false directly without collapsing it to an unset value", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "required-boolean-selection",
      labels: { en: { name: "Boolean" }, ko: { name: "불리언" } },
      metadataFields: [
        { id: "billable", labels: { en: "Billable", ko: "청구 가능" }, required: true, type: "boolean" },
      ],
      readiness: [{ id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: [] }],
    });

    const { rerender } = render(
      <DocumentMetadataPanel
        metadata={{}}
        onMetadataFieldChange={handleChange}
        onReadinessChange={vi.fn()}
        profile={profile}
        readiness="draft"
      />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "청구 가능" }), "false");

    expect(handleChange).toHaveBeenLastCalledWith("billable", false);
    expect(screen.getByRole("option", { name: "아니요" })).toHaveValue("false");

    rerender(
      <DocumentMetadataPanel
        metadata={{ billable: false }}
        onMetadataFieldChange={handleChange}
        onReadinessChange={vi.fn()}
        profile={profile}
        readiness="draft"
      />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "청구 가능" }), "");
    expect(handleChange).toHaveBeenLastCalledWith("billable", undefined);
  });

  it("renders required state and declarative text or tag caps from the profile", () => {
    const profile = defineProjectProfile({
      defaultTemplateIds: [],
      id: "field-contract",
      labels: { en: { name: "Field contract" }, ko: { name: "필드 계약" } },
      metadataFields: [
        { id: "summary", labels: { en: "Summary", ko: "요약" }, maxLength: 12, required: true, type: "text" },
        { id: "topics", itemMaxLength: 5, labels: { en: "Topics", ko: "주제" }, maxItems: 2, type: "tags" },
      ],
      readiness: [{ id: "draft", labels: { en: "Draft", ko: "초안" }, transitions: [] }],
    });

    render(
      <DocumentMetadataPanel
        metadata={{}}
        onMetadataFieldChange={vi.fn()}
        onReadinessChange={vi.fn()}
        profile={profile}
        readiness="draft"
      />,
    );

    expect(screen.getByRole("textbox", { name: "요약" })).toBeRequired();
    expect(screen.getByRole("textbox", { name: "요약" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: "요약" })).toHaveAttribute("maxlength", "12");
    expect(screen.getByText("필수 · 최대 12자")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "주제" })).toHaveAttribute("maxlength", "12");
    expect(screen.getByText("최대 2개 · 항목당 5자")).toBeInTheDocument();
  });

  it("disables readiness independently with an accessible server-authority explanation", () => {
    const handleMetadataFieldChange = vi.fn();
    const handleReadinessChange = vi.fn();

    render(
      <DocumentMetadataPanel
        metadata={{ owner: "Legal" }}
        metadataDisabled={false}
        onMetadataFieldChange={handleMetadataFieldChange}
        onReadinessChange={handleReadinessChange}
        readiness="draft"
        readinessDescription="준비 상태는 서버에서 승인됩니다."
        readinessDisabled
      />,
    );

    const readiness = screen.getByRole("combobox", { name: "준비 상태" });
    expect(readiness).toBeDisabled();
    expect(readiness).toHaveAccessibleDescription("준비 상태는 서버에서 승인됩니다.");

    const owner = screen.getByRole("textbox", { name: "소유자" });
    expect(owner).toBeEnabled();
    fireEvent.change(owner, { target: { value: "Finance" } });

    expect(handleMetadataFieldChange).toHaveBeenLastCalledWith("owner", "Finance");
    expect(handleReadinessChange).not.toHaveBeenCalled();
  });

  it("disables approval independently and announces localized workflow feedback", () => {
    render(
      <DocumentMetadataPanel
        isReadinessOptionDisabled={(next) => next === "approved"}
        metadata={{}}
        onMetadataFieldChange={vi.fn()}
        onReadinessChange={vi.fn()}
        readiness="ready"
        readinessFeedback="다른 사용자가 준비 상태를 변경했습니다."
        readinessFeedbackKind="error"
      />,
    );

    const readiness = screen.getByRole("combobox", { name: "준비 상태" });
    expect(readiness).toBeEnabled();
    expect(screen.getByRole("option", { name: "승인됨" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "초안" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("다른 사용자가 준비 상태를 변경했습니다.");
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });

  it("preserves spaces while a controlled text field receives canonical metadata after every keystroke", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    renderCanonicalHarness({
      handleChange,
      profile: getProjectProfile("research-writing"),
    });

    const owner = screen.getByRole("textbox", { name: "소유자" });
    const researchQuestion = screen.getByRole("textbox", { name: "연구 질문" });
    await user.type(owner, "Jane Doe");
    await user.type(researchQuestion, "How do teams decide?");

    expect(owner).toHaveValue("Jane Doe");
    expect(researchQuestion).toHaveValue("How do teams decide?");
    expect(handleChange).toHaveBeenCalledWith("owner", "Jane Doe");
    expect(handleChange).toHaveBeenLastCalledWith("researchQuestion", "How do teams decide?");
  });

  it("preserves tag separators while a controlled tags field receives normalized arrays", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    renderCanonicalHarness({ handleChange, profile: getProjectProfile("default") });

    const tags = screen.getByRole("textbox", { name: "태그" });
    await user.type(tags, "alpha, beta");

    expect(tags).toHaveValue("alpha, beta");
    expect(handleChange).toHaveBeenLastCalledWith("tags", ["alpha", "beta"]);
  });

  it("drops a focused draft when a different remote canonical value arrives and does not overwrite it on blur", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    let replaceMetadata: (metadata: DocumentMetadata) => void = () => {
      throw new Error("Harness is not ready");
    };

    function Harness() {
      const [metadata, setMetadata] = useState<DocumentMetadata>({ owner: "Alice" });
      replaceMetadata = setMetadata;
      return (
        <DocumentMetadataPanel
          metadata={metadata}
          onMetadataFieldChange={(key, value) => {
            handleChange(key, value);
            setMetadata((current) => normalizeMetadataChange(getProjectProfile("default"), current, key, value));
          }}
          onReadinessChange={vi.fn()}
          readiness="draft"
        />
      );
    }

    render(<Harness />);
    const owner = screen.getByRole("textbox", { name: "소유자" });
    await user.click(owner);
    await user.type(owner, " ");
    expect(owner).toHaveValue("Alice ");
    const localCallCount = handleChange.mock.calls.length;

    act(() => replaceMetadata({ owner: "Bob" }));
    expect(owner).toHaveValue("Bob");
    fireEvent.blur(owner);

    expect(handleChange).toHaveBeenCalledTimes(localCallCount);
    expect(owner).toHaveValue("Bob");
  });

  it("does not resurrect an acknowledged local value after remote canonical returns to its base", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    let replaceMetadata: (metadata: DocumentMetadata) => void = () => {
      throw new Error("Harness is not ready");
    };

    function Harness() {
      const [metadata, setMetadata] = useState<DocumentMetadata>({ owner: "Alice" });
      replaceMetadata = setMetadata;
      return (
        <DocumentMetadataPanel
          metadata={metadata}
          onMetadataFieldChange={(key, value) => {
            handleChange(key, value);
            setMetadata((current) => normalizeMetadataChange(getProjectProfile("default"), current, key, value));
          }}
          onReadinessChange={vi.fn()}
          readiness="draft"
        />
      );
    }

    render(<Harness />);
    const owner = screen.getByRole("textbox", { name: "소유자" });
    await user.click(owner);
    await user.type(owner, "X");
    expect(owner).toHaveValue("AliceX");
    expect(handleChange).toHaveBeenLastCalledWith("owner", "AliceX");

    act(() => replaceMetadata({ owner: "Alice" }));
    expect(owner).toHaveValue("Alice");
    const callCountAfterRemoteDecision = handleChange.mock.calls.length;
    fireEvent.blur(owner);

    expect(handleChange).toHaveBeenCalledTimes(callCountAfterRemoteDecision);
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(owner).toHaveValue("Alice");
  });

  it("clears focused drafts on permission downgrade and Project Profile replacement", async () => {
    const user = userEvent.setup();
    const metadata = { owner: "Alice" } satisfies DocumentMetadata;
    const defaultProfile = getProjectProfile("default");
    const replacementProfile = defineProjectProfile({
      ...defaultProfile,
      id: "replacement-profile",
      metadataFields: defaultProfile.metadataFields.map((field) => ({ ...field })),
    });
    const props = {
      metadata,
      onMetadataFieldChange: vi.fn(),
      onReadinessChange: vi.fn(),
      profile: defaultProfile,
      readiness: "draft" as const,
    };
    const { rerender } = render(<DocumentMetadataPanel {...props} />);
    const owner = screen.getByRole("textbox", { name: "소유자" });

    await user.click(owner);
    await user.type(owner, " ");
    expect(owner).toHaveValue("Alice ");

    rerender(<DocumentMetadataPanel {...props} metadataDisabled />);
    expect(screen.getByRole("textbox", { name: "소유자" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "소유자" })).toHaveValue("Alice");

    rerender(<DocumentMetadataPanel {...props} profile={defaultProfile} />);
    const enabledOwner = screen.getByRole("textbox", { name: "소유자" });
    await user.click(enabledOwner);
    await user.type(enabledOwner, " ");
    expect(enabledOwner).toHaveValue("Alice ");

    rerender(<DocumentMetadataPanel {...props} profile={replacementProfile} />);
    expect(screen.getByRole("textbox", { name: "소유자" })).toHaveValue("Alice");
  });

  it("clears a focused draft when the collaborative field-store identity rotates", async () => {
    const user = userEvent.setup();
    const firstIdentity = {};
    const props = {
      metadata: { owner: "Alice" },
      metadataDraftIdentity: firstIdentity,
      onMetadataFieldChange: vi.fn(),
      onReadinessChange: vi.fn(),
      readiness: "draft" as const,
    };
    const { rerender } = render(<DocumentMetadataPanel {...props} />);
    const owner = screen.getByRole("textbox", { name: "소유자" });
    await user.click(owner);
    await user.type(owner, " ");
    expect(owner).toHaveValue("Alice ");

    rerender(<DocumentMetadataPanel {...props} metadataDraftIdentity={{}} />);

    expect(screen.getByRole("textbox", { name: "소유자" })).toHaveValue("Alice");
  });
});

function renderCanonicalHarness({
  handleChange,
  profile,
}: {
  handleChange: (key: string, value: DocumentMetadata[string] | undefined) => void;
  profile: ProjectProfile;
}) {
  function Harness() {
    const [metadata, setMetadata] = useState<DocumentMetadata>({});
    return (
      <DocumentMetadataPanel
        metadata={metadata}
        onMetadataFieldChange={(key, value) => {
          handleChange(key, value);
          setMetadata((current) => normalizeMetadataChange(profile, current, key, value));
        }}
        onReadinessChange={vi.fn()}
        profile={profile}
        readiness="draft"
      />
    );
  }

  return render(<Harness />);
}

function normalizeMetadataChange(
  profile: ProjectProfile,
  current: DocumentMetadata,
  key: string,
  value: DocumentMetadata[string] | undefined,
) {
  const candidate = { ...current };
  if (value === undefined) delete candidate[key];
  else candidate[key] = value;
  const result = validateProjectMetadata(profile, candidate, current, { enforceRequired: false });
  if (!result.ok) throw new Error(`Invalid test metadata for ${result.fieldId}`);
  return result.value;
}
