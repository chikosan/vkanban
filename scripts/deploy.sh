#!/usr/bin/env bash
set -euo pipefail

cd /opt/vkanban

echo "Pulling latest image from registry..."
docker compose -f /opt/vkanban/docker-compose.registry.yml pull

echo "Starting container..."
docker compose -f /opt/vkanban/docker-compose.registry.yml up -d

echo "Done. vkanban should be available via nginx."
