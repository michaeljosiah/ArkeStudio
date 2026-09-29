# Settings voice browser

## Settings catalogue browser (design master turn 176, 2026-09-29)

The Settings narrator picker searches the complete catalogue by name, description and supplied
attributes, and intersects that query with source, provider, language, accent, gender and style
filters. Facets preserve provider labels; missing metadata is never inferred from a voice's name
or sound. Unsupported facets are omitted and mixed catalogues offer “Not specified”. Result and
facet counts refer to the complete loaded source, including every provider page. Provider failures
remain visible with Retry rather than silently becoming empty lists.

Play and Select are independent. The saved narrator is Current, the pending choice is Selected,
and filtering preserves that choice even outside the results. Only Use saves it. Escape, Cancel
and close discard the pending choice, stop its audio and ignore late preview results.

Previews work without a world or sheet. Prefer a supplied public provider sample (labelled as
such; providers may use different words). Otherwise a supported narrator synthesizes the fixed
`NARRATOR_PREVIEW_TEXT`, with the price visible before the explicit press. Nothing generates on
open, selection or filtering. Kokoro previews remain local and unmetered; cloud synthesis uses
the ordinary durable job queue and ledger under the explicit `app:voice-previews` scope, not a
placeholder world. Reconciliation and spend rules apply unchanged. Requests cap the authorized
price; a higher current quote refuses and asks for a refresh.

Validated audio is cached below the app root's `voice-previews/audio`, keyed by the provider,
model, voice, sample URL or sentence, format and cache version. The authenticated
`/voice-preview-media/<hash>.<format>` endpoint serves only those audio files. Provider samples
are fetched by the coordinator without credentials, with a bounded size, timeout, approved
public host and no redirects. The renderer receives no additional network permissions.

Loading, sample failure, unavailable preview and empty results are distinct. One clip sounds at
a time through the shared player. Filters and close cancel outstanding preview requests; a
submitted cloud request may already have incurred its stated charge. The modal contains keyboard
focus, restores focus on close, announces result counts, and wraps controls on narrow screens.


Settings previews use the durable app:voice-previews job and ledger scope. They do not require an open world and are never adopted into one.

Gemini catalogue rows come from every page of Google's `GET /v1beta/voices?type=prebuilt`
library, limited to models available on the active key. The provider's language, accent,
gender and persona populate the filters; context, pitch and description remain searchable.
Missing metadata stays unspecified. Search also matches provider and model names, so “Gemini”
finds Google voices. Extended presets are verified against the live library before synthesis;
custom project voices still require their separate verified binding.

Protocol reference: https://ai.google.dev/api/voices (checked 2026-09-29).
