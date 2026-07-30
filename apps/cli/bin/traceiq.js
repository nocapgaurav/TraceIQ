#!/usr/bin/env node
import { run } from '../dist/index.js';

const status = await run(process.argv.slice(2), {
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
  cwd: process.cwd(),
});

process.exitCode = status;
