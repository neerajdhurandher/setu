#!/usr/bin/env bash
# Runs on the Oracle VM (systemd timer: setu-update.timer).
# Deploys the newest commit on main once GitHub Actions has published its
# image, keeping compose/Caddy configuration and image on the same commit.
# Rolls back to the previous release if the new one does not become healthy.
#
# Usage: setu-update            deploy main's latest commit if it is new
#        setu-update <commit>   deploy a specific commit (manual rollback)
set -euo pipefail

SETU_HOME="${SETU_HOME:-$HOME/setu}"
REPO_URL="${SETU_REPO_URL:-https://github.com/neerajdhurandher/setu.git}"
IMAGE_REPO="${SETU_IMAGE_REPO:-ghcr.io/neerajdhurandher/setu}"
BRANCH="${SETU_BRANCH:-main}"
APP="$SETU_HOME/app"
STATE="$SETU_HOME/release.env"
PREVIOUS="$SETU_HOME/release.previous.env"
FAILED="$SETU_HOME/failed.commit"

mkdir -p "$SETU_HOME"
exec 9>"$SETU_HOME/.update.lock"
flock -n 9 || {
  echo "Another update is already running."
  exit 0
}

if [[ ! -f "$SETU_HOME/.env.public" ]]; then
  echo "Missing $SETU_HOME/.env.public. Create it from .env.public.example." >&2
  exit 1
fi
touch "$STATE"
[[ -d "$APP/.git" ]] || git clone --quiet --no-checkout "$REPO_URL" "$APP"
git -C "$APP" fetch --quiet origin "$BRANCH"

state_value() { sed -n "s/^$1=//p" "$2" 2>/dev/null || true; }

manual=0
if [[ $# -gt 0 ]]; then
  manual=1
  target="$(git -C "$APP" rev-parse --verify "$1^{commit}")"
else
  target="$(git -C "$APP" rev-parse "origin/$BRANCH")"
fi
current="$(state_value SETU_COMMIT "$STATE")"

if [[ "$target" == "$current" ]]; then
  ((manual)) && echo "${target:0:7} is already deployed."
  exit 0
fi
# Don't retry a release that already failed health checks; the next commit
# on main (or a manual deploy) clears this.
if ((!manual)) && [[ -f "$FAILED" && "$(<"$FAILED")" == "$target" ]]; then
  exit 0
fi

image="$IMAGE_REPO:sha-$target"
if ! docker manifest inspect "$image" >/dev/null 2>&1; then
  echo "Image for ${target:0:7} is not published yet; will retry."
  ((manual)) && exit 1
  exit 0
fi

compose() {
  docker compose -p setu --project-directory "$APP" \
    --env-file "$SETU_HOME/.env.public" --env-file "$STATE" \
    -f "$APP/compose.public.yaml" "$@"
}

wait_healthy() {
  local id status
  for _ in $(seq 1 30); do
    id="$(compose ps -q setu)"
    status="$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    sleep 5
  done
  return 1
}

echo "Deploying ${target:0:7} ($image)."
git -C "$APP" checkout --quiet --force --detach "$target"
SETU_IMAGE="$image" compose pull --quiet setu

[[ -s "$STATE" ]] && cp "$STATE" "$PREVIOUS"
printf 'SETU_COMMIT=%s\nSETU_IMAGE=%s\n' "$target" "$image" >"$STATE"

if compose up -d --remove-orphans && wait_healthy; then
  rm -f "$FAILED"
  previous_image="$(state_value SETU_IMAGE "$PREVIOUS")"
  # Keep only the current and previous Setu images on the small disk.
  docker image ls "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' |
    grep -vxF -e "$image" -e "${previous_image:-none}" |
    xargs -r docker image rm >/dev/null 2>&1 || true
  docker image prune -f >/dev/null
  echo "Deployed ${target:0:7}."
  exit 0
fi

echo "Setu did not become healthy with ${target:0:7}." >&2
compose logs --tail=50 setu >&2 || true
printf '%s\n' "$target" >"$FAILED"
if [[ -s "$PREVIOUS" ]]; then
  cp "$PREVIOUS" "$STATE"
  git -C "$APP" checkout --quiet --force --detach "$(state_value SETU_COMMIT "$STATE")"
  compose up -d --remove-orphans
  echo "Rolled back to $(state_value SETU_COMMIT "$STATE" | cut -c1-7)." >&2
fi
exit 1
