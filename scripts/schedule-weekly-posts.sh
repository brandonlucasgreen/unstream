#!/bin/bash
# Generates next week's social posts and pushes them to Buffer as drafts.
# Intended to run every Monday at 9am via cron/launchd.
#
# Setup:
#   crontab -e
#   0 9 * * 1 /Users/brandonlucasgreen/Projects/unstream/scripts/schedule-weekly-posts.sh
#
# Logs to: data/social-posts/cron.log

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$PROJECT_DIR/data/social-posts/cron.log"

# nvm-managed node
export PATH="/Users/brandonlucasgreen/.nvm/versions/node/v22.21.1/bin:$PATH"

cd "$PROJECT_DIR"

# Load env vars
set -a
source .env
set +a

# Calculate next week's ISO week number
NEXT_WEEK=$(date -v+7d +"%G-W%V")

echo "=== $(date) ===" >> "$LOG_FILE"
echo "Generating posts for $NEXT_WEEK" >> "$LOG_FILE"

# Generate posts and schedule for publication
if npx tsx scripts/generate-social-posts.ts --week "$NEXT_WEEK" --schedule --publish >> "$LOG_FILE" 2>&1; then
  echo "Done." >> "$LOG_FILE"
  osascript -e "display notification \"Posts for $NEXT_WEEK scheduled to Buffer. Check the dashboard to review.\" with title \"Unstream Social\" sound name \"Glass\""
else
  echo "FAILED." >> "$LOG_FILE"
  osascript -e "display notification \"Failed to schedule posts for $NEXT_WEEK. Check data/social-posts/cron.log\" with title \"Unstream Social\" sound name \"Basso\""
fi

echo "" >> "$LOG_FILE"
