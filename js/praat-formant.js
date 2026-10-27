/*
 * praat-formant.js
 * Praat "Sound: To Formant (burg)..."과 같은 계산을 JavaScript로 옮긴 것.
 * 바탕 논문(parselmouth 0.4.7, Praat 6.1.38 엔진)의 설정을 그대로 쓴다:
 *   시간 간격 0.01 s, 최대 포먼트 5개(LPC 차수 10), 분석 창 0.025 s(실제 가우시안 창 0.05 s),
 *   선강조 50 Hz, 상한 남 5000 Hz / 여 5500 Hz / 아동 별도.
 * 순서: (필요하면) 2×상한으로 리샘플(FFT 저역통과 + sinc 보간, 정밀도 50)
 *       → 선강조 → 프레임마다 가우시안 창 → Burg LPC → 다항식 근 → 단위원 안으로 → 주파수·대역폭
 * 브라우저와 Node 양쪽에서 같은 코드로 돌아간다(원어민 기준값도 이 파일로 계산).
 */
(function (root) {
  "use strict";

  // ---------- FFT (radix-2, 복소수, 제자리) ----------
  function fft(re, im, inverse) {
    const n = re.length;
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
      const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  // ---------- Praat NUM_interpolate_sinc (y는 0-based 배열, x는 1-based 위치) ----------
  function interpolateSinc(y, x, maxDepth) {
    const n = y.length;
    const midleft = Math.floor(x), midright = midleft + 1;
    if (x < 1 || x > n) return 0;
    if (x === midleft) return y[midleft - 1];
    if (maxDepth > midright - 1) maxDepth = midright - 1;
    if (maxDepth > n - midleft) maxDepth = n - midleft;
    if (maxDepth <= 0) return y[Math.round(x) - 1];
    if (maxDepth === 1) return y[midleft - 1] + (x - midleft) * (y[midright - 1] - y[midleft - 1]);
    if (maxDepth === 2) {
      const yl = y[midleft - 1], yr = y[midright - 1];
      const dyl = 0.5 * (yr - y[midleft - 2]), dyr = 0.5 * (y[midright] - yl);
      const fil = x - midleft, fir = midright - x;
      return yl * fir + yr * fil - fil * fir * (0.5 * (dyr - dyl) + (fil - 0.5) * (dyl + dyr - 2 * (yr - yl)));
    }
    const left = midright - maxDepth, right = midleft + maxDepth;
    let result = 0;
    let a = Math.PI * (x - midleft);
    let halfsina = 0.5 * Math.sin(a);
    let aa = a / (x - left + 1), daa = Math.PI / (x - left + 1);
    let cosaa = Math.cos(aa), sinaa = Math.sin(aa), cosdaa = Math.cos(daa), sindaa = Math.sin(daa);
    for (let ix = midleft; ix >= left; ix--) {
      result += y[ix - 1] * (halfsina / a * (1 + cosaa));
      a += Math.PI;
      const h = cosaa * cosdaa - sinaa * sindaa;
      sinaa = cosaa * sindaa + sinaa * cosdaa; cosaa = h;
      halfsina = -halfsina;
    }
    a = Math.PI * (midright - x);
    halfsina = 0.5 * Math.sin(a);
    aa = a / (right - x + 1); daa = Math.PI / (right - x + 1);
    cosaa = Math.cos(aa); sinaa = Math.sin(aa); cosdaa = Math.cos(daa); sindaa = Math.sin(daa);
    for (let ix = midright; ix <= right; ix++) {
      result += y[ix - 1] * (halfsina / a * (1 + cosaa));
      a += Math.PI;
      const h = cosaa * cosdaa - sinaa * sindaa;
      sinaa = cosaa * sindaa + sinaa * cosdaa; cosaa = h;
      halfsina = -halfsina;
    }
    return result;
  }

  // ---------- Sound 객체: {z: Float64Array, dx, x1, xmin, xmax} ----------
  function makeSound(samples, fs) {
    const n = samples.length, dx = 1 / fs;
    return { z: Float64Array.from(samples), dx: dx, x1: 0.5 * dx, xmin: 0, xmax: n * dx };
  }

  // Praat Sound_resample(me, fs, 50)
  function resample(me, fs, precision) {
    precision = precision || 50;
    const nx = me.z.length;
    const upfactor = fs * me.dx;
    if (Math.abs(upfactor - 1) < 1e-6) {
      return { z: Float64Array.from(me.z), dx: me.dx, x1: me.x1, xmin: me.xmin, xmax: me.xmax };
    }
    let src = me.z;
    if (upfactor < 1) {
      const anti = 1000;
      let nfft = 1;
      while (nfft < nx + anti * 2) nfft *= 2;
      const re = new Float64Array(nfft), im = new Float64Array(nfft);
      for (let i = 0; i < nx; i++) re[anti + i] = me.z[i];
      fft(re, im, false);
      // Praat: 실수 FFT 배열 인덱스 floor(upfactor*nfft)..nfft를 0으로 → 주파수 bin k >= floor(upfactor*nfft)/2 제거
      const i0 = Math.floor(upfactor * nfft);       // 1-based index in Praat's packed array
      // packed index i(1-based): i=1 DC, i=2k -> Re(bin k), i=2k+1 -> Im(bin k), i=nfft -> Re(nyquist)
      for (let k = 1; k <= nfft / 2; k++) {
        const iRe = (k === nfft / 2) ? nfft : 2 * k, iIm = 2 * k + 1;
        const zeroRe = iRe >= i0, zeroIm = (k < nfft / 2) && iIm >= i0;
        if (zeroRe) { re[k] = 0; if (k !== nfft / 2) re[nfft - k] = 0; }
        if (zeroIm) { im[k] = 0; if (k !== nfft / 2) im[nfft - k] = 0; }
        if (k === nfft / 2 && zeroRe) { im[k] = 0; }
      }
      fft(re, im, true);
      src = new Float64Array(nx);
      for (let i = 0; i < nx; i++) src[i] = re[anti + i] / nfft;
    }
    const n2 = Math.round((me.xmax - me.xmin) * fs);
    const dx2 = 1 / fs;
    const x12 = 0.5 * (me.xmin + me.xmax - (n2 - 1) / fs);
    const out = new Float64Array(n2);
    for (let i = 0; i < n2; i++) {
      const x = x12 + i * dx2;
      out[i] = interpolateSinc(src, (x - me.x1) / me.dx + 1, precision);
    }
    return { z: out, dx: dx2, x1: x12, xmin: me.xmin, xmax: me.xmax };
  }

  // ---------- Burg (Praat NUMburg_preallocated) ----------
  function burg(x, m) {
    const n = x.length;
    const a = new Float64Array(m + 1); // 1-based
    if (n <= 2) { a[1] = -1; return a; }
    const b1 = new Float64Array(n + 1), b2 = new Float64Array(n + 1), aa = new Float64Array(m + 1);
    let p = 0;
    for (let j = 1; j <= n; j++) p += x[j - 1] * x[j - 1];
    if (p <= 0) return null;
    b1[1] = x[0];
    b2[n - 1] = x[n - 1];
    for (let j = 2; j <= n - 1; j++) { b1[j] = x[j - 1]; b2[j - 1] = x[j - 1]; }
    for (let i = 1; i <= m; i++) {
      // Praat은 long double로 더한다 → 보정 합(Neumaier)으로 정밀도를 맞춘다
      let num = 0, cn = 0, den = 0, cd = 0;
      for (let j = 1; j <= n - i; j++) {
        const pn = b1[j] * b2[j];
        let t = num + pn;
        cn += Math.abs(num) >= Math.abs(pn) ? (num - t) + pn : (pn - t) + num;
        num = t;
        const pd = b1[j] * b1[j] + b2[j] * b2[j];
        t = den + pd;
        cd += Math.abs(den) >= Math.abs(pd) ? (den - t) + pd : (pd - t) + den;
        den = t;
      }
      num += cn; den += cd;
      if (den <= 0) return null;
      a[i] = 2 * num / den;
      for (let j = 1; j <= i - 1; j++) a[j] = aa[j] - a[i] * aa[i - j];
      if (i < m) {
        for (let j = 1; j <= i; j++) aa[j] = a[j];
        for (let j = 1; j <= n - i - 1; j++) {
          b1[j] -= aa[i] * b2[j];
          b2[j] = b2[j + 1] - aa[i] * b1[j + 1];
        }
      }
    }
    return a;
  }

  // ---------- 다항식 근: 동반행렬 고유값(Hessenberg QR) + Newton 다듬기 ----------
  // c: 계수 c[0] + c[1] z + ... + c[m] z^m (c[m] = 1)
  function polyRoots(c) {
    const m = c.length - 1;
    // 동반행렬 (상 Hessenberg)
    const A = [];
    for (let i = 0; i < m; i++) A.push(new Float64Array(m));
    for (let j = 0; j < m; j++) A[0][j] = -c[m - 1 - j] / c[m];
    for (let i = 1; i < m; i++) A[i][i - 1] = 1;
    const wr = new Float64Array(m), wi = new Float64Array(m);
    if (!hqr(A, m, wr, wi)) return null;
    const roots = [];
    for (let i = 0; i < m; i++) roots.push(polish(c, wr[i], wi[i]));
    return roots;
  }

  function polish(c, re, im) {
    // Newton 반복 (Praat Polynomial_polish_complexroot_nr과 같은 취지)
    const m = c.length - 1;
    let zr = re, zi = im;
    for (let it = 0; it < 80; it++) {
      let pr = c[m], pi = 0, dr = 0, di = 0;
      for (let k = m - 1; k >= 0; k--) {
        const ndr = dr * zr - di * zi + pr, ndi = dr * zi + di * zr + pi;
        dr = ndr; di = ndi;
        const npr = pr * zr - pi * zi + c[k], npi = pr * zi + pi * zr;
        pr = npr; pi = npi;
      }
      const den = dr * dr + di * di;
      if (den === 0) break;
      const dzr = (pr * dr + pi * di) / den, dzi = (pi * dr - pr * di) / den;
      const nzr = zr - dzr, nzi = zi - dzi;
      if (!isFinite(nzr) || !isFinite(nzi)) break;
      const change = Math.hypot(dzr, dzi);
      zr = nzr; zi = nzi;
      if (change <= 1e-15 * Math.max(1, Math.hypot(zr, zi))) break;
    }
    if (Math.abs(zi) < 1e-300) zi = 0;
    return [zr, zi];
  }

  // Numerical Recipes hqr: 상 Hessenberg 행렬의 고유값
  function hqr(a, n, wr, wi) {
    let nn, m, l, k, j, its, i, mmin;
    let z = 0, y, x, w, v, u, t, s, r = 0, q = 0, p = 0, anorm = 0;
    for (i = 0; i < n; i++)
      for (j = Math.max(i - 1, 0); j < n; j++) anorm += Math.abs(a[i][j]);
    nn = n - 1; t = 0;
    while (nn >= 0) {
      its = 0;
      do {
        for (l = nn; l >= 1; l--) {
          s = Math.abs(a[l - 1][l - 1]) + Math.abs(a[l][l]);
          if (s === 0) s = anorm;
          if (Math.abs(a[l][l - 1]) + s === s) { a[l][l - 1] = 0; break; }
        }
        x = a[nn][nn];
        if (l === nn) { wr[nn] = x + t; wi[nn--] = 0; }
        else {
          y = a[nn - 1][nn - 1];
          w = a[nn][nn - 1] * a[nn - 1][nn];
          if (l === nn - 1) {
            p = 0.5 * (y - x);
            q = p * p + w;
            z = Math.sqrt(Math.abs(q));
            x += t;
            if (q >= 0) {
              z = p + (p >= 0 ? Math.abs(z) : -Math.abs(z));
              wr[nn - 1] = wr[nn] = x + z;
              if (z) wr[nn] = x - w / z;
              wi[nn - 1] = wi[nn] = 0;
            } else {
              wr[nn - 1] = wr[nn] = x + p;
              wi[nn - 1] = -(wi[nn] = z);
            }
            nn -= 2;
          } else {
            if (its === 60) return false;
            if (its === 10 || its === 20) {
              t += x;
              for (i = 0; i <= nn; i++) a[i][i] -= x;
              s = Math.abs(a[nn][nn - 1]) + Math.abs(a[nn - 1][nn - 2]);
              y = x = 0.75 * s;
              w = -0.4375 * s * s;
            }
            ++its;
            for (m = nn - 2; m >= l; m--) {
              z = a[m][m];
              r = x - z; s = y - z;
              p = (r * s - w) / a[m + 1][m] + a[m][m + 1];
              q = a[m + 1][m + 1] - z - r - s;
              r = a[m + 2][m + 1];
              s = Math.abs(p) + Math.abs(q) + Math.abs(r);
              p /= s; q /= s; r /= s;
              if (m === l) break;
              u = Math.abs(a[m][m - 1]) * (Math.abs(q) + Math.abs(r));
              v = Math.abs(p) * (Math.abs(a[m - 1][m - 1]) + Math.abs(z) + Math.abs(a[m + 1][m + 1]));
              if (u + v === v) break;
            }
            for (i = m; i < nn - 1; i++) {
              a[i + 2][i] = 0;
              if (i !== m) a[i + 2][i - 1] = 0;
            }
            for (k = m; k < nn; k++) {
              if (k !== m) {
                p = a[k][k - 1]; q = a[k + 1][k - 1]; r = 0;
                if (k + 1 !== nn) r = a[k + 2][k - 1];
                if ((x = Math.abs(p) + Math.abs(q) + Math.abs(r)) !== 0) { p /= x; q /= x; r /= x; }
              }
              const sq = Math.sqrt(p * p + q * q + r * r);
              if ((s = (p >= 0 ? sq : -sq)) !== 0) {
                if (k === m) { if (l !== m) a[k][k - 1] = -a[k][k - 1]; }
                else a[k][k - 1] = -s * x;
                p += s; x = p / s; y = q / s; z = r / s; q /= p; r /= p;
                for (j = k; j <= nn; j++) {
                  p = a[k][j] + q * a[k + 1][j];
                  if (k + 1 !== nn) { p += r * a[k + 2][j]; a[k + 2][j] -= p * z; }
                  a[k + 1][j] -= p * y; a[k][j] -= p * x;
                }
                mmin = nn < k + 3 ? nn : k + 3;
                for (i = l; i <= mmin; i++) {
                  p = x * a[i][k] + y * a[i][k + 1];
                  if (k + 1 !== nn) { p += z * a[i][k + 2]; a[i][k + 2] -= p * r; }
                  a[i][k + 1] -= p * q; a[i][k] -= p;
                }
              }
            }
          }
        }
      } while (l < nn - 1);
    }
    return true;
  }

  // ---------- Sound: To Formant (burg) ----------
  // opts: {timeStep, maxFormants, ceiling, windowLength, preEmphasis}
  function toFormantBurg(sound, opts) {
    const timeStep = opts.timeStep || 0.01;
    const nPoles = Math.round(2 * (opts.maxFormants || 5));
    const halfWin = opts.windowLength || 0.025;
    const preF = opts.preEmphasis == null ? 50 : opts.preEmphasis;
    const safety = 50;
    const origNyq = 0.5 / sound.dx;
    let me;
    if (Math.abs(opts.ceiling / origNyq - 1) < 1e-12) {
      me = { z: Float64Array.from(sound.z), dx: sound.dx, x1: sound.x1, xmin: sound.xmin, xmax: sound.xmax };
    } else {
      if (opts.ceiling >= origNyq - 0.001) throw new Error("상한 주파수가 표본화 주파수의 절반보다 큽니다.");
      me = resample(sound, opts.ceiling * 2, 50);
    }
    const nx = me.z.length, dx = me.dx;
    const nyquist = 0.5 / dx;
    const dtWin = 2 * halfWin;
    let nsampWin = Math.floor(dtWin / dx);
    const halfN = Math.floor(nsampWin / 2);
    if (nsampWin < nPoles + 1) throw new Error("분석 창이 너무 짧습니다.");
    nsampWin = halfN * 2;
    const duration = dx * nx;
    if (dtWin > duration) throw new Error("소리가 너무 짧습니다.");
    const nFrames = Math.floor((duration - dtWin) / timeStep) + 1;
    const mid = me.x1 - 0.5 * dx + 0.5 * duration;
    const t1 = mid - 0.5 * nFrames * timeStep + 0.5 * timeStep;
    // 선강조
    const pe = Math.exp(-2 * Math.PI * preF * dx);
    const z = me.z;
    for (let i = nx - 1; i >= 1; i--) z[i] -= pe * z[i - 1];
    // 가우시안 창
    const win = new Float64Array(nsampWin);
    const imid = 0.5 * (nsampWin + 1), edge = Math.exp(-12);
    for (let i = 1; i <= nsampWin; i++) {
      win[i - 1] = (Math.exp(-48 * (i - imid) * (i - imid) / (nsampWin + 1) / (nsampWin + 1)) - edge) / (1 - edge);
    }
    const frames = [];
    const frame = new Float64Array(nsampWin);
    for (let f = 0; f < nFrames; f++) {
      const t = t1 + f * timeStep;
      const leftSample = Math.floor((t - me.x1) / dx) + 1;
      const rightSample = leftSample + 1;
      let start = rightSample - halfN, end = leftSample + halfN;
      if (start < 1) start = 1;
      if (end > nx) end = nx;
      let maxI = 0;
      for (let i = start; i <= end; i++) { const v = z[i - 1]; if (v * v > maxI) maxI = v * v; }
      if (maxI === 0) { frames.push([]); continue; }
      const len = end - start + 1;
      for (let j = 0; j < len; j++) frame[j] = z[start - 1 + j] * win[j];
      const a = burg(frame.subarray(0, len), nPoles);
      if (!a) { frames.push([]); continue; }
      const c = new Float64Array(nPoles + 1);
      for (let i = 1; i <= nPoles; i++) c[i - 1] = -a[nPoles - i + 1];
      c[nPoles] = 1;
      const roots = polyRoots(c);
      const fl = [];
      if (roots) {
        for (const r of roots) {
          let re = r[0], im = r[1];
          const mod2 = re * re + im * im;
          if (mod2 > 1) { re = re / mod2; im = im / mod2; } // 1/conj(z)
          if (im >= 0) {
            const fr = Math.abs(Math.atan2(im, re)) * nyquist / Math.PI;
            if (fr >= safety && fr <= nyquist - safety) {
              const bw = -Math.log(re * re + im * im) * nyquist / Math.PI;
              fl.push([fr, bw]);
            }
          }
        }
        fl.sort((p, q) => p[0] - q[0]);
      }
      frames.push(fl);
    }
    return { frames: frames, t1: t1, dt: timeStep, nx: nFrames, xmin: me.xmin, xmax: me.xmax };
  }

  // Praat Formant_getValueAtTime (Hz, 선형 보간)
  function formantAt(fm, k, time) {
    if (k < 1 || time < fm.xmin || time > fm.xmax) return NaN;
    const findex = (time - fm.t1) / fm.dt + 1;
    const ileft = Math.floor(findex);
    const phase = findex - ileft;
    const val = (i) => {
      if (i < 1 || i > fm.nx) return NaN;
      const fr = fm.frames[i - 1];
      return k <= fr.length ? fr[k - 1][0] : NaN;
    };
    if (ileft < 1) return Math.round(findex) === 1 ? val(1) : NaN;
    if (ileft >= fm.nx) return Math.round(findex) === fm.nx ? val(fm.nx) : NaN;
    const l = val(ileft), r = val(ileft + 1);
    if (phase === 0) return l;
    if (isNaN(l) || isNaN(r)) return NaN;
    return l + phase * (r - l);
  }

  const api = { fft, interpolateSinc, makeSound, resample, burg, polyRoots, toFormantBurg, formantAt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraatFormant = api;
})(typeof self !== "undefined" ? self : this);
