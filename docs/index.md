# Coredot Editor

Coredot Editor is an open-source starter for teams building AI-assisted document products. It combines a Tiptap editor, prompt-template driven AI workflows, proposal review, DOCX import/export, SQLite persistence, and clear extension points for downstream products.

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

The default local AI provider is `stub`, so the editor, proposal workflow, and end-to-end tests work without external credentials. Production deployments should configure real provider credentials server-side and add product-specific authentication, authorization, and workspace ownership.

## Public Boundaries

Treat these as the most important extension boundaries:

- `src/features/ai/providers.ts`: AI provider contract.
- `src/features/ai/ai-command-service.ts`: shared preflight for AI routes.
- `src/features/templates/template-validation.ts`: prompt template variable contract.
- `src/features/proposals/proposal-application-service.ts`: server-side proposal application transaction.
- `src/plugins/types.ts`: editor plugin contribution contract.
- `src/app/api/*`: JSON route behavior for app integrations.

Read [Architecture](ARCHITECTURE.md) before changing these boundaries.
