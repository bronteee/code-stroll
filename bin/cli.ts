#!/usr/bin/env node

import { existsSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// When bundled, cli.js is in dist/ — config/ is a sibling of dist/
const packageRoot = join(__dirname, "..");

const command = process.argv[2];

if (command === "init") {
  init(process.argv[3] || ".");
} else {
  console.log(`code-stroll — interactive code review learning sessions

Usage:
  npx code-stroll init [dir]   Install command and agent files into a project

The init command copies the slash command and review agent into
your project's .opencode/ directory. After that, add the plugin
to your opencode.json:

  { "plugin": ["code-stroll"] }

Then use /code-stroll in opencode to start a review.`);
  process.exit(command === undefined || command === "--help" ? 0 : 1);
}

function init(targetDir: string) {
  const target = resolve(process.cwd(), targetDir);

  if (!existsSync(target)) {
    console.error(`Error: directory ${target} does not exist.`);
    process.exit(1);
  }

  const opencodeDir = join(target, ".opencode");
  const commandsDir = join(opencodeDir, "commands");
  const agentsDir = join(opencodeDir, "agents");

  mkdirSync(commandsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const configDir = join(packageRoot, "config");

  copyFileSync(
    join(configDir, "commands", "code-stroll.md"),
    join(commandsDir, "code-stroll.md")
  );
  copyFileSync(
    join(configDir, "agents", "review-agent.md"),
    join(agentsDir, "review-agent.md")
  );

  console.log(`Installed code-stroll into ${target}:
  .opencode/commands/code-stroll.md
  .opencode/agents/review-agent.md

Next: add the plugin to your opencode.json (or create one):

  { "plugin": ["code-stroll"] }

Then use /code-stroll in opencode to start a review.`);
}
