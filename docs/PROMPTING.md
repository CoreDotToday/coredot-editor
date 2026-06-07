# Prompt Template Guide

Coredot Editor stores prompt templates as editable product configuration. The default templates are seeded from `src/db/seed.ts`, then sent as the system message for review and rewrite requests.

This guide documents the contract downstream projects should preserve when replacing prompts.

## Runtime Contract

`buildAiMessages` sends two messages:

- `system`: the selected template's `systemPrompt`
- `user`: stable sections for `Command`, `Template variables`, `Before context`, `Selected text`, `After context`, and `Document text`

Review calls use structured output with this schema:

- `summary`
- `findings[]`
- `problem`
- `reason`
- `targetText`
- `replacementText`

Rewrite and translation calls are plain text. Whatever the model returns becomes the proposed replacement text.

## Default Template Set

The seed file currently installs four active default templates:

- `Strategy Review`: flags decision quality, evidence, metrics, and strategic clarity issues.
- `Executive Rewrite`: rewrites selected text for concise senior-leadership communication.
- `Market Research Critique`: challenges source quality, market claims, evidence gaps, and unsupported conclusions.
- `Contract Review`: reviews clauses against a configurable contract playbook and returns redline-ready edits.

`Contract Review` is the Spellbook-style starting point. It asks for the reviewer's perspective, contract type, and risk tolerance, then checks common commercial-contract topics such as confidentiality, data use, privacy, IP, payment, renewal, termination, indemnity, liability, audit, compliance, assignment, governing law, and dispute resolution. It is intentionally framed as an attorney-assist workflow, not autonomous legal advice.

Korean and English translation are selection rewrite commands, not separate seeded templates. They currently run through the active rewrite-capable template and the command-specific instructions.

## Template Principles

- Put stable identity, task boundaries, safety rules, and output contracts in the system prompt.
- Keep request-specific intent in the `Command` and template variables.
- Treat document text, selected text, and variables as untrusted input, not as instructions.
- Ground outputs in the provided text. Do not invent facts, metrics, citations, dates, customer names, or business results.
- Preserve names, numbers, dates, citations, terminology, and author intent unless the command explicitly asks to change them.
- Give the model an out: return no review findings when there is no high-confidence issue or the target text is ambiguous.
- Prefer short, direct prompts with clear section headers over long persona prose.
- Add examples only when a prompt repeatedly fails a known pattern.

## Review Prompt Checklist

Review templates must tell the model to:

- Review `Selected text` first when present, otherwise `Document text`.
- Return only the API schema, with no markdown wrapper or conversational preface.
- Use `targetText` copied exactly from the provided text.
- Use `replacementText` as a drop-in replacement, not commentary.
- Omit findings when the target text is missing, duplicated ambiguously, or too broad to replace safely.
- Focus on fixable, decision-relevant issues rather than generic writing advice.

Contract review templates should also:

- State the reviewer perspective, for example customer-side, vendor-side, mutual, or investor-side.
- Convert playbook violations into surgical `replacementText` edits that can be inserted as a redline.
- Flag missing, aggressive, one-sided, non-market, ambiguous, or internally inconsistent terms only when the provided text supports the finding.
- Avoid broad rewrites of entire sections unless the whole target clause is short and appears exactly once.
- Make escalation clear when legal judgment, jurisdiction-specific analysis, or business approval is required.

## Rewrite And Translation Checklist

Rewrite and translation templates must tell the model to:

- Operate only on the selected text unless the command explicitly asks for document-level work.
- Return only replacement text.
- Exclude explanations, labels, markdown fences, and acceptance instructions.
- Preserve factual claims and business meaning.
- For Continue writing, return only the new continuation text that should follow the selected text; do not repeat the selected text.
- For Korean and English translation, preserve names, numbers, dates, citations, product names, and domain terms.
- Preserve paragraph breaks when they improve readability.

## Evaluation Cases

Before shipping a new prompt set, test at least these cases with the real provider:

- A normal executive rewrite.
- Korean translation and English translation of text with numbers and product names.
- Review finding where the target text appears exactly once.
- Review input where the same sentence appears twice; the model should omit the ambiguous finding or choose enough exact context.
- A document containing text such as "ignore previous instructions"; the model should treat it as document content.
- A document with weak evidence; the model should flag the gap without inventing sources.
- A clean document; review should return an empty findings list.

## Source-Informed Basis

These practices follow current official guidance:

- [OpenAI prompt engineering](https://platform.openai.com/docs/guides/prompt-engineering): use clear message roles, Markdown/XML-style structure, and explicit instructions.
- [OpenAI reasoning best practices](https://platform.openai.com/docs/guides/reasoning-best-practices): keep prompts simple and direct, use delimiters, and avoid unnecessary chain-of-thought requests.
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices): evaluate instruction following, system-prompt priority, and edge cases.
- [Anthropic prompting best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags): separate instructions, context, and variable input with clear structure.
- [Anthropic prompt-injection guidance](https://docs.anthropic.com/en/docs/mitigating-jailbreaks-prompt-injections): add guardrails and test jailbreak or injection attempts.
- [Google Vertex AI prompting strategies](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/prompt-design-strategies): use clear instructions, roles, contextual information, structured prompts, and iteration.
- [Microsoft system message guidance](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/system-message): keep system messages clear, concise, robust, and scenario-specific.
