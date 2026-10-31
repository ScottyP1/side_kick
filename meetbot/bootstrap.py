"""Sidekick's meeting bot: makes this container's Attendee credentials at start (meetbot/entrypoint.sh).

Ensures Attendee's organization and project "Sidekick" exist in its database, makes a fresh API key for this one
meeting (keys from earlier meetings older than a day are deleted) and makes sure the project has a webhook secret.
It writes both to a file only this container can read (/tmp/meetbot-credentials.json, mode 600) for the shim. So no
Attendee secret is ever stored outside the container, put in Key Vault, or written to a log.
"""
import base64
import datetime
import json
import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "attendee.settings.production")
django.setup()

from django.utils import timezone  # noqa: E402

from accounts.models import Organization  # noqa: E402
from bots.models import ApiKey, Project, WebhookSecret  # noqa: E402

org, _ = Organization.objects.get_or_create(name="Sidekick")
project = Project.objects.filter(organization=org, name="Sidekick").first() or Project.objects.create(organization=org, name="Sidekick")
ApiKey.objects.filter(project=project, name__startswith="meetbot-", created_at__lt=timezone.now() - datetime.timedelta(days=1)).delete()
_, key = ApiKey.create(project=project, name=f"meetbot-{os.environ.get('SIDEKICK_SESSION', 'unknown')[:40]}")
secret = project.webhook_secrets.order_by("created_at").first() or WebhookSecret.objects.create(project=project)

path = "/tmp/meetbot-credentials.json"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"apiKey": key, "webhookSecret": base64.b64encode(secret.get_secret()).decode()}, f)
print("[meetbot] Attendee credentials ready")
