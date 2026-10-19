# Plug Review Pipeline

An agent that reviews viaSocket plugs, asks the reviewer in Slack, and records every decision.

**Flow:** a row in the `plug_queue` table starts a review → the review automation audits the plug against its API docs → the decision automation re-checks the findings → Slack buttons (Approve / Reject / Improve) → the decision is recorded once in `plug_decisions`.

- Reject runs without a click only when the audit and the re-check both say reject.
- Approve and Improve wait for a click. They record a status but do **not** call Developer Hub yet (not connected).
- With no plug definition, nothing is audited or auto-rejected: the reviewer decides.

## Run locally

```bash
npm install
cp .env.example .env   # fill in the values
npm run dev
```

## Environment

| Variable | Purpose |
| --- | --- |
| `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID`, `VIASOCKET_EMBED_SECRET` | viaSocket embed credentials (secret is server-side only) |
| `VIASOCKET_API_URL`, `VIASOCKET_RUN_URL` | viaSocket hosts |
| `APP_PASSWORD` | shared password (HTTP basic auth, any username) |
| `DATA_DIR` | where state and settings are kept (set by Embarko) |

## Known limits

- The audit compares the plug definition with the docs. It does not run actions or triggers.
- Intake is polled, so a queue row starts a review about two minutes later.
- Data in `DATA_DIR` is not backed up.
