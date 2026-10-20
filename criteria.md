# Plug review criteria

Generated from `src/review/criteria.js`. Edit that file, then run `node scripts/write-criteria-md.mjs`.

| id | outcome | criterion | checked by | kind |
| --- | --- | --- | --- | --- |
| R1 | reject | A live run fails because of our side | live run | hard rule |
| R2 | reject | A documented field is missing from the action | API docs | judgement (lessons may adjust) |
| R3 | reject | The error component is not imported | plug code (Developer Hub) | hard rule |
| R4 | reject | Code validation is not handled | plug code (Developer Hub) | hard rule |
| I1 | improve | A label or placeholder is missing | schema | hard rule |
| I2 | improve | Help is missing or badly written | schema | hard rule |
| I3 | improve | A text field should be a dropdown | schema + judgement | judgement (lessons may adjust) |
| I4 | improve | Other UX / UI problems | judgement | judgement (lessons may adjust) |

## Text the reviewer AI reads

```
REJECT if any of these is found, with evidence:
R1 A live run fails because of our side: A live run fails because of the plug: bad request, wrong endpoint, wrong auth handling, or an error in the plug code. A failure on the SaaS side (5xx, rate limit, outage, plan or account limits) is NOT counted.
R2 A documented field is missing from the action: A parameter the API docs list for this operation is missing from the action's fields.
R3 The error component is not imported: The error component is not imported or mapped in the action or trigger code.
R4 Code validation is not handled: Code validation is not handled: no required-field checks, no try/catch around requests, or unvalidated inputs.

IMPROVE if any of these is found (and no reject criterion):
I1 A label or placeholder is missing: A field has no label, or no placeholder where its type needs one.
I2 Help is missing or badly written: Help is missing, or does not start with Enter (text fields) or Select (choices), or is long or technical.
I3 A text field should be a dropdown: A free-text string field holds something the user would otherwise copy from the app (an ID) or choose from fixed values, so it should be a dropdown.
I4 Other UX / UI problems: Other UX or UI problems: naming, field order, grouping, long descriptions, unclear wording.

APPROVE only when nothing above is found and every reject criterion was actually checked.
Report findings only for R2, I3 and I4; the rest are checked by code. Every finding needs a short quote or fact from the docs or the plug as evidence. Do not choose the verdict yourself.
```
