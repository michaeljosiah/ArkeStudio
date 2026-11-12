/* global AudioWorkletProcessor, registerProcessor */
class ArkeVoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Int16Array(640); this.offset = 0; }
  process(inputs) {
    const audio = inputs[0]?.[0];
    if (!audio) return true;
    for (const value of audio) {
      this.samples[this.offset++] = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(640); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("arke-voice-capture", ArkeVoiceCapture);
