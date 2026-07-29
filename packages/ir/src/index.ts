export { IrBuildError, IrBuilder } from './ir-builder.js';
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

// No ts-morph value or type is re-exported. The IR is the boundary: a consumer
// works with plain objects and never reaches the compiler through this package.
