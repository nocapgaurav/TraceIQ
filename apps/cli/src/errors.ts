/**
 * Every way a command can fail, as a closed vocabulary.
 *
 * A code rather than a message, so a caller — a shell script, a test, a future HTTP surface — can
 * branch on the failure without matching prose. Each has one exit status and one fixed wording.
 */
export const ERROR_CODES = [
  'unknown-command',
  'missing-argument',
  'unknown-option',
  'repository-not-scanned',
  'invalid-repository',
  'unknown-identifier',
  'unknown-route',
  'unknown-package',

  // Chat. The AI layer's own codes are surfaced verbatim where they reach the user, so a code seen in the
  // CLI is the same code seen over HTTP; these are the two the CLI itself raises before it ever gets there.
  'unknown-provider',
  'provider-unavailable',
  'model-not-found',
  'chat-failed',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Exit status per code.
 *
 * `2` is a usage error — the command line itself was wrong. `3` means the repository is not in a
 * state the command can work from. `4` means the command was well-formed and the thing it named does
 * not exist. Distinct statuses let a script tell "I typed it wrong" from "it is not there".
 */
export const EXIT_STATUS: Readonly<Record<ErrorCode, number>> = {
  // `2` for a wrong provider name — a usage error. `3` for a provider that is not running: the command was
  // fine and the environment is not ready, which is the same shape as "not scanned". `4` for a model that
  // does not exist, matching every other "the thing you named is not there". `5` for a generation that
  // started and failed, which is neither the user's mistake nor a missing prerequisite.
  'unknown-provider': 2,
  'provider-unavailable': 3,
  'model-not-found': 4,
  'chat-failed': 5,
  'unknown-command': 2,
  'missing-argument': 2,
  'unknown-option': 2,
  'repository-not-scanned': 3,
  'invalid-repository': 3,
  'unknown-identifier': 4,
  'unknown-route': 4,
  'unknown-package': 4,
};

/**
 * A failure a user can act on.
 *
 * `detail` names the specific thing that was wrong — an identifier, a path — and is the only part
 * that varies. `hint` is fixed per code and says what to do next.
 */
export class CliError extends Error {
  readonly code: ErrorCode;
  readonly detail: string;
  readonly hint: string;

  constructor(code: ErrorCode, detail: string, hint: string) {
    super(`${code}: ${detail}`);
    this.name = 'CliError';
    this.code = code;
    this.detail = detail;
    this.hint = hint;
  }

  get status(): number {
    return EXIT_STATUS[this.code];
  }

  /** Rendered to stderr. Deterministic: no path, clock or environment beyond `detail`. */
  render(): string {
    return `error: ${this.code}\n  ${this.detail}\n  ${this.hint}`;
  }
}

export function unknownCommand(name: string, commands: readonly string[]): CliError {
  return new CliError('unknown-command', `no command named '${name}'`, `run 'traceiq help' — available: ${commands.join(', ')}`);
}

export function missingArgument(command: string, argument: string, usage: string): CliError {
  return new CliError('missing-argument', `'${command}' needs <${argument}>`, `usage: ${usage}`);
}

export function unknownOption(option: string): CliError {
  return new CliError('unknown-option', `no option named '${option}'`, "known options: --db <path>, --profile");
}

export function repositoryNotScanned(databasePath: string): CliError {
  return new CliError(
    'repository-not-scanned',
    `no graph at '${databasePath}'`,
    "run 'traceiq scan <repository>' first, or pass --db <path>",
  );
}

export function invalidRepository(repositoryPath: string, reason: string): CliError {
  return new CliError('invalid-repository', `cannot scan '${repositoryPath}': ${reason}`, 'check the path and that it holds a TypeScript project');
}

export function unknownIdentifier(id: string): CliError {
  return new CliError('unknown-identifier', `the graph holds nothing named '${id}'`, "run 'traceiq search <text>' to find an identifier");
}

export function unknownRoute(method: string, path: string): CliError {
  return new CliError('unknown-route', `no route '${method} ${path}' is registered`, "run 'traceiq routes' to list every route");
}

export function unknownPackage(name: string): CliError {
  return new CliError('unknown-package', `no package named '${name}'`, "run 'traceiq packages' to list every package");
}
