export { RepositoryAnswerer, type Answer, type AnswerRequest } from './answer.js';
export {
  BUDGET_TIERS,
  CHARS_PER_TOKEN,
  TIER_TOKENS,
  digest,
  estimatingCounter,
  smallerTier,
  tierForWindow,
  type BudgetTier,
} from './budget.js';
export { acquire, describe as describeRequest, type ContextSource } from './context-source.js';
export {
  NO_HISTORY,
  recentTurns,
  type Conversation,
  type ConversationHistory,
  type ConversationId,
  type Turn,
} from './conversation.js';
export { AI_ERROR_CODES, AI_ERROR_HINTS, AiError, aborted, modelNotFound, protocolError, providerUnavailable, type AiErrorCode } from './errors.js';
export {
  CITATION_PATTERN,
  IDENTIFIER_PATTERN,
  IDENTIFIER_PREFIXES,
  PREDICATES,
  factLine,
  trimIdentifier,
  type Citation,
  type ContextProjection,
  type Fact,
  type FactConfidence,
  type FactId,
  type Omission,
  type Predicate,
} from './facts.js';
export { checkGrounding, type GroundingReport, type GroundingVerdict } from './grounding.js';
export {
  MODEL_CAPABILITIES,
  type GenerationRequest,
  type LanguageModel,
  type Message,
  type MessageRole,
  type ModelCapability,
  type ModelDescription,
  type ModelEvent,
  type ModelProvider,
  type ProviderHealth,
  type StopReason,
  type TokenCounter,
  type TokenUsage,
} from './model.js';
export {
  FACTS_CLOSE,
  FACTS_OPEN,
  SYSTEM_PROMPT,
  assemble,
  renderFacts,
  renderHistory,
  reservedTokens,
  type PromptInput,
} from './prompt.js';
export { project, subjectOf, type ProjectionOptions } from './projection.js';
export { collect, collectText, type AnswerEvent, type GroundingSummary } from './stream.js';

// The final consumer of the architecture, and a pure one. Repository data enters through exactly one
// method — ContextSource.build — so there is no graph traversal, no SQLite, no Query Engine, no Explain,
// Impact, Explorer or Health call anywhere in this package, and nothing to duplicate. The compiled output
// imports no @traceiq module: the boundary is structural, not conventional. No vendor is named here.
