import type { QualityComparison } from './compare.js';
import type { FactScore, GroundTruthReport } from './ground-truth-types.js';
import type { QualityReport, TargetReach } from './types.js';

/**
 * Renders a report as fixed-width text.
 *
 * Formatting only: every number rendered here was computed by `measureQuality`, and
 * nothing is derived, rounded into a different meaning, or summarised into a verdict.
 */
export function formatReport(report: QualityReport): string {
  const universal = report.universal;
  const lines: string[] = [
    `${report.repository}  —  ${report.files} files, ${report.nodes} nodes, ${report.edges} edges, ${report.unresolved} unresolved  (${report.scanMillis} ms)`,
    '',
    `  depth ${universal.depth}${universal.isPolyglot ? '  (polyglot)' : ''}  —  ${universal.regions} region(s), ${universal.semanticRegions} semantic, ${universal.manifests} manifest(s), ${universal.declaredDependencies} declared dependenc(ies)`,
    `  languages  ${universal.languages.length === 0 ? 'none recognised' : universal.languages.map((entry) => `${entry.language} ${entry.files}`).join(', ')}`,
    '',
    `  ${'relationship'.padEnd(17)}${'resolved'.padStart(9)}${'unresolved'.padStart(12)}${'bind rate'.padStart(11)}`,
    `  ${'-'.repeat(49)}`,
  ];

  for (const relationship of report.relationships) {
    lines.push(
      `  ${relationship.type.padEnd(17)}${String(relationship.resolved).padStart(9)}${String(
        relationship.unresolved,
      ).padStart(12)}${percent(relationship.bindRate).padStart(11)}`,
    );
  }

  lines.push('', `  IMPORTS reach   ${formatReach(report.importReach)}`);
  lines.push(`  CALLS reach     ${formatReach(report.callReach)}`);
  lines.push(
    `  CALLS internal  ${percent(report.internalCallBindRate)} of calls reach a declaration in this repository`,
  );

  const withReasons = report.relationships.filter(
    (relationship) => relationship.byReason.length > 0,
  );

  if (withReasons.length > 0) {
    lines.push('', '  unresolved reasons');

    for (const relationship of withReasons) {
      for (const reason of relationship.byReason) {
        lines.push(
          `    ${String(reason.count).padStart(7)}  ${relationship.type}  ${reason.reason}`,
        );
      }
    }
  }

  return lines.join('\n');
}

/** `internal` is the number that matters; the others explain where the rest went. */
function formatReach(reach: TargetReach): string {
  return `internal ${reach.internal}, named external ${reach.named}, opaque ${reach.opaque}`;
}

export function formatComparison(comparison: QualityComparison): string {
  const lines: string[] = [
    `${comparison.repository}  —  baseline vs current`,
    '',
    `  ${'relationship'.padEnd(17)}${'baseline'.padStart(10)}${'current'.padStart(10)}${'change'.padStart(11)}${'resolved'.padStart(11)}`,
    `  ${'-'.repeat(59)}`,
  ];

  for (const delta of comparison.relationships) {
    lines.push(
      `  ${delta.type.padEnd(17)}${percent(delta.baselineBindRate).padStart(10)}${percent(
        delta.currentBindRate,
      ).padStart(10)}${points(delta.bindRatePoints).padStart(11)}${signed(delta.resolvedDelta).padStart(11)}`,
    );
  }

  lines.push(
    '',
    `  CALLS internal  ${points(comparison.internalCallBindRatePoints)}`,
    `  opaque IMPORTS  ${signed(comparison.opaqueImportsDelta)}`,
    `  opaque CALLS    ${signed(comparison.opaqueCallsDelta)}`,
    `  scan time       ${signed(comparison.scanMillisDelta)} ms`,
  );

  return lines.join('\n');
}

function percent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function points(value: number | null): string {
  return value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)} pp`;
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

/**
 * Renders a ground-truth report.
 *
 * Precision and recall lead, because they are the only numbers in this project with a right answer
 * to be right about. The examples follow, because a percentage says a scan is wrong and only a
 * named fact says how.
 */
export function formatGroundTruth(report: GroundTruthReport): string {
  const lines: string[] = [
    `${report.name}  —  ${report.description}`,
    '',
    `  ${report.files} files, ${report.scanMillis} ms, ${formatBytes(report.heapBytes)} heap`,
    '',
    `  ${'fact'.padEnd(17)}${'expected'.padStart(9)}${'produced'.padStart(10)}${'matched'.padStart(9)}${'precision'.padStart(11)}${'recall'.padStart(9)}`,
    `  ${'-'.repeat(65)}`,
    scoreLine('declarations', report.declarations),
  ];

  for (const edge of report.edges) {
    lines.push(scoreLine(edge.type, edge));
  }

  lines.push(`  ${'-'.repeat(65)}`, scoreLine('overall', report.overall));

  const missing = [...report.declarations.missing, ...report.edges.flatMap((edge) => edge.missing)];
  const spurious = [...report.declarations.spurious, ...report.edges.flatMap((edge) => edge.spurious)];

  if (missing.length > 0) {
    lines.push('', '  expected and not found');
    lines.push(...missing.map((fact) => `    ${fact}`));
  }

  if (spurious.length > 0) {
    lines.push('', '  found and not expected');
    lines.push(...spurious.map((fact) => `    ${fact}`));
  }

  const confidence = Object.entries(report.byConfidence).filter(([, count]) => count > 0);

  if (confidence.length > 0) {
    lines.push(
      '',
      `  confidence  ${confidence.map(([level, count]) => `${level} ${count}`).join(', ')}`,
    );
  }

  if (report.unresolvedByReason.length > 0) {
    lines.push('', '  unresolved reasons');
    lines.push(
      ...report.unresolvedByReason.map((entry) => `    ${String(entry.count).padStart(5)}  ${entry.reason}`),
    );
  }

  return lines.join('\n');
}

function scoreLine(label: string, entry: FactScore): string {
  return `  ${label.padEnd(17)}${String(entry.expected).padStart(9)}${String(entry.produced).padStart(
    10,
  )}${String(entry.matched).padStart(9)}${percent(entry.precision).padStart(11)}${percent(
    entry.recall,
  ).padStart(9)}`;
}

function formatBytes(bytes: number | null): string {
  return bytes === null ? 'unmeasured' : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
