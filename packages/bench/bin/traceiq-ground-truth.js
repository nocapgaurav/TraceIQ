#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

import { GROUND_TRUTH_CASES } from '../dist/ground-truth-cases.js';
import { formatGroundTruth } from '../dist/format.js';
import { measureGroundTruth } from '../dist/ground-truth.js';

/**
 * The ground-truth suite's entry point.
 *
 * ```
 * traceiq-ground-truth                        run every case and print
 * traceiq-ground-truth typescript go          run named cases only
 * traceiq-ground-truth --save <file>          also record the reports as JSON
 * ```
 *
 * Exits non-zero when any case scores below a perfect recall *or* precision, so the suite can gate
 * a change without a human reading it. There is no partial-credit threshold: the expectation is a
 * hand-written truth about a repository small enough to hold in one's head, and "most of it" is not
 * a state this suite is meant to sit in.
 */
const argv = process.argv.slice(2);
const save = takeOption('--save');
const names = argv.filter((argument) => !argument.startsWith('--'));

const selected =
  names.length === 0
    ? GROUND_TRUTH_CASES
    : GROUND_TRUTH_CASES.filter((entry) => names.includes(entry.name));

if (selected.length === 0) {
  process.stderr.write(
    `no such case. known: ${GROUND_TRUTH_CASES.map((entry) => entry.name).join(', ')}\n`,
  );
  process.exit(2);
}

const reports = await measureGroundTruth(selected);

for (const report of reports) {
  process.stdout.write(`\n${formatGroundTruth(report)}\n`);
}

process.stdout.write(`\n${summaryOf(reports)}\n`);

if (save !== null) {
  await writeFile(save, `${JSON.stringify(reports, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nground truth written to ${save}\n`);
}

process.exit(reports.every(isPerfect) ? 0 : 1);

function isPerfect(report) {
  return report.overall.precision === 1 && report.overall.recall === 1;
}

function summaryOf(reports) {
  const rows = reports.map(
    (report) =>
      `  ${report.name.padEnd(12)}${percent(report.overall.precision).padStart(11)}${percent(
        report.overall.recall,
      ).padStart(9)}${String(report.scanMillis).padStart(8)} ms`,
  );

  return [
    `summary  —  ${reports.filter(isPerfect).length} of ${reports.length} cases exact`,
    '',
    `  ${'case'.padEnd(12)}${'precision'.padStart(11)}${'recall'.padStart(9)}${'scan'.padStart(11)}`,
    `  ${'-'.repeat(43)}`,
    ...rows,
  ].join('\n');
}

function percent(rate) {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function takeOption(name) {
  const index = argv.indexOf(name);

  if (index === -1) {
    return null;
  }

  const value = argv[index + 1];

  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`${name} needs a file path\n`);
    process.exit(2);
  }

  argv.splice(index, 2);

  return value;
}
