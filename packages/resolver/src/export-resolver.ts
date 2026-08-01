import { commonJsExportSites, moduleSourceFileOf, moduleSpecifierOf } from '@traceiq/ir';
import type { ExportIR, RepositoryIR } from '@traceiq/ir';
import type { NodeId } from '@traceiq/types';
import { Node, type SourceFile } from 'ts-morph';

import { symbolAt, type CheckerSymbol } from './checker-symbol.js';
import type { DeclarationIndex } from './declaration-index.js';
import { classifyExternalFile, classifyUnresolvedSpecifier } from './external-classification.js';
import { resolveRequiredModule } from './import-resolver.js';
import type { ResolutionCollector } from './resolution-collector.js';
import { sourceRangeOf } from './source-position.js';
import { resolveSymbol } from './symbol-target.js';

interface ExportContext {
  readonly fileId: NodeId;
  readonly index: DeclarationIndex;
  readonly collector: ResolutionCollector;
}

/**
 * Resolves exports.
 *
 * Three shapes are handled separately because they carry different certainty:
 *
 * - An `export` modifier on a declaration is already linked by the IR. It needs no
 *   checker, so it is recorded as CERTAIN.
 * - An export specifier — `export { a }`, `export { a as b } from '…'` — is what
 *   the IR deliberately left unresolved, because matching a local name to a
 *   declaration requires scope analysis. The checker resolves it here.
 * - A star re-export resolves to the module it forwards, not to the individual
 *   symbols flowing through it.
 */
export function resolveExports(input: {
  readonly file: SourceFile;
  readonly fileId: NodeId;
  readonly ir: RepositoryIR;
  readonly index: DeclarationIndex;
  readonly collector: ResolutionCollector;
}): void {
  recordInlineExports(input);
  recordExportSpecifiers(input);
  recordExportAssignments(input);
  recordCommonJsExports(input);
}

/**
 * Binds what a CommonJS module publishes.
 *
 * A fourth shape, and it carries the same certainty as an export specifier: `module.exports = Router`
 * assigns a value, and matching that value to a declaration is exactly the scope analysis
 * `export { Router }` needs. So it goes through `symbolAt` and `resolveSymbol` — the same path, the
 * same failure reasons, the same confidence — rather than a name match that could bind a local of
 * the same name.
 *
 * A re-export forwards a module, so the specifier is resolved instead, through the identical rules a
 * star export uses. There is deliberately no ts-morph export declaration here to hand to
 * `recordStarExport`, so the specifier is classified directly.
 */
function recordCommonJsExports(input: Parameters<typeof resolveExports>[0]): void {
  // Built once for the file rather than searched per site: `ir.exports` holds the whole repository's
  // exports, and React's 7,280 files against its 11,274 exports would be eighty million comparisons.
  const linked = new Set(
    input.ir.exports
      .filter((entry) => entry.fileId === input.fileId && entry.declarationId !== null)
      .map((entry) => siteKey(entry.location, entry.exportedName)),
  );

  for (const site of commonJsExportSites(input.file)) {
    const reference = {
      type: 'EXPORTS' as const,
      sourceId: input.fileId,
      name: site.exportedName,
      location: site.location,
      resolver: 'exports' as const,
      fileId: input.fileId,
    };

    if (site.moduleSpecifier !== null) {
      // A re-export forwards a module, so the module is the target. Resolved by the *same* function
      // the import resolver uses on the *same* literal, so `module.exports = require('./router')`
      // and the import it also produces can never point at different files.
      const module =
        site.value !== null && Node.isStringLiteral(site.value)
          ? resolveRequiredModule(site.value, site.moduleSpecifier, input)
          : null;

      if (module === null) {
        input.collector.addUnresolved(
          reference,
          'module-not-resolved',
          site.moduleSpecifier,
          `'${site.moduleSpecifier}' is re-exported but resolves to no file and names no package`,
        );

        continue;
      }

      input.collector.addRelationship(
        reference,
        module.target,
        module.confidence,
        `re-exports the whole of '${site.moduleSpecifier}': ${module.evidence}`,
      );

      continue;
    }

    if (site.value === null || linked.has(siteKey(site.location, site.exportedName))) {
      continue;
    }

    if (!isReferential(site.value)) {
      input.collector.addUnresolved(
        reference,
        'value-is-not-a-declaration',
        site.value.getText().slice(0, LITERAL_TEXT_LIMIT),
        `'${site.exportedName ?? 'the module'}' is exported as a literal value, which names no declaration`,
      );

      continue;
    }

    input.collector.addSymbolResolution(
      reference,
      resolveSymbol(shorthandAwareSymbolAt(site.value), input.index),
      site.value.getText(),
    );
  }
}

/**
 * A key identifying one export site, so the IR's reading and this one can be matched up.
 *
 * Position plus name, which is what makes two readings the same *site* rather than two facts about
 * one statement. Without the match every linked CommonJS export would be recorded twice — once
 * CERTAIN from the IR and once through the checker — and the duplicate would double the count of
 * exactly the exports this milestone set out to make visible.
 */
function siteKey(
  location: { readonly startLine: number; readonly startColumn: number },
  exportedName: string | null,
): string {
  return `${location.startLine}:${location.startColumn}|${exportedName ?? ''}`;
}

/** Enough of an exported literal to recognise it, without carrying a whole config object. */
const LITERAL_TEXT_LIMIT = 80;

/**
 * Whether an expression can denote a declaration at all.
 *
 * A literal, an array, an object, a template or a regular expression is a value written in place.
 * Asking the checker about it is not wrong so much as pointless — it either answers nothing or
 * answers with a synthetic symbol no file declares — and either way the export is reported as a
 * failure when the only thing that happened is that the module exports data.
 *
 * Everything else is let through: an identifier, a member expression, a call, a function or class
 * expression, an `as` cast. Those may or may not reach a declaration, and finding out is the
 * checker's job.
 */
function isReferential(value: Node): boolean {
  return !(
    Node.isStringLiteral(value) ||
    Node.isNoSubstitutionTemplateLiteral(value) ||
    Node.isTemplateExpression(value) ||
    Node.isNumericLiteral(value) ||
    Node.isBigIntLiteral(value) ||
    Node.isTrueLiteral(value) ||
    Node.isFalseLiteral(value) ||
    Node.isNullLiteral(value) ||
    Node.isRegularExpressionLiteral(value) ||
    Node.isArrayLiteralExpression(value) ||
    Node.isObjectLiteralExpression(value)
  );
}

/**
 * The symbol a CommonJS export's value names, following a shorthand property to its local.
 *
 * `module.exports = { save, load }` writes each name once and means two things by it: the property
 * being defined, and the local being read. `symbolAt` returns the first, whose declaration is the
 * property inside the object literal — not in the IR, so the export resolved to
 * `declaration-not-in-ir` and the two functions the module actually publishes stayed invisible.
 * TypeScript models the second meaning as the shorthand assignment's *value* symbol, which is what
 * an importer would reach.
 */
function shorthandAwareSymbolAt(value: Node): CheckerSymbol {
  const parent = value.getParent();

  if (parent === undefined || !Node.isShorthandPropertyAssignment(parent)) {
    return symbolAt(value);
  }

  try {
    const shorthand = value
      .getProject()
      .getTypeChecker()
      .getShorthandAssignmentValueSymbol(parent);

    // Falls back rather than reporting nothing: the property symbol still names the export, and a
    // `declaration-not-in-ir` is a better answer than a `no-symbol` this rule invented.
    return shorthand === undefined ? symbolAt(value) : { outcome: 'symbol', symbol: shorthand };
  } catch (cause) {
    // Guarded like every other checker call in this package, and for the same reason.
    return { outcome: 'failed', detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * The IR already established these syntactically, so they are echoed as CERTAIN
 * rather than re-derived. This is the one place the Resolver adds a relationship
 * without consulting the checker.
 */
function recordInlineExports(input: Parameters<typeof resolveExports>[0]): void {
  // Every export the IR already linked, whichever construct wrote it. The filter was
  // `kind === 'declaration' || 'default'` — the two ES shapes — and a CommonJS export the IR could
  // link just as certainly then went through the checker anyway and, in React, failed 189 times.
  // `declarationId !== null` *is* the condition: the field is documented as set only where the link
  // is syntactic, so the kind adds nothing.
  const inline = input.ir.exports.filter(
    (entry: ExportIR) => entry.fileId === input.fileId && entry.declarationId !== null,
  );

  for (const entry of inline) {
    if (entry.declarationId === null) {
      continue;
    }

    input.collector.addRelationship(
      {
        type: 'EXPORTS',
        sourceId: input.fileId,
        name: entry.exportedName,
        location: entry.location,
        resolver: 'exports',
        fileId: input.fileId,
      },
      { kind: 'declaration', declarationId: entry.declarationId },
      'CERTAIN',
      `'${entry.exportedName ?? 'default'}' is exported by a modifier on its own declaration, which needs no resolution`,
    );
  }
}

function recordExportSpecifiers(input: Parameters<typeof resolveExports>[0]): void {
  for (const declaration of input.file.getExportDeclarations()) {
    const specifier = moduleSpecifierOf(declaration) ?? '';

    if (declaration.isNamespaceExport()) {
      recordStarExport(declaration.getNamespaceExport()?.getName() ?? null, specifier, {
        node: declaration,
        ...input,
      });

      continue;
    }

    for (const named of declaration.getNamedExports()) {
      const nameNode = named.getNameNode();
      const exportedName = named.getAliasNode()?.getText() ?? nameNode.getText();

      input.collector.addSymbolResolution(
        {
          type: 'EXPORTS',
          sourceId: input.fileId,
          name: exportedName,
          location: sourceRangeOf(named),
          resolver: 'exports',
          fileId: input.fileId,
        },
        resolveSymbol(symbolAt(nameNode), input.index),
        nameNode.getText(),
      );
    }
  }
}

/**
 * A star re-export forwards a module rather than naming symbols, so the module is
 * the target. Expanding it into one relationship per forwarded symbol is left
 * undone deliberately: the set is derived rather than written, and materialising
 * it is closer to organising facts than to enriching them.
 */
function recordStarExport(
  exportedName: string | null,
  specifier: string | undefined,
  input: ExportContext & { readonly node: Node },
): void {
  const site = {
    type: 'EXPORTS' as const,
    sourceId: input.fileId,
    name: exportedName,
    location: sourceRangeOf(input.node),
    resolver: 'exports' as const,
    fileId: input.fileId,
  };

  if (specifier === undefined) {
    input.collector.addUnresolved(
      site,
      'module-not-resolved',
      '*',
      'a star export with no module specifier',
    );

    return;
  }

  const resolvedFile = Node.isExportDeclaration(input.node)
    ? moduleSourceFileOf(input.node)
    : undefined;

  if (resolvedFile === undefined) {
    const classified = classifyUnresolvedSpecifier(specifier);

    if (classified === null) {
      input.collector.addUnresolved(
        site,
        'module-not-resolved',
        specifier,
        `the relative specifier '${specifier}' does not resolve to a file`,
      );

      return;
    }

    input.collector.addRelationship(
      site,
      classified.target,
      classified.confidence,
      `re-exports the whole of ${classified.evidence}`,
    );

    return;
  }

  const targetFileId = input.index.fileIdOf(resolvedFile.getFilePath());

  if (targetFileId !== undefined) {
    input.collector.addRelationship(
      site,
      { kind: 'file', fileId: targetFileId },
      'RESOLVED',
      `re-exports the whole of '${specifier}', which resolves to an analysed file; the forwarded names are not expanded`,
    );

    return;
  }

  const external = classifyExternalFile(resolvedFile.getFilePath());

  input.collector.addRelationship(
    site,
    { kind: 'external', origin: external.origin, name: external.name, ecosystem: external.ecosystem },
    'RESOLVED',
    `re-exports the whole of '${specifier}', which resolves outside the analysed set`,
  );
}

function recordExportAssignments(input: Parameters<typeof resolveExports>[0]): void {
  for (const assignment of input.file.getExportAssignments()) {
    const expression = assignment.getExpression();
    const isExportEquals = assignment.isExportEquals();

    input.collector.addSymbolResolution(
      {
        type: 'EXPORTS',
        sourceId: input.fileId,
        name: isExportEquals ? null : 'default',
        location: sourceRangeOf(assignment),
        resolver: 'exports',
        fileId: input.fileId,
      },
      resolveSymbol(symbolAt(expression), input.index),
      expression.getText(),
    );
  }
}
