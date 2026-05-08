// ═══════════════════════════════════════════════════════════════════════════
// aec-main.js  v2.1
// AEC Processor — Main Thread Wrapper
//
// v2.1: Reference signal routed via AudioGraph (inputs[1]) instead of
//       postMessage chunks — eliminates setTimeout timing jitter.
// ═══════════════════════════════════════════════════════════════════════════

class ChatbotAEC {
  constructor() {
    this.audioCtx    = null;
    this.aecNode     = null;
    this.micSource   = null;
    this.isReady     = false;
    this._botSpeaking = false;
  }

  // ── Başlatma ───────────────────────────────────────────────────────────────
  async init() {
    this.audioCtx = new AudioContext({ sampleRate: 48000 });

    const processorUrl = new URL('./aec-processor.js', import.meta.url).href;
    await this.audioCtx.audioWorklet.addModule(processorUrl);

    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
        sampleRate:       48000
      }
    });

    this.micSource = this.audioCtx.createMediaStreamSource(micStream);
    this.aecNode   = new AudioWorkletNode(this.audioCtx, 'aec-processor', {
      numberOfInputs:     2,   // input 0: mic, input 1: reference (bot audio)
      numberOfOutputs:    1,
      outputChannelCount: [1]
    });

    this.aecNode.port.onmessage = ({ data }) => {
      if (data?.type === 'error') console.error('AEC Processor:', data.message);
    };

    this.micSource.connect(this.aecNode);
    this.isReady = true;
  }

  // ── Bot sesini çal ve referansı AudioGraph üzerinden ilet ─────────────────
  async playBotAudio(audioData) {
    if (!this.isReady) throw new Error('init() has not been called');
    if (this._botSpeaking) {
      console.warn('Bot is already speaking — new audio ignored');
      return;
    }

    const audioBuffer = await this.audioCtx.decodeAudioData(audioData);

    if (audioBuffer.sampleRate !== this.audioCtx.sampleRate) {
      console.warn(
        `Sample rate mismatch: bot=${audioBuffer.sampleRate}Hz, ` +
        `ctx=${this.audioCtx.sampleRate}Hz — decodeAudioData resampled`
      );
    }

    this._botSpeaking = true;

    return new Promise((resolve) => {
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);  // hoparlöre
      source.connect(this.aecNode, 0, 1);          // referans girişine (sample-accurate)

      source.onended = () => {
        this._botSpeaking = false;
        this.aecNode.port.postMessage({ type: 'reset' });
        resolve();
      };

      source.start();
    });
  }

  // ── Bypass modu (A/B karşılaştırma için) ──────────────────────────────────
  bypass(value) {
    if (!this.aecNode) return;
    this.aecNode.port.postMessage({ type: 'bypass', value: !!value });
  }

  // ── Parametre güncelleme ──────────────────────────────────────────────────
  setParams(params = {}) {
    if (!this.aecNode) return;
    this.aecNode.port.postMessage({ type: 'params', ...params });
  }

  // ── Temizlik ───────────────────────────────────────────────────────────────
  dispose() {
    this.micSource?.disconnect();
    this.aecNode?.disconnect();
    this.audioCtx?.close();
    this.isReady = false;
  }
}

export default ChatbotAEC;
