#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --set=writer_password="$(cat /run/secrets/database_writer_password)" \
  --set=reader_password="$(cat /run/secrets/database_reader_password)" <<'SQL'
CREATE ROLE analytics_writer LOGIN PASSWORD :'writer_password';
CREATE ROLE grafana_reader LOGIN PASSWORD :'reader_password';
REVOKE ALL ON DATABASE project_analytics FROM PUBLIC;
GRANT CONNECT ON DATABASE project_analytics TO analytics_writer, grafana_reader;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA analytics AUTHORIZATION analytics_writer;
GRANT USAGE ON SCHEMA analytics TO grafana_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE analytics_writer IN SCHEMA analytics GRANT SELECT ON TABLES TO grafana_reader;
ALTER ROLE grafana_reader SET default_transaction_read_only = on;
SQL
