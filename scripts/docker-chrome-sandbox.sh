#!/bin/sh
# A `docker` for eve that starts the team's computer with Chrome's sandbox intact.
#
# eve creates the computer's container with plain `docker run`, and an
# ordinary container forbids the user namespaces Chrome sandboxes its
# renderers in, so Chrome runs there without its sandbox. Pointing
# EVE_DOCKER_PATH at this script adds `--security-opt seccomp=...` with
# docker/seccomp-chrome.json, Docker's default profile plus those namespace
# calls, to every `docker run`; the computer's startup script then sees that
# user namespaces work and leaves Chrome's sandbox on. Every other docker
# command passes straight through. docker-compose.yml uses it by default.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
profile="$here/../docker/seccomp-chrome.json"

# The real docker: the first `docker` on PATH that is not this script.
real="${BOT_REAL_DOCKER:-}"
if [ -z "$real" ]; then
  IFS=:
  for dir in $PATH; do
    candidate="$dir/docker"
    [ -x "$candidate" ] || continue
    [ "$candidate" -ef "$0" ] && continue
    real="$candidate"
    break
  done
  unset IFS
fi
if [ -z "$real" ]; then
  echo "docker-chrome-sandbox: no docker CLI on PATH; set BOT_REAL_DOCKER to its path." >&2
  exit 127
fi

if [ "${1:-}" = "run" ] && [ -f "$profile" ]; then
  shift
  exec "$real" run --security-opt "seccomp=$profile" "$@"
fi
exec "$real" "$@"
