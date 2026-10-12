#!/usr/bin/env node
/**
 * `chatly` — the command line.
 *
 * Dogfoods `@chatlychat/sdk-node`: every call goes through the published SDK,
 * so the CLI and a customer's own integration exercise the same transport,
 * the same retry policy and the same error model. When the SDK's errors are
 * unhelpful, we feel it first.
 *
 * This file is only the process boundary — argv in, exit code out. The
 * behaviour is in `run.ts`, which takes argv as a parameter and is therefore
 * testable without spawning anything.
 */
import { explain, run } from './run.js';

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const { code, message } = explain(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = code;
  });
