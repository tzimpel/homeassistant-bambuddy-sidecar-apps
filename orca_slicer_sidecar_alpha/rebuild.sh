#!/usr/bin/env bash
# Clean rebuild of the slicer-API sidecars.
#
# Why this exists: `docker compose down` only removes containers whose
# compose-project label matches the current project. Containers created
# by an older compose project name (or `docker run`) survive and cause
# "container name already in use" on the next `up`. This script tears
# down BOTH profiles and then force-removes the known container names
# before rebuilding, so re-runs are always clean.
#
# Usage:
#   ./rebuild.sh              # rebuild both services (orca + bambu)
#   ./rebuild.sh orca         # rebuild only orca-slicer-api
#   ./rebuild.sh bambu        # rebuild only bambu-studio-api
#   ./rebuild.sh --no-pull    # skip `git pull`
#
# Env vars (forwarded to compose):
#   ORCA_VERSION, BAMBU_VERSION, ORCA_API_PORT, BAMBU_API_PORT

set -euo pipefail

cd "$(dirname "$0")"

TARGET="both"
DO_PULL=1

for arg in "$@"; do
    case "$arg" in
        orca)      TARGET="orca" ;;
        bambu)     TARGET="bambu" ;;
        both)      TARGET="both" ;;
        --no-pull) DO_PULL=0 ;;
        -h|--help)
            sed -n '2,18p' "$0"
            exit 0
            ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

if [ "$DO_PULL" = 1 ]; then
    echo "==> git pull"
    git pull --ff-only
fi

echo "==> compose down (both profiles)"
docker compose --profile bambu down --remove-orphans || true
docker compose down --remove-orphans || true

# Force-remove stragglers from older compose project names.
for name in orca-slicer-api bambu-studio-api; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
        echo "==> removing stale container: $name"
        docker rm -f "$name"
    fi
done

case "$TARGET" in
    orca)
        echo "==> build + up: orca-slicer-api"
        docker compose up --build -d orca-slicer-api
        ;;
    bambu)
        echo "==> build + up: bambu-studio-api"
        docker compose --profile bambu up --build -d bambu-studio-api
        ;;
    both)
        echo "==> build + up: orca-slicer-api + bambu-studio-api"
        docker compose --profile bambu up --build -d
        ;;
esac

echo
docker compose ps
