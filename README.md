# reflex-aec

**Zero-dependency, ML-free acoustic echo cancellation for browser voice applications.**

Prevents a voice chatbot from hearing its own audio output — without machine learning models, without external libraries, and with full Safari iOS support.

[![npm version](https://img.shields.io/npm/v/reflex-aec)](https://www.npmjs.com/package/reflex-aec)
[![license](https://img.shields.io/npm/l/reflex-aec)](LICENSE)
[![bundle size](https://img.shields.io/badge/bundle-11.7kB-blue)](https://www.npmjs.com/package/reflex-aec)

---

## Live Demo

**[xinmurat.github.io/reflex-aec/demo/](https://xinmurat.github.io/reflex-aec/demo/)**

The demo lets you play a test tone through your speakers and see — in real time — the echo being cancelled. A scrolling dB history graph shows mic input (with echo) vs AEC output (cleaned). Toggle the bypass button to A/B compare.

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

**Reference signal routing:**
```
Reference Sources
  ├── Bot audio       (always available)
  │     AudioBufferSourceNode → BotGainNode → AEC inputs[1]
  └── System audio loopback   (optional — desktop Chrome/Edge)
        getDisplayMedia systemAudio → SysGainNode → AEC inputs[1]
        When active: covers ALL speaker output, not just bot audio
```
Both sources are summed at `inputs[1]` by WebAudio automatically — no extra mixing required.

**Background audio guard:** If another app is playing audio (e.g. Spotify), the power ratio detector prevents `H(f)` from learning corrupted data.

---

## Browser Support

| Platform | System Audio Loopback | Notes |
|---|---|---|
| Chrome / Windows | ✅ | Full support |
| Chrome / macOS | ⚠️ | Requires screen share permission |
| Firefox | ❌ | `getDisplayMedia` audio not supported |
| Safari iOS | ❌ | Not supported |
| Chrome Android | ❌ | Not supported |

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

### Via npm

```bash
npm install reflex-aec
```

### Via CDN (no build step)

```html
<script type="module">
  import ChatbotAEC from 'https://cdn.jsdelivr.net/npm/reflex-aec@1.0.1/src/aec-main.js';
</script>
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
Plays bot audio through the speaker while simultaneously routing the reference signal to the AEC processor via the AudioGraph (sample-accurate). Resolves when playback ends and resets the filter state.

### `await aec.enableSystemAudio(): Promise<{active, reason?}>`
Captures system audio via `getDisplayMedia` and adds it as a second reference source. Must be called from a user gesture (click handler). Falls back gracefully if the user denies or the browser doesn't support it.

```javascript
const result = await aec.enableSystemAudio();
if (result.active) {
  console.log('System audio loopback active');
} else {
  console.warn('Unavailable:', result.reason);
}
```

### `aec.getSystemAudioStatus()`
Returns the current system audio state.

```javascript
const { supported, active } = aec.getSystemAudioStatus();
```

| Field | Type | Description |
|---|---|---|
| `supported` | `boolean` | `getDisplayMedia` available in this browser |
| `active` | `boolean` | System audio loopback currently running |

### `aec.bypass(value: boolean)`
Toggles bypass mode. When `true`, mic signal passes through unprocessed. Useful for A/B comparison during testing.

```javascript
aec.bypass(true);   // raw mic — echo audible
aec.bypass(false);  // AEC on — echo cancelled
```

### `aec.setParams(params: object)`
Updates processing parameters at runtime.

| Parameter | Default | Range | Description |
|---|---|---|---|
| `alpha` | `0.85` | 0.5–0.99 | H(f) EMA smoothing. Higher = slower adaptation, more stable |
| `beta` | `0.02` | 0.01–0.1 | Spectral floor ratio. Lower = more aggressive subtraction |
| `mu` | `0.05` | 0.01–0.3 | NLMS step size. Higher = faster convergence, less stable |
| `ratioMax` | `5.0` | 2–20 | Background noise guard upper threshold |
| `ratioMin` | `0.01` | — | Background noise guard lower threshold |
| `nlmsOrder` | `64` | 32–256 | NLMS filter length. Use 128 for Bluetooth speakers |

### `aec.dispose()`
Disconnects nodes and closes AudioContext.

---

## Parameter Tuning Guide

**Quiet environment (home, private office):**
```javascript
aec.setParams({ alpha: 0.85, beta: 0.02, mu: 0.05, ratioMax: 5.0 })
```

**Noisy environment (open office, café):**
```javascript
aec.setParams({ alpha: 0.80, beta: 0.04, mu: 0.04, ratioMax: 8.0 })
```

**Bluetooth speaker (higher latency):**
```javascript
aec.setParams({ nlmsOrder: 128, mu: 0.03 })
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

### Why route reference via AudioGraph?

The reference signal is connected as a second input to the AudioWorkletNode (`inputs[1]`). This gives **sample-accurate synchronization** — both mic and reference are delivered to the same `process()` callback in the same audio thread tick, with no `setTimeout` jitter.

### Why NLMS as a second stage?

FDAF assumes a linear speaker model. Real speakers introduce nonlinear distortion, especially at high volumes. NLMS in the time domain handles this residual without requiring the full complexity of nonlinear system identification.

### Why Overlap-Add with 75% overlap?

The Constant Overlap-Add (COLA) condition with Hann windows at 75% overlap guarantees that each output sample is weighted by exactly 1.5 (sum of squared Hann values), which the `OLA_SCALE = 2/3` factor corrects. This eliminates frame-boundary artifacts.

---

## Limitations

| Limitation | Impact | Workaround |
|---|---|---|
| Acoustic path delay | Speaker nonlinearity adds delay not in digital reference | NLMS stage compensates up to ~1.3ms; use `nlmsOrder: 128` for Bluetooth |
| Speaker nonlinearity | Residual echo at high volumes | NLMS stage reduces this significantly |
| Background audio (non-iOS) | H(f) may learn incorrect model | Background guard prevents this; restart H on detection |
| Safari iOS exclusive mic mode | Other apps ducked automatically | Actually beneficial — less interference |

---

## License

MIT © 2026

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Algorithm details: [docs/algorithm.md](docs/algorithm.md)
