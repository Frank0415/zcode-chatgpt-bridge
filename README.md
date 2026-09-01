# ZCode ChatGPT Bridge

A small local service that lets ZCode use a ChatGPT/Codex subscription through an OpenAI Responses-compatible endpoint. It uses the official `codex app-server` for ChatGPT authentication, model access, persistent Codex threads, and native conversation compaction. No OpenAI API key is needed.

## Install

Requirements: macOS or a systemd-based Linux desktop, Node.js 24 or newer, and the Codex CLI.

```bash
make install
zcode-chatgpt-bridge login
```

The install command creates and starts a launchd agent on macOS or a systemd user service on Linux. The service keeps running after the terminal closes and starts automatically with your user session.

The bridge starts Codex with a 1,000,000-token context window and native automatic compaction at 900,000 total tokens. Override these defaults with `BRIDGE_MODEL_CONTEXT_WINDOW` and `BRIDGE_AUTO_COMPACT_TOKEN_LIMIT` when running the service manually.

## Add it to ZCode

Open ZCode Model Settings, add a custom provider, and enter:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:9099/v1` |
| API format | OpenAI Responses |
| API key | Leave empty |

Add `gpt-5.6-sol` and `gpt-5.6-luna` to the provider's model list with a 1,000,000-token context window and vision enabled.

If ZCode requires text in the API key box, enter any placeholder. The local service ignores the `Authorization` header.

Run `zcode-chatgpt-bridge models` to see the model IDs available to the signed-in ChatGPT account.

## CLI

```text
zcode-chatgpt-bridge start
zcode-chatgpt-bridge stop
zcode-chatgpt-bridge restart
zcode-chatgpt-bridge status
zcode-chatgpt-bridge endpoint
zcode-chatgpt-bridge login
zcode-chatgpt-bridge login device
zcode-chatgpt-bridge logout
zcode-chatgpt-bridge models
```

The service exposes `GET /v1/models`, `POST /v1/responses`, streamed Responses events, response retrieval, and `POST /v1/responses/compact`. Responses function tools are bridged to Codex dynamic tools so ZCode can execute a tool and return its `function_call_output`. Compaction uses Codex's native `thread/compact/start`; the returned compaction item is an opaque local handle to the persisted Codex thread.
