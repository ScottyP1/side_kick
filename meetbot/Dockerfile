# Sidekick's meeting bot (docs/LIVE-MEETINGS.md → "Runs only during meetings"): Attendee at a pinned version, our patches
# (raise hand, local webhooks), Redis and the shim, in one image for an Azure Container Apps job (one execution per
# meeting). BASE is Attendee's own image built from its repository at the pinned tag (infra/azure/meetbot-setup.sh:
# az acr build … https://github.com/attendee-labs/attendee.git#v1.89.2).
ARG BASE=sidekicklabsacr.azurecr.io/attendee:v1.89.2
FROM ${BASE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends redis-server curl ca-certificates \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*
# Our changes to Attendee: Teams' Raise hand button, and webhooks/websockets to the shim on 127.0.0.1 over plain http.
COPY patches/ /meetbot/patches/
RUN cd /attendee && for p in /meetbot/patches/*.patch; do patch -p1 < "$p"; done
COPY shim/package.json /meetbot/shim/package.json
RUN cd /meetbot/shim && npm install --omit=dev --no-audit --no-fund
COPY shim/ /meetbot/shim/
COPY entrypoint.sh bootstrap.py /meetbot/
RUN chmod +x /meetbot/entrypoint.sh && chown -R app:app /meetbot
USER app
ENTRYPOINT ["/tini", "--", "/meetbot/entrypoint.sh"]
