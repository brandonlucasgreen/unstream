#!/bin/bash
# Claude Code context backup/restore for Unstream
# Backs up memory, agents, and skills so they can be transferred to another machine.
#
# Usage:
#   ./scripts/claude-context-backup.sh backup          # creates backup archive
#   ./scripts/claude-context-backup.sh restore FILE     # restores from archive
#   ./scripts/claude-context-backup.sh restore FILE /path/to/unstream  # restore with different project path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Encode a path the way Claude Code does: replace / with -
encode_path() {
    echo "$1" | sed 's/\//-/g'
}

ENCODED_PATH=$(encode_path "$PROJECT_DIR")
MEMORY_DIR="$HOME/.claude/projects/${ENCODED_PATH}/memory"
AGENTS_DIR="$PROJECT_DIR/.claude/agents"
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"

backup() {
    local timestamp=$(date +%Y%m%d-%H%M%S)
    local backup_file="$PROJECT_DIR/build/claude-context-${timestamp}.tar.gz"

    mkdir -p "$PROJECT_DIR/build"

    echo "Backing up Claude Code context..."
    echo "  Project: $PROJECT_DIR"
    echo "  Memory:  $MEMORY_DIR"
    echo "  Agents:  $AGENTS_DIR"

    local tmp=$(mktemp -d)
    mkdir -p "$tmp/memory" "$tmp/agents"

    # Copy memory files
    if [ -d "$MEMORY_DIR" ]; then
        cp -R "$MEMORY_DIR"/* "$tmp/memory/" 2>/dev/null || true
        local mem_count=$(ls -1 "$tmp/memory/" 2>/dev/null | wc -l | tr -d ' ')
        echo "  Found $mem_count memory files"
    else
        echo "  No memory directory found (skipping)"
    fi

    # Copy agent definitions
    if [ -d "$AGENTS_DIR" ]; then
        cp -R "$AGENTS_DIR"/* "$tmp/agents/" 2>/dev/null || true
        local agent_count=$(ls -1 "$tmp/agents/" 2>/dev/null | wc -l | tr -d ' ')
        echo "  Found $agent_count agent files"
    else
        echo "  No agents directory found (skipping)"
    fi

    # Copy CLAUDE.md
    if [ -f "$CLAUDE_MD" ]; then
        cp "$CLAUDE_MD" "$tmp/CLAUDE.md"
        echo "  Found CLAUDE.md"
    fi

    # Copy skills if they exist
    if [ -d "$HOME/.claude/skills" ]; then
        mkdir -p "$tmp/skills"
        cp -R "$HOME/.claude/skills"/* "$tmp/skills/" 2>/dev/null || true
        local skill_count=$(ls -1 "$tmp/skills/" 2>/dev/null | wc -l | tr -d ' ')
        echo "  Found $skill_count skill files"
    fi

    # Store the original project path for restore
    echo "$PROJECT_DIR" > "$tmp/.original_project_path"

    tar czf "$backup_file" -C "$tmp" .
    rm -rf "$tmp"

    echo ""
    echo "Backup saved to: $backup_file"
    echo "Transfer this file to your new machine and run:"
    echo "  ./scripts/claude-context-backup.sh restore $backup_file"
}

restore() {
    local backup_file="$1"
    local target_project="${2:-$PROJECT_DIR}"

    if [ ! -f "$backup_file" ]; then
        echo "Error: Backup file not found: $backup_file"
        exit 1
    fi

    local target_encoded=$(encode_path "$target_project")
    local target_memory="$HOME/.claude/projects/${target_encoded}/memory"

    echo "Restoring Claude Code context..."
    echo "  From:    $backup_file"
    echo "  Project: $target_project"
    echo "  Memory:  $target_memory"

    local tmp=$(mktemp -d)
    tar xzf "$backup_file" -C "$tmp"

    # Show original path if different
    if [ -f "$tmp/.original_project_path" ]; then
        local orig=$(cat "$tmp/.original_project_path")
        if [ "$orig" != "$target_project" ]; then
            echo "  Note: Original project was at $orig"
        fi
    fi

    # Restore memory
    if [ -d "$tmp/memory" ] && [ "$(ls -A "$tmp/memory" 2>/dev/null)" ]; then
        mkdir -p "$target_memory"
        cp -R "$tmp/memory"/* "$target_memory/"
        echo "  Restored memory files"
    fi

    # Restore agents
    if [ -d "$tmp/agents" ] && [ "$(ls -A "$tmp/agents" 2>/dev/null)" ]; then
        mkdir -p "$target_project/.claude/agents"
        cp -R "$tmp/agents"/* "$target_project/.claude/agents/"
        echo "  Restored agent files"
    fi

    # Restore CLAUDE.md (only if not already present)
    if [ -f "$tmp/CLAUDE.md" ] && [ ! -f "$target_project/CLAUDE.md" ]; then
        cp "$tmp/CLAUDE.md" "$target_project/CLAUDE.md"
        echo "  Restored CLAUDE.md"
    elif [ -f "$tmp/CLAUDE.md" ]; then
        echo "  CLAUDE.md already exists (skipped — check for differences manually)"
    fi

    # Restore skills
    if [ -d "$tmp/skills" ] && [ "$(ls -A "$tmp/skills" 2>/dev/null)" ]; then
        mkdir -p "$HOME/.claude/skills"
        cp -R "$tmp/skills"/* "$HOME/.claude/skills/"
        echo "  Restored skill files"
    fi

    rm -rf "$tmp"

    echo ""
    echo "Restore complete. Start a new Claude Code session to pick up the context."
}

case "${1:-}" in
    backup)
        backup
        ;;
    restore)
        if [ -z "${2:-}" ]; then
            echo "Usage: $0 restore BACKUP_FILE [/path/to/project]"
            exit 1
        fi
        restore "$2" "${3:-$PROJECT_DIR}"
        ;;
    *)
        echo "Claude Code Context Backup/Restore"
        echo ""
        echo "Usage:"
        echo "  $0 backup                           Create a backup archive"
        echo "  $0 restore FILE                      Restore from archive"
        echo "  $0 restore FILE /path/to/unstream    Restore to a different path"
        ;;
esac
