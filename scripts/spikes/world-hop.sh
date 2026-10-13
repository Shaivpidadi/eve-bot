#!/bin/bash
# hop.sh <dev|start> <label> : start one server, send one message to desk, report session id, turns, time to turn.started, stop it.
set -u
# The D4 spike (docs/research/shared-world.md), kept so it can be run again.
# Needs: an env file at $SPIKE_ENV exporting BOT_WORKFLOW_WORLD, WORKFLOW_POSTGRES_URL,
# EVE_MOCK_AUTHORED_MODELS=1, BOT_STORE=fs, BOT_DATA_DIR, BOT_TICK_ON_START=off;
# a token in $SPIKE_TOKEN; and, for `start`, a build made with the same env.
cd "$(dirname "$0")/../.."
S=${SPIKE_DIR:-/tmp/eve-bot-spike}
mkdir -p "$S"
. "${SPIKE_ENV:?set SPIKE_ENV to the spike's env file}"
T=${SPIKE_TOKEN:?set SPIKE_TOKEN}
mode=$1; label=$2
if [ "$mode" = dev ]; then (BOT_CONSOLE_TOKEN="$T" nohup npm run dev > "$S/$label.log" 2>&1 &); else (BOT_CONSOLE_TOKEN="$T" BOT_PREWARM_ON_START=0 nohup npm start > "$S/$label.log" 2>&1 &); fi
for i in $(seq 1 90); do curl -s -o /dev/null -w "%{http_code}" localhost:3000/bot/v1/state -H "Authorization: Bearer $T" 2>/dev/null | grep -q 200 && break; sleep 2; done
t0=$(python3 -c 'import time;print(time.time())')
resp=$(curl -s -X POST localhost:3000/bot/v1/rooms/desk/messages -H "Authorization: Bearer $T" -H 'content-type: application/json' -d "{\"message\":\"Hop $label\"}" --max-time 60 -w " %{http_code}")
for i in $(seq 1 40); do
  n=$(curl -s --max-time 5 "localhost:3000/bot/v1/rooms/desk/stream?startIndex=0" -H "Authorization: Bearer $T" | grep -c "Hop $label")
  [ "$n" -ge 2 ] && break; sleep 1
done
t1=$(python3 -c 'import time;print(time.time())')
turns=$(curl -s --max-time 5 "localhost:3000/bot/v1/rooms/desk/stream?startIndex=0" -H "Authorization: Bearer $T" | grep -c '"type":"turn.completed"')
starts=$(curl -s --max-time 5 "localhost:3000/bot/v1/rooms/desk/stream?startIndex=0" -H "Authorization: Bearer $T" | grep -c '"type":"session.started"')
echo "$label ($mode): $resp | answered=$([ "$n" -ge 2 ] && echo yes || echo no) in $(python3 -c "print(round($t1-$t0,1))")s | turns on stream=$turns | session.started events=$starts"
pkill -f "next dev"; pkill -f "eve dev"; pkill -f "scripts/start.mjs"; pkill -f ".output/server/index.mjs"; pkill -f "next start"; sleep 4
