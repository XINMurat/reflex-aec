// test/aec.test.js
// Node.js birim testleri — FFT ve NLMS algoritmalarını doğrular.
// Çalıştırma: node test/aec.test.js

// ── FFT ve NLMSFilter sınıflarını test ortamına taşı ───────────────────────
// AudioWorkletProcessor browser API'si gerektirdiğinden burada sadece
// algoritma çekirdeklerini izole ediyoruz.

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
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cosT[k * step], wi = this.sinT[k * step];
          const ur = re[i+k], ui = im[i+k];
          const vr = re[i+k+half]*wr - im[i+k+half]*wi;
          const vi = re[i+k+half]*wi + im[i+k+half]*wr;
          re[i+k]=ur+vr; im[i+k]=ui+vi; re[i+k+half]=ur-vr; im[i+k+half]=ui-vi;
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

// v2.1: updateWeights parametresi eklendi.
// updateWeights=false: filtrele ama katsayıları güncelleme.
// Processor'da OLA geçmişindeki sample'lar için kullanılır — ses kısılmasını önler.
class NLMSFilter {
  constructor(order = 64, mu = 0.1) {
    this.order = order; this.MU = mu; this.EPS = 1e-6;
    this.w = new Float32Array(order);
    this.xBuf = new Float32Array(order);
    this.xIdx = 0;
  }
  process(micSample, refSample, updateWeights = true) {
    this.xBuf[this.xIdx] = refSample;
    this.xIdx = (this.xIdx + 1) % this.order;
    let echo = 0;
    for (let i = 0; i < this.order; i++)
      echo += this.w[i] * this.xBuf[(this.xIdx + i) % this.order];
    const err = micSample - echo;
    if (updateWeights) {
      let xPow = this.EPS;
      for (let i = 0; i < this.order; i++) xPow += this.xBuf[i] ** 2;
      const step = this.MU / xPow;
      for (let i = 0; i < this.order; i++)
        this.w[i] += step * err * this.xBuf[(this.xIdx + i) % this.order];
    }
    return err;
  }
  reset() { this.w.fill(0); this.xBuf.fill(0); this.xIdx = 0; }
}

// ── Test framework (sıfır bağımlılık) ─────────────────────────────────────
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertNear(a, b, tol = 1e-4, msg) {
  const diff = Math.abs(a - b);
  if (diff > tol) throw new Error(
    msg || `Expected ${a} ≈ ${b} (diff=${diff.toExponential(2)}, tol=${tol})`
  );
}

// ── FFT Testleri ───────────────────────────────────────────────────────────
console.log('\nFFT');

test('DC sinyali — tüm güç bin 0\'da olmalı', () => {
  const N = 64;
  const fft = new FFT(N);
  const re = new Float32Array(N).fill(1.0);
  const im = new Float32Array(N);
  fft.forward(re, im);
  assertNear(re[0], N, 0.01, `re[0]=${re[0]}, beklenen=${N}`);
  for (let k = 1; k < N; k++) {
    assertNear(re[k], 0, 0.001, `DC: re[${k}]=${re[k]} sıfır olmalı`);
    assertNear(im[k], 0, 0.001, `DC: im[${k}]=${im[k]} sıfır olmalı`);
  }
});

test('Tek frekans — doğru binde enerji', () => {
  const N = 64, K = 8; // bin 8
  const fft = new FFT(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let n = 0; n < N; n++) re[n] = Math.cos(2 * Math.PI * K * n / N);
  fft.forward(re, im);
  const mag8  = Math.sqrt(re[8]**2 + im[8]**2);
  const mag56 = Math.sqrt(re[N-K]**2 + im[N-K]**2); // simetrik konjugat
  assertNear(mag8,  N/2, 0.1, `Bin 8 büyüklüğü ≈ N/2=${N/2}, bulundu=${mag8.toFixed(3)}`);
  assertNear(mag56, N/2, 0.1, `Bin 56 büyüklüğü ≈ N/2=${N/2}, bulundu=${mag56.toFixed(3)}`);
  // Diğer binler sıfır olmalı
  for (let k = 1; k < N; k++) {
    if (k === K || k === N - K) continue;
    const mag = Math.sqrt(re[k]**2 + im[k]**2);
    assertNear(mag, 0, 0.01, `Leakage: bin[${k}]=${mag.toFixed(4)}`);
  }
});

test('İleri + ters FFT — özdeşlik', () => {
  const N = 128;
  const fft = new FFT(N);
  const orig = Float32Array.from({ length: N }, () => Math.random() * 2 - 1);
  const re = new Float32Array(orig);
  const im = new Float32Array(N);
  fft.forward(re, im);
  fft.inverse(re, im);
  for (let i = 0; i < N; i++) {
    assertNear(re[i], orig[i], 1e-5, `Özdeşlik hatası: i=${i} re=${re[i].toFixed(6)} orig=${orig[i].toFixed(6)}`);
  }
});

test('Parsevals teoremi — enerji korunumu', () => {
  const N = 64;
  const fft = new FFT(N);
  const re = Float32Array.from({ length: N }, (_, i) => Math.sin(2 * Math.PI * 3 * i / N));
  const im = new Float32Array(N);
  const energyTime = re.reduce((s, v) => s + v * v, 0);
  fft.forward(re, im);
  const energyFreq = re.reduce((s, v, i) => s + v * v + im[i] ** 2, 0) / N;
  assertNear(energyTime, energyFreq, 0.01,
    `Parseval: zaman=${energyTime.toFixed(4)}, frekans=${energyFreq.toFixed(4)}`);
});

test('2\'nin kuvveti olmayan boyut hata vermeli', () => {
  try {
    new FFT(100);
    assert(false, 'Hata fırlatılmadı');
  } catch (e) {
    assert(e.message.includes('2^k'), `Yanlış hata mesajı: ${e.message}`);
  }
});

// ── NLMS Testleri ──────────────────────────────────────────────────────────
console.log('\nNLMS');

test('Saf eko — yakınsama sonrası sıfır hata', () => {
  // Mikrofon = sadece eko (kullanıcı sesi yok)
  // NLMS tam olarak öğrenmeli → hata ≈ 0
  const filter = new NLMSFilter(32, 0.3);
  const DELAY = 5; // sample gecikme simülasyonu
  const ref = new Float32Array(500).map(() => (Math.random() * 2 - 1) * 0.5);
  const GAIN = 0.4;

  let lastErr = Infinity;
  for (let n = DELAY; n < ref.length; n++) {
    const mic = GAIN * ref[n - DELAY]; // Saf eko, kullanıcı sesi yok
    const err = filter.process(mic, ref[n]);
    lastErr = Math.abs(err);
  }
  assert(lastErr < 0.02, `Son hata çok yüksek: ${lastErr.toFixed(5)} (beklenen < 0.02)`);
});

test('Kullanıcı sesi korunur — eko giderilirken sinyal kaybolmaz', () => {
  const filter = new NLMSFilter(32, 0.3);
  const ref = new Float32Array(500).map(() => (Math.random() * 2 - 1) * 0.3);
  const userFreq = 440; // Hz (simüle)
  const SR = 48000;

  let totalUserPow = 0, totalOutPow = 0;
  for (let n = 5; n < ref.length; n++) {
    const userSample = 0.5 * Math.sin(2 * Math.PI * userFreq * n / SR);
    const echoSample = 0.4 * ref[n - 5];
    const mic = userSample + echoSample;
    const out = filter.process(mic, ref[n]);
    totalUserPow += userSample ** 2;
    totalOutPow  += out ** 2;
  }
  // Çıkış gücü kullanıcı gücünün en az %60'ı olmalı
  const ratio = totalOutPow / totalUserPow;
  assert(ratio > 0.6, `Kullanıcı sesi çok zayıfladı: güç oranı=${ratio.toFixed(3)} (beklenen > 0.6)`);
});

test('Reset — sıfırlama sonrası katsayılar sıfır', () => {
  const filter = new NLMSFilter(32, 0.3);
  const ref = new Float32Array(300).map(() => Math.random() - 0.5);
  // 300 sample öğren
  for (let n = 5; n < 300; n++) filter.process(0.4 * ref[n - 5], ref[n]);

  filter.reset();
  // Sıfırlama sonrası katsayılar sıfır olmalı
  const wSum = filter.w.reduce((s, v) => s + Math.abs(v), 0);
  assertNear(wSum, 0, 1e-9, `Reset sonrası katsayı toplamı=${wSum}`);
});

test('updateWeights=false — katsayılar değişmemeli', () => {
  // v2.1 özelliği: OLA geçmişindeki eski sample'lar için katsayı güncellenmez.
  // Bu sayede kullanıcı sesinin kısılması önlenir.
  const filter = new NLMSFilter(16, 0.3);
  const ref = new Float32Array(50).map(() => Math.random() - 0.5);

  // Önce birkaç iterasyon öğren
  for (let n = 2; n < 50; n++) filter.process(0.4 * ref[n - 2], ref[n]);

  // Katsayıları kaydet
  const wBefore = new Float32Array(filter.w);

  // updateWeights=false ile çalıştır
  for (let n = 2; n < 50; n++) filter.process(0.4 * ref[n - 2], ref[n], false);

  // Katsayılar değişmemiş olmalı
  for (let i = 0; i < filter.order; i++) {
    assertNear(filter.w[i], wBefore[i], 1e-9,
      `Katsayı değişti: w[${i}]=${filter.w[i].toFixed(8)} vs ${wBefore[i].toFixed(8)}`);
  }
});

test('NLMS — sıfır güç referansında kararlı', () => {
  const filter = new NLMSFilter(16, 0.5);
  // Sıfır referansla 100 iteration — NaN veya Infinity üretmemeli
  for (let i = 0; i < 100; i++) {
    const out = filter.process(0.1, 0);
    assert(isFinite(out), `Sonsuz çıkış: i=${i} out=${out}`);
  }
});

// ── Frekans Domeninde Eko Çıkarma Entegrasyon Testi ───────────────────────
console.log('\nFDAF Integration');

test('H(f) tahmini — bilinen transfer fonksiyonu ile yakınsama', () => {
  // Bilinen H: tüm frekanslarda gain=0.5, gecikme=0
  // Y(f) = 0.5 · X(f) → H tahmin edilmeli ≈ 0.5 + 0j
  const N = 256;
  const fft = new FFT(N);
  const H_re = new Float32Array(N);
  const H_im = new Float32Array(N);
  const ALPHA = 0.85;
  const TRUE_GAIN = 0.5;

  for (let iter = 0; iter < 200; iter++) {
    const xRe = Float32Array.from({ length: N }, () => Math.random() - 0.5);
    const xIm = new Float32Array(N);
    fft.forward(xRe, xIm);

    // Y = 0.5 * X (bilinen transfer fonksiyonu)
    const yRe = xRe.map(v => TRUE_GAIN * v);
    const yIm = xIm.map(v => TRUE_GAIN * v);

    for (let k = 0; k < N; k++) {
      const xPow = xRe[k]**2 + xIm[k]**2;
      if (xPow < 1e-8) continue;
      const hRe = (yRe[k]*xRe[k] + yIm[k]*xIm[k]) / xPow;
      const hIm = (yIm[k]*xRe[k] - yRe[k]*xIm[k]) / xPow;
      H_re[k] = ALPHA * H_re[k] + (1 - ALPHA) * hRe;
      H_im[k] = ALPHA * H_im[k] + (1 - ALPHA) * hIm;
    }
  }

  // Bin 10-100 arası kontrol (DC ve Nyquist hariç)
  let maxErr = 0;
  for (let k = 10; k < 100; k++) {
    const errRe = Math.abs(H_re[k] - TRUE_GAIN);
    const errIm = Math.abs(H_im[k]);
    maxErr = Math.max(maxErr, errRe, errIm);
  }
  assert(maxErr < 0.05, `H(f) yakınsama hatası çok yüksek: ${maxErr.toFixed(4)} (beklenen < 0.05)`);
});

// ── Reference Signal Merge Test ───────────────────────────────────────────
console.log('\nReference Merge');

test('Two sources merged — combined power equals sum of individual powers', () => {
  // Tam bin frekansları kullan: ortogonallik garantisi için.
  // Bin aralığı = SR/N = 48000/256 = 187.5 Hz
  // bin 2 = 375 Hz,  bin 5 = 937.5 Hz
  const N  = 256;
  const SR = 48000;
  const f1 = 2 * SR / N;  // exact bin 2
  const f2 = 5 * SR / N;  // exact bin 5

  const bot = Float32Array.from({ length: N }, (_, i) =>
    0.4 * Math.sin(2 * Math.PI * f1 * i / SR));
  const sys = Float32Array.from({ length: N }, (_, i) =>
    0.3 * Math.sin(2 * Math.PI * f2 * i / SR));

  const merged = new Float32Array(N);
  for (let i = 0; i < N; i++) merged[i] = bot[i] + sys[i];

  const botPow   = bot.reduce((s, v) => s + v * v, 0) / N;
  const sysPow   = sys.reduce((s, v) => s + v * v, 0) / N;
  const mergePow = merged.reduce((s, v) => s + v * v, 0) / N;

  assertNear(mergePow, botPow + sysPow, 0.001,
    `Merged power error: merge=${mergePow.toFixed(4)}, bot+sys=${(botPow + sysPow).toFixed(4)}`);
});

// ── Sonuç ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Toplam: ${passed + failed} test | ✓ ${passed} geçti | ✗ ${failed} başarısız`);
if (failed > 0) process.exit(1);
