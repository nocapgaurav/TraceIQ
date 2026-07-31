#!/usr/bin/env node
import { createInterface } from 'node:readline';

import { resolveModel } from '../dist/providers.js';
import { run } from '../dist/index.js';

/**
 * The CLI's entry point, and its composition root.
 *
 * Everything a terminal provides and a test cannot — stdin, TTY detection, signal handling — is gathered
 * here and injected. `run` itself stays a function of `(argv, io, chat)`, which is what lets the whole CLI,
 * including the chat REPL, be driven by calling it.
 */
const io = {
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
  cwd: process.cwd(),
};

/**
 * Lines the user types.
 *
 * `readline` in async-iterator form. The prompt is written by hand rather than with readline's own, so it
 * is not reprinted underneath streaming output.
 */
async function* lines() {
  const reader = createInterface({ input: process.stdin, terminal: process.stdin.isTTY === true });

  process.stdout.write('> ');

  for await (const line of reader) {
    yield line;
    process.stdout.write('> ');
  }

  process.stdout.write('\n');
}

/**
 * Ctrl+C.
 *
 * **The first press cancels the answer, not the process.** A local model can take ten seconds, and losing a
 * whole session because one answer was going nowhere would make the REPL unusable. A press with nothing
 * generating, or a second within two seconds, exits — which is what pressing it twice means.
 *
 * One process listener registered once, dispatching to whichever answer is currently subscribed. A listener
 * per answer would accumulate and Node would warn about a leak.
 */
let cancelCurrent = null;
let lastInterruptAt = 0;

process.on('SIGINT', () => {
  const now = Date.now();

  if (cancelCurrent === null || now - lastInterruptAt < 2000) {
    process.stdout.write('\n');
    process.exit(130);
  }

  lastInterruptAt = now;
  cancelCurrent();
});

function onInterrupt(handler) {
  cancelCurrent = handler;

  return () => {
    cancelCurrent = null;
  };
}

// Colour only for a terminal, and never when NO_COLOR is set: redirected output stays plain and diffable.
const colour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const status = await run(process.argv.slice(2), io, { resolveModel, lines, onInterrupt, colour });

process.exit(status);
