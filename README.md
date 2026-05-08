# reflex-aec

**Zero-dependency, ML-free acoustic echo cancellation for browser voice applications.**

Prevents a voice chatbot from hearing its own audio output — without machine learning models, without external libraries, and with full Safari iOS support.

---

## Why reflex-aec?

Most browser AEC solutions rely on:
- The browser's built-in `echoCancellation` constraint (unreliable on Safari iOS)
- ML-based libraries like `@ricky0123/vad-web` (~2MB WASM model)
- Server-side processing (adds latency)

reflex-aec takes a different approach: since the bot's audio is a **known digital signal**, it can be subtracted directly in the frequency domain — no room acoustics estimation, no neural networks, no guesswork.

---

## How It Works

```
Microphone input (user voice + bot echo)
         │
         ▼
┌─────────────────────────────┐
│  Stage 1 — FDAF             │  Frequency-domain adaptive filter
│  V(f) = Y(f) − H(f)·X(f)   │  ~25 dB echo suppression
│  H(f) updated via EMA       │  Gain + delay absorbed into H(f)
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│  Stage 2 — NLMS             │  Time-domain residual cancellation
│  Normalized LMS filter      │  +8–12 dB additional suppression
│  Handles speaker nonlinearity│
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│  Stage 3 — Spectral Floor   │  Musical noise prevention
│  |V(f)| ≥ β·|Y(f)|         │
└────────────┬────────────────┘
             │
             ▼
      Clean user voice
```

**Background audio guard:** If another app is playing audio (e.g. Spotify), the power ratio detector prevents `H(f)` from learning corrupted data.

---

## Browser Support

| Browser | AEC Works | Notes |
|---|---|---|
| Chrome (desktop) | ✅ | Full support |
| Firefox (desktop) | ✅ | Full support |
| Safari (macOS) | ✅ | Full support |
| Chrome (Android) | ✅ | Full support |
| **Safari (iOS)** | ✅ | Primary target — works where browser built-in fails |
| Edge | ✅ | Chromium-based |

---

## Installation

### Via CDN (no build step)
```html
<script src="https://cdn.jsdelivr.net/gh/XINMurat/reflex-aec/src/aec-main.js"></script>
```

### Via npm
```bash
npm install reflex-aec
```

---

## Quick Start

```javascript
import ChatbotAEC from 'reflex-aec';

const aec = new ChatbotAEC();

// Must be called inside a user gesture (click/touch) — required by browsers
document.getElementById('start-btn').addEventListener('click', async () => {
  await aec.init();

  // Route cleaned microphone to your STT service
  const dest = aec.audioCtx.createMediaStreamDestination();
  aec.aecNode.connect(dest);
  const cleanStream = dest.stream; // → feed to STT

  // When bot responds with audio
  const response = await fetch('/api/chat', { method: 'POST', body: userInput });
  const audioData = await response.arrayBuffer();

  await aec.playBotAudio(audioData); // plays audio + sends reference to AEC
  // Promise resolves when bot finishes speaking
});
```

---

## API Reference

### `new ChatbotAEC()`
Creates a new AEC instance.

### `await aec.init()`
Initializes AudioContext and AudioWorklet. Must be called inside a user gesture event handler.

### `await aec.playBotAudio(audioData: ArrayBuffer): Promise<void>`
Plays bot audio through the speaker while simultaneously sending the reference signal to the AEC processor. Resolves when playback ends and resets the filter state.

### `aec.setParams(params: object)`
Updates processing parameters at runtime.

| Parameter | Default | Range | Description |
|---|---|---|---|
| `alpha` | `0.92` | 0.5–0.99 | H(f) EMA smoothing. Higher = slower adaptation, more stable |
| `beta` | `0.02` | 0.01–0.1 | Spectral floor ratio. Lower = more aggressive subtraction |
| `mu` | `0.10` | 0.01–0.3 | NLMS step size. Higher = faster convergence, less stable |
| `ratioMax` | `5.0` | 2–20 | Background noise guard upper threshold |
| `ratioMin` | `0.01` | — | Background noise guard lower threshold |
| `nlmsOrder` | `64` | 32–256 | NLMS filter length. Use 128 for Bluetooth speakers |

### `aec.dispose()`
Disconnects nodes and closes AudioContext.

---

## Parameter Tuning Guide

**Quiet environment (home, private office):**
```javascript
aec.setParams({ alpha: 0.92, beta: 0.02, mu: 0.10, ratioMax: 5.0 })
```

**Noisy environment (open office, café):**
```javascript
aec.setParams({ alpha: 0.88, beta: 0.04, mu: 0.08, ratioMax: 8.0 })
```

**Bluetooth speaker (higher latency):**
```javascript
aec.setParams({ nlmsOrder: 128, mu: 0.05 })
```

---

## Architecture Notes

### Why frequency domain?

In the time domain, echo cancellation requires knowing both **gain** (how much the speaker attenuates) and **delay** (how long sound takes to reach the microphone) as separate parameters.

In the frequency domain, both are absorbed into a single complex transfer function `H(f)`:

```
H(f) = G · e^(-j2πfτ)
     = magnitude × phase
     = gain   ×  delay
```

Since the reference signal is the exact digital copy of what the speaker plays, `H(f)` converges in a few frames — unlike room acoustics AEC which may take seconds.

### Why NLMS as a second stage?

FDAF assumes a linear speaker model. Real speakers introduce nonlinear distortion, especially at high volumes. NLMS in the time domain handles this residual without requiring the full complexity of nonlinear system identification.

### Why Overlap-Add with 75% overlap?

The Constant Overlap-Add (COLA) condition with Hann windows at 75% overlap guarantees that each output sample is weighted by exactly 1.5 (sum of squared Hann values), which the `OLA_SCALE = 2/3` factor corrects. This eliminates frame-boundary artifacts.

---

## Limitations

| Limitation | Impact | Workaround |
|---|---|---|
| Reference timing accuracy | ±2.7ms sync error | Acceptable for voice; add BT delay offset for Bluetooth |
| Speaker nonlinearity | Residual echo at high volumes | NLMS stage reduces this significantly |
| Background audio (non-iOS) | H(f) may learn incorrect model | Background guard prevents this; restart H on detection |
| Safari iOS exclusive mic mode | Other apps ducked automatically | Actually beneficial — less interference |

---

## License

MIT © 2025

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Algorithm details: [docs/algorithm.md](docs/algorithm.md)
