#!/bin/sh
# Starts the API in its container: database migrations first, then the server.
#
# A deployment replaces the image, so the schema must follow the code before
# the server takes requests. Lucid holds a database lock while it migrates, so
# several replicas starting together migrate once. A failed migration stops
# the container: the orchestrator keeps the previous version running.
#
# BLAME_API_MIGRATE_ON_START=false skips the migrations, for a setup that runs
# them itself (`node ace.js migration:run --force` in the container).
set -eu

if [ "${BLAME_API_MIGRATE_ON_START:-true}" != "false" ]; then
  node ace.js migration:run --force
fi

# The server replaces this shell, so it receives the container's signals.
exec node bin/server.js
