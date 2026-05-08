# Algorithm Reference — reflex-aec

## Problem Formulation

In a voice chatbot application, the microphone captures:

```
y[n] = s[n] + e[n] + v[n]
```

Where:
- `y[n]` — microphone signal
- `s[n]` — user's voice (desired signal)
- `e[n]` — echo: bot audio routed back through the speaker into the microphone
- `v[n]` — ambient noise
- `n`    — discrete time index

The goal is to recover `s[n]` given `y[n]` and `x[n]` (the known reference: exact digital copy of bot audio).

---

## Stage 1 — Frequency-Domain Adaptive Filter (FDAF)

### Signal Model

In the frequency domain (after DFT of length N):

```
Y(f) = H(f) · X(f) + V(f)
```

Where `H(f)` is the complex acoustic transfer function from speaker to microphone:

```
H(f) = G · e^(-j2πfτ)
```

- `G` — acoustic gain (speaker volume, distance, room absorption)
- `τ` — propagation delay (speaker → air → microphone)
- `f` — frequency bin index

**Key insight:** Both gain and delay are encoded in the magnitude and phase of the single complex number `H(f)` per bin. No separate estimation required.

### Transfer Function Estimation

At each FFT frame, `H(f)` is estimated via complex division:

```
Ĥ(f) = Y(f) / X(f)
```

This is the Wiener-Hopf solution for the linear case when the reference is exact.

To avoid instability from noisy instantaneous estimates, an Exponential Moving Average (EMA) is applied:

```
H_new(f) = α · H_old(f) + (1 - α) · Ĥ(f)
```

Where `α ∈ [0, 1]` is the smoothing factor:
- `α → 1`: slow adaptation, stable (recommended for static environments)
- `α → 0`: fast adaptation, may track noise

Update is suppressed when reference power is below threshold `ε`:

```
|X(f)|² < ε  →  H(f) unchanged
```

### Echo Estimation and Subtraction

```
V̂(f) = Y(f) − H(f) · X(f)
```

Complex multiplication `H(f) · X(f)`:

```
Re[H·X] = Re[H]·Re[X] − Im[H]·Im[X]
Im[H·X] = Re[H]·Im[X] + Im[H]·Re[X]
```

### Spectral Floor (Musical Noise Prevention)

Spectral subtraction can produce negative power estimates in some bins, which manifests as metallic tonal artifacts ("musical noise"). A spectral floor prevents this:

```
if |V̂(f)| < β · |Y(f)|:
    V̂(f) ← V̂(f) · (β · |Y(f)| / |V̂(f)|)
```

The phase is preserved; only the magnitude is floored. `β = 0.02` is the default.

---

## Stage 2 — Normalized Least Mean Squares (NLMS)

### Motivation

FDAF assumes a linear transfer path. Real loudspeakers introduce:
- Harmonic distortion (especially at high SPL)
- Intermodulation distortion
- Membrane nonlinearities

These residuals are not cancelled by `H(f)`. The NLMS filter in the time domain handles them as a second-stage post-filter.

### Algorithm

Given the FDAF output `v[n]` (residual + user voice) and reference `x[n]`:

**Filter output (estimated residual echo):**
```
ê[n] = wᵀ[n] · x[n]    (dot product, length-L filter)
```

**Error signal:**
```
e[n] = v[n] − ê[n]
```

**Weight update:**
```
w[n+1] = w[n] + (μ / (‖x[n]‖² + ε)) · e[n] · x[n]
```

Where:
- `L`  — filter order (default: 64)
- `μ`  — step size (default: 0.1)
- `ε`  — regularization constant (default: 1e-6)
- `‖x[n]‖²` — power of the reference vector (normalization)

**Why NLMS over LMS?**

LMS uses a fixed step `μ`, which is unstable when reference power varies (e.g. quiet to loud bot audio). NLMS normalizes by `‖x‖²`, making convergence rate independent of reference signal power.

### Filter Length Selection

After FDAF removes the bulk of the linear echo, the residual is small. A short filter (L=64 taps ≈ 1.3ms at 48kHz) is sufficient for most cases.

For Bluetooth speakers with additional hardware latency (typically 50–150ms), increase to L=128 and add a corresponding reference delay offset in `playBotAudio()`.

---

## Stage 3 — Overlap-Add Synthesis

### COLA Condition

The Constant Overlap-Add (COLA) condition ensures that the synthesis is artifact-free at frame boundaries.

For Hann windows of length N with hop size H = N/4 (75% overlap):

```
∑_k  hann²(n + k·H) = 1.5    ∀n
```

This sum is constant for all sample positions `n`, meaning each output sample is covered by exactly 4 frames with total weight 1.5.

The output is scaled by `OLA_SCALE = 2/3 = 1/1.5` to normalize.

### Frame Parameters

| Parameter | Value | Rationale |
|---|---|---|
| FFT size N | 512 | 10.67ms at 48kHz — good frequency resolution for voice |
| Hop size H | 128 | AudioWorklet fixed block size = N/4 = 75% overlap |
| Analysis window | Hann | COLA-compliant, low spectral leakage |
| Synthesis window | Hann | Symmetric — analysis × synthesis = Hann² |

---

## Background Audio Guard

### Problem

If another application plays audio concurrently (e.g. music streaming), the microphone captures:

```
Y(f) = H_bot(f)·X_bot(f) + H_bg(f)·X_bg(f) + V(f)
```

Only `X_bot(f)` is available as reference. Estimating `H(f)` in this state causes `H(f)` to absorb the background component, corrupting future echo cancellation.

### Detection

The power ratio between microphone and reference is tracked via EMA:

```
μ_mic[n] = α_s · μ_mic[n-1] + (1 - α_s) · |Y(f)|²_avg
μ_ref[n] = α_s · μ_ref[n-1] + (1 - α_s) · |X(f)|²_avg
ratio = μ_mic / μ_ref
```

`H(f)` update is suppressed when:

```
ratio > R_max   (background audio present — mic power unexpectedly high)
ratio < R_min   (bot not speaking — reference too weak to be meaningful)
```

The current `H(f)` estimate is frozen (not reset) during suppression, preserving the last valid model.

`α_s = 0.95` provides ~20 frame averaging at 48kHz/128 hop, smoothing transient spikes.

---

## Computational Complexity

| Stage | Cost per frame | Notes |
|---|---|---|
| FFT (N=512) | O(N log N) = O(4608) | Cooley-Tukey Radix-2 |
| H(f) update | O(N) = O(512) | Per-bin complex division + EMA |
| V(f) subtraction | O(N) = O(512) | Per-bin complex multiply + subtract |
| IFFT | O(N log N) = O(4608) | Same as FFT |
| NLMS (L=64) | O(L·H) = O(8192) | Per sample, 128 samples per frame |
| OLA | O(N) = O(512) | Windowing + accumulate |
| **Total** | **~18,944 ops/frame** | ~142,080 ops/sec at 48kHz |

Modern browser JS engines handle this comfortably within the AudioWorklet's real-time budget (~2.67ms per frame at 48kHz/128 hop).

---

## References

1. Haykin, S. (2002). *Adaptive Filter Theory* (4th ed.). Prentice Hall.
   — NLMS derivation and convergence analysis (Chapter 9)

2. Benesty, J., Gänsler, T., Morgan, D. R., Sondhi, M. M., & Gay, S. L. (2001).
   *Advances in Network and Acoustic Echo Cancellation*. Springer.
   — Frequency-domain AEC formulation

3. Allen, J. B., & Rabiner, L. R. (1977). A unified approach to short-time Fourier analysis and synthesis.
   *Proceedings of the IEEE*, 65(11), 1558–1564.
   — Overlap-Add method and COLA conditions

4. Boll, S. F. (1979). Suppression of acoustic noise in speech using spectral subtraction.
   *IEEE Transactions on Acoustics, Speech, and Signal Processing*, 27(2), 113–120.
   — Spectral subtraction and musical noise
