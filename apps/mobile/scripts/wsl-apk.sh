#!/bin/bash
# Builds an Android preview APK with `eas build --local`, inside WSL. Run by phone-build.ps1,
# which explains the setup; this is only the WSL half.
#
# Usage: wsl-apk.sh <branch> <commit> <npm stall seconds> <build stall seconds> <attempts>
#
# The build runs from a clone of the Windows repository (~/fortytwo, its origin the Windows
# checkout) rather than from /mnt/c: npm and Gradle are many times slower on the Windows mount.
# A lost connection leaves npm or EAS waiting for good - under WSL's default NAT networking about
# 1 in 4 were lost, hence mirrored networking in the README's setup - so npm and the build each
# run under a watchdog that kills the step once its log stops growing, then tries it again.
set -uo pipefail

BRANCH=$1
COMMIT=$2
NPM_STALL=${3:-180}
BUILD_STALL=${4:-420}
ATTEMPTS=${5:-3}
# Before EAS prints its first build phase (see `watched`).
START_STALL=120

CLONE=$HOME/fortytwo
APK=$HOME/fortytwo-preview.apk
LOGS=$HOME/.fortytwo-build
mkdir -p "$LOGS"

# Only the distro's own tools: with /mnt/c on PATH, Windows' npm and node win over nvm's.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# nvm's Node, ~/jdk17 and ~/Android/Sdk (README: "Phone builds from WSL").
# shellcheck disable=SC1090
source "$HOME/.buildenv" || { echo "No ~/.buildenv: the WSL build setup isn't done"; exit 1; }

step() { echo "> $*"; }
elapsed() { local s=$(($(date +%s) - $1)); printf '%dm%02ds' $((s / 60)) $((s % 60)); }

# Runs a command in its own process group, its output in $log, and kills the whole group if
# the log doesn't grow for $stall seconds - or $start_stall seconds until a line matches
# $started: EAS goes quiet for good at startup when a request to Expo is lost, and only for a
# moment otherwise. Returns the command's exit code, or 124 on a stall.
watched() {
  local log=$1 stall=$2 start_stall=$3 started=$4
  shift 4
  : > "$log"
  setsid "$@" > "$log" 2>&1 &
  local pid=$! size=-1 still=0
  # Not `kill -0`: a command that has finished is a zombie until `wait`, and still passes it.
  while ! grep -qs '^State:.*Z' "/proc/$pid/status" && [ -e "/proc/$pid" ]; do
    sleep 15
    local now
    now=$(stat -c %s "$log")
    if [ "$now" = "$size" ]; then still=$((still + 15)); else still=0; size=$now; fi
    local limit=$stall
    if [ -n "$started" ] && ! grep -qE "$started" "$log"; then limit=$start_stall; fi
    if [ "$still" -ge "$limit" ]; then
      echo "  ...no output for ${limit}s, stopping it"
      kill -- -"$pid" 2> /dev/null
      sleep 2
      kill -9 -- -"$pid" 2> /dev/null
      wait "$pid" 2> /dev/null
      return 124
    fi
  done
  wait "$pid"
}

# Tries `watched` up to $ATTEMPTS times; a failure that isn't a stall isn't retried. Each
# stalled attempt's log is kept beside $log, numbered.
with_retries() {
  local name=$1 log=$2
  shift 2
  local attempt code
  rm -f "$log".stalled-*
  for attempt in $(seq 1 "$ATTEMPTS"); do
    watched "$log" "$@"
    code=$?
    [ "$code" -eq 0 ] && return 0
    [ "$code" -eq 124 ] && cp "$log" "$log.stalled-$attempt"
    if [ "$code" -ne 124 ]; then
      echo "  $name failed (exit $code). The end of $log:"
      tail -40 "$log"
      return "$code"
    fi
    [ "$attempt" -lt "$ATTEMPTS" ] && echo "  trying $name again ($((attempt + 1)) of $ATTEMPTS)"
  done
  echo "  $name stalled $ATTEMPTS times. The end of $log:"
  tail -20 "$log"
  return 124
}

START=$(date +%s)

T=$(date +%s)
step "Checking out $BRANCH in $CLONE"
cd "$CLONE" || exit 1
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "$CLONE has uncommitted changes; leaving it alone"
  exit 1
fi
git fetch -q origin "$BRANCH" || exit 1
git checkout -q -B "$BRANCH" FETCH_HEAD || exit 1
HEAD=$(git rev-parse HEAD)
if [ "$HEAD" != "$COMMIT" ]; then
  echo "origin's $BRANCH is at ${HEAD:0:7}, not ${COMMIT:0:7}; is the Windows checkout's branch up to date?"
  exit 1
fi
echo "  $(git log --oneline -1) ($(elapsed "$T"))"

# The build installs its own copy of the dependencies; this one is for EAS reading the app
# config. Skipped while the lockfile hasn't changed since the last install that finished.
T=$(date +%s)
LOCK_HASH=$(sha1sum package-lock.json | cut -d' ' -f1)
if [ -d node_modules ] && [ "$(cat "$LOGS/lock-hash" 2> /dev/null)" = "$LOCK_HASH" ]; then
  step "Dependencies unchanged since the last build"
else
  step "Installing dependencies"
  rm -f "$LOGS/lock-hash"
  with_retries "npm ci" "$LOGS/npm-ci.log" "$NPM_STALL" "$NPM_STALL" "" \
    npm ci --prefer-offline --fetch-timeout=60000 --fetch-retries=2 --no-audit --no-fund || exit 1
  echo "$LOCK_HASH" > "$LOGS/lock-hash"
  echo "  done ($(elapsed "$T"))"
fi

# A stopped build leaves its working copy behind in /tmp; only this script's builds use it.
rm -rf "/tmp/$USER/eas-build-local-nodejs"

T=$(date +%s)
step "Building the APK (about 10 minutes with Gradle's cache warm, 45 the first time)"
rm -f "$APK"
cd "$CLONE/apps/mobile" || exit 1
with_retries "the build" "$LOGS/eas-build.log" "$BUILD_STALL" "$START_STALL" '^\[[A-Z_]+\]' \
  eas build --platform android --profile preview --local --non-interactive --output "$APK" || exit 1
[ -f "$APK" ] || { echo "The build finished without $APK"; exit 1; }
grep -o "Incremented versionCode from [0-9]* to [0-9]*" "$LOGS/eas-build.log" | tail -1 | sed 's/^/  /'
echo "  done ($(elapsed "$T"))"

echo "> Built in $(elapsed "$START")"
echo "APK=$APK"
