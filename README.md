# Watchtower

An agent that connects public-tender portals on its own, watches over them, and repairs itself when one breaks. Built for Patterno's challenge at the MAIN AI Hackathon 2026.

## Run it

```bash
docker build -t watchtower .
docker run -p 8080:8080 --env-file .env watchtower
```

Dashboard: http://localhost:8080. API: see below.

## How it works
_A (person) finishes this page by Saturday 08:00. One page, plain words._

1. **Attach.** Given a portal address, an LLM explores the portal once and writes a recipe: a small JSON description of where the tender list is, how to page through it, where each field and document is.
2. **Read.** Plain code runs the recipe on a schedule. **No model call.** At most one request per second per portal.
3. **Notice.** Deterministic checks decide whether a read is correct before it is served, including known "golden" tenders that must still match.
4. **Repair.** When checks fail, the LLM proposes a minimal change to the recipe. Code proves it against the golden tenders before it serves anything. Meanwhile, the last correct tenders stay available.

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | yes | Model key. |
| `MODEL_SMART` | yes | Model for attaching and repairing. |
| `MODEL_FAST` | yes | Model for triage. |
| `PRICE_SMART_IN`, `PRICE_SMART_OUT`, `PRICE_FAST_IN`, `PRICE_FAST_OUT` | no | USD per million tokens, for the cost ledger. |
| `PORT` | no | Default 8080. |
| `DATA_DIR` | no | Default `/data` in the container. |
| `READ_INTERVAL_MINUTES` | no | Default 30. |
| `FAILED_RETRY_MINUTES` | no | Default 30. |

## What one portal costs in model usage
_Filled from measured numbers (`GET /internal/ledger`) before hand-in._

| | Model calls | Cost |
|---|---|---|
| Attach (once) | – | – |
| Regular read | 0 | $0 |
| Repair (per portal change) | – | – |

## API
`POST /portals`, `GET /portals`, `GET /portals/{id}`, `DELETE /portals/{id}`, `POST /portals/{id}/refresh`, `GET /portals/{id}/tenders[?changedSince=]`, `GET /portals/{id}/runs`, `GET /files/{sha256}`, `GET /` (dashboard). Exact shapes: `src/shared/contract.ts`.
