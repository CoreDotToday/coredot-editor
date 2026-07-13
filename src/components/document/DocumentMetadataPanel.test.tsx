import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DocumentMetadataPanel } from "./DocumentMetadataPanel";
import type { DocumentMetadata, DocumentReadiness } from "@/db/schema";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import { defineProjectProfile } from "@/features/projects/project-profile";

describe("DocumentMetadataPanel", () => {
  it("edits readiness and common metadata fields", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    function Harness() {
      const [readiness, setReadiness] = useState<DocumentReadiness>("draft");
      const [metadata, setMetadata] = useState<DocumentMetadata>({ owner: "Legal" });

      return (
        <DocumentMetadataPanel
          metadata={metadata}
          onChange={(change) => {
            handleChange(change);
            if (change.readiness) setReadiness(change.readiness);
            if (change.metadataJson) setMetadata(change.metadataJson);
          }}
          readiness={readiness}
        />
      );
    }

    render(<Harness />);

    await user.selectOptions(screen.getByRole("combobox", { name: "준비 상태" }), "ready");
    await user.clear(screen.getByRole("textbox", { name: "소유자" }));
    await user.type(screen.getByRole("textbox", { name: "소유자" }), "Finance");

    expect(handleChange).toHaveBeenCalledWith({ readiness: "ready" });
    expect(handleChange).toHaveBeenLastCalledWith({ metadataJson: { owner: "Finance" } });
  });

  it("renders fields and allowed readiness transitions from a Project Profile", () => {
    render(
      <DocumentMetadataPanel
        metadata={{}}
        onChange={vi.fn()}
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
        onChange={vi.fn()}
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
          onChange={(change) => {
            handleChange(change);
            if (change.metadataJson) setMetadata(change.metadataJson);
          }}
          profile={profile}
          readiness="draft"
        />
      );
    }

    render(<Harness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "청구 가능" }), "true");
    await user.type(screen.getByRole("spinbutton", { name: "예상치" }), "12.5");

    expect(handleChange).toHaveBeenLastCalledWith({
      metadataJson: { billable: true, estimate: 12.5 },
    });
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
      <DocumentMetadataPanel metadata={{}} onChange={vi.fn()} profile={profile} readiness="draft" />,
    );
    const input = screen.getByRole("combobox", { name: "청구 가능" });

    expect(input).toHaveValue("");
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("aria-required", "true");

    rerender(
      <DocumentMetadataPanel metadata={{ billable: false }} onChange={vi.fn()} profile={profile} readiness="draft" />,
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
      <DocumentMetadataPanel metadata={{}} onChange={handleChange} profile={profile} readiness="draft" />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "청구 가능" }), "false");

    expect(handleChange).toHaveBeenLastCalledWith({ metadataJson: { billable: false } });
    expect(screen.getByRole("option", { name: "아니요" })).toHaveValue("false");

    rerender(
      <DocumentMetadataPanel
        metadata={{ billable: false }}
        onChange={handleChange}
        profile={profile}
        readiness="draft"
      />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "청구 가능" }), "");
    expect(handleChange).toHaveBeenLastCalledWith({ metadataJson: {} });
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
      <DocumentMetadataPanel metadata={{}} onChange={vi.fn()} profile={profile} readiness="draft" />,
    );

    expect(screen.getByRole("textbox", { name: "요약" })).toBeRequired();
    expect(screen.getByRole("textbox", { name: "요약" })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: "요약" })).toHaveAttribute("maxlength", "12");
    expect(screen.getByText("필수 · 최대 12자")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "주제" })).toHaveAttribute("maxlength", "12");
    expect(screen.getByText("최대 2개 · 항목당 5자")).toBeInTheDocument();
  });
});
