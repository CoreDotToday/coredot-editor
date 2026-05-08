# Security Policy

## Supported Versions

The `main` branch is the active development line. Security fixes should target `main` unless a maintainer publishes a separate release branch policy.

## Reporting a Vulnerability

Please do not report sensitive vulnerabilities in public issues.

Use GitHub private vulnerability reporting if it is enabled for the repository. If private reporting is not available, contact the project maintainers through a private channel before publishing details.

Please include:

- A short description of the vulnerability
- Impact and affected behavior
- Reproduction steps or proof of concept
- Affected commit, branch, or release
- Suggested mitigation if known

## Scope

Security-sensitive areas include:

- API route validation and authorization added by downstream projects
- AI provider credentials and environment variables
- Database access and migration scripts
- Prompt template storage and user-provided document content
- Proposal application logic
- Deployment configuration

## Secrets

Never commit `.env`, `.env.local`, API keys, database credentials, exported production databases, Playwright traces containing private data, or user documents.

The default repository ignores environment files and SQLite databases, but downstream forks should re-check ignore rules after changing paths.
