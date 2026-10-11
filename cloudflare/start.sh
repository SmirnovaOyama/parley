#!/bin/sh
# Starts Parley on Cloudflare Containers, whose disk is new every time (Dockerfile): the files
# bucket is mounted where Parley keeps files, the database comes back from R2, and Litestream runs
# Parley, copying each change to R2. Told to stop, Parley stops, Litestream makes its last copy, and
# the files bucket is unmounted, which sends any file still on its way.
set -eu

for name in R2_ACCOUNT_ID DB_BUCKET FILES_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY KEY_ENCRYPTION_SECRET; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "$name isn't set. See cloudflare/README.md" >&2
    exit 1
  fi
done

FILES=/data/files
mkdir -p "$FILES"
tigrisfs --endpoint "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" --region auto -f "$FILES_BUCKET" "$FILES" &
fuse=$!
tries=0
until mountpoint -q "$FILES"; do
  if ! kill -0 "$fuse" 2>/dev/null; then
    echo "The files bucket ($FILES_BUCKET) couldn't be mounted" >&2
    exit 1
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "The files bucket ($FILES_BUCKET) took too long to mount" >&2
    exit 1
  fi
  sleep 1
done

# A new site has nothing in R2 yet, and starts with an empty database; a database already here stays.
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /data/chat.db

litestream replicate -config /etc/litestream.yml -exec "node server/index.ts" &
app=$!
# As process 1, this script gets the stop signal; Litestream passes it to Parley.
trap 'kill -TERM "$app" 2>/dev/null || true' TERM INT
status=0
wait "$app" || status=$?
# The signal ends the first wait at once; this one waits for Litestream's last copy.
if kill -0 "$app" 2>/dev/null; then
  status=0
  wait "$app" || status=$?
fi

fusermount3 -u "$FILES" || umount "$FILES" || true
wait "$fuse" || true
exit "$status"
