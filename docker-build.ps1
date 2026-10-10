# build.ps1 - Windows PowerShell Build Script
#
# This script automates the process of building and running the Docker container
# with version information dynamically injected at build time.

# Stop script execution on any error
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path "docker-data/runtime.env")) {
    throw "Run node scripts/setup-subscriptions.mjs --docker on the Linux host first."
}

# --- Step 1: Choose Environment ---
Write-Host "Please select an option:"
Write-Host "1) Run an existing local image (build it first)"
Write-Host "2) Build this fork and run (recommended)"
$choice = Read-Host -Prompt "Enter choice [1-2]"

# --- Step 2: Execute based on choice ---
switch ($choice) {
    "1" {
        Write-Host "Starting the existing local image."
        docker compose --env-file docker-data/runtime.env up -d --no-build --pull never
        Write-Host "Services are starting from the local image."
        Write-Host "Run 'docker compose --env-file docker-data/runtime.env logs -f' to see the logs."
    }
    "2" {
        Write-Host "--- Building from Source and Running ---"

        # Get Version Information
        $VERSION = (git describe --tags --always --dirty)
        $COMMIT  = (git rev-parse --short HEAD)
        $BUILD_DATE = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

        Write-Host "Building with the following info:"
        Write-Host "  Version: $VERSION"
        Write-Host "  Commit: $COMMIT"
        Write-Host "  Build Date: $BUILD_DATE"
        Write-Host "----------------------------------------"

        # Build and start the services with a local-only image tag
        $env:CLI_PROXY_IMAGE = "subscription-desk:local"
        
        Write-Host "Building the Docker image..."
        docker compose --env-file docker-data/runtime.env build --build-arg VERSION=$VERSION --build-arg COMMIT=$COMMIT --build-arg BUILD_DATE=$BUILD_DATE

        Write-Host "Starting the services..."
        docker compose --env-file docker-data/runtime.env up -d --pull never

        Write-Host "Build complete. Services are starting."
        Write-Host "Run 'docker compose --env-file docker-data/runtime.env logs -f' to see the logs."
    }
    default {
        Write-Host "Invalid choice. Please enter 1 or 2."
        exit 1
    }
}
