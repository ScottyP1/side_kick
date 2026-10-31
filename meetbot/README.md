# Sidekick's meeting bot (self-hosted, one container per meeting)

What runs when Sidekick joins a Teams meeting live (docs/LIVE-MEETINGS.md → "Runs only during meetings"). One **Azure
Container Apps job execution per meeting** in Sidekick's own `sidekick-env`: it starts about 2 minutes before a
group's meeting (or on "@Sidekick join") and exits when the meeting ends or Sidekick stops it. Nothing runs between
meetings, so there's no fixed cost.

Inside the one container (`Dockerfile`, `entrypoint.sh`):
- **Attendee** v1.89.2 (open source, Elastic License 2.0): headless Chrome joins the Teams meeting as
  "Sidekick (notes)", turns on Teams' live captions, reads the chat, and posts, speaks and (with our patch) raises its
  hand. Its web API and Celery worker run on 127.0.0.1 only. Our changes: `patches/`.
- **Redis**, in the container (no Azure Cache).
- **The shim** (`shim/`, Node 22): forwards Attendee's events to Sidekick signed with the session's own key, and
  long-polls Sidekick for commands (the job has no inbound address). It switches hearing to Azure AI Speech
  speech-to-text (`shim/audio.mjs`) when Sidekick says captions are off or stalled, and exits with the meeting.

Attendee's database: its own database (`attendee`) on Sidekick's existing Postgres server.

Settings the job execution gets:
- At launch (app/src/lib/live-meetings/launcher.ts): `SIDEKICK_SESSION`, `SIDEKICK_URL`, `SIDEKICK_BOT_KEY`,
  `MEETING_URL`, `BOT_NAME`, `RAISE_HAND`.
- From the job's Key Vault secrets: `DATABASE_URL` (Attendee's database), `DJANGO_SECRET_KEY`,
  `CREDENTIALS_ENCRYPTION_KEY`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`.
- Made in the container at start (`bootstrap.py`): this meeting's Attendee API key and the project's webhook secret.
  They never leave the container.

Build and set-up: `infra/azure/meetbot-setup.sh` (idempotent; **don't run it before Cody approves the Azure
resources**). Tests: `app/tests/run.mjs` runs `meetbot/shim/core.test.mjs` against a fake Attendee and a fake Sidekick.
