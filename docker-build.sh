#!/usr/bin/env bash
#
# Linux Docker build script for Subscription Desk
#
# This script automates the process of building and running the Docker container
# with version information dynamically injected at build time.

set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ ! -f docker-data/runtime.env ]]; then
  echo "Run node scripts/setup-subscriptions.mjs --docker first." >&2
  exit 1
fi

if [[ "${1:-}" != "" ]]; then
  echo "Error: unknown option '${1}'."
  echo "Usage: ./docker-build.sh"
  exit 1
fi

# --- Step 1: Choose Environment ---
echo "Please select an option:"
echo "1) Run an existing local image (build it first)"
echo "2) Build this fork and run (recommended)"
read -r -p "Enter choice [1-2]: " choice

# --- Step 2: Execute based on choice ---
case "$choice" in
  1)
    echo "Starting the existing local image."
    docker compose --env-file docker-data/runtime.env up -d --no-build --pull never
    echo "Services are starting from the local image."
    echo "Run 'docker compose --env-file docker-data/runtime.env logs -f' to see the logs."
    ;;
  2)
    echo "--- Building from Source and Running ---"

    # Get Version Information
    VERSION="$(git describe --tags --always --dirty)"
    COMMIT="$(git rev-parse --short HEAD)"
    BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    echo "Building with the following info:"
    echo "  Version: ${VERSION}"
    echo "  Commit: ${COMMIT}"
    echo "  Build Date: ${BUILD_DATE}"
    echo "----------------------------------------"

    # Build and start the services with a local-only image tag
    export CLI_PROXY_IMAGE="subscription-desk:local"

    echo "Building the Docker image..."
    docker compose --env-file docker-data/runtime.env build \
      --build-arg VERSION="${VERSION}" \
      --build-arg COMMIT="${COMMIT}" \
      --build-arg BUILD_DATE="${BUILD_DATE}"

    echo "Starting the services..."
    docker compose --env-file docker-data/runtime.env up -d --pull never

    echo "Build complete. Services are starting."
    echo "Run 'docker compose --env-file docker-data/runtime.env logs -f' to see the logs."
    ;;
  *)
    echo "Invalid choice. Please enter 1 or 2."
    exit 1
    ;;
esac
