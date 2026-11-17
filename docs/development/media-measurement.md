# Media measurement

Arke can measure a cut the way a person checks one (epic #3070). These tools sit on the same
leased reads as `inspect_media`, `sample_video` and `analyze_audio_signal`. They resolve sources by
identity, decode verified private snapshots through the bounded process runner, record a receipt,
and run locally with no provider and no cost. Each reports what it measured and says what it did
not.

They began as scripts written while making the "Why You Do Me Like That" music video, where every
check of a round had to be done by hand outside the Studio. The methods below are those scripts,
rebuilt here.

## `measure_sync`: lip sync against a reference (#3205)

**Inputs:**
- a take and an interval of it (at most 60 s);
- a reference: the song, a vocal stem or a dialogue recording, with `startSec` where the take's
  interval begins in it.

For a clip in a cut, that is the song time where the clip starts. For a take made from a slice of
the song, it is the slice's start.

**Soundtrack method** (default). The video models give back the audio they were sent as the
clip's own soundtrack, so that soundtrack is compared with the reference:
- both are decoded to 16 kHz mono;
- each becomes an RMS envelope in 10 ms steps;
- Pearson correlation is taken at every lag in ±0.6 s (`maxLagSec`), needing 0.6 s of overlap;
- the best lag is kept, and a tie goes to the smaller lag.

**Mouth method.** For a take whose own sound is not the reference, it needs a box round the mouth:
- frames inside the box, at 25 a second and at most 96 px across, give the mean change from frame
  to frame;
- that is set against how much the reference's loudness changes from one 40 ms step to the next,
  because lips move most when the voice starts and stops.

Head and camera movement inside the box count, so it is a coarse proxy, and its result says so.

**What it returns:**
- **`lagSec`:** positive means the take is late.
- **`correlation`** at the lag, and at zero lag for comparison.
- **`follows`:** the correlation is at least 0.5.
- **`sourceShiftSec`:** start the clip this much later in its source to land on the reference.
- **Activity:** each side's share of steps above −45 dBFS. A silent side gets no lag at all, rather
  than the best of noise.

**Measured on the music video:**
- Seedance 2.0 takes sat 100–450 ms off.
- Five takes that sang words of their own correlated under 0.5.
- Wan 3.0 takes on the singer's own vocal held within 50 ms at 0.96–1.00. Take 2.8 measures +50 ms
  at 0.991 here, as the script did.

It is signal measurement. A high correlation says the take's sound rises and falls with the
reference, not that the words are the same; `transcribe_audio` reads words.

Receipts raise the world to schema 140.

## `song_map`: beats, sections and voice (#3075, #3099)

**Input:** an audio source: the production's song, a stem or a recording. A source over 15 minutes
needs a `window` (at most 15 minutes). Every time it returns is in seconds from the source's start.

**Beats are tracked, not gridded.** The music video's hand grid was 2 ms a beat short of the song's
0.600 s, and away from where it was fitted it drifted up to half a beat. The song's overall pulse,
held as one grid, sat a quarter of a second off. So the tracker:
- decodes 16 kHz mono;
- takes spectral flux of log magnitudes in 40 mel bands, 10 ms steps (mel bands, so the hi-hats
  filling the upper FFT bins do not outvote the kick);
- finds the tempo from the onset curve's autocorrelation under a prior around 120 bpm, refined
  between lags;
- tracks beats by dynamic programming (Ellis 2007, tightness 100), each about one period from the
  last and on an onset;
- drops weak beats at either end, so a quiet intro or fade gets none.

Where the music repeats every half-beat as well (a hi-hat on every off-beat), the tempo can read
at double; the result says so.

**Sections are the Studio's own.** `findSongSections` (#3134), fed the window as 48 kHz stereo
through the effects analysis, returns the same boundaries the Cut proposes, with each section's
loudness. They are boundaries, never names.

**Voice, given a vocal stem aligned with the song:**
- the stem's level in 100 ms steps;
- a step counts as voice above the louder of −50 dBFS and 30 dB under the stem's usual loud level
  (its 95th percentile);
- gaps under 0.6 s are one phrase, and runs under 0.3 s are dropped as breaths;
- each section reports how much of it is sung.

**On the music video's song:**
- 3:47 maps in 5.6 s: 100 bpm, 376 beats, one on the riff at 3:04 (183.98 s), and eight sections.
- The lead stem shows no voice in the intro or the lull (0%), and 90–95% where he sings, from
  0:15.

Receipts raise the world to schema 141.

## `clip_quality`: cadence and detail (#3076)

**Input:** a clip and an interval (at most 60 s), an optional `region` (a face, a texture), and an
optional second clip in `compare`.

**Cadence** reads every decoded frame of the interval at 128 px, with no resample, so repeats are
not hidden:
- it measures the mean change from one frame to the next;
- a step under 15% of the median is a repeated or blended frame;
- the repeat period is the mean spacing of repeats, given only when it is regular (spacings within
  a frame of it): FFmpeg's fps filter takes 24 to 30 with repeats 4, 5, 6 frames apart, mean 5;
- the motion rate is the container's rate less its repeats;
- unevenness is the steps' standard deviation over their mean;
- a still picture (median step under 0.3) reports no cadence rather than every frame a repeat.

**Detail** reads the region at full resolution (longer side at most 960) over at most 2 s from the
interval's middle:
- **Sharpness:** mean absolute Laplacian, with its 10th and 90th percentile frames.
- **Shimmer:** the mean change of the Laplacian from frame to frame over its mean. Detail that is
  real moves with the picture and leaves shimmer where it was; detail that flickers raises it.
  Fast motion raises it too, so compare like with like.
- **Motion:** the frame-to-frame change of a 4×4-block-averaged picture.

**Compare** meets the two clips at one size: the larger crop, its longer side at most 960, the
smaller enlarged bicubic as the Cut's export would. It reports both clips' cadence and detail and
the change in sharpness and shimmer. Clips of different shapes are refused rather than stretched.

**On the music video's clips:**
- The Seedance police take, conformed to 30 fps the way the Cut does, shows 30 repeats in 150
  frames, period 5, motion 23.96 fps, unevenness 0.555. The smooth copy shows none (0.232); the
  native 24 fps take shows none.
- Topaz Proteus against bicubic, at 1080p, is 17–30% sharper (whole frame and face) with shimmer
  −5% to +6%: added detail, not flicker.

Receipts raise the world to schema 142.

## `cut_contact_sheet`: the whole film at once (#3072)

**Input:** a finished film by its export id (any immutable video works), with a `window` when it
is over 15 minutes.

**Output:**
- **Pages:** one frame from the middle of each shot, five to a row and up to 30 a page (at most 240
  shots on 8 pages). Each tile is labelled with its number and start (`12  2:56.6`) in a small
  built-in digit font.
- **A table of shots:** number, start, end, the frame's time, and the clip's name and id.

**Where the shots come from:**
- When the export's production still holds the cut it was made from (the current
  `productionExportFingerprint` equals the export's stamp; episode exports excepted), the shots are
  its picture clips, named.
- Otherwise cuts are found in the picture. Frames are decoded at 10 a second and 64 px, skipping the
  deblocking filter and frames nothing refers to. A cut is a step of at least 14 grey levels and 3
  times the median of the 30 steps around it, with shots at least 0.5 s long. Dissolves are missed.

Pages go through `view_image`'s pipeline, so they share its budget, privacy check and disclosure.
Decodes run three at a time.

**On the music video:** the 3:47 export's sheet takes 21 s (66 s one decode at a time). It finds
78 shots against the cut's 76 clips; the two extra are cuts inside generated takes.

**`sample_video` regions.** `sample_video` takes an optional `region`. The frame is cropped to that
box at the source's own resolution before it is scaled, for eyes, a mouth or a hand. Its receipt
names the region.

Both raise the world to schema 143.

## `review_export`: a finished film checked before it is shared (#3073)

**Input:** a finished film by its export id, with a `window` when it is over 15 minutes.

**What it returns:**
- **Length:** the film's length, and when its production still holds the cut it was made from, the
  cut's length and the difference.
- **Format:** the picture's size, frame rate and codec, and the sound's rate, channels and codec.
- **Loudness:** FFmpeg's EBU R128 meter (`ebur128=peak=true`): integrated LUFS, loudness range,
  true peak, and the loudest short-term (3 s) value.
- **Shots:** from the cut when it is the film's, otherwise found in the picture. Each shot reports:
  - repeated frames and their period, as `clip_quality` reads them, from every native frame at
    48 px read in 60 s pieces, keeping only the steps;
  - jumps: steps of 1.6× the usual or more, every 3 to 6 frames, as rate conversions drop them (30
    to 24 every fourth);
  - for each clip whose own sound is muted in the cut, placed from an artifact or a take at normal
    speed: that sound against the film's mix over the clip's time, by `measure_sync`'s method. Each
    clip source is read from its own contained snapshot and its bytes rechecked.
- **Findings:** plain sentences, each with its shot number:
  - the film is longer or shorter than its cut by more than a frame;
  - no sound, sound under 44.1 kHz, or mono;
  - a true peak over −1 dBTP;
  - a shot that repeats or drops frames regularly;
  - a muted clip off the mix by more than a frame, with the shift that lands it;
  - how many muted clips' sound does not follow the mix (expected for a film shot's own ambience, a
    fault for a sung or spoken one).

**Limits:** dropped frames show only where the motion is steady, so some converted shots are not
caught. Clips placed as shots, which play whichever take is accepted at render, are not synced.

**On the music video:**
- The 3:47 30 fps film reviews in 29 s: 48 kHz stereo, −13.6 LUFS integrated, 4.2 LU range,
  −1.2 dBTP. One finding: the deep-water flood shot's 30 fps file carries 27 fps of motion (the
  tool provider's frame pattern).
- The earlier 24 fps export, where 30 fps takes were played at 24, shows three shots stepping twice
  as far every 4 frames.

Receipts raise the world to schema 144.
