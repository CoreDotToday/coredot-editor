export const BUILTIN_TEMPLATE_KEYS = Object.freeze({
  contractReview: "tpl_contract_review",
  executiveRewrite: "tpl_executive_rewrite",
  marketResearch: "tpl_market_research",
  strategyReview: "tpl_strategy_review",
} as const);

export const builtinTemplateKeys = Object.freeze([
  BUILTIN_TEMPLATE_KEYS.strategyReview,
  BUILTIN_TEMPLATE_KEYS.executiveRewrite,
  BUILTIN_TEMPLATE_KEYS.marketResearch,
  BUILTIN_TEMPLATE_KEYS.contractReview,
] as const);

export type BuiltinTemplateKey = (typeof builtinTemplateKeys)[number];
