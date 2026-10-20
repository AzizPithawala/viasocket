# Plug Review Pipeline

An agent that reviews viaSocket plugs, asks the reviewer in Slack, and records every decision.

**Flow:** a row in the `plug_queue` table starts a review → the review automation audits the plug against its API docs → the decision automation re-checks the findings → Slack buttons (Approve / Reject / Improve) → the decision is recorded once in `plug_decisions`.

- **Live tests (published plugs):** the queue row's Developer Hub URL (or the plug name) is matched to a published app. The hosted app runs every *read* action and fetches one event per trigger on a test connection, and the results go into the audit and the Slack message. Write actions are never run. A failed live read is a blocking finding quoted with the real error; a missing connection or skipped test is reported as unverified, never as a reject.
- Reject runs without a click only when the audit and the re-check both say reject.
- Approve and Improve wait for a click. They record a status but change nothing in Developer Hub: the agent only reads it (read-only by design), and applying fixes or granting publish access is not built yet.
- With no plug definition, nothing is audited or auto-rejected: the reviewer decides.

## Choosing accounts

Slack and viaSocket Table each have a dropdown listing every connected account (for example the Slack workspace or the Table database). Pick one to make it active, or choose "Connect another account…". Old connections are kept. Switching clears the saved channel, team leader and table picks, because they belong to the old account; pick them again and save so the automations use the new account. Saving checks that the chosen tables have the required columns. To use a different login, use the **Use a different login** link under the app: the sign-in popup always uses the account the browser is already signed into and the agent cannot change that, so the connection is made in a private window. The page notices the new account within a few seconds and offers **Use this account**. After switching, the pickers preselect `plug_decisions` and `plug_queue` if the new account already has them, and a **Required table columns** box lists what to create otherwise (with a **Check** button). Accounts that are not in use can be removed.

## Review criteria and learning

The verdict is decided by rule (`src/review/criteria.js`, `verdict.js`), not by the AI's judgement. The AI only reports findings with evidence; code applies the rules.

- **Reject** (any one, with evidence): R1 a live run fails because of the plug (SaaS-side failures are not counted); R2 a parameter in the API docs is missing from the action; R3 the error component is not imported; R4 code validation is not handled.
- **Improve**: I1 label or placeholder missing; I2 help missing or badly written; I3 a text field that should be a dropdown; I4 other UX/UI problems. Improve comes with a ready-to-apply patch (proposed labels, placeholders, help).
- **Approve** only when nothing is found **and** every reject check was actually assessed. R3 and R4 run on the plug's real code read from Developer Hub; when that code cannot be read (the plug is not in the org, the name is ambiguous, or the token expired) they are "not assessed", and a clean plug is reported as **incomplete**, never approve.
- Live failures are classified by whose fault they are (`plug`, `saas`, `unknown`). Only the plug's own failures can reject; unclear ones go to a person.

**Points.** The agent earns +1 when the final decision matches its recommendation and loses 2 when the reviewer overrules it. Automatic rejects wait on the dashboard for Correct (+1) or Wrong (-2). Scores come from the decisions table the core already writes, so the decision flow is untouched. Nothing is scored for an `incomplete` review (it made no claim), and decisions that existed when learning first started are not scored.

**Lessons.** Each overrule is turned into one short correction (AI-written, validated) that is added to the next reviews' prompt. Lessons may only adjust the judgement checks (R2, I3, I4); an overrule of a hard rule is flagged for a person and never softens the rule. Each lesson earns and loses points of its own and retires itself at -4; any lesson can be switched off. State is in `DATA_DIR/learning.json` (not backed up).

**Testing changes to the core safely.** The viaSocket flows are shared with the hosted app, so a code branch alone does not isolate them. Run `STAGING=1 PORT=3001 APP_PASSWORD=... node --env-file=.env src/server.js` and save settings on it: it creates separate `STAGING:` flows and its own settings and learning files, with no queue trigger. Offline tests: `node scripts/criteria-test.mjs`, `node scripts/learning-test.mjs`; `scripts/lesson-ai-test.mjs` runs the real AI lesson writer.

## Developer Hub (read only)

With `DEVHUB_ORG`, `DEVHUB_TOKEN` and `DEVHUB_API_BASE` set, the agent reads the plug under review from Developer Hub (`src/devhub.js`). **It can only issue GET requests: nothing in this agent changes a plug.** The token is a Developer Hub session token (the `proxy_auth_token` header of requests to `https://flow-api.viasocket.com`, not `dev-api`); it expires, and then plug code shows as "not assessed" until it is replaced.

- The plug is found by the Developer Hub id in the queue row's URL, then by the catalog id, then by an exact name. If two plugs share the name the agent does not guess: it says so and a person decides.
- **R3 and R4 run on the plug's real code** (`src/review/codechecks.js`), following viaSocket's own review rules: `errorComponent` awaited in the catch and every component used is mapped (R3); the code parses, runs inside try/catch, validates required inputs before the request, reads only inputs a field defines, and builds no credentials by hand (R4). Missing optional chaining is an improve-level note (I4), not a reject. Constant sample payloads, `authData` inside a URL, and required fixed-choice dropdowns are not flagged.
- A draft or private plug (not in the public catalog) now gets a real definition from Developer Hub, so the schema checks (I1 to I3) and the docs comparison (R2) run on it. Live runs for such plugs (R1) are not built yet and are reported as not assessed.
- A same-named public app is never used in place of the plug under review.

## Reviewing one action or trigger

The submit form has a **Developer Hub link** field. Open an action or trigger in Developer Hub and paste its address (`…/developer/<org>/plugin/<plugId>/<action|trigger>/<id>?versionId=…`): **only that operation is reviewed** (its code, its fields, its live run if it is published), and if the link names a version, that version. A link to the whole plug (`…/analytics`) reviews all of it. A link for another org is refused, and a link to an action that is not in the plug stops the review with the reason. The decision records show "Plug › Action" and use a key per operation, so two actions of one plug do not block each other.

**API docs are optional.** Order of preference: the link you submitted; a doc link stored with the plug in Developer Hub (only AI-created plugs have one); otherwise a web search for that operation, accepted only if the page is on the provider's own domain and answers. Every review says where the docs came from and how sure it is. Docs found with low confidence are never used to reject: R2 is reported as "not assessed" instead. Docs are not stored on actions in Developer Hub, so the search is needed for most plugs.

If the embed AI endpoint reports "Plan credits are exhausted", the shared AI helper (`src/review/ai.js`) falls back to the built-in Run AI Model action. Free-text add-on requests (`src/addons/analyze.js`) do not use it yet; the ready-made add-ons need no AI.

## Add-ons

Users can build on top of the review agent without changing it. Pick a ready-made add-on (decision digest, reject alert, developer summary) or describe one in plain words. The agent turns the words into a small spec (AI), then checks it against reality in plain code: does the data exist, are the apps connected, is it something it can build. It shows a verdict (I can build this / part of this / I can't, and why) and builds nothing until the user approves. Then: preview (computed from the real decisions table and double-checked), send a test, turn on.

- Add-ons only **read** the decisions table and send a message. They never write to the core's tables or flows. They run as their own viaSocket automations (`Add-on: …`), kept in `DATA_DIR/addons.json`, and can be paused, resumed, deleted, or all paused at once.
- Add-ons are built from vetted step templates. The AI only fills in parameters, it never writes code.
- "Check for problems" reads an add-on's recent runs. viaSocket's run history does not keep an app's own error text, so the cause is found by checking the likely culprits (connection, channel, table) with read-only probes.
- Limits: output goes to Slack only for now (other apps are reported, not built); no writing into other apps; 2,000 decision rows are read per run; schedule times follow viaSocket's schedule time zone.
- Safety nets: `node --env-file=.env scripts/core-check.mjs baseline` then `compare` proves the core automations are byte-for-byte unchanged. `scripts/addon-run-test.mjs` and `scripts/addon-diagnose-test.mjs` run an add-on's real steps in viaSocket and break one on purpose.

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

- Live tests need a published plug and a test connection made in the browser. Draft and private plugs are not run live yet (not built; Developer Hub's dry-run endpoint could do it).
- Required free-text inputs are never invented, so an action that needs them is reported as not run.
- Intake is polled, so a queue row starts a review about two minutes later.
- Data in `DATA_DIR` is not backed up.
