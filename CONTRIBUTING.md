# Contributing to reflex-aec

Thank you for your interest. Contributions are welcome — especially around browser compatibility, parameter tuning, and test coverage.

---

## Getting Started

```bash
git clone https://github.com/yourusername/reflex-aec.git
cd reflex-aec
```

No build step required. The project has zero dependencies.

**Run tests:**
```bash
node test/aec.test.js
```

**Run the demo:**
```bash
# Any static file server works:
npx serve .
# Then open http://localhost:3000/demo/
```

The demo must be served over HTTP (not `file://`) due to AudioWorklet restrictions.

---

## What to Contribute

### High priority
- **Safari iOS testing** — Real device test results with iOS version numbers
- **Bluetooth speaker latency** — Measured delay offsets for common devices
- **Parameter presets** — Tuned `alpha/beta/mu` values for specific environments

### Medium priority
- **Double-talk detection** — H(f) should also freeze when user speaks simultaneously with bot
- **WebAssembly FFT** — Drop-in replacement for the JS FFT for performance-critical scenarios
- **TypeScript definitions** — `.d.ts` file for `aec-main.js`

### Lower priority
- Additional demo scenarios
- Documentation improvements

---

## Code Guidelines

**Language:** Vanilla JavaScript (ES2020+). No TypeScript compilation step, no bundler.

**Comments:** All DSP code must be commented with the mathematical operation being performed. A developer unfamiliar with adaptive filters should be able to understand what each block does.

**Variable naming:**
- FFT buffers: `re`, `im` suffix (e.g. `mRe`, `mIm` for microphone)
- Filters: use established names (`H_re`, `nlms`, `hann`)
- Avoid abbreviations outside DSP conventions

**No GC in `process()`:** The AudioWorklet `process()` method runs in a real-time thread. Do not allocate new objects (`new Float32Array`, `new Array`, etc.) inside `process()`. Pre-allocate everything in the constructor.

**Numeric stability:** Always guard divisions with a minimum denominator (`+ 1e-8` or similar). The audio pipeline should never produce `NaN` or `Infinity`.

---

## Pull Request Process

1. Fork the repository
2. Create a branch: `git checkout -b feature/your-feature`
3. Make changes and add/update tests
4. Run `node test/aec.test.js` — all tests must pass
5. Open a PR with a clear description of what changed and why

For significant algorithm changes, include:
- Before/after echo suppression measurements (even informal ones)
- Which browsers/devices were tested

---

## Reporting Issues

When filing a bug, please include:
- Browser name and version
- OS and version (especially iOS version for Safari issues)
- Whether the issue is with the demo or your own integration
- Console errors if any

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
