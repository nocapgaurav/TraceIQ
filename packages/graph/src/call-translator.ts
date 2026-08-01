import type { CallGraph, ExternalCall } from '@traceiq/call-graph';
import type { GraphEdge, GraphUnresolvedReference } from '@traceiq/graph-api';
import type { NodeId } from '@traceiq/types';

import { externalIdentityOf } from './external-identity.js';
import { edgeIdentity } from './identity.js';

export interface CallTranslation {
  readonly edges: readonly GraphEdge[];
  readonly unresolved: readonly GraphUnresolvedReference[];
}

/**
 * Translates the call graph into `CALLS` edges.
 *
 * A field-for-field copy, like every other relationship the Graph Builder handles. The
 * binding rule that fired is carried through in the provenance, and the confidence is
 * copied rather than recomputed.
 *
 * A call the resolver could not bind becomes an unresolved reference rather than a missing
 * edge, so an absent `CALLS` edge stays distinguishable from an absent call.
 */
/**
 * Registers an external node and returns the identity it was given.
 *
 * Supplied by the Graph Builder, which owns the map every external is pooled in, so a
 * package that is both imported and called becomes one node rather than two.
 */
export type RegisterExternal = (input: {
  readonly id: NodeId;
  readonly kind: ReturnType<typeof externalIdentityOf>['kind'];
  readonly name: string | null;
  readonly confidence: GraphEdge['confidence'];
}) => void;

/**
 * Translates calls that leave the repository into `CALLS` edges onto External nodes.
 *
 * These edges are what make a declaration's third-party dependencies visible. `IMPORTS`
 * is recorded at the *file*, so before this the graph could say that a file imports
 * `better-sqlite3` but not which function in it actually calls into the package — and in
 * a file of twenty declarations that is the difference between a usable answer and a
 * shrug.
 *
 * Identity is minted through `externalIdentityOf`, the same function imports go through,
 * so `ext:npm:express` reached by a call and by an import is one node.
 */
export function translateExternalCalls(
  externalCalls: readonly ExternalCall[],
  register: RegisterExternal,
): readonly GraphEdge[] {
  return externalCalls.map((call) => {
    const identity = externalIdentityOf(
      { kind: 'external', origin: call.origin, name: call.name, ecosystem: call.ecosystem },
      call.calleeText,
    );

    register({
      id: identity.id,
      kind: identity.kind,
      name: identity.name,
      confidence: call.confidence,
    });

    return {
      id: edgeIdentity(
        'CALLS',
        call.sourceId,
        identity.id,
        call.calleeText,
        call.provenance.fileId,
        call.location,
      ),
      type: 'CALLS' as const,
      sourceId: call.sourceId,
      targetId: identity.id,
      name: call.calleeText,
      confidence: call.confidence,
      candidateGroup: null,
      ordinal: null,
      provenance: {
        producer: call.provenance.producer,
        fileId: call.provenance.fileId,
        evidence: `external: ${call.provenance.evidence}`,
      },
      location: call.location,
    };
  });
}

export function translateCallGraph(callGraph: CallGraph): CallTranslation {
  return {
    edges: callGraph.calls.map((call) => ({
      id: edgeIdentity(
        'CALLS',
        call.sourceId,
        call.targetId,
        call.calleeText,
        call.provenance.fileId,
        call.location,
      ),
      type: 'CALLS',
      sourceId: call.sourceId,
      targetId: call.targetId,
      name: call.calleeText,
      confidence: call.confidence,
      candidateGroup: call.candidateGroup,
      ordinal: null,
      provenance: {
        producer: call.provenance.producer,
        fileId: call.provenance.fileId,
        evidence: `${call.kind}: ${call.provenance.evidence}`,
      },
      location: call.location,
    })),
    unresolved: callGraph.unresolved.map((call) => ({
      id: [
        'unresolved',
        'CALLS',
        call.sourceId,
        call.calleeText,
        call.provenance.fileId,
        `${call.location.startLine}:${call.location.startColumn}`,
      ].join('|'),
      type: 'CALLS',
      sourceId: call.sourceId,
      name: call.calleeText,
      reason: call.reason,
      text: call.calleeText,
      provenance: {
        producer: call.provenance.producer,
        fileId: call.provenance.fileId,
        evidence: call.provenance.evidence,
      },
      location: call.location,
    })),
  };
}
