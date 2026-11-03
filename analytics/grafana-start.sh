#!/bin/sh
set -eu
export GRAFANA_POSTGRES_PASSWORD="$(cat /run/secrets/database_reader_password)"
exec /run.sh
