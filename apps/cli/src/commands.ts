import type { NodeId } from '@traceiq/types';

import {
  missingArgument,
  unknownIdentifier,
  unknownPackage,
  unknownRoute,
} from './errors.js';
import {
  renderArchitecture,
  renderCycles,
  renderDependencies,
  renderFile,
  renderHealth,
  renderHotspots,
  renderImpact,
  renderOverview,
  renderPackage,
  renderPackages,
  renderRoute,
  renderRoutes,
  renderScan,
  renderSearch,
  renderSymbol,
} from './render.js';
import type { CommandSession } from './session.js';
import type { ScanRunner } from './types.js';

export interface CommandInput {
  readonly args: readonly string[];
  /** Opens the stored graph. Throws `repository-not-scanned` when there is none. */
  readonly session: () => CommandSession;
  /** Builds and stores a graph. Only `scan` uses it. */
  readonly scan: ScanRunner;
}

export interface Command {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  /** Argument names, all required. Checked before the command runs. */
  readonly arguments: readonly string[];
  run(input: CommandInput): Promise<string>;
}

const id = (value: string): NodeId => value as NodeId;

/**
 * Every command, in the order `help` lists them.
 *
 * A command **orchestrates and renders**. It resolves arguments, calls one capability and hands the
 * result to a renderer — there is no analysis here, and nothing is recomputed that a capability
 * already returned.
 */
export const COMMANDS: readonly Command[] = [
  {
    name: 'scan',
    usage: 'traceiq scan <repository>',
    summary: 'Build the repository graph and store it.',
    arguments: ['repository'],
    async run({ args, scan }) {
      return renderScan(await scan(args[0] ?? ''));
    },
  },
  {
    name: 'overview',
    usage: 'traceiq overview',
    summary: 'Repository, graph and health summary.',
    arguments: [],
    async run({ session }) {
      return renderOverview(session().explorer().overview());
    },
  },
  {
    name: 'architecture',
    usage: 'traceiq architecture',
    summary: 'Roles, kinds and package dependencies.',
    arguments: [],
    async run({ session }) {
      return renderArchitecture(session().navigator().architecture());
    },
  },
  {
    name: 'packages',
    usage: 'traceiq packages',
    summary: 'Every derived package.',
    arguments: [],
    async run({ session }) {
      return renderPackages(session().explorer().browsePackages());
    },
  },
  {
    name: 'package',
    usage: 'traceiq package <name>',
    summary: 'One package: files, dependencies, roles.',
    arguments: ['name'],
    async run({ args, session }) {
      const name = args[0] ?? '';
      const view = session().explorer().browsePackage(name);

      if (view === null) {
        throw unknownPackage(name);
      }

      return renderPackage(view);
    },
  },
  {
    name: 'file',
    usage: 'traceiq file <path>',
    summary: 'One file: declarations, imports, routes.',
    arguments: ['path'],
    async run({ args, session }) {
      const path = args[0] ?? '';
      const view = session().explorer().browseFile(fileId(path));

      if (view === null) {
        throw unknownIdentifier(path);
      }

      return renderFile(view);
    },
  },
  {
    name: 'symbol',
    usage: 'traceiq symbol <id>',
    summary: 'Everything recorded about one declaration.',
    arguments: ['id'],
    async run({ args, session }) {
      const value = args[0] ?? '';
      const view = session().explorer().browseSymbol(id(value));

      if (view === null) {
        throw unknownIdentifier(value);
      }

      return renderSymbol(view);
    },
  },
  {
    name: 'impact',
    usage: 'traceiq impact <id>',
    summary: 'What a change to one declaration could affect.',
    arguments: ['id'],
    async run({ args, session }) {
      const value = args[0] ?? '';
      const result = session().impact().analyze(id(value));

      if (result === null) {
        throw unknownIdentifier(value);
      }

      return renderImpact(result);
    },
  },
  {
    name: 'routes',
    usage: 'traceiq routes',
    summary: 'Every route the repository registers.',
    arguments: [],
    async run({ session }) {
      return renderRoutes(session().navigator().routes());
    },
  },
  {
    name: 'route',
    usage: 'traceiq route <method> <path>',
    summary: 'One route: chain, roles reached, health.',
    arguments: ['method', 'path'],
    async run({ args, session }) {
      const method = args[0] ?? '';
      const path = args[1] ?? '';
      const view = session().navigator().explainRoute({ method, path });

      if (view === null) {
        throw unknownRoute(method, path);
      }

      return renderRoute(view);
    },
  },
  {
    name: 'health',
    usage: 'traceiq health',
    summary: 'Architectural health report.',
    arguments: [],
    async run({ session }) {
      return renderHealth(session().health().analyze());
    },
  },
  {
    name: 'search',
    usage: 'traceiq search <text>',
    summary: 'Exact or prefix search, alphabetical.',
    arguments: ['text'],
    async run({ args, session }) {
      return renderSearch(session().explorer().search({ text: args[0] ?? '' }));
    },
  },
  {
    name: 'dependencies',
    usage: 'traceiq dependencies <id>',
    summary: 'Direct and transitive dependencies of a package, file, declaration or route.',
    arguments: ['id'],
    async run({ args, session }) {
      const value = args[0] ?? '';
      const navigator = session().navigator();

      // A package is named rather than identified, so a value with no identity prefix is tried as one.
      const view = hasIdentityPrefix(value)
        ? navigator.dependencies(id(value))
        : navigator.dependencies({ package: value });

      if (view === null) {
        throw unknownIdentifier(value);
      }

      return renderDependencies(view);
    },
  },
  {
    name: 'cycles',
    usage: 'traceiq cycles',
    summary: 'Import, call, reference and inheritance cycles.',
    arguments: [],
    async run({ session }) {
      return renderCycles(session().explorer().cycles());
    },
  },
  {
    name: 'hotspots',
    usage: 'traceiq hotspots',
    summary: 'The most connected declarations and files.',
    arguments: [],
    async run({ session }) {
      return renderHotspots(session().explorer().hotspots());
    },
  },
];

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((command) => command.name);

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** Checks every declared argument is present, before the command runs. */
export function requireArguments(command: Command, args: readonly string[]): void {
  for (const [index, name] of command.arguments.entries()) {
    if (args[index] === undefined || args[index] === '') {
      throw missingArgument(command.name, name, command.usage);
    }
  }
}

/** A file is named by path on the command line and by identity in the graph. */
function fileId(path: string): NodeId {
  return id(path.startsWith('file:') ? path : `file:${path}`);
}

function hasIdentityPrefix(value: string): boolean {
  return /^(sym|file|route|env|ext):/.test(value);
}
