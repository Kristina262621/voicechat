/**
 * AudioWorkletProcessor — шумоподавление на стороне отправки
 * Алгоритм: Noise Gate + Спектральное вычитание (упрощённое)
 *
 * Помещается в: public/audio-processor.js
 * Регистрируется как AudioWorklet
 */
class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // ── Параметры ──
    this._threshold   = options.processorOptions?.threshold   ?? 0.008; // порог шума
    this._attack      = options.processorOptions?.attack      ?? 0.003; // время атаки (с)
    this._release     = options.processorOptions?.release     ?? 0.08;  // время отпускания (с)
    this._smoothing   = options.processorOptions?.smoothing   ?? 0.92;  // сглаживание огибающей
    this._gain        = 1.0;   // текущее усиление гейта
    this._envelope    = 0.0;   // огибающая уровня сигнала

    // ── История для спектрального вычитания (упрощённое) ──
    this._noiseFloor  = new Float32Array(128).fill(0.0005);
    this._noiseAlpha  = 0.995; // скорость адаптации шумовой полки
    this._frameCount  = 0;

    // Принимаем обновления параметров из основного потока
    this.port.onmessage = (e) => {
      if (e.data.threshold !== undefined) this._threshold = e.data.threshold;
      if (e.data.release   !== undefined) this._release   = e.data.release;
    };
  }

  /**
   * Основной цикл обработки — вызывается ~375 раз/с (128 семплов при 48kHz)
   */
  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];

    if (!input || !input[0]) return true;

    const inL  = input[0];
    const inR  = input[[1]](#annotation-145642-0) || input[0]; // моно → дублируем в стерео
    const outL = output[0];
    const outR = output[[1]](#annotation-145642-0) || output[0];

    const len        = inL.length;
    const attackCoef = Math.exp(-1 / (sampleRate * this._attack));
    const relCoef    = Math.exp(-1 / (sampleRate * this._release));

    // ── Вычисляем RMS текущего блока ──
    let sumSq = 0;
    for (let i = 0; i < len; i++) sumSq += inL[i] * inL[i];
    const rms = Math.sqrt(sumSq / len);

    // ── Обновляем огибающую ──
    if (rms > this._envelope) {
      this._envelope = attackCoef * this._envelope + (1 - attackCoef) * rms;
    } else {
      this._envelope = relCoef   * this._envelope + (1 - relCoef)   * rms;
    }

    // ── Noise Gate: открываем только когда сигнал выше порога ──
    const targetGain = this._envelope > this._threshold ? 1.0 : 0.0;
    this._gain = this._smoothing * this._gain + (1 - this._smoothing) * targetGain;

    // ── Адаптивный шумовой пол (только когда гейт закрыт) ──
    if (this._gain < 0.1) {
      for (let i = 0; i < len; i++) {
        const idx = i % this._noiseFloor.length;
        const abs = Math.abs(inL[i]);
        this._noiseFloor[idx] =
          this._noiseAlpha * this._noiseFloor[idx] +
          (1 - this._noiseAlpha) * abs;
      }
    }

    // ── Применяем гейт + мягкое вычитание шумовой полки ──
    for (let i = 0; i < len; i++) {
      const nf   = this._noiseFloor[i % this._noiseFloor.length];
      const gL   = Math.sign(inL[i]) * Math.max(0, Math.abs(inL[i]) - nf * 1.5);
      const gR   = Math.sign(inR[i]) * Math.max(0, Math.abs(inR[i]) - nf * 1.5);

      outL[i] = gL * this._gain;
      outR[i] = gR * this._gain;
    }

    this._frameCount++;
    return true; // держим процессор живым
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
