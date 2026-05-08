import { eq } from "drizzle-orm";
import { promptTemplates, type PromptVariableSchema } from "./schema";

type DefaultPromptTemplate = {
  name: string;
  description: string;
  category: string;
  systemPrompt: string;
  variableSchema: PromptVariableSchema;
};

const strategyVariableSchema: PromptVariableSchema = {
  fields: [
    { name: "audience", label: "Audience", type: "text", required: true },
    { name: "objective", label: "Document objective", type: "textarea", required: true },
    { name: "tone", label: "Tone", type: "select", required: true, options: ["executive", "analytical", "direct"] },
  ],
  required: ["audience", "objective", "tone"],
};

export const defaultPromptTemplates: DefaultPromptTemplate[] = [
  {
    name: "Strategy Review",
    description: "Evaluate strategic clarity, evidence, risks, and executive readability.",
    category: "strategy_review",
    systemPrompt:
      "You are a senior business strategy editor. Review the document for strategic clarity, evidence quality, risk framing, decision usefulness, and executive readability. Return concrete findings with suggested edits.",
    variableSchema: strategyVariableSchema,
  },
  {
    name: "Executive Rewrite",
    description: "Rewrite selected text for concise executive communication.",
    category: "executive_rewrite",
    systemPrompt:
      "You are an executive communications editor. Rewrite the selected text to be concise, decision-oriented, specific, and suitable for senior stakeholders.",
    variableSchema: strategyVariableSchema,
  },
  {
    name: "Market Research Critique",
    description: "Check market claims, assumptions, segmentation, and evidence gaps.",
    category: "market_research",
    systemPrompt:
      "You are a market research lead. Review the content for market sizing logic, customer segmentation, competitive assumptions, evidence gaps, and unsupported claims.",
    variableSchema: strategyVariableSchema,
  },
];

export async function seedDefaultPromptTemplates(now = new Date()) {
  const { db } = await import("./client");

  for (const template of defaultPromptTemplates) {
    const existing = await db
      .select({ id: promptTemplates.id })
      .from(promptTemplates)
      .where(eq(promptTemplates.name, template.name))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(promptTemplates).values({
        name: template.name,
        description: template.description,
        category: template.category,
        systemPrompt: template.systemPrompt,
        variableSchemaJson: template.variableSchema,
        isDefault: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedDefaultPromptTemplates()
    .then(() => {
      console.log("Seeded default prompt templates");
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
