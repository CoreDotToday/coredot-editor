import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DocumentMetadataPanel } from "./DocumentMetadataPanel";
import type { DocumentMetadata, DocumentReadiness } from "@/db/schema";

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
});
