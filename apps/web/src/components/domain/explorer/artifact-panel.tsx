'use client';

import { ListingNote } from '@/components/domain/listing-note';
import { NodePill } from '@/components/domain/node-pill';
import { Stat, StatGrid } from '@/components/domain/stat';
import { EmptyState } from '@/components/domain/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { count } from '@/lib/format';
import type { ArtifactLink, ArtifactSection, ArtifactView } from '@/types/api';

/**
 * What a non-code artefact declares, for the centre panel of the Explorer.
 *
 * **The Explorer was a declaration explorer wearing a repository explorer's name, and this is the fix.**
 * Opening `.github/workflows/release.yml` showed six zeroes and the sentence "This file declares nothing" —
 * true of declarations, false of the file, and indistinguishable to a reader from "this file does nothing".
 * The graph now holds the four jobs it declares, which of them needs which, the eleven steps inside them and
 * the two scripts those steps run, and every one of those is a stored node or edge rather than a
 * description of one.
 *
 * **The layout is the layout.** Same header, same stat grid, same tab shape, same card and empty-state
 * components as the source-file panel — only the *information* changes with the artefact. A reader moving
 * between a `.ts` file and a compose file should not have to learn a second page.
 */
export function ArtifactSummaryHeader({ artifact }: { readonly artifact: ArtifactView }) {
  const { summary } = artifact;

  return (
    <div className="flex flex-col gap-4">
      {/*
        The deterministic summary, as prose rather than as a table.
        Every clause is a projection of stored facts — see `ArtifactSummary` — so nothing here is generated
        and nothing is a ranking.
      */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {sentenceFor(artifact)}
      </p>

      <StatGrid compact>
        {summary.defines.slice(0, 4).map((entry) => (
          <Stat key={entry.kind} compact label={label(entry.kind)} value={entry.count} />
        ))}
        {summary.referencedBy === 0 ? null : (
          <Stat
            compact
            label="Referenced by"
            value={summary.referencedBy}
            detail="files and artefacts naming this one"
          />
        )}
        {summary.variables.length === 0 ? null : (
          <Stat
            compact
            label="Variables"
            value={summary.variables.length}
            detail="names only; no value is read"
          />
        )}
      </StatGrid>
    </div>
  );
}

/**
 * The artefact's structure, grouped by the section the reader recorded.
 *
 * Elements appear in file order, never sorted by name: the file's own order is the only order that was
 * observed, and re-ordering the steps of a pipeline would show a reader a sequence nobody wrote.
 */
export function ArtifactStructure({
  sections,
  boundary,
  kind,
}: {
  readonly sections: readonly ArtifactSection[];
  readonly boundary: string;
  readonly kind: string;
}) {
  if (sections.length === 0) {
    return (
      <Card className="min-w-0 p-1">
        {/*
          **Never "this file declares nothing".** The distinction the empty state has to carry is between
          an artefact that was read and yielded no structure and a file nobody looked at, and the boundary
          sentence below is what tells them apart.
        */}
        <EmptyState
          title="No structure was extracted from this artefact"
          detail={`TraceIQ read it as ${kind.replace(/-/g, ' ')} and found none of the structures it knows how to recognise. That is a statement about the reading, not about the file.`}
        />
        <p className="px-3 pb-3 text-[11px] leading-relaxed text-muted-foreground">{boundary}</p>
      </Card>
    );
  }

  return (
    <Card className="min-w-0 p-1">
      {sections.map((section) => (
        <div key={section.title} className="mb-2">
          <p className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {section.title === '' ? 'top level' : section.title} ({section.elements.length})
          </p>
          <ul>
            {section.elements.map((element) => (
              <li key={element.node.id} className="rounded-md px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {element.kind}
                  </Badge>
                  <span className="truncate font-mono text-xs">{element.name}</span>
                  {element.line === 0 ? null : (
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">:{element.line}</span>
                  )}
                </div>
                {element.detail === '' || element.detail === element.name ? null : (
                  <p className="mt-0.5 truncate pl-1 font-mono text-[11px] text-muted-foreground">{element.detail}</p>
                )}
                {element.requires.length === 0 ? null : (
                  /*
                   * The only ordering shown anywhere in this panel, and it is shown because the artefact
                   * states it: a workflow's `needs`, a compose `depends_on`, a `COPY --from`. Nothing here
                   * is derived from the order elements appear in the file.
                   */
                  <p className="mt-0.5 pl-1 text-[11px] text-muted-foreground">
                    needs {element.requires.map((node) => node.name).join(', ')}{' '}
                    <span className="opacity-70">— declared by this artefact</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">{boundary}</p>
    </Card>
  );
}

/** What this artefact reaches, and what reaches it, with the evidence for each. */
export function ArtifactLinks({
  links,
  empty,
  onSelectFile,
}: {
  readonly links: { readonly entries: readonly ArtifactLink[]; readonly total: number; readonly truncated: boolean };
  readonly empty: { readonly title: string; readonly detail: string };
  readonly onSelectFile?: (path: string) => void;
}) {
  return (
    <Card className="min-w-0 p-1">
      {links.entries.length === 0 ? (
        <EmptyState title={empty.title} detail={empty.detail} />
      ) : (
        <ul>
          {links.entries.map((link, index) => (
            <li key={`${link.type}-${link.node.id}-${index}`} className="rounded-md px-2 py-1.5">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {RELATION_LABEL[link.type] ?? link.type.toLowerCase()}
                </Badge>
                {link.node.kind === 'File' && onSelectFile !== undefined ? (
                  <button
                    type="button"
                    onClick={() => {
                      onSelectFile(link.node.id.replace(/^file:/, ''));
                    }}
                    className="truncate font-mono text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {link.node.name}
                  </button>
                ) : (
                  <NodePill node={link.node} />
                )}
                {link.confidence === 'CERTAIN' ? null : (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {link.confidence}
                  </Badge>
                )}
              </div>
              {/* The evidence, verbatim. A relationship a reader cannot check is one they have to trust. */}
              <p className="mt-0.5 pl-1 text-[11px] leading-relaxed text-muted-foreground">{link.evidence}</p>
            </li>
          ))}
        </ul>
      )}
      <ListingNote listing={links} noun="relationship" />
    </Card>
  );
}

/** Paths the artefact names that resolved to no file. Shown, because an unresolved reference is a finding. */
export function ArtifactUnresolved({ artifact }: { readonly artifact: ArtifactView }) {
  return (
    <Card className="min-w-0 p-1">
      {artifact.unresolved.entries.length === 0 ? (
        <EmptyState
          title="Everything this artefact names resolved"
          detail="Each path and prerequisite it states matched something the repository holds."
        />
      ) : (
        <ul>
          {artifact.unresolved.entries.map((entry, index) => (
            <li key={`${entry.type}-${entry.text}-${index}`} className="rounded-md px-2 py-1.5">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {entry.type.toLowerCase()}
                </Badge>
                <span className="truncate font-mono text-xs">{entry.text}</span>
              </div>
              <p className="mt-0.5 pl-1 text-[11px] leading-relaxed text-muted-foreground">{entry.evidence}</p>
            </li>
          ))}
        </ul>
      )}
      <ListingNote listing={artifact.unresolved} noun="unresolved reference" />
    </Card>
  );
}

/**
 * The summary as one sentence, assembled from the fields the graph filled.
 *
 * Assembled rather than written, exactly as the AI layer's purpose sentence is: every clause is a field
 * that either has a value or does not, and a clause with no value simply does not appear.
 */
function sentenceFor(artifact: ArtifactView): string {
  const { summary } = artifact;
  const clauses: string[] = [`A ${summary.kind.replace(/-/g, ' ')}`];

  if (summary.role !== null) {
    clauses.push(`classified as ${summary.role} by the scan`);
  }

  if (summary.defines.length > 0) {
    clauses.push(
      `declaring ${summary.defines
        .slice(0, 4)
        .map((entry) => `${entry.count} ${entry.count === 1 ? singular(entry.kind) : label(entry.kind).toLowerCase()}`)
        .join(', ')}`,
    );
  }

  if (summary.configures.length > 0) {
    clauses.push(`configuring ${summary.configures.join(', ')}`);
  }

  if (summary.reaches.length > 0) {
    clauses.push(
      summary.reaches
        .map((entry) => `${entry.count} ${entry.count === 1 ? 'file it' : 'files it'} ${verb(entry.type)}`)
        .join(', '),
    );
  }

  clauses.push(summary.position);

  return `${clauses.join(', ')}.${
    summary.established
      ? ''
      : ' Nothing structural was extracted from it — see the analysis boundary below.'
  }`;
}

const RELATION_LABEL: Readonly<Record<string, string>> = {
  RUNS: 'runs',
  REFERENCES: 'references',
  DOCUMENTS: 'documents',
  CONFIGURES: 'configures',
  USES_ENV: 'uses variable',
  CONTAINS: 'contains',
};

function verb(type: string): string {
  return type === 'RUNS' ? 'invokes' : type === 'DOCUMENTS' ? 'documents' : 'names';
}

/** An element kind as a plural label, in the artefact's own vocabulary rather than a generic one. */
function label(kind: string): string {
  const known: Readonly<Record<string, string>> = {
    job: 'Jobs',
    step: 'Steps',
    command: 'Commands',
    'script-target': 'Scripts',
    service: 'Services',
    stage: 'Stages',
    image: 'Images',
    port: 'Ports',
    volume: 'Volumes',
    network: 'Networks',
    variable: 'Variables',
    trigger: 'Triggers',
    condition: 'Conditions',
    input: 'Inputs',
    output: 'Outputs',
    resource: 'Resources',
    entity: 'Entities',
    index: 'Indexes',
    heading: 'Sections',
    section: 'Sections',
    setting: 'Settings',
    member: 'Members',
  };

  return known[kind] ?? `${kind.replace(/-/g, ' ')}s`;
}

function singular(kind: string): string {
  return kind.replace(/-/g, ' ');
}

/** Counts for the tab triggers, so a reader sees which tabs hold anything before opening them. */
export function artifactTabCounts(artifact: ArtifactView): {
  readonly structure: string;
  readonly references: string;
  readonly referencedBy: string;
  readonly unresolved: string;
} {
  return {
    structure: count(artifact.sections.reduce((total, section) => total + section.elements.length, 0)),
    references: count(artifact.references.total),
    referencedBy: count(artifact.referencedBy.total),
    unresolved: count(artifact.unresolved.total),
  };
}
