// ═══════════════════════════════════════════════════════════════════════════
// aec-main.js  v2.2
// AEC Processor — Main Thread Wrapper
//
// v2.2: System audio loopback support via getDisplayMedia.
//   Reference graph: BotGainNode + SysGainNode → AEC inputs[1]
//   Both sources are summed at inputs[1] by WebAudio automatically.
// ═══════════════════════════════════════════════════════════════════════════

class ChatbotAEC {
  constructor() {
    this.audioCtx        = null;
    this.aecNode         = null;
    this.micSource       = null;
    this.isReady         = false;
    this._botSpeaking    = false;
    this._botGain        = null;   // GainNode — bot audio reference path
    this._sysGain        = null;   // GainNode — system audio reference path
    this._sysAudioSource = null;   // MediaStreamAudioSourceNode from getDisplayMedia
    this._sysAudioStream = null;   // MediaStream from getDisplayMedia (for dispose)
    this._hasSysAudio    = false;  // System audio loopback active flag
  }

  // ── Başlatma ───────────────────────────────────────────────────────────────
  // requestSystemAudio: convenience flag — calls _tryAcquireSystemAudio()
  // inside init(). Requires a user gesture context. Silently ignored on failure.
  async init({ requestSystemAudio = false } = {}) {
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
      numberOfInputs:     2,   // input[0]: mic, input[1]: reference (bot + sys)
      numberOfOutputs:    1,
      outputChannelCount: [1]
    });

    this.aecNode.port.onmessage = ({ data }) => {
      if (data?.type === 'error') console.error('AEC Processor:', data.message);
    };

    this.micSource.connect(this.aecNode);

    if (requestSystemAudio) {
      await this._tryAcquireSystemAudio();
    }

    this._buildReferenceGraph();
    this.isReady = true;
  }

  // ── Reference graph ────────────────────────────────────────────────────────
  // Built once in init(). Bot and system audio both connect to input[1] via
  // their respective GainNodes — WebAudio sums them automatically.
  _buildReferenceGraph() {
    this._botGain = this.audioCtx.createGain();
    this._botGain.gain.value = 1.0;
    this._botGain.connect(this.aecNode, 0, 1);

    this._sysGain = this.audioCtx.createGain();
    this._sysGain.gain.value = 1.0;
    this._sysGain.connect(this.aecNode, 0, 1);

    if (this._sysAudioSource) {
      this._sysAudioSource.connect(this._sysGain);
    }
  }

  // ── System audio capture ───────────────────────────────────────────────────
  // Must be called from a user gesture context (click handler).
  // Silently falls back (_hasSysAudio stays false) on any failure.
  async _tryAcquireSystemAudio() {
    try {
      this._sysAudioStream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: { systemAudio: 'include' }
      });
      this._sysAudioSource = this.audioCtx.createMediaStreamSource(this._sysAudioStream);
      this._hasSysAudio = true;
    } catch {
      this._hasSysAudio = false;
    }
  }

  // ── Public: enable system audio from a button click ────────────────────────
  async enableSystemAudio() {
    if (!this.isReady) return { active: false, reason: 'init() has not been called' };
    try {
      await this._tryAcquireSystemAudio();
      if (this._hasSysAudio && this._sysGain) {
        this._sysAudioSource.connect(this._sysGain);
      }
      return { active: this._hasSysAudio };
    } catch (e) {
      return { active: false, reason: e.message };
    }
  }

  // ── Public: query system audio state ──────────────────────────────────────
  getSystemAudioStatus() {
    return {
      supported: typeof navigator !== 'undefined' && 'getDisplayMedia' in navigator.mediaDevices,
      active: this._hasSysAudio
    };
  }

  // ── Bot audio playback ─────────────────────────────────────────────────────
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
      source.connect(this.audioCtx.destination);  // play to speakers
      source.connect(this._botGain);               // reference via botGain → inputs[1]

      source.onended = () => {
        this._botSpeaking = false;
        this.aecNode.port.postMessage({ type: 'reset' });
        resolve();
      };

      source.start();
    });
  }

  // ── Bypass mode (A/B comparison) ───────────────────────────────────────────
  bypass(value) {
    if (!this.aecNode) return;
    this.aecNode.port.postMessage({ type: 'bypass', value: !!value });
  }

  // ── Runtime parameter update ───────────────────────────────────────────────
  setParams(params = {}) {
    if (!this.aecNode) return;
    this.aecNode.port.postMessage({ type: 'params', ...params });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  dispose() {
    this._sysAudioStream?.getTracks().forEach(t => t.stop());
    this._sysAudioSource?.disconnect();
    this._botGain?.disconnect();
    this._sysGain?.disconnect();
    this.micSource?.disconnect();
    this.aecNode?.disconnect();
    this.audioCtx?.close();
    this.isReady = false;
  }
}

export default ChatbotAEC;
