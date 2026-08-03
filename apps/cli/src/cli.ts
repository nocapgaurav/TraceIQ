import { RepositoryPipeline } from '@traceiq/pipeline';

import type { LanguageModel } from '@traceiq/ai';

import { parseSubjectArgument, runChat } from './chat.js';
import { DEFAULT_PROVIDER, EXAMPLE_MODEL, PROVIDER_NAMES } from './providers.js';
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
  let model = defaults.model;
  let provider = defaults.provider;
  let subject = defaults.subject;

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

    // `chat` takes a value flag each. Both spellings are accepted, as `--db` already is, because a user
    // who learned one form should not have to learn the other.
    const valued: readonly [string, (value: string) => void][] = [
      ['--model', (value) => { model = value; }],
      ['--provider', (value) => { provider = value; }],
      ['--subject', (value) => { subject = value; }],
    ];

    let matched = false;

    for (const [flag, assign] of valued) {
      if (token === flag) {
        index += 1;
        assign(argv[index] ?? '');
        matched = true;

        break;
      }

      if (token.startsWith(`${flag}=`)) {
        assign(token.slice(flag.length + 1));
        matched = true;

        break;
      }
    }

    if (matched) {
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
    options: { databasePath, profile, model, provider, subject },
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
/**
 * What `chat` needs that a test cannot get from a terminal.
 *
 * Injected for the same reason `Io` is: the REPL is then a function a test drives, and nothing in this file
 * reaches for `process.stdin` or a live TTY. The bin script supplies the real implementations.
 */
export interface ChatHost {
  /** Resolves a provider name and a model id to a model. The only vendor-aware step. */
  resolveModel(provider: string, model: string): Promise<LanguageModel>;
  /** Lines the user types. */
  lines(): AsyncIterable<string>;
  /** Subscribes to Ctrl+C, returning an unsubscribe. Each press cancels the answer in flight. */
  onInterrupt?(handler: () => void): () => void;
  /** Whether to colour. False for a pipe, so redirected output stays plain. */
  readonly colour: boolean;
}

export async function run(argv: readonly string[], io: Io, chat?: ChatHost): Promise<number> {
  let parsed: ParsedCommandLine;

  try {
    parsed = parseCommandLine(argv, {
      databasePath: DEFAULT_DATABASE,
      profile: false,
      model: null,
      provider: DEFAULT_PROVIDER,
      subject: null,
    });
  } catch (error) {
    return fail(error, io);
  }

  if (parsed.command === 'help' || parsed.command === '--help') {
    io.write(`${renderHelp()}\n`);

    return 0;
  }

  // `chat` is dispatched before the command table because it is not shaped like a command: a `Command`
  // returns one string when it finishes, and a REPL writes as it goes and reads between writes.
  if (parsed.command === 'chat') {
    return await runChatCommand(parsed, io, chat);
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
 * `traceiq chat`.
 *
 * Everything vendor-aware happens in `chat.resolveModel`, which the bin script supplies. This function
 * validates the command line, opens the graph and hands a resolved model to the REPL — it contains no AI
 * logic, no provider and no prompt.
 */
async function runChatCommand(parsed: ParsedCommandLine, io: Io, chat: ChatHost | undefined): Promise<number> {
  if (chat === undefined) {
    return fail(
      new CliError('chat-failed', 'this build cannot run an interactive session', 'run traceiq from its bin script'),
      io,
    );
  }

  const modelId = parsed.options.model;

  if (modelId === null || modelId === '') {
    // No default model is baked in: the caller must always name one, so an answer never comes from
    // whatever happened to be installed.
    return fail(
      new CliError('missing-argument', '--model is required', `for example: traceiq chat --model ${EXAMPLE_MODEL}`),
      io,
    );
  }

  let subject;

  try {
    subject = parseSubjectArgument(parsed.options.subject ?? 'repository');
  } catch (error) {
    return fail(error, io);
  }

  const pipeline = new RepositoryPipeline();
  const open = openOnce(pipeline, parsed.options.databasePath);

  try {
    const model = await chat.resolveModel(parsed.options.provider, modelId);

    return await runChat(open.session().context(), io, {
      model,
      subject,
      colour: chat.colour,
      lines: chat.lines(),
      ...(chat.onInterrupt === undefined ? {} : { onInterrupt: chat.onInterrupt.bind(chat) }),
    });
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
    'Repository intelligence. Scan a repository, then ask it questions.',
    heading('Commands'),
    table(
      [{ header: 'command' }, { header: 'description' }],
      [
        ...COMMANDS.map((command) => [command.usage, command.summary] as const),
        // `chat` is not in COMMANDS because it is not shaped like one — it is interactive — but a user
        // looking for it will look here, so it is listed with the rest.
        ['chat', 'ask questions about the repository, grounded and cited'] as const,
      ].map((row) => [...row]),
    ),
    heading('Options'),
    fields([
      ['--db <path>', `where the graph is stored (default ${DEFAULT_DATABASE})`],
      ['--profile', 'print graph reads and cache hits after the output'],
    ]),
    heading('Chat options'),
    fields([
      ['--model <id>', 'which model answers — required, no default is assumed'],
      ['--provider <name>', `which provider holds it — one of ${PROVIDER_NAMES.join(', ')} (default ${DEFAULT_PROVIDER})`],
      ['--subject <what>', 'repository, sym:<id>, impact:sym:<id>, file:<path>, pkg:<name>, route:<METHOD>:<path>'],
    ]),
    'In a session: /subject to see or change what is being asked about, /clear to forget the',
    'conversation, /exit to leave. Ctrl+C cancels an answer without ending the session.',
  );
}
