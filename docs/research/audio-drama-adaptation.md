# Audio drama adaptation research · 17 October 2026

Purpose: inform [design turn 228](../../design-system/audio-drama-228.notes.md), extending Arke's Story adaptation and Audio Studio. These are established production approaches and published examples, not a quantitative ranking of today's most popular shows. No programme audio was listened to in this research pass; claims below come from publisher descriptions, format guidance and documentation.

## Approaches worth supporting

| Approach | Primary evidence | Implication for Arke (our design judgement) |
|---|---|---|
| Narrated dramatisation of existing books | GraphicAudio describes full-cast adaptations with music and sound design in its [publisher media kit](https://www.graphicaudio.net/pub/media/wysiwyg/GraphicAudioMediaKit2019.pdf). The kit is dated 2019; it establishes a format, not current catalogue or audience figures. | Preserve essential narration and interiority. Do not impose a zero-narrator rule or retain every prose attribution. |
| Serial ensemble drama | Wayland's [We're Alive: Lockdown](https://www.waylandproductions.com/were-alive-lockdown/) is a six-episode standalone miniseries that also continues an existing story. | Episode and scene structure should support both standalone arcs and series continuity. Do not derive one episode per source chapter. |
| Narrated testimony / archive framing | Rusty Quill describes [The Magnus Archives](https://rustyquill.com/the-magnus-archives/) as a horror anthology concerned with an institute's archives. | Make in-world recordings an available creative approach. Its framing needs an actual speaker, listener and knowledge limit, rather than using exposition without cause. |
| Dialogue-led audio comedy | [Wooden Overcoats](https://www.woodenovercoats.com/listen) identifies its format as a podcast sitcom and provides episode script links. The linked first script could not be retrieved in this pass; no detailed claim about its formatting is made. | Support performance timing, episode identity and readable scripts alongside finished audio. Comedy and action both depend on exchanges, not independent sentence samples. |

The common design need is control over who communicates information and how a listener receives it. Narrated drama is a useful starting approach for a military discovery novel because sound alone cannot reliably explain complex terrain, experiments or interior judgement. That recommendation is our inference, not a rule asserted by these publishers.

## Script conventions

The BBC's [Radio Drama Format — Scene Style](https://downloads.bbc.co.uk/writersroom/scripts/bbcradioscene.pdf), dated 2004, distinguishes dialogue from technical sound/music direction, keeps character designations consistent and advises restraint with parentheticals and technical prose. It also warns that listeners can lose track of an overcrowded scene. It defines familiar channel/performance labels such as off-mic, voiceover and distorted telephone/radio. Its old paper-submission instructions are not modern application requirements.

Design consequences: readable named dialogue; numbered scenes/cues on export; separate sound and direction elements; a channel field rather than a new voice for radio; optional sound cues with a clear story function; and a review for character presence and listener orientation. Do not enforce an arbitrary speaker maximum: show complexity and review it in context.

[Fountain's official syntax](https://fountain.io/syntax/) offers plain-text scenes, character cues, dialogue, parentheticals and dual dialogue. It is a screenplay interchange rather than an audio-production data model. Arke can learn its keyboard ergonomics and later exchange its basic script elements, but durable cue anchors, source lineage, render instructions and performance history need structured records. A Fountain file must not silently discard those on round trip.

## Provider support is not a complete production workflow

[ElevenLabs' audiobook guide](https://elevenlabs.io/docs/eleven-creative/products/audiobooks) documents single- and multi-cast choices, character detection and voice preview on actual dialogue. It cautions that detection can miss or misidentify characters. [Dialogue mode guidance](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/what-is-dialogue-mode) describes multi-speaker conversational generation. This supports auditioning exchanges and reviewing attribution; it does not establish that Arke's current single-voice adapter already supports the dialogue API or that a returned mix includes separable stems.

The current Arke baseline has three audiobook readings, character voice assignments, grouping by reader, generation quotes and background runs. Its actor direction and provider request planning need explicit audio-drama treatment. A capability registry should determine supported speaker counts, contextual controls and output structure for each model; model documentation and a returned mixed file are not evidence of independently editable actor tracks.

## Recommendations derived from the research

- Adapt information, not punctuation: removing “she said” is only safe if voice identity and presence remain clear.
- Review the complete source before claiming complete coverage. Record purposeful omissions and new exposition rather than silently abridging.
- Introduce listener perspective per scene: nearby speech, a remote radio participant and a narrator communicate different kinds of knowledge.
- Write an audible purpose for significant sound cues. A generic impact rarely explains who fell or what broke.
- Keep silence and overlap as authored timing, and distinguish intended silence from a missing take.
- Audition a short scene with all voices; individual voice attractiveness is not evidence of a coherent cast.
- Review dry performance before complex sound design, then inspect the actual mix with a transcript and exact intervals.
- Preserve a source-linked novel and a separate adaptation. Shared character and canon knowledge should not turn the audio script into a second editable copy of the prose.

No universal episode duration, narration percentage, production budget or mastering target is established by these sources. Those are editable production choices with estimates and listening validation. No present popularity ranking or claim of having heard the example shows is made.
