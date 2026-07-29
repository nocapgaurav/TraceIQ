import type { NodeId } from '@traceiq/types';
import { Node, type SourceFile } from 'ts-morph';

import { accessChainOf } from './access-chain.js';
import { sourceRangeOf } from './source-range.js';
import type { CallArgumentIR, CallSiteIR, MemberAccessIR } from './types.js';

export interface ExpressionExtraction {
  readonly callSites: readonly CallSiteIR[];
  readonly memberAccesses: readonly MemberAccessIR[];
}

/**
 * Walks a file's call and member-access expressions.
 *
 * This traversal *does* enter function bodies, unlike declaration extraction, because
 * that is where calls appear. Declarations local to a body remain unrecorded: only
 * expressions are collected here.
 *
 * `declarationIdByNode` maps the declaration nodes the IR recorded to their
 * identifiers, so each expression can be attributed to the declaration containing it
 * by walking its ancestors. Node identity is used rather than positions because
 * ts-morph caches one wrapper per node, which makes the lookup exact and cheap.
 */
export function extractExpressions(input: {
  readonly file: SourceFile;
  readonly fileId: NodeId;
  readonly declarationIdByNode: ReadonlyMap<Node, NodeId>;
}): ExpressionExtraction {
  const callSites: CallSiteIR[] = [];
  const memberAccesses: MemberAccessIR[] = [];

  input.file.forEachDescendant((node) => {
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      callSites.push(callSiteOf(node, input));
      return;
    }

    if (!isAccessExpression(node) || !isOutermostAccess(node)) {
      return;
    }

    const chain = accessChainOf(node);

    // A chain with an empty path is a bare identifier, which carries no access.
    if (chain === null || chain.path.length === 0) {
      return;
    }

    memberAccesses.push({
      fileId: input.fileId,
      enclosingDeclarationId: enclosingDeclarationIdOf(node, input.declarationIdByNode),
      text: node.getText(),
      rootName: chain.rootName,
      path: chain.path,
      location: sourceRangeOf(node),
    });
  });

  return { callSites, memberAccesses };
}

function callSiteOf(
  call: import('ts-morph').CallExpression | import('ts-morph').NewExpression,
  input: Parameters<typeof extractExpressions>[0],
): CallSiteIR {
  const callee = call.getExpression();
  const chain = accessChainOf(callee);

  return {
    fileId: input.fileId,
    isConstruction: Node.isNewExpression(call),
    enclosingDeclarationId: enclosingDeclarationIdOf(call, input.declarationIdByNode),
    calleeText: callee.getText(),
    calleeRootName: chain?.rootName ?? null,
    // Taken from the node rather than the chain, so `this.handle()` still reports
    // `handle` even though a this-rooted chain has no readable root.
    calleeMemberName: Node.isPropertyAccessExpression(callee) ? callee.getName() : null,
    arguments: (call.getArguments() ?? []).map((argument) => callArgumentOf(argument)),
    location: sourceRangeOf(call),
  };
}

function callArgumentOf(argument: Node): CallArgumentIR {
  return {
    text: argument.getText(),
    stringValue: stringValueOf(argument),
  };
}

/**
 * A template literal with no substitutions is a string constant in every practical
 * sense, so `` `/login` `` reads the same as `'/login'`. One containing a substitution
 * is not a constant and yields `null`.
 */
function stringValueOf(argument: Node): string | null {
  if (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.getLiteralValue();
  }

  return null;
}

function isAccessExpression(node: Node): boolean {
  return Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node);
}

/**
 * True when nothing longer contains this chain, and it is not a callee.
 *
 * Inner links are prefixes of the chain already being recorded, and a callee is
 * already described by its `CallSiteIR` — recording either again would duplicate the
 * same syntax under two entries.
 */
function isOutermostAccess(node: Node): boolean {
  const parent = node.getParent();

  if (parent === undefined) {
    return true;
  }

  if (isAccessExpression(parent)) {
    return false;
  }

  // A callee is already described by its own invocation entry, whether that invocation is
  // a call or a construction.
  const isCallee =
    (Node.isCallExpression(parent) || Node.isNewExpression(parent)) &&
    parent.getExpression() === node;

  return !isCallee;
}

function enclosingDeclarationIdOf(
  node: Node,
  declarationIdByNode: ReadonlyMap<Node, NodeId>,
): NodeId | null {
  for (let current = node.getParent(); current !== undefined; current = current.getParent()) {
    const id = declarationIdByNode.get(current);

    if (id !== undefined) {
      return id;
    }
  }

  return null;
}
