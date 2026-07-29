import type { CallGraph } from '@traceiq/call-graph';
import type { GraphEdge, GraphUnresolvedReference } from '@traceiq/graph-api';

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
