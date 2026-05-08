# Changelog

All notable changes to reflex-aec will be documented here.

Format: [Semantic Versioning](https://semver.org)

---

## [1.0.1] — 2026-05-08

### Bug fixes

- **Reference signal now routed via AudioGraph (`inputs[1]`) instead of `postMessage` chunks** — eliminates `setTimeout` timing jitter that was preventing echo cancellation
- **NLMS weight update restricted to new HOP samples only** — fixes voice attenuation caused by re-processing old OLA frames on every callback
- ALPHA default `0.92 → 0.85` for faster H(f) convergence
- Default mu `0.10 → 0.05` for less aggressive NLMS adaptation

### New features

- `aec.bypass(true/false)` — toggle passthrough mode for A/B comparison

### Breaking change

`playBotAudio()` now routes the reference signal through the AudioGraph automatically. The previous `postMessage`-based chunk sending is removed. No API change required — the method signature is unchanged.

---

## [1.0.0] — 2026-05-08

### Initial release

**Core algorithm:**
- Cooley-Tukey Radix-2 DIT FFT (512-point, zero dependencies)
- Frequency-Domain Adaptive Filter (FDAF) with EMA-smoothed H(f) estimation
- NLMS second stage for residual echo and speaker nonlinearity
- Overlap-Add synthesis with 75% Hann window overlap (COLA-compliant)
- Spectral floor to prevent musical noise artifacts

**Background audio guard:**
- EMA-smoothed mic/ref power ratio tracking
- H(f) update suppression when background audio detected (ratio > RATIO_MAX)
- Freeze-not-reset behavior preserves last valid model during contamination

**Runtime parameter control:**
- `alpha` — H(f) EMA smoothing
- `beta` — spectral floor ratio
- `mu` — NLMS step size
- `ratioMax` / `ratioMin` — background guard thresholds
- `nlmsOrder` — NLMS filter length

**Safari iOS notes:**
- `echoCancellation: false` in getUserMedia prevents pipeline conflict
- AudioContext initialized inside user gesture handler
- Tested: iOS 16, 17 (Safari)

---

## Planned

- [ ] Double-talk detection (freeze H when user and bot speak simultaneously)
- [ ] WebAssembly FFT option
- [ ] TypeScript definitions
- [ ] Automated browser test suite (Playwright)
