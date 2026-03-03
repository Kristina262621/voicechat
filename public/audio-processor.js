class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // ИЗМЕНЕНО: порог поднят с 0.035 до 0.08 — более агрессивное шумоподавление
    this._threshold  = options.processorOptions?.threshold  ?? 0.08;
    this._attack     = options.processorOptions?.attack     ?? 0.003;
    // ИЗМЕНЕНО: release увеличен для более плавного закрытия
    this._release    = options.processorOptions?.release    ?? 0.25;
    // ИЗМЕНЕНО: smoothing увеличен — более плавное переключение
    this._smoothing  = options.processorOptions?.smoothing  ?? 0.97;
    this._gain       = 0.0;
    this._envelope   = 0.0;
    this._noiseFloor      = new Float32Array(128).fill(0.001);
    // ИЗМЕНЕНО: noiseAlpha увеличен — медленнее обновляется шумовой профиль
    this._noiseAlpha      = 0.9995;
    this._frameCount      = 0;
    this._calibrating     = true;
    this._calibFrames     = 0;
    // ИЗМЕНЕНО: больше фреймов для калибровки — точнее определяет фоновый шум
    this._calibMax        = 120;
    this._ambientNoise    = 0.001;
    this._ambientAccum    = 0;

    this.port.onmessage = (e) => {
      if (e.data.threshold !== undefined) this._threshold = e.data.threshold;
      if (e.data.release   !== undefined) this._release   = e.data.release;
    };
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const inL  = input[0];
    const inR  = input[1] || input[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const len  = inL.length;

    let sumSq = 0;
    for (let i = 0; i < len; i++) sumSq += inL[i] * inL[i];
    const rms = Math.sqrt(sumSq / len);

    if (this._calibrating) {
      this._ambientAccum += rms;
      this._calibFrames++;
      if (this._calibFrames >= this._calibMax) {
        // ИЗМЕНЕНО: множитель увеличен с 3.0 до 5.0 — адаптивный порог выше фонового шума
        this._ambientNoise = (this._ambientAccum / this._calibMax) * 5.0;
        this._calibrating  = false;
      }
      for (let i = 0; i < len; i++) { outL[i] = 0; outR[i] = 0; }
      return true;
    }

    // ИЗМЕНЕНО: множитель адаптивного порога увеличен с 2.5 до 4.0
    const adaptiveThreshold = Math.max(this._threshold, this._ambientNoise * 4.0);
    const attackCoef = Math.exp(-1 / (sampleRate * this._attack));
    const relCoef    = Math.exp(-1 / (sampleRate * this._release));
    if (rms > this._envelope)
      this._envelope = attackCoef * this._envelope + (1 - attackCoef) * rms;
    else
      this._envelope = relCoef   * this._envelope + (1 - relCoef)   * rms;

    const targetGain = this._envelope > adaptiveThreshold ? 1.0 : 0.0;
    this._gain = this._smoothing * this._gain + (1 - this._smoothing) * targetGain;

    // ИЗМЕНЕНО: порог отсечки поднят с 0.1 до 0.15 — шум подавляется сильнее
    if (this._gain < 0.15) {
      for (let i = 0; i < len; i++) {
        const abs = Math.abs(inL[i]);
        const idx = i % this._noiseFloor.length;
        this._noiseFloor[idx] =
          this._noiseAlpha * this._noiseFloor[idx] +
          (1 - this._noiseAlpha) * abs;
      }
      // ИЗМЕНЕНО: адаптация фонового шума медленнее — стабильнее при тишине
      this._ambientNoise = this._ambientNoise * 0.9998 + rms * 0.0002;
    }

    for (let i = 0; i < len; i++) {
      const nf = this._noiseFloor[i % this._noiseFloor.length];
      // ИЗМЕНЕНО: множитель вычитания шума увеличен с 2.0 до 3.5
      const cleanL = Math.sign(inL[i]) * Math.max(0, Math.abs(inL[i]) - nf * 3.5);
      const cleanR = Math.sign(inR[i]) * Math.max(0, Math.abs(inR[i]) - nf * 3.5);
      outL[i] = cleanL * this._gain;
      outR[i] = cleanR * this._gain;
    }

    this._frameCount++;
    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
