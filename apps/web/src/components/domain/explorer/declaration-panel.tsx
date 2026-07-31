'use client';

import { ArrowDownLeft, ArrowUpRight, Braces, Link2 } from 'lucide-react';

import { ConfidenceBadge, KindLabel, NodePill } from '@/components/domain/node-pill';
import { declarationActions, QuickActions } from '@/components/domain/explorer/quick-actions';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState, QueryState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { count, filePathOf, symbolName } from '@/lib/format';
import { routes } from '@/lib/routes';
import type { useSymbol } from '@/hooks/queries';
import type { Callee, Reference } from '@/types/api';

/**
 * One declaration, in full.
 *
 * The Explorer's destination. Everything comes from `GET /symbol/{id}`, which already assembles what
 * would otherwise be several requests — the declaration, its roles, its calls in both directions, its
 * references, its impact summary and its provenance.
 *
 * The three relationship lists are kept apart rather than merged into "related". Callers, callees and
 * references answer different questions, and a single blended list would answer none of them.
 */
export function DeclarationPanel({
  query,
  id,
  onSelectFile,
}: {
  readonly query: ReturnType<typeof useSymbol>;
  readonly id: string;
  readonly onSelectFile: (path: string) => void;
}) {
  return (
    <QueryState query={query} loadingRows={6}>
      {(view) => {
        const { explain } = view;
        const node = explain.declaration.node;
        const path = explain.sourceFile?.path ?? filePathOf(node.id);

        return (
          <div className="flex flex-col gap-5 p-5">
            {/* The card the milestone asks for: identity first, at a size that says this is the subject. */}
            <header className="relative overflow-hidden rounded-xl border border-border bg-card p-6">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-primary/[0.07] to-transparent"
              />
              <div className="relative">
                <div className="flex flex-wrap items-center gap-2">
                  <KindLabel kind={node.kind} />
                  {node.isExported ? <Badge variant="outline">export</Badge> : null}
                  <ConfidenceBadge confidence={node.confidence} />
                  {explain.declaration.roles.map((role) => (
                    <Badge key={role.role} variant="secondary" title={role.evidence}>
                      {role.role}
                    </Badge>
                  ))}
                </div>

                <h2 className="mt-3 break-all font-mono text-2xl font-semibold tracking-tight">
                  {symbolName(node.id)}
                </h2>

                <dl className="mt-4 flex flex-col gap-1.5 text-xs">
                  <Line label="Package">
                    <span className="font-mono">{view.packageName ?? 'not derived'}</span>
                  </Line>
                  <Line label="File">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectFile(path);
                      }}
                      className="break-all text-left font-mono text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {path}
                    </button>
                  </Line>
                  {explain.locations[0] === undefined ? null : (
                    <Line label="Lines">
                      <span className="font-mono tabular-nums">
                        {explain.locations[0].startLine}–{explain.locations[0].endLine}
                      </span>
                    </Line>
                  )}
                </dl>

                <div className="mt-5">
                  <QuickActions actions={declarationActions(node.id, symbolName(node.id))} />
                </div>
              </div>
            </header>

            <StatGrid compact>
              <Stat compact label="Fan-in" value={view.health.fanIn} detail="distinct referencing nodes" />
              <Stat compact label="Fan-out" value={view.health.fanOut} detail="distinct referenced nodes" />
              <Stat compact label="Directly affected" value={view.impact.directlyAffected} detail="if this changed" />
              <Stat compact label="Indirectly affected" value={view.impact.indirectlyAffected} />
              <Stat compact label="Max depth" value={view.impact.maxDepth} detail="hops to the furthest dependent" />
              <Stat compact label="In a cycle" value={view.health.inCycle ? 'yes' : 'no'} />
            </StatGrid>

            <div className="grid gap-4 xl:grid-cols-2">
              <RelationCard
                icon={ArrowDownLeft}
                title="Dependents"
                detail="what calls this declaration"
                empty="Nothing recorded as calling this. It may be an entry point, called dynamically, or reached in a way the call graph could not bind."
                nodes={explain.incomingCalls.map((reference) => reference.source)}
              />
              <RelationCard
                icon={ArrowUpRight}
                title="Dependencies"
                detail="what this declaration calls"
                empty="This calls nothing the analysis could bind to a declaration."
                nodes={explain.outgoingCalls.map((callee) => callee.target)}
              />
            </div>

            <RelationCard
              icon={Link2}
              title="References"
              detail="every mention of this declaration, not only calls"
              empty="No reference to this declaration was resolved."
              nodes={explain.references.map((reference) => reference.source)}
            />

            {explain.typeReferences.length === 0 ? null : (
              <RelationCard
                icon={Braces}
                title="Type references"
                detail="declarations naming this one in a type position"
                empty=""
                nodes={explain.typeReferences.map((reference) => reference.source)}
              />
            )}

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Provenance</CardTitle>
                <p className="text-[11px] font-normal text-muted-foreground">
                  Which part of the analysis recorded this, and on what evidence.
                </p>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5 text-xs">
                <Line label="Producer">
                  <span className="font-mono">{explain.provenance.producer}</span>
                </Line>
                <Line label="Confidence">
                  <span className="font-mono">{explain.confidence}</span>
                </Line>
                <Line label="Evidence">
                  <span className="text-muted-foreground">{explain.provenance.evidence}</span>
                </Line>
              </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground">
              Reading the whole record for this declaration?{' '}
              <a href={routes.symbol(id)} className="text-primary hover:underline">
                Open it on the Symbol page
              </a>
              , which adds children, routes, unresolved references and the raw payload.
            </p>
          </div>
        );
      }}
    </QueryState>
  );
}

function Line({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

/**
 * One relationship list.
 *
 * `null` targets are dropped, not rendered blank: the API returns a null node where an edge exists but its
 * other end could not be resolved, and the count above already states how many edges there were — so the
 * difference between the two is visible without inventing a row for something unnamed.
 */
function RelationCard({
  icon: Icon,
  title,
  detail,
  empty,
  nodes,
}: {
  readonly icon: React.ComponentType<{ readonly className?: string }>;
  readonly title: string;
  readonly detail: string;
  readonly empty: string;
  readonly nodes: readonly (Reference['source'] | Callee['target'])[];
}) {
  const resolved = nodes.filter((node) => node !== null);
  const unresolved = nodes.length - resolved.length;

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          <CardTitle>
            {title} <span className="font-normal text-muted-foreground">({count(nodes.length)})</span>
          </CardTitle>
        </div>
        <p className="text-[11px] font-normal text-muted-foreground">{detail}</p>
      </CardHeader>
      <CardContent className="p-1">
        {resolved.length === 0 ? (
          <EmptyState title={empty === '' ? 'Nothing recorded' : empty} />
        ) : (
          <ul>
            {resolved.slice(0, 15).map((node) => (
              <li key={node.id}>
                <NodePill node={node} />
              </li>
            ))}
          </ul>
        )}
        {resolved.length > 15 ? (
          <p className="px-2 py-1 text-[11px] text-warning">
            showing 15 of {count(resolved.length)} — this panel caps this list
          </p>
        ) : null}
        {unresolved > 0 ? (
          // One string, not three expressions: split across elements the sentence cannot be read as a
          // whole — by a text matcher or by anyone using a screen reader.
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            {unresolved === 1
              ? '1 further edge exists whose other end the analysis could not name.'
              : `${count(unresolved)} further edges exist whose other ends the analysis could not name.`}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
