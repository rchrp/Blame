# Blame supplemental model catalog

Small, provider-specific additions bridge the gap between a provider release and
the model catalog bundled by Cline. Both the API worker and the agent runtime use
this package. It has no runtime dependencies and does not mutate Cline's registry.

## Add a model

1. Add a module in `src/models/` exporting `SupplementalModel[]`. Specify the exact
   provider ID, model ID, capabilities, supported reasoning levels, token limits,
   source and verification date. Copy `gpt-6-astra.ts` as an example. Declare each
   provider separately: API and subscription limits need not match.
2. Import its entries into `supplementalModels` in `src/index.ts`.
3. Run `pnpm --filter @blame/model-catalog test` and the runtime integration test
   `supplemental-model-config.test.js` after building `@blame/agent-runtime`.
4. Rebuild/restart the API and desktop/runtime that consume the catalog. Additions
   are versioned source modules, not user-editable database rows or hot reloads.

An entry applies only when its **exact provider/model pair** is absent from Cline.
When Cline supplies it, the official entry replaces the entire fallback, including
deprecation status and removed fields. No cleanup deployment or global registration
is needed to retire a fallback. `enabled: false` disables an entry manually;
`supplementalModelStatus` exposes `active`, `official` or `disabled` for inspection.
The original entry can remain as documented history. Duplicate active entries fail.

The API's existing catalog hash invalidates persisted snapshots when the resolved
catalog changes. Its subscription allowlist remains in force; an API alias does
not count as official availability for a subscription provider. Direct live
provider metadata takes priority over a fallback for that same provider.

The API also stores the complete Cline metadata of every catalog model, from its
bundled Cline release and the live catalog, and serves one entry at
`GET /api/v1/providers/catalog/model?providerId=…&modelId=…`. When a desktop
session starts with a model its bundled Cline registry does not know, the runtime
fetches that entry alongside the credential and applies it like a supplemental
model. A bundled supplemental entry remains the offline fallback.

`appendProductionConfig` passes missing model metadata through Cline's serializable
`knownModels` field. This covers the main agent, utility sessions and remote hub
starts without modifying Cline's installed packages. Explicit session overrides
keep priority. Existing sessions retain their start configuration; newly started
sessions pick up the installed catalog. Provider authorization still applies.

## GPT-6 Astra

API characteristics: [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra),
verified September 10, 2026. The API context is 1,050,000 tokens with up to 128,000
output tokens; the input budget reserves those output tokens.

For `openai-codex`, Codex model discovery on that date advertises a maximum context
of 872,000 tokens (272,000 by default) and a 95% effective input budget. Blame uses
the maximum with that margin, or 828,400 input tokens. It does not assign API
token prices to a ChatGPT subscription. The temporary entries expose `low`,
`medium`, `high` and `xhigh`: Cline 0.0.82 silently rewrites `max` to `xhigh`, so
the fallback does not advertise a distinct `max` mode. Codex's `ultra` mode also
includes orchestration that Cline does not implement. The integration test
captures a real Cline handler request offline to
verify the model ID, image input, tools and reasoning configuration.
