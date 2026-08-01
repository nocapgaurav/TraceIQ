import type { NodeId } from '@traceiq/types';
import { Node, SyntaxKind, type Expression, type SourceFile, type StringLiteral } from 'ts-morph';

import { moduleSpecifierOf } from './module-specifier.js';
import { sourceRangeOf } from './source-range.js';
import type { ExportIR, ExportKind, SourceRange } from './types.js';

/**
 * Records a file's export statements.
 *
 * Covers `export { … }`, `export … from '…'`, `export *`, `export * as ns`,
 * `export default …` and `export = …`. Exports written as a modifier on a
 * declaration are recorded by the declaration extractor, which is the only place
 * that knows the declaration's identifier.
 *
 * Re-export specifiers are kept as written. `declarationId` stays `null` here:
 * even for `export { local }`, matching the name to a declaration in the same file
 * requires scope analysis, which is resolution.
 */
export function extractExports(file: SourceFile, fileId: NodeId, links: CommonJsLinks = {}): ExportIR[] {
  const exports: ExportIR[] = [...extractEsExports(file, fileId)];

  for (const site of commonJsExportSites(file)) {
    exports.push({
      fileId,
      kind: site.kind,
      exportedName: site.exportedName,
      localName: site.value !== null && Node.isIdentifier(site.value) ? site.value.getText() : null,
      moduleSpecifier: site.moduleSpecifier,
      declarationId: site.moduleSpecifier === null ? declarationLinkOf(site.value, links) : null,
      isTypeOnly: false,
      location: site.location,
    });
  }

  return exports;
}

/**
 * What the declaration extractor already knows about this file, for linking an export to its value.
 *
 * Both maps come from the same pass that recorded the declarations, so nothing here is a second
 * reading of the syntax.
 */
export interface CommonJsLinks {
  /** Top-level declarations of this file, by name. */
  readonly topLevelIdByName?: ReadonlyMap<string, NodeId>;
  /** Every node the declaration extractor recorded, by node. */
  readonly declarationIdByNode?: ReadonlyMap<Node, NodeId>;
}

/**
 * The declaration a CommonJS export publishes, when the syntax alone establishes it.
 *
 * **This is the same rule an `export` modifier follows, and it exists for the same reason.**
 * `ExportIR.declarationId` is documented as set only where the link is knowable syntactically, and
 * two CommonJS shapes are:
 *
 * - `module.exports = Router` — a bare identifier naming a declaration at this file's top level.
 * - `exports.compile = function compile() {}` — a value the declaration extractor just recorded.
 *
 * Resolving these here rather than through the checker is not an optimisation. Measured against
 * React, routing every CommonJS export through `getSymbolAtLocation` turned **189** exports that had
 * resolved into `no-symbol` failures: the checker declines on plenty of ordinary published
 * JavaScript, and the syntax was never in doubt for any of them.
 *
 * `null` for anything else — a member expression, a call, a literal — which the Resolver then binds
 * with the checker, exactly as it does for `export { a }`.
 */
function declarationLinkOf(value: Expression | null, links: CommonJsLinks): NodeId | null {
  if (value === null) {
    return null;
  }

  const direct = links.declarationIdByNode?.get(value);

  if (direct !== undefined) {
    return direct;
  }

  return Node.isIdentifier(value) ? (links.topLevelIdByName?.get(value.getText()) ?? null) : null;
}

function extractEsExports(file: SourceFile, fileId: NodeId): ExportIR[] {
  const exports: ExportIR[] = [];

  for (const declaration of file.getExportDeclarations()) {
    const moduleSpecifier = moduleSpecifierOf(declaration);
    const location = sourceRangeOf(declaration);
    const isStatementTypeOnly = declaration.isTypeOnly();

    if (declaration.isNamespaceExport()) {
      const namespaceExport = declaration.getNamespaceExport();

      exports.push({
        fileId,
        kind: namespaceExport === undefined ? 'star' : 'star-as',
        exportedName: namespaceExport?.getName() ?? null,
        localName: null,
        moduleSpecifier,
        declarationId: null,
        isTypeOnly: isStatementTypeOnly,
        location,
      });

      continue;
    }

    for (const specifier of declaration.getNamedExports()) {
      const localName = specifier.getName();
      const alias = specifier.getAliasNode()?.getText();

      exports.push({
        fileId,
        kind: 'named',
        exportedName: alias ?? localName,
        localName,
        moduleSpecifier,
        declarationId: null,
        isTypeOnly: isStatementTypeOnly || specifier.isTypeOnly(),
        location,
      });
    }
  }

  for (const assignment of file.getExportAssignments()) {
    const expression = assignment.getExpression();
    const isExportEquals = assignment.isExportEquals();

    exports.push({
      fileId,
      kind: isExportEquals ? 'equals' : 'default',
      exportedName: isExportEquals ? null : 'default',
      // Only a plain identifier is recorded. `export default { a: 1 }` exports an
      // expression with no local name, and storing its source text would invite a
      // consumer to parse it.
      localName: Node.isIdentifier(expression) ? expression.getText() : null,
      moduleSpecifier: null,
      declarationId: null,
      isTypeOnly: false,
      location: sourceRangeOf(assignment),
    });
  }

  return exports;
}

/**
 * One place a CommonJS module publishes something.
 *
 * Shared with the Resolver rather than duplicated there. Both stages must agree on exactly which
 * assignments count as exports — the IR records them and the Resolver binds them — and two
 * independent readers of the same syntax is precisely how a file ends up with an EXPORTS edge the
 * IR has no entry for, or an entry with no edge.
 *
 * `value` is the node whose symbol the Resolver follows. For a named or whole-module export that is
 * the assigned expression. For a re-export it is the `require` call's *string literal*, because the
 * checker puts the resolved module's symbol on the literal — which is how a `require` gets the same
 * module resolution an `import` does, and the rule the import resolver already relies on.
 */
export interface CommonJsExportSite {
  readonly kind: ExportKind;
  /** The name an importer sees. `null` for a whole-module assignment, matching `export =`. */
  readonly exportedName: string | null;
  readonly value: Expression | null;
  /** Set only when the export forwards another module: `module.exports = require('./x')`. */
  readonly moduleSpecifier: string | null;
  readonly location: SourceRange;
}

/**
 * Every CommonJS export a file writes.
 *
 * **Why this exists.** Imports were done in an earlier milestone and exports were carried forward as
 * a known limitation, which left express reporting 9 EXPORTS across 141 CommonJS files — its nine
 * ES ones — while its region honestly said no exports were found. The dependency graph was intact
 * and the *public surface* of every CommonJS module was invisible: nothing could answer what a file
 * publishes, so Explorer showed no exports, and an importer's `require('./router')` bound to a file
 * rather than to the declaration behind it.
 *
 * The forms, each mapped onto vocabulary the IR already had — no new `ExportKind` was needed,
 * because CommonJS states the same three things ES modules do:
 *
 * ```js
 * module.exports = Router;              // equals   — the whole module is one value
 * module.exports = { a, b };            // named ×2 — a shorthand or a property per name
 * module.exports.create = create;       // named
 * exports.create = create;              // named    — `exports` aliases `module.exports`
 * module.exports = require('./other');  // star     — forwards another module wholesale
 * exports.helper = require('./h').go;   // named, and the specifier is not recorded: the export is
 *                                       // one member of that module rather than the module
 * ```
 *
 * **Only assignments at statement position are read.** A conditional `if (x) module.exports = a`
 * publishes different things on different runs, and a static reader that claimed either would be
 * wrong half the time; it is skipped rather than guessed at. Same for a computed member,
 * `exports[name] = v`, which names nothing a reader could follow.
 */
export function commonJsExportSites(file: SourceFile): readonly CommonJsExportSite[] {
  return file.getStatements().flatMap((statement) => commonJsExportSitesIn(statement));
}

/**
 * The sites one statement writes.
 *
 * Split out so the declaration extractor, which walks statements anyway, can ask about the one in
 * front of it rather than re-reading the file and filtering by position.
 */
export function commonJsExportSitesIn(statement: Node): readonly CommonJsExportSite[] {
  if (!Node.isExpressionStatement(statement)) {
    return [];
  }

  const expression = statement.getExpression();

  if (!Node.isBinaryExpression(expression)) {
    return [];
  }

  if (expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
    return [];
  }

  const target = exportTargetOf(expression.getLeft());

  if (target === null) {
    return [];
  }

  const value = expression.getRight();
  const location = sourceRangeOf(statement);

  // `exports.create = …` or `module.exports.create = …`.
  if (target.property !== null) {
    return [{ kind: 'named', exportedName: target.property, value, moduleSpecifier: null, location }];
  }

  // `module.exports = require('./other')` forwards a whole module, which is what a star export
  // means. Recorded as one, so a consumer needs no CommonJS branch to understand it.
  const forwarded = requireSpecifierOf(value);

  if (forwarded !== null) {
    return [
      {
        kind: 'star',
        exportedName: null,
        value: forwarded.literal,
        moduleSpecifier: forwarded.specifier,
        location,
      },
    ];
  }

  // `module.exports = { a, b, c: d }` publishes a name per property, which is what an importer
  // destructures. Recorded as several named exports rather than one opaque object, because the
  // names are exactly the question a reader is asking.
  if (Node.isObjectLiteralExpression(value)) {
    return value.getProperties().flatMap((property) => {
      const named = objectLiteralExportOf(property);

      return named === null
        ? []
        : [{ kind: 'named' as const, ...named, moduleSpecifier: null, location }];
    });
  }

  // `module.exports = Router` — the module *is* one value, which is what `export =` says.
  return [{ kind: 'equals', exportedName: null, value, moduleSpecifier: null, location }];
}

/**
 * Whether an assignment target is a CommonJS export, and which name it publishes.
 *
 * `property: null` means the whole module — `module.exports = …`. A property name means one export.
 * `null` altogether means this is an ordinary assignment to something else.
 */
function exportTargetOf(left: Node): { readonly property: string | null } | null {
  if (!Node.isPropertyAccessExpression(left)) {
    return null;
  }

  const object = left.getExpression();
  const name = left.getName();

  // `module.exports = …`
  if (Node.isIdentifier(object) && object.getText() === 'module' && name === 'exports') {
    return { property: null };
  }

  // `exports.foo = …`
  if (Node.isIdentifier(object) && object.getText() === 'exports') {
    return { property: name };
  }

  // `module.exports.foo = …`
  if (
    Node.isPropertyAccessExpression(object) &&
    Node.isIdentifier(object.getExpression()) &&
    object.getExpression().getText() === 'module' &&
    object.getName() === 'exports'
  ) {
    return { property: name };
  }

  return null;
}

/** One property of a `module.exports = { … }` literal, or `null` when it names nothing. */
function objectLiteralExportOf(
  property: Node,
): { readonly exportedName: string; readonly value: Expression | null } | null {
  if (Node.isShorthandPropertyAssignment(property)) {
    return { exportedName: property.getName(), value: property.getNameNode() };
  }

  if (!Node.isPropertyAssignment(property)) {
    // A spread publishes whatever another object holds, and a method or accessor declares a
    // function inline. Neither names a value this reader can follow to a declaration.
    return null;
  }

  const nameNode = property.getNameNode();

  // A computed key names nothing statically. `{ [k]: v }` is skipped rather than recorded under
  // the text of the expression, which no importer would ever write.
  if (!Node.isIdentifier(nameNode) && !Node.isStringLiteral(nameNode)) {
    return null;
  }

  return {
    exportedName: Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText(),
    value: property.getInitializer() ?? null,
  };
}

/** The specifier of a bare `require('…')` expression, with the literal that carries its symbol. */
function requireSpecifierOf(
  value: Node,
): { readonly specifier: string; readonly literal: StringLiteral } | null {
  if (!Node.isCallExpression(value)) {
    return null;
  }

  const callee = value.getExpression();

  if (!Node.isIdentifier(callee) || callee.getText() !== 'require') {
    return null;
  }

  const [argument] = value.getArguments();

  return argument !== undefined && Node.isStringLiteral(argument)
    ? { specifier: argument.getLiteralValue(), literal: argument }
    : null;
}
