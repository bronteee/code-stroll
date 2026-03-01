#!/usr/bin/env bash
set -euo pipefail

# code-stroll installer
# Copies command and agent files into your project's .opencode/ directory
# and builds the plugin.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect target project directory
TARGET="${1:-.}"
TARGET="$(cd "$TARGET" && pwd)"

OPENCODE_DIR="$TARGET/.opencode"

echo "Installing code-stroll into $TARGET"

# Create .opencode directories if they don't exist
mkdir -p "$OPENCODE_DIR/commands"
mkdir -p "$OPENCODE_DIR/agents"

# Copy command and agent files
cp "$SCRIPT_DIR/config/commands/code-stroll.md" "$OPENCODE_DIR/commands/code-stroll.md"
cp "$SCRIPT_DIR/config/agents/review-agent.md" "$OPENCODE_DIR/agents/review-agent.md"

echo "  Copied command:  .opencode/commands/code-stroll.md"
echo "  Copied agent:    .opencode/agents/review-agent.md"

# Build the plugin
echo "  Building plugin..."
cd "$SCRIPT_DIR"
bun install --silent 2>/dev/null || true
bun build src/index.ts --outdir dist --target bun

echo ""
echo "Done! Usage:"
echo "  /code-stroll                    # review current branch vs main"
echo "  /code-stroll --depth skim       # flag concerns only"
echo "  /code-stroll --focus auth,api   # review specific directories"
echo "  /code-stroll --base develop     # diff against develop"
echo "  /code-stroll --resume           # continue previous session"
