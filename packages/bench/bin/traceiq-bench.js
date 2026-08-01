#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

import { benchmarkRepository } from '../dist/benchmark.js';
import { compareQuality } from '../dist/compare.js';
import { formatComparison, formatReport } from '../dist/format.js';

/**
 * The benchmark's entry point.
 *
 * ```
 * traceiq-bench <repository> [more...]         measure and print
 * traceiq-bench --save <file> <repository>...  measure, print and record a baseline
 * traceiq-bench --against <file> <repository>… measure, print and diff against a baseline
 * ```
 *
 * A baseline file holds an array of reports keyed by repository name. Diffing pairs them
 * up by name and skips any repository the baseline does not contain, so a baseline may
 * cover fewer repositories than the run without failing.
 */
const argv = process.argv.slice(2);

const save = takeOption('--save');
const against = takeOption('--against');
const repositories = argv.filter((argument) => !argument.startsWith('--'));

if (repositories.length === 0) {
  process.stderr.write(
    'usage: traceiq-bench [--save <file>] [--against <file>] <repository> [more...]\n',
  );
  process.exit(2);
}

const baseline = against === null ? null : indexByRepository(JSON.parse(await readFile(against, 'utf8')));
const reports = [];

for (const repository of repositories) {
  let report;

  try {
    report = await benchmarkRepository(repository);
  } catch (error) {
    // One unscannable repository must not discard the measurements already taken.
    process.stderr.write(`\n${repository}: scan failed — ${error.message}\n`);
    continue;
  }

  reports.push(report);
  process.stdout.write(`\n${formatReport(report)}\n`);

  const before = baseline?.get(report.repository);

  if (before !== undefined) {
    process.stdout.write(`\n${formatComparison(compareQuality(before, report))}\n`);
  }
}

if (save !== null) {
  await writeFile(save, `${JSON.stringify(reports, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nbaseline written to ${save}\n`);
}

process.exit(reports.length === repositories.length ? 0 : 1);

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

  // Removed so the remaining positional arguments are repositories only.
  argv.splice(index, 2);

  return value;
}

function indexByRepository(reports) {
  return new Map(reports.map((report) => [report.repository, report]));
}
