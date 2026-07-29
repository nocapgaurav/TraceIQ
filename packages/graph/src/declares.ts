import type { DeclarationIR } from '@traceiq/ir';
import type { NodeId } from '@traceiq/types';

/**
 * Finds the node that declares a declaration, per spec §2.1.
 *
 * Walks the container chain upwards and returns the first ancestor that exists as a
 * declaration; falls back to the declaring file. Walking upwards rather than taking
 * the immediate parent matters because a dotted namespace (`namespace A.B {}`)
 * declares `A.B` without declaring `A` — so `A.B` is declared by its file, while
 * members of `A.B` are declared by `A.B`.
 *
 * This is arithmetic over `containerChain` and `fileId`, both already in the IR. It
 * resolves no names, analyses no scopes and consults no compiler.
 */
export function declaringNodeIdOf(
  declaration: DeclarationIR,
  declarationIds: ReadonlySet<NodeId>,
): NodeId {
  const repoRelativePath = filePathOf(declaration.fileId);

  for (let length = declaration.containerChain.length - 1; length >= 1; length -= 1) {
    const candidate = `sym:${repoRelativePath}#${declaration.containerChain
      .slice(0, length)
      .join('.')}` as NodeId;

    if (declarationIds.has(candidate)) {
      return candidate;
    }
  }

  return declaration.fileId;
}

/** `file:src/a.ts` → `src/a.ts`. The prefix is fixed by the contract. */
function filePathOf(fileId: NodeId): string {
  return fileId.startsWith('file:') ? fileId.slice('file:'.length) : fileId;
}
