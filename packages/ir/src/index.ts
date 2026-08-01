export { IrBuildError, IrBuilder } from './ir-builder.js';
// Exported for the Resolver, which reads the same specifiers from the same nodes and must survive the
// same ts-morph throw. One guard, not two that could diverge.
export { moduleSourceFileOf, moduleSpecifierOf } from './module-specifier.js';
// Exported for the Resolver for the same reason: it binds the exports this reader records, and two
// independent readings of which assignments are CommonJS exports would drift apart.
export { commonJsExportSites, type CommonJsExportSite } from './export-extractor.js';
// Exported for other language analysers. The identifier is the unit of a declaration in every
// language, so the rule for folding several syntactic sites onto one — Python's `@overload`
// signatures, TypeScript's merged interfaces — must be one rule rather than one per analyser.
// It touches no compiler type: plain data in, plain data out.
export {
  DeclarationCollector,
  type CollectedDeclarationRef,
  type DeclarationInput,
} from './declaration-collector.js';
export {
  DECLARATION_KINDS,
  VISIBILITIES,
  type CallArgumentIR,
  type CallSiteIR,
  type DeclarationIR,
  type DeclarationKind,
  type DeclarationModifiers,
  type ExportIR,
  type ExportKind,
  type FileIR,
  type ImportBindingIR,
  type ImportBindingKind,
  type ImportIR,
  type MemberAccessIR,
  type RepositoryIR,
  type RepositoryIRMetadata,
  type SourceRange,
  type Visibility,
} from './types.js';

// `RepositoryIR` is the boundary: a consumer of the IR *data* works with plain objects and never
// reaches the compiler through it. The three exports above are the exception, and each is there for
// the same reason — the Resolver reads the same syntax this package does, and a second reading of it
// would be a second chance to disagree. Their signatures do name ts-morph types, which is precisely
// why they are called out rather than mixed in with the data exports below.
