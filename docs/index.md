# Coredot Editor

Coredot Editor is an open-source starter for teams building AI-assisted document products. It combines a Tiptap editor, Clerk-backed personal and organization Workspaces, prompt-template driven AI workflows, revision-safe Proposal review, fidelity-aware DOCX interchange, durable Conversations, SQLite/libSQL persistence, and build-time extension points.

Use these docs when you want to:

- Run the starter locally without model credentials.
- Fork it into a product-specific document editor.
- Replace prompts, AI providers, persistence, or editor plugins.
- Review the architecture before contributing.
- Deploy a fork safely.

## Where To Start

| Goal | Page |
| --- | --- |
| Run the app locally | [Getting Started](getting-started.md) |
| Understand the main user flows | [Product Tour](product-tour.md) |
| Configure environment variables and providers | [Configuration](configuration.md) |
| Work on the codebase | [Development](development.md) |
| Integrate against the built-in routes | [API Reference](api-reference.md) |
| Fork this into another product | [Adopting The Starter](ADOPTION.md) |
| Extend editor behavior | [Extension Points](PLUGINS.md) |
| Replace prompt templates | [Prompting](PROMPTING.md) |

## Project Shape

Coredot Editor is an application starter, not a published npm component package. Clone or fork the repository, keep the boundaries documented here stable, and adapt the product-specific layers for your domain.

The default local AI provider is `stub`, and `.env.example` uses deterministic test authentication, so the editor, Proposal workflow, and end-to-end tests work without external credentials. Production rejects test authentication and requires real Clerk keys. Clerk organizations map to shared Workspaces, signed-in users without an active organization receive personal owner Workspaces, and repositories enforce Workspace scope plus owner/admin/member permissions.

## Public Boundaries

Treat these as the most important extension boundaries:

- `src/features/ai/providers.ts`: AI provider contract.
- `src/features/ai/ai-execution.ts`: deadline, idempotency, attempt fencing, finalization, and recovery-aware AI execution.
- `src/features/documents/document-change-service.ts`: revision-aware single/bulk Proposal application, durable Document Changes, and server undo.
- `src/features/templates/template-validation.ts`: prompt template variable contract.
- `src/plugins/types.ts`: editor plugin contribution contract.
- `src/plugins/app-plugins.ts`: app plugin composition and the shared document schema Profile.
- `src/app/api/*`: JSON route behavior for app integrations.

Read [Architecture](ARCHITECTURE.md) before changing these boundaries.
