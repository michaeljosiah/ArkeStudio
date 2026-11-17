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
