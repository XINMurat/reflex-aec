// ═══════════════════════════════════════════════════════════════════════════
// aec-processor.js  v2.0
// Cascaded Frekans + Zaman Domenli Yazılım AEC — AudioWorkletProcessor
//
// Mimari:
//   Aşama 1 — FDAF  : Frekans domeninde H(f) ile lineer eko çıkarma (~25dB)
//   Aşama 2 — NLMS  : Zaman domeninde artık + nonlineer eko temizleme (+10dB)
//   Aşama 3 — RES   : Spektral taban ile musical noise bastırma
//
// Yeni özellikler (v2.0):
//   • _shouldUpdateH() : Arka plan ses kirliliği tespiti (Spotify, müzik vb.)
//   • NLMSFilter       : FDAF artığını ve hoparlör nonlinearity'sini giderir
//   • Tüm parametreler çalışma anında güncellenebilir (params mesajı)
//
// Performans:
//   • GC baskısı yok — tüm tamponlar constructor'da ayrıldı
//   • NLMS O(order) = O(64) — FFT'den ~100x daha ucuz
// ═══════════════════════════════════════════════════════════════════════════


// ─── Cooley-Tukey Radix-2 DIT FFT ──────────────────────────────────────────
class FFT {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error(`FFT boyutu 2^k olmalı: ${n}`);
    this.n = n;
    this.cosT = new Float32Array(n);
    this.sinT = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = -2 * Math.PI * i / n;
      this.cosT[i] = Math.cos(a);
      this.sinT[i] = Math.sin(a);
    }
  }

  forward(re, im) {
    const n = this.n;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cosT[k * step];
          const wi = this.sinT[k * step];
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + half] * wr - im[i + k + half] * wi;
          const vi = re[i + k + half] * wi + im[i + k + half] * wr;
          re[i + k]        = ur + vr;  im[i + k]        = ui + vi;
          re[i + k + half] = ur - vr;  im[i + k + half] = ui - vi;
        }
      }
    }
  }

  inverse(re, im) {
    for (let i = 0; i < this.n; i++) im[i] = -im[i];
    this.forward(re, im);
    const inv = 1 / this.n;
    for (let i = 0; i < this.n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
  }
}


// ─── NLMS Filtresi ──────────────────────────────────────────────────────────
// Aşama 2: FDAF'tan çıkan artık ekoyu ve hoparlör nonlinearity'sini giderir.
// Sample bazında çalışır — FFT gerektirmez, çok düşük hesaplama maliyeti.
//
// NLMS seçim gerekçesi vs LMS:
//   LMS: sabit adım μ → ref gücü değişince instabil
//   NLMS: μ / ||x||² → normalize adım, her koşulda kararlı
class NLMSFilter {
  /**
   * @param {number} order - Filtre uzunluğu (tap)
   *   64: FDAF sonrası artık küçük → kısa filtre yeterli
   *   128: Daha uzun eko kuyruğu varsa (Bluetooth hoparlör gecikmesi)
   * @param {number} mu - Adım büyüklüğü [0.01–0.3]
   *   Büyük → hızlı yakınsama, instabil risk
   *   Küçük → yavaş, kararlı
   */
  constructor(order = 64, mu = 0.1) {
    this.order = order;
    this.MU    = mu;
    this.EPS   = 1e-6;
    this.w     = new Float32Array(order);  // Adaptif katsayılar
    this.xBuf  = new Float32Array(order);  // Referans geçmişi (ring buffer)
    this.xIdx  = 0;
  }

  process(micSample, refSample) {
    // Ring buffer'a yaz
    this.xBuf[this.xIdx] = refSample;
    this.xIdx = (this.xIdx + 1) % this.order;

    // Filtre çıkışı: ĥ = Σ w[i] · x[i]
    let echo = 0;
    for (let i = 0; i < this.order; i++) {
      echo += this.w[i] * this.xBuf[(this.xIdx + i) % this.order];
    }

    const err  = micSample - echo;

    // Normalize güç: ||x||²
    let xPow = this.EPS;
    for (let i = 0; i < this.order; i++) xPow += this.xBuf[i] ** 2;

    // NLMS güncelleme: w ← w + (μ / ||x||²) · e · x
    const step = this.MU / xPow;
    for (let i = 0; i < this.order; i++) {
      this.w[i] += step * err * this.xBuf[(this.xIdx + i) % this.order];
    }

    return err;
  }

  reset() {
    this.w.fill(0);
    this.xBuf.fill(0);
    this.xIdx = 0;
  }
}


// ─── AEC AudioWorkletProcessor ──────────────────────────────────────────────
class AECProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // ══ Temel parametreler ══════════════════════════════════════════════════
    this.N        = 512;   // FFT pencere boyutu (sample)
    this.HOP      = 128;   // Adım — AudioWorklet sabit 128 verir
    this.ALPHA    = 0.92;  // H(f) EMA katsayısı
    this.BETA     = 0.02;  // Spektral taban oranı
    this.XPOW_MIN = 1e-8;  // Ref gücü eşiği

    // ── Arka plan kirliliği tespiti parametreleri ───────────────────────────
    // mic/ref güç oranı bu aralığın dışındaysa H güncellenmez:
    //
    //   ratio < RATIO_MIN → bot konuşmuyor, ref anlamsız
    //   ratio > RATIO_MAX → arka planda başka ses var (Spotify vb.)
    //
    // Bu değerler ortama göre ayarlanabilir (params mesajıyla):
    //   Sessiz ofis:   RATIO_MAX=4.0
    //   Gürültülü ev:  RATIO_MAX=8.0  (daha toleranslı)
    this.RATIO_MIN = 0.01;
    this.RATIO_MAX = 5.0;

    // Hann %75 overlap COLA ölçeği
    // sum_k hann²(n + k·HOP) = 1.5  →  OLA_SCALE = 1/1.5 = 2/3
    this.OLA_SCALE = 2 / 3;

    const N   = this.N;
    const HOP = this.HOP;

    // ══ DSP nesneleri ═══════════════════════════════════════════════════════
    this.fft  = new FFT(N);
    this.nlms = new NLMSFilter(64, 0.1);

    // ══ Hann penceresi ══════════════════════════════════════════════════════
    this.hann = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N));
    }

    // ══ Geçmiş tamponlar ════════════════════════════════════════════════════
    this.micHist = new Float32Array(N);
    this.refHist = new Float32Array(N);

    // ══ Transfer fonksiyonu H(f) ════════════════════════════════════════════
    this.H_re = new Float32Array(N);
    this.H_im = new Float32Array(N);

    // ══ GC baskısız çalışma tamponları ═════════════════════════════════════
    this.mRe     = new Float32Array(N);  // Mikrofon FFT — gerçek
    this.mIm     = new Float32Array(N);  // Mikrofon FFT — sanal
    this.xRe     = new Float32Array(N);  // Referans FFT — gerçek
    this.xIm     = new Float32Array(N);  // Referans FFT — sanal
    this.vRe     = new Float32Array(N);  // FDAF çıkışı  — gerçek
    this.vIm     = new Float32Array(N);  // FDAF çıkışı  — sanal
    this.nlmsOut = new Float32Array(N);  // NLMS çıkışı

    // ══ Overlap-Add tamponu ═════════════════════════════════════════════════
    this.olaBuf = new Float32Array(N + HOP);

    // ══ Referans ring buffer ════════════════════════════════════════════════
    const RING    = N * 16;
    this.ring     = new Float32Array(RING);
    this.ringSize = RING;
    this.ringW    = 0;
    this.ringR    = 0;
    this.hasRef   = false;

    // ══ Güç istatistikleri (kirlililik tespiti için smooth değerler) ════════
    this._micPowSmooth = 0;
    this._refPowSmooth = 0;
    this._STAT_ALPHA   = 0.95;

    // ══ Mesaj alıcısı ════════════════════════════════════════════════════════
    this.port.onmessage = ({ data }) => {
      switch (data.type) {

        case 'reference':
          // Bot ses chunk'ı → ring buffer'a yaz
          {
            const s = data.samples;
            for (let i = 0; i < s.length; i++) {
              this.ring[this.ringW % this.ringSize] = s[i];
              this.ringW++;
            }
            this.hasRef = true;
          }
          break;

        case 'reset':
          // Bot konuşmayı bitirdi
          // H(f) sıfırla — eski model yeni konuşmada yanlış çıkarma yapmasın
          // NLMS sıfırla — aynı gerekçe
          this.H_re.fill(0);
          this.H_im.fill(0);
          this.nlms.reset();
          this.olaBuf.fill(0);
          this.ringR = this.ringW;
          this.hasRef = false;
          this._micPowSmooth = 0;
          this._refPowSmooth = 0;
          break;

        case 'params':
          // Çalışma anında parametre güncelleme
          if (data.alpha     !== undefined) this.ALPHA         = data.alpha;
          if (data.beta      !== undefined) this.BETA          = data.beta;
          if (data.mu        !== undefined) this.nlms.MU       = data.mu;
          if (data.ratioMax  !== undefined) this.RATIO_MAX     = data.ratioMax;
          if (data.ratioMin  !== undefined) this.RATIO_MIN     = data.ratioMin;
          if (data.nlmsOrder !== undefined) {
            this.nlms = new NLMSFilter(data.nlmsOrder, this.nlms.MU);
          }
          break;
      }
    };
  }

  // ── Ring buffer'dan HOP adet referans sample çek ─────────────────────────
  _pullRef(HOP) {
    if ((this.ringW - this.ringR) < HOP) return false;
    this.refHist.copyWithin(0, HOP);
    const off = this.N - HOP;
    for (let i = 0; i < HOP; i++) {
      this.refHist[off + i] = this.ring[this.ringR % this.ringSize];
      this.ringR++;
    }
    return true;
  }

  // ── Arka plan ses kirliliği tespiti ──────────────────────────────────────
  /**
   * H(f)'i güncellemek bu frame'de güvenli mi?
   *
   * Senaryo analizi:
   *   Normal bot konuşması : mic ≈ H·ref + küçük v  → ratio orta → güncelle
   *   Arka plan müzik var  : mic >> H·ref             → ratio yüksek → GÜNCELLEME
   *   Bot sessiz           : ref ≈ 0, oran tanımsız   → ratio düşük → GÜNCELLEME
   *
   * EMA smooth değerler kullanılır — anlık spike'lardan etkilenmez.
   *
   * @param {number} micPow - Anlık mikrofon güç tahmini (normalize)
   * @param {number} refPow - Anlık referans güç tahmini (normalize)
   * @returns {boolean}
   */
  _shouldUpdateH(micPow, refPow) {
    const A = this._STAT_ALPHA;
    this._micPowSmooth = A * this._micPowSmooth + (1 - A) * micPow;
    this._refPowSmooth = A * this._refPowSmooth + (1 - A) * refPow;

    if (this._refPowSmooth < this.XPOW_MIN) return false;

    const ratio = this._micPowSmooth / (this._refPowSmooth + 1e-10);

    // Arka plan ses var: oran beklenenden yüksek
    // H bu kirli sinyali öğrenmemeli — mevcut (doğru) tahmini koru
    if (ratio > this.RATIO_MAX) return false;

    // Bot konuşmuyor veya ref çok zayıf
    if (ratio < this.RATIO_MIN) return false;

    return true;
  }

  // ── Ana DSP döngüsü ──────────────────────────────────────────────────────
  process(inputs, outputs) {
    const mic = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!mic || !out) return true;

    const N   = this.N;
    const HOP = this.HOP;

    // Mikrofon geçmişini güncelle
    this.micHist.copyWithin(0, HOP);
    this.micHist.set(mic, N - HOP);

    // Referans yoksa işleme gerek yok
    if (!this.hasRef || !this._pullRef(HOP)) {
      out.set(mic);
      return true;
    }

    // ══════════════════════════════════════════════════════════════════════
    // AŞAMA 1 — FDAF: Frekans Domeninde Lineer Eko Çıkarma
    //   Kazanım: ~25dB eko baskılama
    //   Gideremediği: hoparlör nonlinearity, çok kısa gecikme artıkları
    // ══════════════════════════════════════════════════════════════════════

    // 1a. Hann pencereleme (spectral leakage azaltma)
    for (let i = 0; i < N; i++) {
      this.mRe[i] = this.micHist[i] * this.hann[i];  this.mIm[i] = 0;
      this.xRe[i] = this.refHist[i] * this.hann[i];  this.xIm[i] = 0;
    }

    // 1b. FFT — Y(f) ve X(f)
    this.fft.forward(this.mRe, this.mIm);
    this.fft.forward(this.xRe, this.xIm);

    // 1c. Anlık güç (kirlililik kontrolü için)
    let micPowNow = 0, refPowNow = 0;
    for (let k = 0; k < N; k++) {
      micPowNow += this.mRe[k] ** 2 + this.mIm[k] ** 2;
      refPowNow += this.xRe[k] ** 2 + this.xIm[k] ** 2;
    }
    const canUpdate = this._shouldUpdateH(micPowNow / N, refPowNow / N);

    // 1d. H(f) güncelle ve V(f) hesapla
    for (let k = 0; k < N; k++) {
      const xPow = this.xRe[k] ** 2 + this.xIm[k] ** 2;

      // Kirlililik yok VE ref güçlüyse H güncelle
      if (canUpdate && xPow > this.XPOW_MIN) {
        // Kompleks bölme: H = Y/X = (a+jb)/(c+jd)
        //   Re = (ac+bd)/(c²+d²)
        //   Im = (bc-ad)/(c²+d²)
        const hRe = (this.mRe[k] * this.xRe[k] + this.mIm[k] * this.xIm[k]) / xPow;
        const hIm = (this.mIm[k] * this.xRe[k] - this.mRe[k] * this.xIm[k]) / xPow;

        // EMA smooth güncelleme
        this.H_re[k] = this.ALPHA * this.H_re[k] + (1 - this.ALPHA) * hRe;
        this.H_im[k] = this.ALPHA * this.H_im[k] + (1 - this.ALPHA) * hIm;
      }

      // V(f) = Y(f) − H(f)·X(f)
      // Kompleks çarpma: H·X = (hr·xr − hi·xi) + j(hr·xi + hi·xr)
      this.vRe[k] = this.mRe[k] - (this.H_re[k] * this.xRe[k] - this.H_im[k] * this.xIm[k]);
      this.vIm[k] = this.mIm[k] - (this.H_re[k] * this.xIm[k] + this.H_im[k] * this.xRe[k]);

      // 1e. Spektral taban (Musical Noise Önleme — Aşama 3)
      //   Çıkarma bazı binalarda negatif güç üretebilir.
      //   V'nin büyüklüğünü Y'nin BETA katının altına düşürme.
      const vMag     = Math.sqrt(this.vRe[k] ** 2 + this.vIm[k] ** 2);
      const yMag     = Math.sqrt(this.mRe[k] ** 2 + this.mIm[k] ** 2);
      const floorMag = this.BETA * yMag;
      if (vMag > 0 && vMag < floorMag) {
        const s = floorMag / vMag;
        this.vRe[k] *= s;
        this.vIm[k] *= s;
      }
    }

    // 1f. IFFT — zaman domenine geri dön
    this.fft.inverse(this.vRe, this.vIm);
    // vRe: FDAF çıkışı = artık eko + kullanıcı sesi
    // vIm: ≈ 0 (gerçek sinyal özelliği)

    // ══════════════════════════════════════════════════════════════════════
    // AŞAMA 2 — NLMS: Zaman Domeninde Artık Eko Temizleme
    //   FDAF'ın gideremediği: hoparlör nonlinearity, gecikme artıkları
    //   Kazanım: +8–12dB ek baskılama
    //   Maliyet: O(64) per sample — FFT'den ~100x ucuz
    //
    //   Referans: orijinal refHist kullanılır (ham, işlenmemiş)
    //   Gerekçe: NLMS, H(f)'in kapsamadığı ilişkiyi öğrenir.
    //            İşlenmiş referans versarsa NLMS öğrenecek bir şey kalmaz.
    // ══════════════════════════════════════════════════════════════════════
    for (let i = 0; i < N; i++) {
      this.nlmsOut[i] = this.nlms.process(this.vRe[i], this.refHist[i]);
    }

    // ══════════════════════════════════════════════════════════════════════
    // AŞAMA 3 — Overlap-Add Sentezi
    //   %75 overlap + Hann penceresi → COLA koşulu sağlar
    //   Her sample 4 frame tarafından örtülür, OLA_SCALE=2/3 normalize eder
    // ══════════════════════════════════════════════════════════════════════
    for (let i = 0; i < N; i++) {
      this.olaBuf[i] += this.nlmsOut[i] * this.hann[i];
    }

    for (let i = 0; i < HOP; i++) {
      out[i] = this.olaBuf[i] * this.OLA_SCALE;
    }

    this.olaBuf.copyWithin(0, HOP);
    this.olaBuf.fill(0, N);

    return true;
  }
}

registerProcessor('aec-processor', AECProcessor);
