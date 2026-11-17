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
