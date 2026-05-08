// ═══════════════════════════════════════════════════════════════════════════
// aec-main.js  v2.0
// AEC Processor — Main Thread Wrapper
// aec-processor.js (v2.0) ile birlikte kullanılır.
// ═══════════════════════════════════════════════════════════════════════════

class ChatbotAEC {
  constructor() {
    this.audioCtx  = null;
    this.aecNode   = null;
    this.micSource = null;
    this.isReady   = false;
    this._botSpeaking = false;
  }

  // ── Başlatma ───────────────────────────────────────────────────────────────
  // Safari iOS: Bu fonksiyonu mutlaka bir user gesture (click/touch) içinde çağır.
  // AudioContext kullanıcı etkileşimi olmadan başlamaz.
  async init() {
    this.audioCtx = new AudioContext({ sampleRate: 48000 });

    const processorUrl = new URL('./aec-processor.js', import.meta.url).href;
    await this.audioCtx.audioWorklet.addModule(processorUrl);

    // Mikrofonu aç — tarayıcının kendi AEC'sini KAPAT (biz yapıyoruz)
    // echoCancellation: false çakışmayı önler
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:  false,
        noiseSuppression:  false,
        autoGainControl:   false,
        sampleRate:        48000
      }
    });

    this.micSource = this.audioCtx.createMediaStreamSource(micStream);
    this.aecNode   = new AudioWorkletNode(this.audioCtx, 'aec-processor', {
      numberOfInputs:  1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });

    this.aecNode.port.onmessage = ({ data }) => {
      if (data?.type === 'error') console.error('AEC Processor:', data.message);
    };

    this.micSource.connect(this.aecNode);
    // Temizlenmiş çıkışı STT stream'ine bağlamak için:
    // const dest = this.audioCtx.createMediaStreamDestination();
    // this.aecNode.connect(dest);
    // const cleanStream = dest.stream; → STT servisine ver

    this.isReady = true;
  }

  // ── Bot sesini çal ve referansı worklet'e ilet ────────────────────────────
  /**
   * @param {ArrayBuffer} audioData - Bot TTS çıkışı (herhangi bir format)
   * @returns {Promise<void>} Ses bitince resolve
   */
  async playBotAudio(audioData) {
    if (!this.isReady) throw new Error('init() çağrılmadı');
    if (this._botSpeaking) {
      console.warn('Bot zaten konuşuyor, yeni ses yoksayıldı');
      return;
    }

    const audioBuffer = await this.audioCtx.decodeAudioData(audioData);
    const rawData     = audioBuffer.getChannelData(0); // Mono

    if (audioBuffer.sampleRate !== this.audioCtx.sampleRate) {
      console.warn(
        `Sample rate uyuşmazlığı: bot=${audioBuffer.sampleRate}Hz, ` +
        `ctx=${this.audioCtx.sampleRate}Hz — decodeAudioData yeniden örnekledi`
      );
    }

    this._botSpeaking = true;

    // ── Referans chunk'larını zamanlayarak gönder ────────────────────────────
    // Ses çıkışıyla senkronize olacak şekilde HOP=128 sample'lık parçalar halinde ilet.
    // hopMs ≈ 2.67ms @ 48kHz → setTimeout hassasiyeti yeterli.
    //
    // Bluetooth hoparlör kullanımında ek gecikme eklenebilir:
    //   const BT_DELAY_MS = 50; // Cihaza göre ayarla
    //   setTimeout(sendChunk, BT_DELAY_MS);
    const HOP   = 128;
    const SR    = this.audioCtx.sampleRate;
    const hopMs = (HOP / SR) * 1000;

    let offset = 0;
    const sendChunk = () => {
      if (offset >= rawData.length) return;
      const end     = Math.min(offset + HOP, rawData.length);
      const samples = rawData.slice(offset, end); // Float32Array kopyası
      this.aecNode.port.postMessage({ type: 'reference', samples });
      offset += HOP;
      setTimeout(sendChunk, hopMs);
    };
    sendChunk();

    // ── Sesi çal ─────────────────────────────────────────────────────────────
    return new Promise((resolve) => {
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);

      source.onended = () => {
        this._botSpeaking = false;
        // Worklet'e reset: H(f) ve NLMS temizle
        // Eski model bir sonraki bot konuşmasında yanlış çıkarma yapmasın
        this.aecNode.port.postMessage({ type: 'reset' });
        resolve();
      };

      source.start();
    });
  }

  // ── Parametre güncelleme ──────────────────────────────────────────────────
  /**
   * AEC/NLMS parametrelerini çalışma anında güncelle.
   *
   * @param {object} params
   * @param {number} [params.alpha]     H(f) EMA katsayısı [0.5–0.99]
   *                                    Yüksek → yavaş adaptasyon, kararlı
   * @param {number} [params.beta]      Spektral taban [0.01–0.1]
   *                                    Düşük → agresif çıkarma (musical noise riski)
   * @param {number} [params.mu]        NLMS adım büyüklüğü [0.01–0.3]
   * @param {number} [params.ratioMax]  Kirlililik üst eşiği (arka plan ses)
   *                                    Gürültülü ortam için büyüt (ör. 8.0)
   * @param {number} [params.ratioMin]  Kirlililik alt eşiği
   * @param {number} [params.nlmsOrder] NLMS filtre uzunluğu (Bluetooth: 128)
   */
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


// ══ Kullanım Örneği ════════════════════════════════════════════════════════
//
// const aec = new ChatbotAEC();
//
// // Safari iOS: button click içinde başlat
// document.getElementById('start').addEventListener('click', async () => {
//   await aec.init();
//
//   // STT için temizlenmiş stream
//   const dest = aec.audioCtx.createMediaStreamDestination();
//   aec.aecNode.connect(dest);
//   const cleanStream = dest.stream;
//   // → cleanStream'i STT servisine ver (MediaRecorder, WebSocket vb.)
//
//   // Bot yanıtı gelince:
//   const resp  = await fetch('/api/chat', { method: 'POST', body: userText });
//   const audio = await resp.arrayBuffer(); // TTS ses verisi
//   await aec.playBotAudio(audio);
//   // Bot bitince → kullanıcıdan yeni girdi bekle
// });
//
//
// ══ Parametre Rehberi ══════════════════════════════════════════════════════
//
// Sessiz ev / ofis (varsayılan):
//   aec.setParams({ alpha: 0.92, beta: 0.02, mu: 0.10, ratioMax: 5.0 })
//
// Gürültülü ortam (kafe, açık ofis):
//   aec.setParams({ alpha: 0.88, beta: 0.04, mu: 0.08, ratioMax: 8.0 })
//
// Bluetooth hoparlör (yüksek gecikme):
//   aec.setParams({ nlmsOrder: 128, mu: 0.05 })
//   // ve sendChunk içine BT_DELAY_MS ekle
//
//
// ══ Safari iOS Özel Notlar ════════════════════════════════════════════════
//
// 1. AudioContext kullanıcı etkileşimi gerektirir — init() click içinde çağır
// 2. Arka plan uygulaması (Spotify vb.) Safari mikrofon açınca otomatik duck
//    edilir → ratioMax varsayılan değer yeterli
// 3. echoCancellation: false kritik — Safari'nin kendi pipeline'ıyla çakışmaz
//
export default ChatbotAEC;
