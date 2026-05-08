import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptTemplateRecord } from "@/db/schema";
import { PromptTemplateManager } from "./PromptTemplateManager";

afterEach(() => {
  vi.restoreAllMocks();
});

function createTemplate(overrides: Partial<PromptTemplateRecord> = {}): PromptTemplateRecord {
  return {
    id: "tpl_1",
    name: "Strategy Review",
    description: "Review strategy",
    category: "strategy_review",
    systemPrompt: "You are a strategy editor.",
    variableSchemaJson: { fields: [], required: [] },
    isDefault: true,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createDeferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });

  return { promise, reject, resolve };
}

describe("PromptTemplateManager", () => {
  it("renders editable template fields", () => {
    render(
      <PromptTemplateManager
        templates={[
          createTemplate(),
        ]}
      />,
    );

    expect(screen.getByDisplayValue("Strategy Review")).toBeInTheDocument();
    expect(screen.getByDisplayValue("You are a strategy editor.")).toBeInTheDocument();
  });

  it("does not let an older save response replace the draft after selecting another template", async () => {
    const user = userEvent.setup();
    const deferredSave = createDeferredResponse();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferredSave.promise);

    render(
      <PromptTemplateManager
        templates={[
          createTemplate({ id: "tpl_1", name: "Strategy Review" }),
          createTemplate({
            id: "tpl_2",
            name: "Board Review",
            category: "board_review",
            systemPrompt: "You are a board editor.",
          }),
        ]}
      />,
    );

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Strategy Review v2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: /Board Review/ }));

    await act(async () => {
      deferredSave.resolve(
        new Response(
          JSON.stringify({
            template: createTemplate({ id: "tpl_1", name: "Strategy Review v2" }),
          }),
        ),
      );
      await deferredSave.promise;
    });

    expect(screen.getByLabelText("Name")).toHaveValue("Board Review");
    expect(screen.getByDisplayValue("You are a board editor.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Strategy Review v2/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Strategy Review/ })).toBeInTheDocument();
  });

  it("creates a new template from the manager", async () => {
    const user = userEvent.setup();
    const createdTemplate = createTemplate({
      id: "tpl_created",
      name: "Board Brief",
      description: "Draft board brief",
      category: "custom",
      systemPrompt: "You write board briefs.",
      isDefault: false,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ template: createdTemplate }), { status: 201 }));

    render(<PromptTemplateManager templates={[createTemplate()]} />);

    await user.click(screen.getByRole("button", { name: "New template" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Board Brief");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "Draft board brief");
    await user.clear(screen.getByLabelText("System prompt"));
    await user.type(screen.getByLabelText("System prompt"), "You write board briefs.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/templates",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Board Brief");
  });

  it("continues saving a pending created template with PUT after local edits", async () => {
    const user = userEvent.setup();
    const deferredCreate = createDeferredResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(deferredCreate.promise)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            template: createTemplate({
              id: "tpl_created",
              name: "Board Brief v2",
              description: "Draft board brief",
              category: "custom",
              systemPrompt: "You write board briefs.",
              isDefault: false,
            }),
          }),
        ),
      );

    render(<PromptTemplateManager templates={[createTemplate()]} />);

    await user.click(screen.getByRole("button", { name: "New template" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Board Brief");
    await user.clear(screen.getByLabelText("System prompt"));
    await user.type(screen.getByLabelText("System prompt"), "You write board briefs.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(screen.getByLabelText("Name"), " v2");

    await act(async () => {
      deferredCreate.resolve(
        new Response(
          JSON.stringify({
            template: createTemplate({
              id: "tpl_created",
              name: "Board Brief",
              description: "Draft board brief",
              category: "custom",
              systemPrompt: "You write board briefs.",
              isDefault: false,
            }),
          }),
          { status: 201 },
        ),
      );
      await deferredCreate.promise;
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/templates", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/templates/tpl_created",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("keeps save disabled while a create request is in flight", async () => {
    const user = userEvent.setup();
    const deferredCreate = createDeferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(deferredCreate.promise);

    render(<PromptTemplateManager templates={[createTemplate()]} />);

    await user.click(screen.getByRole("button", { name: "New template" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Board Brief");
    await user.clear(screen.getByLabelText("System prompt"));
    await user.type(screen.getByLabelText("System prompt"), "You write board briefs.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(screen.getByLabelText("Name"), " v2");

    const saveButton = screen.getByRole("button", { name: /Save|Saving/ });
    expect(saveButton).toBeDisabled();

    await user.click(saveButton);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows validation errors before save", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    render(<PromptTemplateManager templates={[createTemplate()]} />);

    await user.clear(screen.getByLabelText("Name"));
    await user.clear(screen.getByLabelText("System prompt"));
    await user.clear(screen.getByLabelText("Variable schema JSON"));
    fireEvent.change(screen.getByLabelText("Variable schema JSON"), {
      target: {
        value: JSON.stringify({
          fields: [{ name: "tone", label: "Tone", type: "select", required: false }],
          required: [],
        }),
      },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("System prompt is required")).toBeInTheDocument();
    expect(screen.getByText("Select fields require at least one option")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not render inactive templates", () => {
    render(
      <PromptTemplateManager
        templates={[
          createTemplate({ id: "tpl_active", name: "Strategy Review", isActive: true }),
          createTemplate({ id: "tpl_archived", name: "Archived Review", isActive: false }),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /Strategy Review/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archived Review/ })).not.toBeInTheDocument();
  });

  it("archives the selected template", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ template: createTemplate({ isActive: false }) })));

    render(
      <PromptTemplateManager
        templates={[
          createTemplate({ id: "tpl_1", name: "Strategy Review" }),
          createTemplate({
            id: "tpl_2",
            name: "Board Review",
            category: "board_review",
            systemPrompt: "You are a board editor.",
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Strategy Review/ }));
    await user.click(screen.getByRole("button", { name: "Archive" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/templates/tpl_1", expect.objectContaining({ method: "DELETE" }));
    expect(screen.queryByRole("button", { name: /Strategy Review/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Board Review");
  });
});
