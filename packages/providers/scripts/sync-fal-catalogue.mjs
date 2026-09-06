/**
 * Regenerate the FAL half of the shipped manifest from fal's own catalogue.
 *
 *   node packages/providers/scripts/sync-fal-catalogue.mjs
 *
 * Why a script and not a hand-written table: the hand-written one was wrong. It called a model
 * "Seedance 2.0" while pointing at the v1 route, priced everything from memory, and listed
 * three models out of fourteen hundred. `https://fal.ai/api/models` is public and needs no key,
 * so the route ids and the prices can come from the place that charges them.
 *
 * What the API does NOT say is what a model accepts — reference images, start and end frames,
 * durations, resolutions. Those stay in CURATED below, written by hand, because guessing them
 * would put wrong promises in front of a dispatch. The script merges the two and refuses to
 * emit a model whose price it could not read: an unpriced model cannot be estimated, and
 * estimating before spending is the whole point of the manifest.
 *
 * `maxPromptChars` is the exception that proves it: the catalogue API is silent, but each route
 * publishes its own JSON schema — no key needed — and where the provider enforces a length it is
 * declared there:
 *
 *   https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<route>   →  input.prompt.maxLength
 *
 * So the caps below are transcribed from that, not chosen. A route whose schema declares none is
 * left without one deliberately: the composer then shows no counter, which is the honest reading
 * of "the provider does not say" — and is not the same as an unlimited prompt.
 */

const API = "https://fal.ai/api/models";

/**
 * The models we offer. Deliberately short — fourteen hundred routes is a search problem, not a
 * dropdown — and every line here is a decision about what the studio is for.
 */
const CURATED = {
  "fal-ai/flux-2-pro": {
    id: "flux-2-pro",
    capability: "image",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {
      resolutions: ["1MP", "2MP", "4MP"],
      tiers: { "1K": "1MP", "2K": "2MP", "4K": "4MP" },
      aspects: ["16:9", "9:16", "1:1", "4:3"],
    },
  },
  "fal-ai/nano-banana-2": {
    id: "nano-banana-2",
    capability: "image",
    // Siblings, not separate models: the base route is text-only, `/edit` takes `image_urls`.
    // Dispatch picks between them by whether the job carries references, so the studio offers
    // one "Nano Banana 2" rather than two half-models.
    //
    // referenceImages: the edit schema declares `image_urls` with no maxItems, so there is no
    // number to read. 3 is deliberately low — it matches Google's published guidance for
    // subject images, and an under-promise costs a dropped reference while an over-promise
    // costs a dispatch that dies after the estimate was accepted. Raise it from a live call,
    // not from a guess.
    editRoute: "fal-ai/nano-banana-2/edit",
    accepts: { referenceImages: 3, startFrame: false, endFrame: false },
    // The route also offers 0.5K and the extreme 8:1/1:8 ratios. Both are left out on purpose:
    // resolutions[0] is what every job gets until the resolution picker exists, so 0.5K first
    // would silently halve every image, and nothing in the studio dispatches a 8:1 frame.
    limits: {
      maxPromptChars: 50000,
      resolutions: ["1K", "2K", "4K"],
      tiers: { "1K": "1K", "2K": "2K", "4K": "4K" },
      aspects: ["21:9", "16:9", "3:2", "4:3", "1:1", "4:5", "3:4", "2:3", "9:16"],
    },
  },
  "fal-ai/nano-banana-pro": {
    id: "nano-banana-pro",
    capability: "image",
    editRoute: "fal-ai/nano-banana-pro/edit",
    accepts: { referenceImages: 3, startFrame: false, endFrame: false },
    limits: {
      maxPromptChars: 50000,
      resolutions: ["1K", "2K", "4K"],
      tiers: { "1K": "1K", "2K": "2K", "4K": "4K" },
      aspects: ["21:9", "16:9", "3:2", "4:3", "1:1", "4:5", "3:4", "2:3", "9:16"],
    },
  },
  "openai/gpt-image-2": {
    // The id is suffixed because manifest ids are unique across providers and `gpt-image-2` is
    // the OpenAI-direct row. Both display as "GPT Image 2" behind their provider's name, so the
    // suffix is visible only in code. This is the pattern for any model two gateways host.
    id: "gpt-image-2-fal",
    // fal titles the route "GPT Image 2 API". The API part is fal's, not the model's, and the
    // picker already says which provider it is reached through.
    displayName: "GPT Image 2",
    capability: "image",
    editRoute: "openai/gpt-image-2/edit",
    // The edit schema declares `image_urls` with maxItems 16, matching the OpenAI direct route.
    accepts: { referenceImages: 16, startFrame: false, endFrame: false },
    // The base route takes a free width/height rather than a tier enum, so there are no native
    // words to map 1K/2K/4K onto. Left without tiers on purpose: offering a size the request
    // cannot carry would be a control that changes nothing.
    limits: {
      maxPromptChars: 32000, aspects: ["16:9", "3:2", "1:1", "2:3", "9:16"] },
    /**
     * fal bills this in tokens, and the token count is not knowable before dispatch. These are
     * the counts the estimate assumes, set above the largest published per-image figure we could
     * find for this family (4,160 tokens for a 1024×1024 high-quality render) so the estimate is
     * a ceiling. They are the one unverified number in this row: the first real invoice settles
     * them, and manifest drift flags the row if the estimates keep missing what was billed.
     */
    tokenAssumption: {
      assumedTextInputTokens: 500,
      assumedImageInputTokensPerReference: 1500,
      assumedImageOutputTokensPerImage: 6500,
    },
  },
  // No frames on any of these: they are text-to-video routes, and their schemas declare no image
  // or frame field at all (#154). The flags were inert — nothing in dispatch ever sent a frame —
  // but the picker printed "frames" from them and the dialog warned about shots that lacked one.
  // Carrying a start frame means dispatching to the image-to-video siblings instead, which is
  // its own piece of work.
  // Durations are the route's own enum, read from its schema: fal video routes take a string
  // from a fixed list, never a number of seconds, and the lists differ per family.
  // https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.0/text-to-video
  "bytedance/seedance-2.0/text-to-video": {
    id: "seedance-2.0",
    capability: "video",
    family: "seedance",
    // Exercised end to end for the character speaking sample (issue 858): a face in,
    // a spoken reference script out. The only two routes that judgement was ever made
    // about — it used to be an id list in code; it is a described fact here now.
    speechVideo: "verified",
    // SPEC-019 T-1: on this provider a task mode is a ROUTE, not a field — text-to-video,
    // image-to-video and reference-to-video are siblings and the endpoint decides the task. No
    // sentinel is declared for the locked ratio: 2.0's spelling for it is unverified, and
    // omitting the parameter is the safe reading of "send no chosen value". The 2.5 rows, whose
    // sentinel is "auto" and whose aspect range is continuous, land with the next catalogue sync.
    modes: {
      generate: { locked: [] },
      "first-frame": { route: "bytedance/seedance-2.0/image-to-video", locked: ["aspect"] },
      "first-and-last-frame": { route: "bytedance/seedance-2.0/image-to-video", locked: ["aspect"] },
    },
    editRoute: "bytedance/seedance-2.0/reference-to-video",
    // "Refer to them in the prompt as @Image1, @Image2" — references, not keyframes.
    accepts: { referenceImages: 9, startFrame: false, endFrame: false },
    limits: {
      maxReferenceVideoSec: 15,
      maxReferenceAudioSec: 15,
      referencesField: "image_urls",
      soundChoice: true,
      durationAuto: true,
      maxDurationSec: 15,
      durations: { "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "10": "10", "11": "11", "12": "12", "13": "13", "14": "14", "15": "15" },
      resolutions: ["720p", "1080p"],
      aspects: ["16:9", "9:16", "1:1"],
      // SPEC-019 R-23: panels this family reads reliably. Past it the documented failure is a
      // still output or panels rendered out of order.
      storyboardPanels: 15,
    },
  },
  "bytedance/seedance-2.0/fast/text-to-video": {
    id: "seedance-2.0-fast",
    capability: "video",
    family: "seedance",
    // Exercised end to end for the character speaking sample (issue 858): a face in,
    // a spoken reference script out. The only two routes that judgement was ever made
    // about — it used to be an id list in code; it is a described fact here now.
    speechVideo: "verified",
    // SPEC-019 T-1: on this provider a task mode is a ROUTE, not a field — text-to-video,
    // image-to-video and reference-to-video are siblings and the endpoint decides the task. No
    // sentinel is declared for the locked ratio: 2.0's spelling for it is unverified, and
    // omitting the parameter is the safe reading of "send no chosen value". The 2.5 rows, whose
    // sentinel is "auto" and whose aspect range is continuous, land with the next catalogue sync.
    modes: {
      generate: { locked: [] },
      "first-frame": { route: "bytedance/seedance-2.0/fast/image-to-video", locked: ["aspect"] },
      "first-and-last-frame": { route: "bytedance/seedance-2.0/fast/image-to-video", locked: ["aspect"] },
    },
    editRoute: "bytedance/seedance-2.0/fast/reference-to-video",
    accepts: { referenceImages: 9, startFrame: false, endFrame: false },
    // The fast route tops out at 720p — its schema offers 480p and 720p only. It was listed at
    // 1080p, a size it cannot make, which the picker offered and the price list charged for.
    limits: {
      maxReferenceVideoSec: 15,
      maxReferenceAudioSec: 15,
      referencesField: "image_urls",
      soundChoice: true,
      durationAuto: true,
      maxDurationSec: 15,
      durations: { "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "10": "10", "11": "11", "12": "12", "13": "13", "14": "14", "15": "15" },
      resolutions: ["720p"],
      aspects: ["16:9", "9:16"],
      // SPEC-019 R-23: panels this family reads reliably. Past it the documented failure is a
      // still output or panels rendered out of order.
      storyboardPanels: 15,
    },
  },
  /*
   * Seedance 2.5, probed 2026-08-23 — the sync the 2.0 rows above said was coming.
   *
   * AFTER 2.0 on purpose. `modelForCapability` falls back to the first video row in manifest
   * order when `settings.routing.video` is unset, so putting the newer model first would move
   * every install that never chose one from 2.0 to 2.5 — a different skill and 473000 against
   * 303400 micro-dollars a second, decided by a catalogue edit rather than by anybody.
   *
   * Every figure here is read from the route's own schema, not carried across from 2.0, because
   * the two disagree in ways that matter: 2.5 runs to **thirty** seconds where 2.0 stops at
   * fifteen, drops 4k, gains `end_image_url` on its image sibling, and takes reference audio and
   * video of 1.8–30.2s where 2.0 declares fifteen. A season written for one is not a season
   * written for the other, which is why the skill is per family and this row is not a copy.
   *
   * No sentinel, though 2.5 finally has a spelling for one. Two reasons and either is enough:
   * `applyLockedSize` in locked-modes.ts is the only thing that would insert it and nothing calls
   * it — the compiler filters the locked aspect out and never puts a value back — so declaring
   * one here would claim behaviour the dispatch does not have. And it would buy nothing if it
   * did: the route declares `aspect_ratio` with a default of `"auto"`, so omitting the field and
   * sending `"auto"` are the same request.
   */
  "bytedance/seedance-2.5/text-to-video": {
    id: "seedance-2.5",
    capability: "video",
    family: "seedance",
    modes: {
      generate: { locked: [] },
      "first-frame": { route: "bytedance/seedance-2.5/image-to-video", locked: ["aspect"] },
      "first-and-last-frame": { route: "bytedance/seedance-2.5/image-to-video", locked: ["aspect"] },
    },
    editRoute: "bytedance/seedance-2.5/reference-to-video",
    // "Refer to them in the prompt as @Image1, @Image2" — the route's own words.
    //
    // Both frame flags stay false, as on every fal video row: they describe THIS route, and this
    // route is text-to-video with no image field. `end_image_url` is real but it belongs to the
    // image sibling, and the way a row says "I can close on a frame" is the task mode above —
    // which is what the picker and the dispatch dialog both read (issue 154). Setting the flag
    // here instead would promise a frame on the route that cannot take one.
    accepts: { referenceImages: 9, startFrame: false, endFrame: false },
    limits: {
      // "Each file must be 1.8 to 30.2 seconds" — the route's own bound, on both audio and video.
      maxReferenceVideoSec: 30,
      maxReferenceAudioSec: 30,
      referencesField: "image_urls",
      soundChoice: true,
      durationAuto: true,
      maxDurationSec: 30,
      durations: Object.fromEntries(
        Array.from({ length: 27 }, (_, i) => String(i + 4)).map((n) => [n, n]),
      ),
      // 720p first because it is the route's default and the rate read from fal's prose is the
      // 720p one: leading with 480p highlights a size the request would not carry and prices the
      // wrong number under it. No 4k on this family — the enum is three deep where 2.0's is four.
      resolutions: ["720p", "1080p", "480p"],
      aspects: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      // Carried from 2.0 rather than measured: the panel ceiling is a property of how the family
      // reads a board, and nothing in 2.5's schema speaks to it. Revise when a run says otherwise.
      storyboardPanels: 15,
    },
  },
  /*
   * Veo 3.1, and the only family here that can extend footage (SPEC-019 R-50, T-31).
   *
   * `extend-video` is a sibling route in exactly the sense T-1 established, so continuation is a
   * route like every other mode. Its schema was read on 2026-08-27, and it disagrees with the
   * text route it sits beside in three ways that would each have been wrong to carry across:
   *
   *   - `duration` accepts exactly "7s", where the text route enumerates 4s/6s/8s. The mode's
   *     duration contract below keeps planning, pricing and the paid request on that value.
   *   - `aspect_ratio` gains an "auto" member and defaults to it, because the footage being
   *     extended already has a shape. Hence `locked: ["aspect"]` with "auto" as the sentinel —
   *     the one route shipped here that genuinely wants a value in a locked parameter's place.
   *   - `video_url` is required. That is the input the whole capability turns on, and four
   *     extend routes from four vendors spell it the same way, which is why the transport holds
   *     that name as a constant instead of the manifest holding it as data.
   */
  "fal-ai/veo3.1": {
    id: "veo-3.1",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    modes: {
      generate: { locked: [] },
      continue: {
        route: "fal-ai/veo3.1/extend-video",
        locked: ["aspect"],
        sentinels: { aspect: "auto" },
        maxDurationSec: 7,
        durations: { "7": "7s" },
      },
    },
    // Veo counts in "4s"/"6s"/"8s" and takes nothing between them.
    limits: {
      maxPromptChars: 20000,
      soundChoice: true,
      maxDurationSec: 8,
      durations: { "4": "4s", "6": "6s", "8": "8s" },
      resolutions: ["720p", "1080p"],
      aspects: ["16:9", "9:16"],
    },
  },
  "fal-ai/veo3.1/fast": {
    id: "veo-3.1-fast",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    modes: {
      generate: { locked: [] },
      continue: {
        route: "fal-ai/veo3.1/fast/extend-video",
        locked: ["aspect"],
        sentinels: { aspect: "auto" },
        maxDurationSec: 7,
        durations: { "7": "7s" },
      },
    },
    limits: {
      maxPromptChars: 20000,
      soundChoice: true,
      maxDurationSec: 8,
      durations: { "4": "4s", "6": "6s", "8": "8s" },
      resolutions: ["720p"],
      aspects: ["16:9", "9:16"],
    },
  },
  // ---- minimax H3 -------------------------------------------------------
  // The three siblings are one model: text-to-video generates, image-to-video takes a start
  // frame (`image_url`) and optionally an end one (`end_image_url`), reference-to-video takes
  // up to nine `reference_image_urls`. That last name is why framesField exists — seedance's
  // reference route calls the same array `image_urls`.
  "minimax/h3/text-to-video": {
    id: "minimax-h3",
    displayName: "MiniMax H3",
    capability: "video",
    family: "minimax-h3",
    // The reference route describes its images as "referenced in the prompt as Image 1,
    // Image 2" — which is this studio's own token vocabulary, not a sequence of keyframes the
    // shot passes through. A job carrying references dispatches there instead of the text route.
    editRoute: "minimax/h3/reference-to-video",
    accepts: { referenceImages: 9, startFrame: false, endFrame: false },
    // Priced per second by resolution and the route's own default is 2K, so the base rate is
    // 2K's — an estimate computed at 480P's rate would understate every unpicked job by 2.6x.
    defaultResolution: "2K",
    modes: {
      generate: { locked: [] },
      // image-to-video declares no aspect_ratio at all: the frame decides the shape.
      "first-frame": { route: "minimax/h3/image-to-video", locked: ["aspect"] },
      "first-and-last-frame": { route: "minimax/h3/image-to-video", locked: ["aspect"] },
    },
    limits: {
      maxPromptChars: 50000,
      // The reference route's own allowances: 9 images, 3 videos and 3 audio clips, each 2-15s
      // with a combined 15s ceiling. Audio and video are budgeted in seconds because that is
      // what the route limits.
      maxReferenceVideoSec: 15,
      maxReferenceAudioSec: 15,
      referencesField: "reference_image_urls",
      // The same route reads up to three clips, 2-15 s each, in this array (issue 852). Naming
      // the field is what lets a clip ride at all: the budget refuses video on a row that
      // publishes seconds but no field, because there would be nowhere to put the bytes.
      referenceVideoField: "reference_video_urls",
      maxDurationSec: 15,
      // duration is an integer 5..15 on this route, not a string out of a list.
      durationWire: "number",
      durations: { 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", 13: "13", 14: "14", 15: "15" },
      resolutions: ["2K", "480P", "768P", "4K"],
      aspects: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    },
  },
  // ---- LTX --------------------------------------------------------------
  // Dropped 2026-08-28: the 2.5 rows (`lightricks/ltx-2.5/text-to-video/{pro,fast}`) came out of
  // the catalogue when local H3 took the fast-and-cheap video slot, and Lightricks has a
  // successor release the studio will curate instead once it is worth having. Two things worth
  // keeping from that curation when it returns: fal titled both 2.5 routes with one display
  // string (rows need their own names to be pickable), and the fast route was billed for "4K"
  // while dispatching "2160p" — `priceAliases` below exists for exactly that bridge and has no
  // live subject until an LTX row is back.
  // ---- wan 2.7 ----------------------------------------------------------
  "fal-ai/wan/v2.7/text-to-video": {
    id: "wan-2.7",
    // "Wan Text to Video" names no version, and the catalogue carries 2.1 through 2.7.
    displayName: "Wan 2.7",
    capability: "video",
    family: "wan",
    editRoute: "fal-ai/wan/v2.7/reference-to-video",
    // This route publishes no maxItems on reference_image_urls, so 4 is a deliberate
    // under-promise in the nano-banana pattern: a dropped reference costs less than a dispatch
    // that dies after the estimate was accepted. Raise it from a live call, never from a guess.
    accepts: { referenceImages: 4, startFrame: false, endFrame: false },
    defaultResolution: "1080p",
    modes: {
      generate: { locked: [] },
      "first-frame": { route: "fal-ai/wan/v2.7/image-to-video", locked: ["aspect"] },
      "first-and-last-frame": { route: "fal-ai/wan/v2.7/image-to-video", locked: ["aspect"] },
    },
    limits: {
      referencesField: "reference_image_urls",
      // The two routes disagree about length (probed 2026-08-16): text-to-video declares
      // duration 2–15, reference-to-video 2–10. The row's `durations` come from the text route,
      // so the reference ceiling is stated separately and the composer shortens the track when
      // a reference is attached.
      maxReferenceDurationSec: 10,
      // The wan 2.7 schema declares no maxLength on prompt, so no counter is offered: "the
      // provider does not say" is not the same as "unlimited".
      maxDurationSec: 15,
      durationWire: "number",
      durations: { 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", 13: "13", 14: "14", 15: "15" },
      resolutions: ["1080p", "720p"],
      aspects: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    },
  },
  "fal-ai/kling-video/v3/pro/text-to-video": {
    id: "kling-3-pro",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    // No resolutions at all: the kling v3 text-to-video schema has no resolution field, so a
    // size listed here was offered in the picker and sent as a word the route does not know.
    limits: {
      maxPromptChars: 2500, soundChoice: true, maxDurationSec: 15, durations: { "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "10": "10", "11": "11", "12": "12", "13": "13", "14": "14", "15": "15" }, aspects: ["16:9", "9:16", "1:1"] },
  },
  "fal-ai/kling-video/v3/standard/text-to-video": {
    id: "kling-3-standard",
    capability: "video",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: {
      maxPromptChars: 2500, soundChoice: true, maxDurationSec: 15, durations: { "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9", "10": "10", "11": "11", "12": "12", "13": "13", "14": "14", "15": "15" }, aspects: ["16:9", "9:16"] },
  },
  // ---- music ------------------------------------------------------------
  // The route id carries no `fal-ai/` prefix — it is `minimax/music-3`, the same shape as the H3
  // rows above. Worth stating because most families here do carry the prefix, and a wrong guess
  // is a 404 at dispatch, long after the estimate was shown and accepted.
  "minimax/music-3": {
    id: "minimax-music-3",
    capability: "music",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    /**
     * Transcribed from the model page, which publishes the rate twice — as prose ("Your request
     * will cost $0.002 per second") and as a structured record
     * (`endpointBilling: { billing_unit: "seconds", price: 0.002 }`). Read 2026-08-17.
     *
     * The catalogue API's row for this route carries no pricing field at all, which is what
     * `priceWhenCatalogueIsSilent` exists for. The moment fal publishes one there, it wins.
     */
    priceWhenCatalogueIsSilent: { kind: "perSecond", microUsdPerSecond: 2000 },
    limits: {
      /**
       * Unlike every video route here, this one takes a *continuous* length: `duration` is a
       * number in 1..300, not a member of a fixed enum. So these are a curated menu rather than a
       * transcription of what the route accepts — the same kind of choice the resolution and
       * aspect lists already are, and made for the same reason: a picker is a short list, not a
       * spinner over three hundred values. They run from a sting to the model's five-minute
       * ceiling, and 60 is the route's own default.
       *
       * What matters is that every one of them is a length dispatch can actually ask for. The
       * estimate is priced per second from the number the user picked, so a length the picker
       * offered but the wire could not carry would price one job and run another.
       */
      durations: {
        "30": "30",
        "60": "60",
        "90": "90",
        "120": "120",
        "150": "150",
        "180": "180",
        "240": "240",
        "300": "300",
      },
      // The schema types `duration` as a number, so the quoted form is rejected.
      durationWire: "number",
      // No maxPromptChars: Music3Input declares no maxLength on `prompt` or `lyrics`, and an
      // invented ceiling would refuse briefs the model would have taken.
    },
  },
};

const money = String.raw`\*{0,2}\$([0-9]+(?:\.[0-9]+)?)\*{0,2}`;

/**
 * Read the price out of fal's own prose. Every pattern here was matched against a real string
 * from the API; anything that does not match returns null and the model is dropped rather than
 * guessed at.
 */
function pricingFrom(text, tokenAssumption, defaultResolution) {
  const clean = (text ?? "").replace(/\s+/g, " ");
  const micro = (s) => Math.round(Number.parseFloat(s) * 1_000_000);

  // "Text tokens (per 1M): **$5.00** input, **$1.25** cached, **$10.00** output. Image tokens
  // (per 1M): **$8.00** input, **$2.00** cached, **$30.00** output."
  //
  // The rates are exact; the token counts are not knowable before dispatch, so a row priced this
  // way must also state what the estimate assumes. Without that annotation the price is dropped
  // rather than half-read — an estimate is the whole point of the manifest.
  const tokenTable = clean.match(
    new RegExp(
      `Text tokens[^$]{0,20}${money}\\s*input[^$]{0,30}${money}\\s*cached[^$]{0,30}${money}\\s*output` +
        `[\\s\\S]{0,60}?Image tokens[^$]{0,20}${money}\\s*input[^$]{0,30}${money}\\s*cached[^$]{0,30}${money}\\s*output`,
      "i",
    ),
  );
  if (tokenTable) {
    if (!tokenAssumption) return null;
    return {
      kind: "perImageToken",
      microUsdPerMillionTextInput: micro(tokenTable[1]),
      microUsdPerMillionImageInput: micro(tokenTable[4]),
      microUsdPerMillionImageOutput: micro(tokenTable[6]),
      ...tokenAssumption,
      // "Total cost is rounded up to the closest hundredth of a cent ($0.0001)" — fal's words.
      roundUpToMicroUsd: /rounded up to the closest hundredth of a cent/i.test(clean) ? 100 : undefined,
    };
  }

  // A per-second table of any length, in either order: "$0.05 per second at 480p, $0.08 per
  // second at 768p" and "for 720p ... $0.09 per second; for 1080p, $0.13" are both this shape.
  // Read whole, because a row that keeps only the first number prices every other resolution
  // wrong — and the price a user is shown before they spend is the whole point of the manifest.
  //
  // The resolution must sit directly after "at"/"for", or directly before the rate. Anything
  // looser paired seedance's 720p rate with the 1080p that happened to follow it.
  const res = String.raw`(\d+[pPkK]|[24][kK])`;
  const forward = [
    ...clean.matchAll(
      new RegExp(String.raw`${money}\s*(?:/|per\s*)second\s*(?:at|for)\s*\**${res}`, "gi"),
    ),
  ].map((m) => [m[2], micro(m[1])]);
  const backward = [
    ...clean.matchAll(new RegExp(String.raw`${res}\**[^.$]{0,30}?${money}\s*(?:/|per\s*)second`, "gi")),
  ].map((m) => [m[1], micro(m[2])]);
  // Forward last, so it wins. Both shapes can match one sentence — "$0.05 per second at 480p,
  // $0.08 per second at 768p" reads correctly forwards and one-off backwards, pairing every
  // resolution with the NEXT price — and the reading anchored on "at"/"for" is the true one.
  const table = new Map([...backward, ...forward].map(([r, rate]) => [String(r).toLowerCase(), rate]));
  if (table.size > 1) {
    // The base is the rate of the route's OWN default resolution: a job that picks nothing is
    // charged that, and basing it on the cheapest tier understates every such job.
    const key = defaultResolution?.toLowerCase();
    const base = (key !== undefined ? table.get(key) : undefined) ?? [...table.values()][0];
    return { kind: "perSecond", microUsdPerSecond: base, byResolution: Object.fromEntries(table) };
  }
  // "For every second of 720p video ... **$0.3034/second** and for 1080p ... **$0.682/second**"
  const perSecondByRes = clean.match(new RegExp(`${money}\\s*/?\\s*second[\\s\\S]{0,80}?1080p[^$]{0,40}${money}`, "i"));
  if (perSecondByRes) {
    return {
      kind: "perSecond",
      microUsdPerSecond: micro(perSecondByRes[1]),
      byResolution: { "1080p": micro(perSecondByRes[2]) },
    };
  }
  if (/every second of/i.test(clean) || /per second/i.test(clean) || /\/second/i.test(clean)) {
    const first = clean.match(new RegExp(money));
    if (first) return { kind: "perSecond", microUsdPerSecond: micro(first[1]) };
  }
  // "**$0.03** for the first megapixel of output"
  const perMegapixel = clean.match(new RegExp(`${money}[^.]{0,30}megapixel`, "i"));
  if (perMegapixel) return { kind: "perMegapixel", microUsdPerMegapixel: micro(perMegapixel[1]) };
  // "Your request will cost **$0.08** per image."
  const perImage = clean.match(new RegExp(`${money}\\s*(?:per|/)\\s*image`, "i"));
  if (perImage) return { kind: "perImage", microUsdPerImage: micro(perImage[1]) };
  return null;
}

/**
 * Re-key a parsed rate table onto the words the picker actually sends.
 *
 * fal's price prose and its schemas disagree about spelling: the ltx fast route is billed for
 * "4K" and dispatched with "2160p"; minimax writes "480p" in prose and "480P" in its enum. A
 * key that is not the wire word is a lookup that misses in silence — the estimate then quietly
 * falls back to the base rate, which is the understatement this table exists to prevent. A rate
 * that matches no offered resolution is dropped and reported rather than carried as noise.
 */
function keyRatesToWireWords(pricing, curated, skipped, route) {
  if (pricing.kind !== "perSecond" || !pricing.byResolution) return pricing;
  const offered = curated.limits.resolutions ?? [];
  const aliases = curated.priceAliases ?? {};
  const out = {};
  for (const [key, rate] of Object.entries(pricing.byResolution)) {
    const wire = aliases[key] ?? offered.find((r) => r.toLowerCase() === key);
    if (wire === undefined) {
      skipped.push(`${route} — a ${key} rate the row offers no resolution for; rate dropped`);
      continue;
    }
    out[wire] = rate;
  }
  return { ...pricing, byResolution: out };
}

async function fetchCatalogue() {
  const items = [];
  let page = 1;
  for (;;) {
    const res = await fetch(`${API}?page=${page}&limit=100`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`fal catalogue: HTTP ${res.status} on page ${page}`);
    const body = await res.json();
    items.push(...(body.items ?? []));
    if (page >= (body.pages ?? 1)) return { items, total: body.total ?? items.length };
    page += 1;
  }
}

const { items, total } = await fetchCatalogue();
const byRoute = new Map(items.map((m) => [m.id, m]));
console.log(`[fal] ${total} models in the catalogue; ${Object.keys(CURATED).length} curated`);

const models = [];
const endpoints = {};
const editEndpoints = {};
/**
 * The cap comes from the lengths, where lengths are declared.
 *
 * Two numbers said the same thing and were free to disagree: `maxDurationSec` packs whole-scene
 * passes, `durations` is what the route can be asked for. A cap above the longest declared length
 * lets packScene build a pass that dispatch then refuses — and the dialog's warning only inspects
 * shots, so nothing says so beforehand. Deriving one from the other removes the disagreement
 * rather than testing for it.
 */
function limitsFor(curated) {
  const declared = Object.keys(curated.limits.durations ?? {}).map(Number);
  if (declared.length === 0) return curated.limits;
  return { ...curated.limits, maxDurationSec: Math.max(...declared) };
}

function modesFor(curated) {
  if (!curated.modes) return undefined;
  return Object.fromEntries(
    Object.entries(curated.modes).map(([mode, spec]) => {
      const declared = Object.keys(spec.durations ?? {}).map(Number);
      return [mode, declared.length === 0 ? spec : { ...spec, maxDurationSec: Math.max(...declared) }];
    }),
  );
}

const skipped = [];
const transcribed = [];
for (const [route, curated] of Object.entries(CURATED)) {
  const live = byRoute.get(route);
  if (!live) {
    skipped.push(`${route} — no longer in the catalogue`);
    continue;
  }
  const read = pricingFrom(live.pricingInfoOverride, curated.tokenAssumption, curated.defaultResolution);
  /**
   * The catalogue API carries no price for every route fal sells. Some models publish their rate
   * only on their own model page — where it appears both as prose and as an `endpointBilling`
   * record — and `pricingInfoOverride` is simply absent on the API's row for them.
   *
   * `priceWhenCatalogueIsSilent` is the hand transcription for exactly that case, and its name is
   * the whole contract: it is consulted only when the API said nothing. A price the API *does*
   * publish always wins, so this can never quietly hold a rate above a cut fal has made — the
   * failure that put MiniMax H3's 768P estimate 33% high. The same doctrine the rest of this
   * script already runs on, one field wider: what the API does not say is curated by hand rather
   * than guessed, and a model with no price from either source is still refused below.
   */
  const parsed = read ?? curated.priceWhenCatalogueIsSilent ?? null;
  if (parsed === null) {
    skipped.push(`${route} — no price we could read from "${(live.pricingInfoOverride ?? "").slice(0, 60)}…"`);
    continue;
  }
  if (read === null) transcribed.push(route);
  const pricing = keyRatesToWireWords(parsed, curated, skipped, route);
  models.push({
    id: curated.id,
    provider: "fal",
    capability: curated.capability,
    displayName: curated.displayName ?? live.title,
    accepts: curated.accepts,
    limits: limitsFor(curated),
    pricing,
    // SPEC-019 R-16: the family selects the authoring skill. Curated, not derived from the id —
    // ids are route names and one family's routes disagree about them ("seedance-2.0" and
    // "seedance-2.0-fast" are one family). A row without one drafts under general guidance.
    ...(curated.family ? { family: curated.family } : {}),
    // SPEC-019 R-32: a task mode is a route on this provider, not a field. Sentinels are data
    // because the vendor API and this aggregator spell the same idea differently ("-1"/"adaptive"
    // vs "auto"). A row with no modes supports generate only, which is what every row meant
    // before this existed.
    ...(curated.modes ? { modes: modesFor(curated) } : {}),
    ...(curated.aspectRange ? { aspectRange: curated.aspectRange } : {}),
    // Issue 858: whether this route's generated speech was exercised end to end. Curated,
    // because nothing on the wire says it — a row that omits it is offered as untested rather
    // than refused, so admitting a new one is a description here rather than a code change.
    ...(curated.speechVideo ? { speechVideo: curated.speechVideo } : {}),
  });
  endpoints[curated.id] = route;
  // An edit route is only emitted when the model also declares it accepts references, so the
  // two can never disagree: a model that says 0 has no reference route to dispatch into.
  if (curated.editRoute && curated.accepts.referenceImages > 0) {
    editEndpoints[curated.id] = curated.editRoute;
  }
}

for (const line of skipped) console.warn(`[fal] skipped ${line}`);
// Loud on purpose. A transcribed price is the one number in this file no fetch will correct, so
// every regeneration should say out loud which rows are running on one and want re-checking
// against the model page.
for (const route of transcribed) {
  console.warn(`[fal] ${route} — price transcribed by hand; the catalogue API publishes none for it`);
}

const banner = `// Generated by packages/providers/scripts/sync-fal-catalogue.mjs — do not edit by hand.
// Route ids and prices come from https://fal.ai/api/models (public, no key). What a model
// accepts is curated in that script, because the API does not say.
// Catalogue size at generation: ${total} models. Regenerate when fal ships something worth having.
`;

const body = `${banner}
import type { ManifestModel } from "@arke-studio/contracts";

export const FAL_MODELS: readonly ManifestModel[] = ${JSON.stringify(models, null, 2)} as const;

/** Model id → fal route. Dispatch needs this; a model without one cannot be submitted. */
export const FAL_ENDPOINTS: Record<string, string> = ${JSON.stringify(endpoints, null, 2)};

/**
 * Model id → the route that accepts reference images. Present only for models whose manifest
 * row declares \`accepts.referenceImages > 0\`; a job carrying references submits here instead
 * of the text route above.
 */
export const FAL_EDIT_ENDPOINTS: Record<string, string> = ${JSON.stringify(editEndpoints, null, 2)};
`;

const out = new URL("../src/fal-catalogue.generated.ts", import.meta.url);
await (await import("node:fs/promises")).writeFile(out, body, "utf8");
console.log(`[fal] wrote ${models.length} models to src/fal-catalogue.generated.ts`);
