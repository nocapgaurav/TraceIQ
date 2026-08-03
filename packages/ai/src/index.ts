export {
  ANSWER_STATUSES,
  RepositoryAnswerer,
  type Answer,
  type AnswerRequest,
  type AnswerStatus,
  type RecoveryReport,
} from './answer.js';
export { NO_RECOVERY, recoveryFor, type RecoveryPlan } from './recovery.js';
export { finalise, isUnsound, type Finalisation } from './finalize.js';
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
  pathAliases,
  trimIdentifier,
  type Citation,
  type ContextProjection,
  type Fact,
  type FactConfidence,
  type FactId,
  type Omission,
  type Predicate,
} from './facts.js';
export {
  checkGrounding,
  type GroundingDiagnostic,
  type GroundingReport,
  type GroundingVerdict,
} from './grounding.js';
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
  REMINDER,
  SYSTEM_PROMPT,
  assemble,
  promptBreakdown,
  renderFacts,
  renderHistory,
  reminderFor,
  stablePrefixOf,
  reservedTokens,
  fixedReservedTokens,
  systemMessage,
  type PromptBreakdown,
  type PromptInput,
} from './prompt.js';
export {
  EVIDENCE_POLICY,
  INTENTS,
  INTENT_PARTS,
  type EvidencePolicy,
  QUESTION_SCOPES,
  focusOf,
  intentOf,
  scopeOf,
  type QuestionIntent,
  type QuestionScope,
  type ScopeInput,
} from './intent.js';
export { project, subjectOf, type ProjectionOptions } from './projection.js';
export {
  COMPLEXITY_TRAITS,
  DOMAINS,
  NAMING_CAPACITY,
  REPOSITORY_SCALES,
  REPOSITORY_TYPES,
  deriveProfile,
  subsystemsOf,
  type ComplexityTrait,
  type Domain,
  type DomainClaim,
  type Evidenced,
  type RepositoryProfile,
  type RepositoryScale,
  type RepositoryType,
  type ScaleMeasure,
  type TraitClaim,
} from './profile.js';
export {
  deriveIdentity,
  renderIdentity,
  type DomainIdentity,
  type RepositoryIdentity,
} from './identity.js';
export {
  rankComponents,
  starsOf,
  topDeclarations,
  topPackages,
  type ComponentImportance,
  type ImportanceSignal,
} from './importance.js';
export {
  renderWorkflow,
  renderWorkflowBrief,
  workflowsOf,
  type Workflow,
  type WorkflowStep,
} from './workflow.js';
export {
  ANSWER_LEADS,
  AUDIENCES,
  FACT_GROUPS,
  PLAN_CONFIDENCES,
  planFor,
  type Audience,
  type AnswerLead,
  type AnswerPlan,
  type FactAllocation,
  type FactGroup,
  type NavigationStep,
  type PlanConfidence,
  type PlanInput,
  type PlanSection,
  type PlanTask,
  EVIDENCE_VERDICTS,
  type EvidenceSufficiency,
  type EvidenceVerdict,
} from './plan.js';
export {
  EXPLANATION_DEPTHS,
  questionGuidance,
  repositoryGuidance,
  strategyFor,
  type ExplanationDepth,
  type ExplanationStrategy,
  type StrategyInput,
} from './strategy.js';
export {
  CLAIM_KINDS,
  CLAIM_STRENGTHS,
  checkEntailment,
  licencesFor,
  sentences,
  type ClaimFinding,
  type ClaimKind,
  type ClaimStrength,
  type EntailmentReport,
} from './entailment.js';
export {
  REGION_ROLES,
  REPOSITORY_CATEGORIES,
  deriveStructure,
  isProductionPath,
  ownRoutes,
  roleOfPath,
  scopedTechnologies,
  type RegionRole,
  type RegionScope,
  type RepositoryArea,
  type RepositoryCategory,
  type RepositoryStructure,
  type ScopedTechnologies,
} from './structure.js';
export {
  CONVERSATION_CLOSE,
  CONVERSATION_OPEN,
  NO_STATE,
  TOPIC_KINDS,
  deriveState,
  renderState,
  type ConversationState,
  type CoveredTopic,
  type TopicKind,
} from './memory.js';
export {
  collect,
  collectText,
  type AnswerEvent,
  type AnswerShape,
  type ConversationSummary,
  type GroundingSummary,
} from './stream.js';

// The final consumer of the architecture, and a pure one. Repository data enters through exactly one
// method — ContextSource.build — so there is no graph traversal, no SQLite, no Query Engine, no Explain,
// Impact, Explorer or Health call anywhere in this package, and nothing to duplicate. The compiled output
// imports no @traceiq module: the boundary is structural, not conventional. No vendor is named here.
