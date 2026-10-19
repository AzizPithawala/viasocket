# Plug review criteria (default — edit to match your real checklist)

1. Auth type matches the app's official docs (API key vs OAuth 2 vs Basic); credential header/format correct.
2. A connection test endpoint and connection label exist.
3. Every action/trigger maps to a documented endpoint; method, path and required params match the docs.
4. Required fields are marked required; no invented or undocumented params.
5. IDs the user would otherwise copy from the app are dropdowns, not free text (except DELETE).
6. Names: actions "[Verb] [Object]"; triggers start with New/Updated/Deleted; descriptions <= 120 chars.
7. Help text is short and starts with "Enter" or "Select".
8. Sample data is realistic and matches the real response shape.
9. Triggers have subscribe and unsubscribe (webhook) or a deduplicating window (polling).
10. No secrets or auth headers built in code; errors surfaced readably.

Verdict rules:
- approve: all criteria met, no blocking gaps.
- improve: fixable gaps (naming, help text, missing dropdowns, sample data) with no wrong behavior.
- reject: wrong auth, wrong endpoints, missing core operations, or broken behavior that needs rework by the developer.
