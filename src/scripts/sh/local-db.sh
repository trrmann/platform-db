#!/bin/bash

################################################################################
# Shared local scratch PostgreSQL (platform-db)
#
# Usage: local-db.sh <command>
#
# One private PostgreSQL cluster on this machine, shared by every project that
# depends on platform-db. Each project gets its own database, named after the
# project's package.json "name" (e.g. FlashCards -> flashcards_local,
# iam-service -> iam_service_local). Schema and migration work is tried here,
# never first on the shared Render database. The system PostgreSQL service is
# not touched; the cluster listens on 127.0.0.1 only.
#
# Run it from a project directory (npm scripts do this), or set LOCAL_DB_NAME.
#
# Commands:
#   init       Create the cluster (once) and this project's database
#   start      Start the cluster
#   stop       Stop the cluster
#   status     Show whether it is running and this project's database
#   psql       psql on this project's database (extra args passed through)
#   env        Print the DB_PG_* exports that point an app at this database
#   run CMD…   Run a command with the app pointed at this database
#   serve      Run `npm run dev` against this database (PORT_DEV default 5001)
#   reset      Drop and recreate this project's database (empty)
#   drop       Drop this project's database
#   load-prod  Replace this database with a read-only pg_dump of the Render DB
#              (copies real users' data: owner use only)
#   destroy    Stop the cluster and delete it with every project's database
################################################################################

set -euo pipefail

STATE_DIR="${LOCAL_PG_DIR:-${HOME}/.local/share/platform-db}"
PGDATA_DIR="${STATE_DIR}/pgdata"
SOCKET_DIR="${STATE_DIR}/socket"
LOG_FILE="${STATE_DIR}/postgres.log"
CREDENTIALS_FILE="${STATE_DIR}/credentials.env"
DUMP_FILE="${STATE_DIR}/render-snapshot.dump"

PORT="${LOCAL_PG_PORT:-5433}"
SUPERUSER="platform_super"
APP_USER="${LOCAL_PG_APP_USER:-flashcards_app}"
PROJECT_DIR="$(pwd)"

die() {
    echo "local-db: $*" >&2
    exit 1
}

project_database() {
    if [ -n "${LOCAL_DB_NAME:-}" ]; then
        echo "${LOCAL_DB_NAME}"
        return
    fi
    [ -f "${PROJECT_DIR}/package.json" ] || die "run from a project directory (package.json) or set LOCAL_DB_NAME"
    local name
    name="$(node -p "require('${PROJECT_DIR}/package.json').name" 2> /dev/null)" || die "cannot read package.json name"
    name="$(echo "${name##*/}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '_')"
    echo "${name}_local"
}

load_credentials() {
    [ -f "${CREDENTIALS_FILE}" ] || die "cluster not initialized; run: local-db.sh init"
    # shellcheck disable=SC1090
    source "${CREDENTIALS_FILE}"
}

is_running() {
    pg_ctl -D "${PGDATA_DIR}" status > /dev/null 2>&1
}

require_running() {
    is_running || die "not running; run: local-db.sh start"
}

super_psql() {
    PGPASSWORD="${SUPER_PASSWORD}" psql -h 127.0.0.1 -p "${PORT}" -U "${SUPER_USER:-${SUPERUSER}}" -d postgres \
        -v ON_ERROR_STOP=1 -q "$@"
}

database_exists() {
    [ "$(super_psql -Atc "SELECT 1 FROM pg_database WHERE datname = '$1'")" = "1" ]
}

init_cluster() {
    command -v initdb > /dev/null || die "initdb not found (install postgresql-server and postgresql-contrib)"
    mkdir -p "${STATE_DIR}" "${SOCKET_DIR}"
    chmod 700 "${STATE_DIR}" "${SOCKET_DIR}"

    local super_password app_password pwfile
    super_password="$(openssl rand -hex 24)"
    app_password="$(openssl rand -hex 24)"
    umask 077
    printf 'SUPER_USER=%s\nSUPER_PASSWORD=%s\nAPP_PASSWORD=%s\n' \
        "${SUPERUSER}" "${super_password}" "${app_password}" > "${CREDENTIALS_FILE}"

    pwfile="$(mktemp)"
    printf '%s\n' "${super_password}" > "${pwfile}"
    initdb -D "${PGDATA_DIR}" -U "${SUPERUSER}" --pwfile="${pwfile}" \
        --auth-local=scram-sha-256 --auth-host=scram-sha-256 --encoding=UTF8 > /dev/null
    rm -f "${pwfile}"

    cat >> "${PGDATA_DIR}/postgresql.conf" <<EOF

# platform-db local scratch cluster
listen_addresses = '127.0.0.1'
port = ${PORT}
unix_socket_directories = '${SOCKET_DIR}'
EOF
    cmd_start
    load_credentials
    super_psql -c "CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}';"
    echo "Initialized cluster at ${PGDATA_DIR} (port ${PORT})"
}

cmd_init() {
    [ -d "${PGDATA_DIR}" ] || init_cluster
    cmd_start
    load_credentials
    local db
    db="$(project_database)"
    if database_exists "${db}"; then
        echo "database ${db} already exists"
    else
        super_psql -c "CREATE DATABASE ${db} OWNER ${APP_USER};"
        echo "created database ${db}"
    fi
}

cmd_start() {
    [ -d "${PGDATA_DIR}" ] || die "not initialized; run: local-db.sh init"
    is_running && { echo "running on 127.0.0.1:${PORT}"; return 0; }
    pg_ctl -D "${PGDATA_DIR}" -l "${LOG_FILE}" -w start > /dev/null
    echo "started on 127.0.0.1:${PORT}"
}

cmd_stop() {
    is_running || { echo "not running"; return 0; }
    pg_ctl -D "${PGDATA_DIR}" -m fast -w stop > /dev/null
    echo "stopped"
}

cmd_status() {
    if is_running; then
        echo "running: 127.0.0.1:${PORT}, project database $(project_database), user ${APP_USER}"
    else
        echo "stopped (data: ${PGDATA_DIR})"
    fi
}

cmd_psql() {
    load_credentials
    # The app schemas first, like the apps' own search paths.
    PGOPTIONS="${PGOPTIONS:--c search_path=flashcards,iam,public}" PGPASSWORD="${APP_PASSWORD}" \
        exec psql -h 127.0.0.1 -p "${PORT}" -U "${APP_USER}" -d "$(project_database)" "$@"
}

cmd_env() {
    load_credentials
    cat <<EOF
export DB_PG_EXTERNAL_HOSTNAME=127.0.0.1
export DB_PG_INTERNAL_HOSTNAME=127.0.0.1
export DB_PG_PORT=${PORT}
export DB_PG_DATABASE=$(project_database)
export DB_PG_USER=${APP_USER}
export DB_PG_PASSWORD=${APP_PASSWORD}
export DB_PG_SSL=disable
export DB_PG_EXPIRE=
EOF
}

cmd_run() {
    [ $# -gt 0 ] || die "usage: local-db.sh run <command> [args…]"
    require_running
    eval "$(cmd_env)"
    # Real environment variables take precedence over .env (node --env-file and
    # dotenv never override them), so the app uses this local database.
    NODE_ENV="${NODE_ENV:-development}" exec "$@"
}

cmd_serve() {
    PORT_DEV="${PORT_DEV:-5001}" cmd_run npm run dev
}

cmd_reset() {
    load_credentials
    require_running
    local db
    db="$(project_database)"
    super_psql -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE);"
    super_psql -c "CREATE DATABASE ${db} OWNER ${APP_USER};"
    echo "reset: ${db} is empty"
}

cmd_drop() {
    load_credentials
    require_running
    super_psql -c "DROP DATABASE IF EXISTS $(project_database) WITH (FORCE);"
    echo "dropped $(project_database)"
}

cmd_load_prod() {
    load_credentials
    require_running
    [ -f "${PROJECT_DIR}/.env" ] || die "no .env with the Render DB_PG_* settings"
    local host port db user password
    host="$(grep '^DB_PG_EXTERNAL_HOSTNAME=' "${PROJECT_DIR}/.env" | cut -d= -f2-)"
    port="$(grep '^DB_PG_PORT=' "${PROJECT_DIR}/.env" | cut -d= -f2-)"
    db="$(grep '^DB_PG_DATABASE=' "${PROJECT_DIR}/.env" | cut -d= -f2-)"
    user="$(grep '^DB_PG_USER=' "${PROJECT_DIR}/.env" | cut -d= -f2-)"
    password="$(grep '^DB_PG_PASSWORD=' "${PROJECT_DIR}/.env" | cut -d= -f2-)"
    echo "Dumping the Render database (read-only)..."
    umask 077
    PGPASSWORD="${password}" PGSSLMODE=require pg_dump -h "${host}" -p "${port:-5432}" -U "${user}" \
        -d "${db}" --format=custom --no-owner --no-privileges -f "${DUMP_FILE}"
    cmd_reset
    PGPASSWORD="${APP_PASSWORD}" pg_restore -h 127.0.0.1 -p "${PORT}" -U "${APP_USER}" \
        -d "$(project_database)" --no-owner --no-privileges --exit-on-error "${DUMP_FILE}"
    echo "Loaded Render snapshot into $(project_database) (dump kept at ${DUMP_FILE})"
}

cmd_destroy() {
    cmd_stop || true
    rm -rf -- "${STATE_DIR:?}"
    echo "deleted ${STATE_DIR}"
}

case "${1:-}" in
    init) cmd_init ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    psql) shift; cmd_psql "$@" ;;
    env) cmd_env ;;
    run) shift; cmd_run "$@" ;;
    serve) cmd_serve ;;
    reset) cmd_reset ;;
    drop) cmd_drop ;;
    load-prod) cmd_load_prod ;;
    destroy) cmd_destroy ;;
    *) sed -n '3,31p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
