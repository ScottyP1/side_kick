#!/bin/bash
# Sidekick's meeting-bot container (one Azure Container Apps job execution per meeting): Redis, Attendee's web API and
# its Celery worker (which runs the Chrome bot), then the shim, all inside this one container. The container exits
# when the shim does (the meeting is over for the bot), so the job execution ends and stops costing.
set -euo pipefail
cd /attendee
redis-server --daemonize yes --save "" --appendonly no --bind 127.0.0.1
# Attendee calls the shim on 127.0.0.1 over plain http (its own switch); the bot runs in the Celery worker here.
export REDIS_URL="redis://127.0.0.1:6379/0" LAUNCH_BOT_METHOD="celery" REQUIRE_HTTPS_WEBHOOKS="false"
# Attendee's database is its own database on Sidekick's Postgres server (DATABASE_URL from the job's secrets). Migrations
# run at setup (infra/azure/meetbot-setup.sh); here only when something is missing, so a start stays quick.
export DJANGO_SETTINGS_MODULE="attendee.settings.production"
python manage.py migrate --check >/dev/null 2>&1 || python manage.py migrate --noinput
# This meeting's Attendee API key and the project's webhook secret, made here and kept in the container (bootstrap.py).
python /meetbot/bootstrap.py
gunicorn attendee.wsgi:application --bind 127.0.0.1:8000 --workers 1 --threads 4 --log-level warning &
celery -A attendee worker --loglevel=warning --concurrency=1 &
exec node /meetbot/shim/main.mjs
