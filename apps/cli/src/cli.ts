import { RepositoryPipeline } from '@traceiq/pipeline';

import { COMMANDS, COMMAND_NAMES, findCommand, requireArguments } from './commands.js';
import {
  CliError,
  invalidRepository,
  repositoryNotScanned,
  unknownCommand,
  unknownOption,
} from './errors.js';
import { fields, heading, sections, table } from './format.js';
import { CommandSession } from './session.js';
import type { Io, Options } from './types.js';

/** Where a scan writes and every other command reads, unless `--db` says otherwise. */
export const DEFAULT_DATABASE = '.traceiq/graph.db';

export interface ParsedCommandLine {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Options;
}

/**
 * Parses `argv` into a command, its arguments and its options.
 *
 * Options may appear anywhere; everything else is positional, in order. Written by hand rather than
 * taken from a package: the grammar is two options and a verb, and a dependency for that would be a
 * larger surface than the thing it parses.
 */
export function parseCommandLine(argv: readonly string[], defaults: Options): ParsedCommandLine {
  const positional: string[] = [];
  let databasePath = defaults.databasePath;
  let profile = defaults.profile;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (token === '--db') {
      index += 1;
      databasePath = argv[index] ?? '';

      continue;
    }

    if (token.startsWith('--db=')) {
      databasePath = token.slice('--db='.length);

      continue;
    }

    if (token === '--profile') {
      profile = true;

      continue;
    }

    if (token.startsWith('-')) {
      throw unknownOption(token);
    }

    positional.push(token);
  }

  return {
    command: positional[0] ?? 'help',
    args: positional.slice(1),
    options: { databasePath, profile },
  };
}

/**
 * Runs one command line and returns its exit status.
 *
 * A function rather than a script: `argv` and `io` are arguments, nothing calls `process.exit`, and
 * nothing is cached between calls. That is what lets the whole CLI be tested by calling it.
 *
 * **The CLI contains no analysis.** It parses, opens a graph through the pipeline, calls one
 * capability and renders the result.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ParsedCommandLine;

  try {
    parsed = parseCommandLine(argv, { databasePath: DEFAULT_DATABASE, profile: false });
  } catch (error) {
    return fail(error, io);
  }

  if (parsed.command === 'help' || parsed.command === '--help') {
    io.write(`${renderHelp()}\n`);

    return 0;
  }

  const command = findCommand(parsed.command);

  if (command === undefined) {
    return fail(unknownCommand(parsed.command, COMMAND_NAMES), io);
  }

  const pipeline = new RepositoryPipeline();
  const open = openOnce(pipeline, parsed.options.databasePath);

  try {
    requireArguments(command, parsed.args);

    const output = await command.run({
      args: parsed.args,
      session: () => open.session(),
      scan: async (repositoryPath) => {
        if (repositoryPath === '') {
          throw invalidRepository(repositoryPath, 'no path given');
        }

        try {
          return await pipeline.scan({
            repositoryPath,
            databasePath: parsed.options.databasePath,
            createdAt: FIXED_CREATED_AT,
          });
        } catch (error) {
          throw invalidRepository(repositoryPath, error instanceof Error ? error.message : 'unreadable');
        }
      },
    });

    io.write(`${output}\n`);

    if (parsed.options.profile) {
      io.write(`\n${renderProfile(open.profile())}\n`);
    }

    return 0;
  } catch (error) {
    return fail(error, io);
  } finally {
    open.close();
  }
}

/**
 * The revision timestamp a scan stamps into the store.
 *
 * Fixed rather than read from the clock, so two scans of one repository produce byte-identical
 * databases. No read exposes it — the Graph API has no accessor — so the only thing a live clock
 * would change is reproducibility, which is worth more here than a scan date nothing displays.
 */
const FIXED_CREATED_AT = '1970-01-01T00:00:00.000Z';

interface OpenGraph {
  session(): CommandSession;
  profile(): { readonly graphApiCalls: number };
  close(): void;
}

/**
 * Opens the stored graph at most once per invocation, and only if a command asks for it.
 *
 * `scan` never opens one, and a usage error never touches the filesystem.
 */
function openOnce(pipeline: RepositoryPipeline, databasePath: string): OpenGraph {
  let opened: { readonly close: () => void; readonly session: CommandSession } | null = null;

  return {
    session() {
      if (opened === null) {
        let session;

        try {
          session = pipeline.open(databasePath);
        } catch {
          throw repositoryNotScanned(databasePath);
        }

        opened = { close: session.close, session: new CommandSession(session) };
      }

      return opened.session;
    },
    profile() {
      return opened === null ? { graphApiCalls: 0 } : opened.session.profile();
    },
    close() {
      opened?.close();
      opened = null;
    },
  };
}

function fail(error: unknown, io: Io): number {
  if (error instanceof CliError) {
    io.writeError(`${error.render()}\n`);

    return error.status;
  }

  throw error;
}

function renderProfile(profile: { readonly graphApiCalls: number }): string {
  // Counts only. Elapsed time differs between runs, and this output has to be reproducible.
  return sections(heading('Profile'), fields([['graph api calls', profile.graphApiCalls]]));
}

export function renderHelp(): string {
  return sections(
    heading('traceiq'),
    'Repository intelligence for TypeScript. Scan a repository, then ask it questions.',
    heading('Commands'),
    table(
      [{ header: 'command' }, { header: 'description' }],
      COMMANDS.map((command) => [command.usage, command.summary]),
    ),
    heading('Options'),
    fields([
      ['--db <path>', `where the graph is stored (default ${DEFAULT_DATABASE})`],
      ['--profile', 'print graph reads and cache hits after the output'],
    ]),
  );
}
