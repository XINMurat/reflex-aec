# reflex-aec v1.1.1

**Zero-dependency, ML-free acoustic echo cancellation for browser voice applications.**

Live demo: **[xinmurat.github.io/reflex-aec/demo/](https://xinmurat.github.io/reflex-aec/demo/)**

---

## What's New in v1.1.x

### v1.1.1
- README: CDN link updated to `@1.1.0`, `init()` `requestSystemAudio` option documented

### v1.1.0 — System Audio Loopback
- `enableSystemAudio()` — captures ALL speaker output via `getDisplayMedia` as AEC reference
- `getSystemAudioStatus()` — query support and active state
- Reference graph: `BotGainNode + SysGainNode → AEC inputs[1]`, summed by WebAudio

### v1.0.1 — Critical Bug Fixes
- **Reference signal now routed via AudioGraph (`inputs[1]`)** — eliminates `setTimeout` timing jitter
- **NLMS weight update restricted to new HOP samples only** — fixes voice attenuation
- `aec.bypass(true/false)` — A/B comparison mode
- ALPHA default `0.92 → 0.85`, mu `0.10 → 0.05`

---

## Architecture

```
Microphone
    │
    ▼
Stage 1 — FDAF      V(f) = Y(f) − H(f)·X(f)    ~25 dB suppression
    │
    ▼
Stage 2 — NLMS      Residual + nonlinearity      +8–12 dB
    │
    ▼
Stage 3 — Spectral floor    Musical noise prevention
    │
    ▼
Clean user voice
```

Reference routing (sample-accurate via AudioGraph):
```
Bot AudioBufferSourceNode → BotGainNode ──┐
                                           ├── AEC inputs[1]
System audio (getDisplayMedia) → SysGain ─┘
```

---

## What's Included

| File | Description |
|---|---|
| `src/aec-processor.js` | AudioWorklet DSP — FFT, NLMS, OLA, bypass mode |
| `src/aec-main.js` | Main thread wrapper — system audio loopback, AudioGraph reference |
| `demo/index.html` | Live demo — waveform, dB history graph, frequency spectrum |
| `test/aec.test.js` | 12 unit tests — all passing |
| `docs/algorithm.md` | Mathematical derivation |

## Test Results

```
FFT         5/5 passed
NLMS        6/6 passed  (incl. updateWeights=false mode)
FDAF        2/2 passed  (incl. dual-source power test)
Total:     12/12 passed
```

## Browser Support

| Browser | AEC | System Audio Loopback |
|---|---|---|
| Chrome / Windows | ✅ | ✅ |
| Chrome / macOS | ✅ | ⚠️ screen share permission |
| Firefox | ✅ | ❌ |
| Safari iOS | ✅ | ❌ |
| Chrome Android | ✅ | ❌ |

## License

MIT © 2026 Reflex-AEC Contributors
