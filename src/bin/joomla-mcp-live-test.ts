#!/usr/bin/env node

import { runLiveTestCli } from '../live-test/cli.js';

runLiveTestCli().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Joomla MCP live validation could not start: ${message}\n`);
    process.exitCode = 2;
  },
);
