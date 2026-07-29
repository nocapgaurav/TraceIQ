import type { SourceRange } from '@traceiq/ir';
import type { ConfidenceLevel, NodeId } from '@traceiq/types';

import type { SymbolResolution } from './symbol-target.js';
import type {
  Provenance,
  ResolutionTarget,
  ResolvedRelationship,
  ResolvedRelationshipType,
  UnresolvedReason,
  UnresolvedReference,
} from './types.js';

interface ReferenceSite {
  readonly type: ResolvedRelationshipType;
  readonly sourceId: NodeId;
  readonly name: string | null;
  readonly location: SourceRange;
  readonly resolver: Provenance['resolver'];
  readonly fileId: NodeId;
}

/**
 * Accumulates resolved relationships and unresolved references.
 *
 * Its one piece of real logic is expanding an ambiguous resolution into several
 * relationships that share a candidate group, so a consumer can tell alternatives
 * apart from independent facts.
 */
export class ResolutionCollector {
  readonly #relationships: ResolvedRelationship[] = [];
  readonly #unresolved: UnresolvedReference[] = [];

  /** Records the outcome of resolving one reference through the type checker. */
  addSymbolResolution(site: ReferenceSite, resolution: SymbolResolution, text: string): void {
    if (resolution.outcome === 'unresolved') {
      this.addUnresolved(site, resolution.reason, text, resolution.evidence);
      return;
    }

    const isAmbiguous = resolution.targets.length > 1;
    const candidateGroup = isAmbiguous ? candidateGroupOf(site) : null;

    for (const target of resolution.targets) {
      this.#relationships.push({
        type: site.type,
        sourceId: site.sourceId,
        target,
        name: site.name,
        confidence: resolution.confidence,
        provenance: {
          resolver: site.resolver,
          fileId: site.fileId,
          evidence: resolution.evidence,
        },
        location: site.location,
        candidateGroup,
      });
    }
  }

  /** Records a relationship established without consulting the checker. */
  addRelationship(
    site: ReferenceSite,
    target: ResolutionTarget,
    confidence: ConfidenceLevel,
    evidence: string,
  ): void {
    this.#relationships.push({
      type: site.type,
      sourceId: site.sourceId,
      target,
      name: site.name,
      confidence,
      provenance: { resolver: site.resolver, fileId: site.fileId, evidence },
      location: site.location,
      candidateGroup: null,
    });
  }

  addUnresolved(
    site: ReferenceSite,
    reason: UnresolvedReason,
    text: string,
    evidence: string,
  ): void {
    this.#unresolved.push({
      type: site.type,
      sourceId: site.sourceId,
      name: site.name,
      reason,
      text,
      provenance: { resolver: site.resolver, fileId: site.fileId, evidence },
      location: site.location,
    });
  }

  get relationships(): readonly ResolvedRelationship[] {
    return this.#relationships;
  }

  get unresolved(): readonly UnresolvedReference[] {
    return this.#unresolved;
  }
}

/**
 * Derived from the reference site rather than generated, so the same sources
 * always produce the same group and a resolved repository stays comparable
 * between runs.
 */
function candidateGroupOf(site: ReferenceSite): string {
  return [
    site.sourceId,
    site.type,
    site.name ?? '',
    `${site.location.startLine}:${site.location.startColumn}`,
  ].join('|');
}
