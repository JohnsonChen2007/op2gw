#!/bin/bash
# op2gw log rotation: archive the active log as a dated .gz, keep the newest KEEP archives.
# launchd holds the log file descriptor open, so we use copy+truncate instead of rename.
set -u

LOG_DIR="/Users/esadmin/src/opencode2gw/op2gw/logs"
LOG="$LOG_DIR/op2gw.log"
KEEP=7

[ -s "$LOG" ] || exit 0

ARCHIVE="$LOG_DIR/op2gw-$(date +%Y-%m-%d).log.gz"
TMP="$ARCHIVE.tmp"
if gzip -c "$LOG" > "$TMP"; then
  mv "$TMP" "$ARCHIVE"
  : > "$LOG"
fi

# prune archives beyond the newest KEEP
ls -t "$LOG_DIR"/op2gw-*.log.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
  rm -f "$f"
done

exit 0
