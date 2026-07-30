export { COMMANDS, COMMAND_NAMES, findCommand, requireArguments, type Command } from './commands.js';
export { DEFAULT_DATABASE, parseCommandLine, renderHelp, run } from './cli.js';
export { CliError, ERROR_CODES, EXIT_STATUS, type ErrorCode } from './errors.js';
export { counted, fields, heading, indent, list, sections, short, table } from './format.js';
export { CommandSession } from './session.js';
export type { Io, Options, ScanRunner } from './types.js';

// The CLI contains zero analysis logic. It parses a command line, opens a graph through
// @traceiq/pipeline, calls one capability and renders the result. It never imports the scanner, the
// project host, the IR, the resolver, the framework extractor, the graph builder, the store, SQLite
// or ts-morph — and it holds no global state: one session per invocation, discarded with it.
