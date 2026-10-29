// Turns microphone audio into 16-bit PCM at the rate the voice model wants,
// in 20 ms frames, with a loudness value for the level meter and speech detection.
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / options.processorOptions.rate;
    this.frame = Math.round(options.processorOptions.rate / 50);
    this.out = new Int16Array(this.frame);
    this.fill = 0;
    this.pos = 0;
    this.prev = 0;
    this.energy = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    // Linear resampling from the device rate to the target rate.
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const t = this.pos - i;
      const a = i === 0 ? this.prev : input[i - 1];
      const b = input[i];
      const s = Math.max(-1, Math.min(1, a + (b - a) * t));
      this.energy += s * s;
      this.out[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.fill === this.frame) {
        this.port.postMessage({ pcm: this.out.buffer, rms: Math.sqrt(this.energy / this.frame) }, [this.out.buffer]);
        this.out = new Int16Array(this.frame);
        this.fill = 0;
        this.energy = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    this.prev = input[input.length - 1];
    return true;
  }
}
registerProcessor("capture", Capture);
