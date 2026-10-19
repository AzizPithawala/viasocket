# Plug Review Pipeline

An agent that reviews viaSocket plugs, asks the reviewer in Slack, and records every decision.

**Flow:** a row in the `plug_queue` table starts a review → the review automation audits the plug against its API docs → the decision automation re-checks the findings → Slack buttons (Approve / Reject / Improve) → the decision is recorded once in `plug_decisions`.

- **Live tests (published plugs):** the queue row's Developer Hub URL (or the plug name) is matched to a published app. The hosted app runs every *read* action and fetches one event per trigger on a test connection, and the results go into the audit and the Slack message. Write actions are never run. A failed live read is a blocking finding quoted with the real error; a missing connection or skipped test is reported as unverified, never as a reject.
- Reject runs without a click only when the audit and the re-check both say reject.
- Approve and Improve wait for a click. They record a status but do **not** call Developer Hub yet (not connected).
- With no plug definition, nothing is audited or auto-rejected: the reviewer decides.

## Choosing accounts

Slack and viaSocket Table each have a dropdown listing every connected account (for example the Slack workspace or the Table database). Pick one to make it active, or choose "Connect another account…". Old connections are kept. Switching clears the saved channel, team leader and table picks, because they belong to the old account; pick them again and save so the automations use the new account. Saving checks that the chosen tables have the required columns. To use a different login, use the **Use a different login** link under the app: the sign-in popup always uses the account the browser is already signed into and the agent cannot change that, so the connection is made in a private window. The page notices the new account within a few seconds and offers **Use this account**. After switching, the pickers preselect `plug_decisions` and `plug_queue` if the new account already has them, and a **Required table columns** box lists what to create otherwise (with a **Check** button). Accounts that are not in use can be removed.

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
| `INTAKE_KEY` | lets the intake automation call `POST /api/live-test` only |
| `PUBLIC_URL` | the hosted app's address, called by the intake automation |

## Known limits

- Live tests need a published plug and a test connection made in the browser. Draft plugs are not tested live (Developer Hub's test API is not connected).
- Required free-text inputs are never invented, so an action that needs them is reported as not run.
- Intake is polled, so a queue row starts a review about two minutes later.
- Data in `DATA_DIR` is not backed up.
