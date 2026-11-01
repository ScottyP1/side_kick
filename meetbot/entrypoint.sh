#!/bin/bash
# Sidekick's meeting-bot container (one Azure Container Apps job execution per meeting): Redis, Attendee's web API and
# its Celery worker (which runs the Chrome bot), then the shim, all inside this one container. The container exits
# when the shim does (the meeting is over for the bot), so the job execution ends and stops costing.
set -euo pipefail
cd /attendee
redis-server --daemonize yes --save "" --appendonly no --bind 127.0.0.1
# Attendee calls the shim on 127.0.0.1 over plain http (its own switch); the bot runs in the Celery worker here.
export REDIS_URL="redis://127.0.0.1:6379/0" LAUNCH_BOT_METHOD="celery" REQUIRE_HTTPS_WEBHOOKS="false"
# Attendee's web API listens only on 127.0.0.1 inside this container, so no HTTPS redirect there (its production
# settings default to one, which sent the shim's plain-http calls to https; found on the first live trial, Nov 1).
export DJANGO_SSL_REQUIRE="false"
# Attendee's database is its own database on Sidekick's Postgres server (DATABASE_URL from the job's secrets). Migrations
# run at setup (infra/azure/meetbot-setup.sh); here only when something is missing, so a start stays quick.
export DJANGO_SETTINGS_MODULE="attendee.settings.production"
python manage.py migrate --check >/dev/null 2>&1 || python manage.py migrate --noinput
# This meeting's Attendee API key and the project's webhook secret, made here and kept in the container (bootstrap.py).
python /meetbot/bootstrap.py
# The moving crystal ball as the bot's camera (only when Sidekick sends ORB_URL, the organization's choice; docs/LIVE-MEETINGS.md → "Sidekick's
# camera"): Attendee's webpage streamer, a second Chrome that shows Sidekick's /live/orb page and streams it to the bot.
# It runs here on 127.0.0.1:8001 (our patch 03), sandbox off like the bot's own Chrome, through Attendee's own
# entrypoint (it starts PulseAudio, which the streamer's audio capture needs). If it fails, the shim shows the logo.
if [ -n "${ORB_URL:-}" ]; then
  export ENABLE_VOICE_AGENTS="true" VOICE_AGENT_URL_PREFIX_ALLOWLIST="${SIDEKICK_URL%/}/live/orb?"
  export WEBPAGE_STREAMER_PORT="8001" WEBPAGE_STREAMER_HOST="127.0.0.1" WEBPAGE_STREAMER_LOCAL_ADDRESS="127.0.0.1:8001"
  export ENABLE_CHROME_SANDBOX_FOR_WEBPAGE_STREAMER="false"
  /usr/local/bin/entrypoint.sh python bots/webpage_streamer/run_webpage_streamer.py --video-frame-size 640x360 &
fi
gunicorn attendee.wsgi:application --bind 127.0.0.1:8000 --workers 1 --threads 4 --log-level warning &
# More than one worker slot: the bot itself occupies one for the whole meeting, and Attendee delivers its webhooks and
# processes captions as Celery tasks too (with one slot they queued behind the bot forever; first live trial, Nov 1).
celery -A attendee worker --loglevel=warning --concurrency=4 &
exec node /meetbot/shim/main.mjs
