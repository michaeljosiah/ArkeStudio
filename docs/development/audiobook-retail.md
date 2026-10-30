# Retail chapter audio

Chapter files in Export audiobook implements the MP3 delivery portion of SPEC-047 R-22–R-28.
It uses the same book/chapter scope as Listen and exports complete current chapters only.
Incomplete chapters in book scope are counted and omitted; chapter scope never widens to the book.
Player, Arke Player, video and private M4B encodings retain their existing profiles. WAV delivery,
an As made profile and a retail M4B are separate work.

## Encoding and mastering

Coordinator `productions/audiobook-chapters.ts` requests the canonical chapter mix, including
Audio Studio arrangements, edits, acknowledged omissions, beds and overlaps. A failed mix refuses
delivery rather than concatenating its takes differently. No synthesis or player-package audio
is used. Source takes remain unchanged. Delivery is consistently stereo, including chapters
exported separately. Legacy mono is upmixed, preserving arranged stereo without mixed channel
formats across separate chapter exports.

`audio/retail.ts` uses the existing `MediaProcessRunner` through `AudioMediaTools.retail`, composed
by desktop and Node hosts. FFmpeg and ffprobe execution is local-only, bounded in output and time,
cancellable and drained before staging cleanup. The delivery is LAME MP3, 192,000 bit/s CBR,
44,100 Hz, without joint stereo. It targets -20.5 dBFS RMS and a -4 dBFS limiter ceiling, then
adjusts gain/headroom from the decoded result for at most three encodes. LUFS is not used as an
RMS substitute. The finished file must have RMS between -23 and -18 dBFS, sample peaks no higher
than -3 dBFS and a measured true peak no higher than -3.1 dBTP. The extra tenth covers the
precision of FFmpeg's printed true-peak measurement.

Existing quiet edges shorter than six seconds are trimmed with a 30 ms margin, then 1.1 seconds
of quiet is added at the beginning and 2.1 at the end. Longer quiet edges require an Audio Studio
edit. The decoded result must have 1–5 seconds of quiet at each end. This follows the current
[ACX submission guidance](https://help.acx.com/s/article/what-are-the-acx-audio-submission-requirements)
(15 April 2026), whose recommendation supersedes the older 0.5-second head in SPEC-047 R-23.
Chapter files over 120 minutes are split at non-overlapping passage starts with padding/encoder
headroom; a passage with no safe boundary is refused for an author edit.

## What validation establishes

Every MPEG frame is checked for 192 kbps, 44.1 kHz and the chosen channel mode. Declared VBR,
truncation and mixed frames are refused; an average bitrate alone does not prove CBR.
ffprobe and FFmpeg independently decode and measure duration, channels, RMS, sample peaks,
true peaks and edge spacing. Output duration is compared to both the MPEG frame count and the
requested content plus padding.

Noise floor is a conservative quiet-window peak estimate from FFmpeg astats (250 ms), required
to be at or below -60 dBFS. It is checked in the source and in the decoded content excluding the
padding added by export, so new silence cannot conceal a noisy programme. It is an estimate,
not voice activity classification or proof that every background sound is inaudible. Digital
silence has no finite level and is recorded as `noiseFloorDb: null` in the report. Listening for
noise, pronunciation and editing errors remains necessary. Credits, spoken chapter headings,
the retail sample, rights and ACX authorization for synthetic narration are separate checks.
Technical success is not a claim of retailer approval.

## Files and lifecycle

The new `export-audiobook-chapters` command shares the `audiobook.exported` result event and
registered `cancel-export` owner. `export.progress` reports mastering/checking steps in Activity
and the open sheet. The command is a production host export action, under the same remote
access policy as player export. Missing FFmpeg/ffprobe support returns a blocker.

Files are staged in an exclusively created `.staging/audiobook-chapters/<export-id>/` directory.
Where host storage admission is configured, reservations cover known MP3 output sizes and the
bounded report before encoding. The final scope, chapter plan and original source identities
are rechecked under the world gate. Sources and deliveries have streaming hashes and concurrent
replacement checks. Only then is the entire folder renamed to
`exports/audiobook-<production>-chapters-<export-id>/`.

`manifest.json` records the profile, scope, chapter/part identities, measured results, source and
delivery hashes, omissions and the remaining manual checks. Failures and cancellation publish
no folder. Completed chapter exports appear in Publications and can be recovered by listing
packages after a reconnect. They have Show in folder, without an Open player action.

## Verification

Coordinator `test/audio/retail.test.ts` covers frame validation, numeric limits, splitting and
optional actual mono/stereo encoding. `test/productions/audiobook-listening.test.ts` exercises
the coordinator command/service composition, scoped receipts, listing, noisy sources, wrong
final bitrates, cancellation, changed-source refusal and an optional complete native export.
Client `test/audiobook-export.test.tsx` covers selection, scope, progress, failure, cancellation
and folder actions. Client tests run from `packages/client`.

Set `ARKE_FFMPEG` and optionally `ARKE_FFPROBE` to run native cases, using a qualified installed
or bundled encoder. Without `ARKE_FFMPEG`, native cases are explicitly skipped. From the root:

```powershell
node --import tsx --test packages/coordinator/test/audio/retail.test.ts packages/coordinator/test/productions/audiobook-listening.test.ts
```
