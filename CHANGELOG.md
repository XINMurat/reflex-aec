# Changelog

All notable changes to reflex-aec will be documented here.

Format: [Semantic Versioning](https://semver.org)

---

## [1.0.0] — 2025

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
