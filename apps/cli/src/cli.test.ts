import { describe, expect, it } from 'vitest';

import { DEFAULT_DATABASE, parseCommandLine, renderHelp } from './cli.js';
import { COMMANDS, COMMAND_NAMES, findCommand, requireArguments } from './commands.js';
import { CliError, ERROR_CODES, EXIT_STATUS } from './errors.js';
import { counted, fields, heading, indent, list, sections, short, table } from './format.js';

const defaults = { databasePath: DEFAULT_DATABASE, profile: false, model: null, provider: 'ollama', subject: null };

describe('command line parsing', () => {
  it('reads a command with no arguments', () => {
    expect(parseCommandLine(['overview'], defaults)).toMatchObject({ command: 'overview', args: [] });
  });

  it('reads positional arguments in order', () => {
    expect(parseCommandLine(['route', 'GET', '/users/:id'], defaults).args).toEqual(['GET', '/users/:id']);
  });

  it('defaults to help when nothing is given', () => {
    expect(parseCommandLine([], defaults).command).toBe('help');
  });

  it('reads --db in both forms', () => {
    expect(parseCommandLine(['overview', '--db', 'a.db'], defaults).options.databasePath).toBe('a.db');
    expect(parseCommandLine(['overview', '--db=b.db'], defaults).options.databasePath).toBe('b.db');
  });

  it('reads --profile', () => {
    expect(parseCommandLine(['overview', '--profile'], defaults).options.profile).toBe(true);
  });

  it('accepts an option before the command', () => {
    const parsed = parseCommandLine(['--db=a.db', 'symbol', 'sym:a#b'], defaults);

    expect(parsed).toMatchObject({ command: 'symbol', args: ['sym:a#b'] });
    expect(parsed.options.databasePath).toBe('a.db');
  });

  it('accepts an option between arguments', () => {
    const parsed = parseCommandLine(['route', 'GET', '--profile', '/x'], defaults);

    expect(parsed.args).toEqual(['GET', '/x']);
    expect(parsed.options.profile).toBe(true);
  });

  it('defaults the database path', () => {
    expect(parseCommandLine(['overview'], defaults).options.databasePath).toBe('.traceiq/graph.db');
  });

  it('rejects an unknown option', () => {
    expect(() => parseCommandLine(['overview', '--nope'], defaults)).toThrowError(CliError);
  });

  it('does not mistake a path argument for an option', () => {
    expect(parseCommandLine(['file', 'src/a.ts'], defaults).args).toEqual(['src/a.ts']);
  });
});

describe('the command table', () => {
  it('holds every command the milestone specifies', () => {
    expect(COMMAND_NAMES).toEqual([
      'scan',
      'overview',
      'architecture',
      'packages',
      'package',
      'file',
      'symbol',
      'impact',
      'routes',
      'route',
      'health',
      'search',
      'dependencies',
      'cycles',
      'hotspots',
    ]);
  });

  it('finds a command by name', () => {
    expect(findCommand('overview')?.name).toBe('overview');
    expect(findCommand('nope')).toBeUndefined();
  });

  it('gives every command a usage line naming its arguments', () => {
    for (const command of COMMANDS) {
      expect(command.usage.startsWith(`traceiq ${command.name}`)).toBe(true);

      for (const argument of command.arguments) {
        expect(command.usage).toContain(`<${argument}>`);
      }
    }
  });

  it('gives every command a summary', () => {
    for (const command of COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(10);
      expect(command.summary.endsWith('.')).toBe(true);
    }
  });

  it('accepts a command whose arguments are all present', () => {
    expect(() => requireArguments(findCommand('route')!, ['GET', '/x'])).not.toThrow();
  });

  it('rejects a missing argument before the command runs', () => {
    expect(() => requireArguments(findCommand('route')!, ['GET'])).toThrowError(CliError);
    expect(() => requireArguments(findCommand('symbol')!, [])).toThrowError(CliError);
  });

  it('treats an empty argument as missing', () => {
    expect(() => requireArguments(findCommand('symbol')!, [''])).toThrowError(CliError);
  });
});

describe('errors', () => {
  it('gives every code an exit status', () => {
    for (const code of ERROR_CODES) {
      expect(EXIT_STATUS[code]).toBeGreaterThan(0);
    }
  });

  it('separates a usage error from a missing graph from a missing thing', () => {
    expect(EXIT_STATUS['unknown-command']).toBe(2);
    expect(EXIT_STATUS['missing-argument']).toBe(2);
    expect(EXIT_STATUS['repository-not-scanned']).toBe(3);
    expect(EXIT_STATUS['invalid-repository']).toBe(3);
    expect(EXIT_STATUS['unknown-identifier']).toBe(4);
  });

  it('renders a code, a detail and a hint', () => {
    const error = new CliError('unknown-identifier', "nothing named 'x'", 'try search');

    expect(error.render()).toBe("error: unknown-identifier\n  nothing named 'x'\n  try search");
    expect(error.status).toBe(4);
  });
});

describe('formatting', () => {
  it('indents every non-empty line by two spaces per level', () => {
    expect(indent('a\n\nb')).toBe('  a\n\n  b');
    expect(indent('a', 2)).toBe('    a');
  });

  it('underlines a heading to its own width', () => {
    expect(heading('abc')).toBe('abc\n---');
  });

  it('pads field keys so values line up', () => {
    expect(fields([['a', 1], ['long', 2]])).toBe('a     1\nlong  2');
  });

  it('renders a table with a header and a rule', () => {
    expect(table([{ header: 'k' }, { header: 'v' }], [['a', 'b']])).toBe('k  v\n-  -\na  b');
  });

  it('right-aligns a column asked for it', () => {
    expect(table([{ header: 'n', align: 'right' }], [['1'], ['100']])).toBe('  n\n---\n  1\n100');
  });

  it('renders an empty table as one line rather than a bare header', () => {
    expect(table([{ header: 'k' }], [])).toBe('(none)');
  });

  it('renders an empty list as one line', () => {
    expect(list([])).toBe('(none)');
    expect(list(['a', 'b'])).toBe('- a\n- b');
  });

  it('joins sections with a blank line and drops empty ones', () => {
    expect(sections('a', null, '', 'b')).toBe('a\n\nb');
  });

  it('says how many of a total are shown only when a list was capped', () => {
    expect(counted(5, 5, false)).toBe('5');
    expect(counted(5, 9, true)).toBe('5 of 9');
  });

  it('trims an identity prefix for display', () => {
    expect(short('sym:src/a.ts#B')).toBe('src/a.ts#B');
    expect(short('file:src/a.ts')).toBe('src/a.ts');
    expect(short('plain')).toBe('plain');
  });

  it('uses no colour, no box drawing and no unicode', () => {
    const rendered = sections(
      heading('Title'),
      table([{ header: 'k' }, { header: 'v', align: 'right' }], [['a', 1]]),
      list(['x']),
      fields([['k', 'v']]),
    );

    expect(rendered).not.toMatch(/\[/);
    expect(rendered).toMatch(/^[\x20-\x7E\n]*$/);
  });
});

describe('help', () => {
  it('lists every command with its usage', () => {
    const help = renderHelp();

    for (const command of COMMANDS) {
      expect(help).toContain(command.usage);
    }
  });

  it('documents both options', () => {
    expect(renderHelp()).toContain('--db <path>');
    expect(renderHelp()).toContain('--profile');
  });

  it('renders identically every time', () => {
    expect(renderHelp()).toBe(renderHelp());
  });
});
