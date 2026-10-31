# Sidekick's changes to Attendee (v1.89.2)

The meeting-bot image (`../Dockerfile`) applies every `*.patch` here to Attendee's source at the pinned tag, in name
order, at build time (`patch -p1`). A patch that no longer applies fails the image build, so an Attendee upgrade can
never silently drop one. Upgrade: change the tag in `../Dockerfile` and `infra/azure/meetbot-setup.sh`, rebuild, and
re-check each patch.

| Patch | What | Status |
|---|---|---|
| `01-local-audio-websocket.patch` | Lets the audio websocket (`websocket_settings.audio.url`) be `ws://127.0.0.1:<port>`: the shim in the same container receives the meeting's mixed audio for Azure speech-to-text (`../shim/audio.mjs`). Attendee only accepts `wss://` otherwise. | Applies to v1.89.2 (checked with `patch --dry-run`) |
| (no patch) local webhooks | Attendee's own switch `REQUIRE_HTTPS_WEBHOOKS=false` (`attendee/settings/base.py`) lets it call the shim at `http://127.0.0.1:8090`. Set in `../entrypoint.sh`. | Built in |
| `02-raise-hand.patch` | **Not written yet: needs a real Teams meeting (stage 2 trial).** See below. Until it's in the image, `ATTENDEE_RAISE_HAND` stays unset and Sidekick puts "✋" in the meeting chat instead. | To do on the trial |

## 02: raise hand (design, from reading v1.89.2)

Attendee has no raise-hand control. The change follows the same path as its chat messages:

1. **API**: `bots/bots_api_urls.py`, next to `bots/<str:object_id>/send_chat_message`: add
   `bots/<str:object_id>/raise_hand`. In `bots/bots_api_views.py`, a view (like the chat one around line 1191) that
   stores the wanted state on the bot (`raised: true|false`) and calls `send_sync_command(bot, "sync_hand")`
   (`bots/bots_api_utils.py:79`).
2. **Bot process**: in `bots/bot_controller/bot_controller.py` `handle_redis_message` (line ~1340), add a
   `sync_hand` branch that reads the wanted state and calls `self.adapter.set_hand_raised(raised)`.
3. **Teams adapter**: `bots/teams_bot_adapter/teams_ui_methods.py`, alongside `click_captions_button` and
   `click_leave_button`: `set_hand_raised(raised)` finds the meeting toolbar's Raise hand control and clicks it when its
   pressed state differs. The selector must be read from the live Teams web client during the trial (Teams changes
   it; Attendee's other clicks use `data-tid` attributes). Other adapters (Zoom, Meet) do nothing.
4. **Tests**: Attendee's own test style (`bots/tests/test_teams_bot.py`) with a mocked driver.

Risk: a Teams web change can break the click. Then the API still answers but nothing happens; Sidekick's daily
synthetic join test (stage 2) should check the hand once, and the fallback is "✋" in the chat.
