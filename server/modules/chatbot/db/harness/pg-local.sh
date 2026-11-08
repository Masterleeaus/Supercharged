#!/usr/bin/env bash
# Local Postgres 16 cluster for the chatbot draft-SQL harness.
#
#   pg-local.sh start   create the cluster if needed, then start it
#   pg-local.sh stop    stop it (fast shutdown)
#   pg-local.sh reset   stop, delete the data directory, initdb, start
#   pg-local.sh status  print running / not running (exit 0 only when running)
#
# Postgres refuses to run as root, so when this script is started as root it
# re-runs itself as the non-root user PG_OS_USER (default: pgtest).
# Auth is `trust` on 127.0.0.1 only. This is a throwaway test cluster, so no
# password is created or needed, and none is ever printed.

set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_PORT="${CHATBOT_PG_PORT:-55432}"
PG_OS_USER="${CHATBOT_PG_OS_USER:-pgtest}"
PG_ROOT="${CHATBOT_PG_ROOT:-/tmp/chatbot-pg}"
PG_DATA="$PG_ROOT/data"
PG_LOG="$PG_ROOT/server.log"
PG_SOCK_DIR="${CHATBOT_PG_SOCK_DIR:-/tmp/chatbot-pg-sock}"
PG_DB_USER="pgtest"

cmd="${1:-}"
case "$cmd" in
  start|stop|reset|status) ;;
  *) echo "usage: $0 start|stop|reset|status" >&2; exit 2 ;;
esac

# Re-run as the non-root user when started as root.
if [ "$(id -u)" -eq 0 ]; then
  if ! id "$PG_OS_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /bin/bash "$PG_OS_USER"
  fi
  mkdir -p "$PG_ROOT" "$PG_SOCK_DIR"
  chown "$PG_OS_USER:$PG_OS_USER" "$PG_ROOT" "$PG_SOCK_DIR"
  chmod 700 "$PG_ROOT"
  exec runuser -u "$PG_OS_USER" -- env \
    PG_BIN="$PG_BIN" CHATBOT_PG_PORT="$PG_PORT" CHATBOT_PG_OS_USER="$PG_OS_USER" \
    CHATBOT_PG_ROOT="$PG_ROOT" CHATBOT_PG_SOCK_DIR="$PG_SOCK_DIR" \
    /bin/bash "$0" "$cmd"
fi

is_running() {
  "$PG_BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1
}

do_status() {
  if is_running; then
    echo "running: port $PG_PORT, socket dir $PG_SOCK_DIR"
    return 0
  fi
  echo "not running"
  return 1
}

do_init() {
  if [ -f "$PG_DATA/PG_VERSION" ]; then
    return 0
  fi
  mkdir -p "$PG_ROOT"
  rm -rf "$PG_DATA"
  "$PG_BIN/initdb" -D "$PG_DATA" -U "$PG_DB_USER" --auth=trust --encoding=UTF8 --locale=C >"$PG_ROOT/initdb.log" 2>&1 \
    || { echo "initdb failed, see $PG_ROOT/initdb.log" >&2; exit 1; }
}

do_start() {
  if is_running; then
    do_status
    return 0
  fi
  do_init
  mkdir -p "$PG_SOCK_DIR"
  "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" -w -t 60 \
    -o "-p $PG_PORT -k $PG_SOCK_DIR -c listen_addresses=127.0.0.1 -c max_connections=50" start \
    || { echo "start failed, see $PG_LOG" >&2; exit 1; }
  do_status
}

do_stop() {
  if ! is_running; then
    echo "not running"
    return 0
  fi
  "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast -w -t 60 stop
}

case "$cmd" in
  start)  do_start ;;
  stop)   do_stop ;;
  status) do_status ;;
  reset)
    if is_running; then
      "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast -w -t 60 stop
    fi
    rm -rf "$PG_DATA"
    do_start
    ;;
esac
