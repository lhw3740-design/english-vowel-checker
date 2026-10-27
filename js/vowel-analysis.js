/*
 * vowel-analysis.js
 * 10번 논문의 가족 측정 절차를 앱에서 쓰는 형태로 옮긴 것.
 *  1) 녹음을 모노로 받아 원래 표본화율 그대로 쓴다(논문과 같음).
 *  2) 모음 구간 = 자기상관 피치 분석의 유성음 연속 구간
 *     (간격 0.15 s 미만은 합치고 0.10 s 미만은 버림; 논문 family_pipeline.py 규칙).
 *     앱은 단어를 하나씩 녹음하므로 문턱 0.45에서 가장 긴 유성 구간 하나를 그 단어의 모음으로 본다
 *     (논문 부록 C 조건 A, 원어민 기준값도 같은 규칙).
 *  3) 포먼트: praat-formant.js (논문과 같은 설정), 20·50·80% 지점 F1·F2.
 *  4) 거리: Lobanov z → 원어민 평균점과의 유클리드 거리(정적), 20→80% 변화량 거리(동적),
 *     원어민 화자별 거리의 90백분위와 비교(논문 compute_distances.py).
 */
(function (root) {
  "use strict";
  const PF = (typeof module !== "undefined" && module.exports) ? require("./praat-formant.js") : root.PraatFormant;

  const VOWELS = [
    { code: "iy", word: "heed", ipa: "i" }, { code: "ih", word: "hid", ipa: "ɪ" },
    { code: "ei", word: "hayed", ipa: "e" }, { code: "eh", word: "head", ipa: "ɛ" },
    { code: "ae", word: "had", ipa: "æ" }, { code: "ah", word: "hod", ipa: "ɑ" },
    { code: "aw", word: "hawed", ipa: "ɔ" }, { code: "oa", word: "hoed", ipa: "o" },
    { code: "oo", word: "hood", ipa: "ʊ" }, { code: "uw", word: "who'd", ipa: "u" },
    { code: "uh", word: "hud", ipa: "ʌ" }, { code: "er", word: "heard", ipa: "ɝ" },
  ];
  const GROUP_SETTINGS = {
    men: { ceiling: 5000, pitch: [70, 300] },
    women: { ceiling: 5500, pitch: [120, 500] },
    kids: { ceiling: 5500, pitch: [120, 600] },
  };
  const THRESHOLDS = [0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25];

  // 녹음 그대로(원래 표본화율) 분석한다. 논문도 44.1 kHz 녹음을 그대로 Praat에 넣었다.
  // 포먼트 분석은 안에서 2×상한(10/11 kHz)으로 리샘플한다.
  function toSound(samples, fs) { return PF.makeSound(samples, fs); }

  // Praat "To Pitch (ac)" (Hanning 창, 후보 15개, 경로 탐색)을 옮긴 유성/무성 판정
  // 논문 설정: time step 0.01, silence 0.03, octave cost 0.05, octave-jump cost 0.5, voiced/unvoiced cost 0.2
  function voicedFrames(snd, pitchRange, vth, opts) {
    opts = opts || {};
    const silence = opts.silence == null ? 0.03 : opts.silence;
    const octaveCost = 0.05, octaveJumpCost = 0.5, vuCost = 0.2, maxCand = 15, step = 0.01;
    const z = snd.z, dx = snd.dx, nx = z.length;
    const [floorF, ceilF] = pitchRange;
    const periodsPerWindow = 3, interpDepth = 0.5;
    const dtWindow = periodsPerWindow / floorF;
    let nsampWindow = Math.floor(dtWindow / dx);
    const halfW = Math.floor(nsampWindow / 2) - 1;
    if (halfW < 2) return { times: [], voiced: [] };
    nsampWindow = halfW * 2;
    const nsampPeriod = Math.floor(1 / dx / floorF), halfPeriod = Math.floor(nsampPeriod / 2) + 1;
    const maximumLag = Math.min(Math.floor(nsampWindow / periodsPerWindow) + 2, nsampWindow);
    const brentIxmax = Math.floor(nsampWindow * interpDepth);
    const duration = nx * dx;
    if (dtWindow > duration) return { times: [], voiced: [] };
    const nF = Math.floor((duration - dtWindow) / step) + 1;
    const mid = snd.x1 - 0.5 * dx + 0.5 * duration;
    const t1 = mid - 0.5 * nF * step + 0.5 * step;
    let nfft = 1; while (nfft < nsampWindow * (1 + interpDepth)) nfft *= 2;
    // 창과 창의 자기상관
    const win = new Float64Array(nsampWindow + 1);
    for (let i = 1; i <= nsampWindow; i++) win[i] = 0.5 - 0.5 * Math.cos(i * 2 * Math.PI / (nsampWindow + 1));
    const wre = new Float64Array(nfft), wim = new Float64Array(nfft);
    for (let i = 1; i <= nsampWindow; i++) wre[i - 1] = win[i];
    PF.fft(wre, wim, false);
    for (let i = 0; i < nfft; i++) { wre[i] = wre[i] * wre[i] + wim[i] * wim[i]; wim[i] = 0; }
    PF.fft(wre, wim, true);
    const windowR = new Float64Array(brentIxmax + 1);
    for (let i = 0; i <= brentIxmax; i++) windowR[i] = wre[i] / wre[0];
    // 전역 최대 진폭(평균 제거)
    let gmean = 0; for (let i = 0; i < nx; i++) gmean += z[i]; gmean /= nx;
    let globalPeak = 0; for (let i = 0; i < nx; i++) globalPeak = Math.max(globalPeak, Math.abs(z[i] - gmean));
    if (globalPeak === 0) return { times: [], voiced: [] };
    const frames = [];
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    const rs = new Float64Array(2 * brentIxmax + 1); // r[-ixmax..ixmax]
    for (let f = 0; f < nF; f++) {
      const t = t1 + f * step;
      const leftSample = Math.floor((t - snd.x1) / dx) + 1, rightSample = leftSample + 1;
      let s0 = rightSample - nsampPeriod, e0 = leftSample + nsampPeriod;
      if (s0 < 1) s0 = 1; if (e0 > nx) e0 = nx;
      let localMean = 0; for (let i = s0; i <= e0; i++) localMean += z[i - 1]; localMean /= (e0 - s0 + 1);
      const startSample = rightSample - halfW;
      re.fill(0); im.fill(0);
      for (let j = 1; j <= nsampWindow; j++) {
        const i = startSample + j - 1;
        const v = (i >= 1 && i <= nx) ? z[i - 1] - localMean : 0;
        re[j - 1] = v * win[j];
      }
      let localPeak = 0;
      let a2 = halfW + 1 - halfPeriod, b2 = halfW + halfPeriod;
      if (a2 < 1) a2 = 1; if (b2 > nsampWindow) b2 = nsampWindow;
      for (let j = a2; j <= b2; j++) { const v = Math.abs(re[j - 1] / win[j]); if (v > localPeak) localPeak = v; }
      const intensity = localPeak > globalPeak ? 1 : localPeak / globalPeak;
      const cands = [[0, 0]]; // [frequency, strength]; 0 = 무성
      if (localPeak > 0) {
        PF.fft(re, im, false);
        for (let i = 0; i < nfft; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
        PF.fft(re, im, true);
        const ac0 = re[0];
        if (ac0 > 0) {
          rs[brentIxmax] = 1;
          for (let i = 1; i <= brentIxmax; i++) { const v = re[i] / (ac0 * windowR[i]); rs[brentIxmax + i] = v; rs[brentIxmax - i] = v; }
          const r = i => rs[brentIxmax + i];
          for (let i = 2; i < maximumLag && i < brentIxmax; i++) {
            if (r(i) > 0.5 * vth && r(i) > r(i - 1) && r(i) >= r(i + 1)) {
              const dr = 0.5 * (r(i + 1) - r(i - 1)), d2r = 2 * r(i) - r(i - 1) - r(i + 1);
              const freq = 1 / dx / (i + dr / d2r);
              let strength = PF.interpolateSinc(rs, 1 / dx / freq + brentIxmax + 1, 70);
              if (strength > 1) strength = 1 / strength;
              let place = -1;
              if (cands.length < maxCand) { cands.push([0, 0]); place = cands.length - 1; }
              else {
                let weakest = 2;
                for (let w = 1; w < maxCand; w++) {
                  const ls = cands[w][1] - octaveCost * Math.log2(floorF / cands[w][0]);
                  if (ls < weakest) { weakest = ls; place = w; }
                }
                if (strength - octaveCost * Math.log2(floorF / freq) <= weakest) place = -1;
              }
              if (place >= 0) cands[place] = [freq, strength];
            }
          }
        }
      }
      frames.push({ t, intensity, cands });
    }
    // 경로 탐색 (Praat Pitch_pathFinder)
    const nFr = frames.length;
    if (!nFr) return { times: [], voiced: [] };
    const delta = [], psi = [];
    for (const fr of frames) {
      let unv = 2 - fr.intensity / (silence / (1 + vth));
      unv = vth + (unv > 0 ? unv : 0);
      delta.push(fr.cands.map(c => (c[0] === 0 || c[0] > ceilF) ? unv : c[1] - octaveCost * Math.log2(ceilF / c[0])));
    }
    psi.push(frames[0].cands.map(() => 0));
    for (let i = 1; i < nFr; i++) {
      const prev = frames[i - 1].cands, cur = frames[i].cands;
      const p = [];
      const nd = cur.map((c, ic) => {
        const f2 = c[0], v2 = f2 > 0 && f2 <= ceilF;
        let best = -1e30, place = 0;
        prev.forEach((pc, jc) => {
          const f1 = pc[0], v1 = f1 > 0 && f1 <= ceilF;
          const tc = (!v1 && !v2) ? 0 : (!v1 || !v2) ? vuCost : octaveJumpCost * Math.abs(Math.log2(f1 / f2));
          const val = delta[i - 1][jc] - tc + delta[i][ic];
          if (val > best) { best = val; place = jc; }
        });
        p.push(place);
        return best;
      });
      delta[i] = nd; psi.push(p);
    }
    let place = 0, mx = -1e30;
    delta[nFr - 1].forEach((v, i) => { if (v > mx) { mx = v; place = i; } });
    const voiced = new Array(nFr);
    for (let i = nFr - 1; i >= 0; i--) {
      const f = frames[i].cands[place][0];
      voiced[i] = f > 0 && f <= ceilF;
      place = psi[i][place];
    }
    return { times: frames.map(f => f.t), voiced };
  }

  function voicedRuns(snd, pitchRange, vth, minLen, fill) {
    minLen = minLen == null ? 0.10 : minLen; fill = fill == null ? 0.15 : fill;
    const { times, voiced } = voicedFrames(snd, pitchRange, vth);
    const runs = [];
    for (let i = 0; i < voiced.length;) {
      if (voiced[i]) { let j = i; while (j + 1 < voiced.length && voiced[j + 1]) j++; runs.push([times[i], times[j]]); i = j + 1; }
      else i++;
    }
    const merged = [];
    for (const r of runs) {
      if (merged.length && r[0] - merged[merged.length - 1][1] < fill) merged[merged.length - 1][1] = r[1];
      else merged.push([r[0], r[1]]);
    }
    return merged.filter(r => r[1] - r[0] >= minLen);
  }

  // 블록(12단어 연속 녹음)에서 12개 구간 찾기: 논문 detect12와 같은 문턱 순서
  function detect12(snd, pitchRange) {
    for (const v of THRESHOLDS) {
      const r = voicedRuns(snd, pitchRange, v);
      if (r.length === 12) return { runs: r, vth: v };
    }
    return null;
  }

  // 한 단어 녹음에서 모음 구간 하나 찾기: 논문 부록 C 조건 A와 같이 문턱 0.45에서 가장 긴 유성 구간.
  // 원어민 기준값도 같은 규칙으로 쟀다. 0.45에서 구간이 없을 때만 더 낮은 문턱을 차례로 시도한다.
  const SINGLE_THRESHOLDS = [0.45, 0.4, 0.35, 0.3, 0.25];
  function detectSingle(snd, pitchRange) {
    for (const v of SINGLE_THRESHOLDS) {
      const r = voicedRuns(snd, pitchRange, v);
      if (r.length) {
        const longest = r.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
        return { run: longest, count: r.length, vth: v };
      }
    }
    return null;
  }

  function makeFormant(snd, group) {
    return PF.toFormantBurg(snd, { timeStep: 0.01, maxFormants: 5, ceiling: GROUP_SETTINGS[group].ceiling, windowLength: 0.025, preEmphasis: 50 });
  }
  function formantsAt(fm, a, b) {
    const r = {};
    for (const p of [20, 50, 80]) for (const k of [1, 2]) r[`F${k}_${p}`] = PF.formantAt(fm, k, a + p / 100 * (b - a));
    return r;
  }

  // 단어 하나 측정: {ok, start, end, dur, F1_20...F2_80, warn}
  function measureWord(samples, fs, group) {
    if (!samples || !samples.length || !isFinite(fs) || fs < 8000) return { ok: false, reason: "소리 데이터를 읽지 못했어요." };
    let peak = 0; for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (!isFinite(v)) return { ok: false, reason: "소리 데이터에 잘못된 값이 있어요." }; if (v > peak) peak = v; }
    const dur = samples.length / fs;
    if (dur < 0.25) return { ok: false, reason: "녹음이 너무 짧아요(0.25초 미만). 단어를 끝까지 말해 주세요." };
    if (dur > 20) return { ok: false, reason: "녹음이 너무 길어요(20초 초과). 단어 하나만 녹음해 주세요." };
    if (peak < 0.003) return { ok: false, reason: "소리가 거의 들리지 않아요. 마이크를 가까이 하고 다시 녹음해 주세요." };
    const snd = toSound(samples, fs);
    const seg = detectSingle(snd, GROUP_SETTINGS[group].pitch);
    if (!seg) return { ok: false, reason: "목소리(모음)를 찾지 못했어요. 조용한 곳에서 단어를 또렷하게 말해 주세요." };
    const [a, b] = seg.run;
    if (b - a < 0.06) return { ok: false, reason: "모음이 너무 짧게 잡혔어요. 조금 길게 말해 주세요." };
    const fm = makeFormant(snd, group);
    const f = formantsAt(fm, a, b);
    if (Object.values(f).some(x => !isFinite(x))) return { ok: false, reason: "포먼트를 재지 못했어요. 다시 녹음해 주세요." };
    if (f.F2_50 - f.F1_50 < 150) return { ok: false, reason: "F1과 F2가 거의 붙어 있어 사람의 모음 소리로 보기 어려워요. 단어를 직접 말해 녹음해 주세요." };
    const warn = [];
    if (seg.count > 1) warn.push("소리 덩어리가 " + seg.count + "개 잡혀 가장 긴 것을 썼어요.");
    if (peak > 0.99) warn.push("소리가 너무 커서 잘렸을 수 있어요.");
    return Object.assign({ ok: true, start: a, end: b, dur: b - a, warn }, f);
  }

  // 12모음 측정값 → 논문 방식 거리 계산
  // meas: {code: {F1_20..F2_80}} (빠진 모음 허용, 최소 개수는 호출 쪽에서 확인)
  function computeDistances(meas, refGroup) {
    const codes = VOWELS.map(v => v.code).filter(c => meas[c]);
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
    const m = [1, 2].map(k => mean(codes.map(c => meas[c][`F${k}_50`])));
    const s = [1, 2].map(k => sd(codes.map(c => meas[c][`F${k}_50`])));
    if (!(s[0] > 0 && s[1] > 0)) return null;
    const per = {};
    for (const c of codes) {
      const z = p => [(meas[c][`F1_${p}`] - m[0]) / s[0], (meas[c][`F2_${p}`] - m[1]) / s[1]];
      const z50 = z(50), z20 = z(20), z80 = z(80);
      const ref = refGroup.meanZ50[c], dref = refGroup.meanDz[c];
      const st = Math.hypot(z50[0] - ref[0], z50[1] - ref[1]);
      const dy = Math.hypot((z80[0] - z20[0]) - dref[0], (z80[1] - z20[1]) - dref[1]);
      per[c] = { z50, static: st, dynamic: dy, inRange: st <= refGroup.vowelP90[c] };
    }
    const stat = mean(codes.map(c => per[c].static)), dyn = mean(codes.map(c => per[c].dynamic));
    return {
      n: codes.length, perVowel: per, static: stat, dynamic: dyn,
      staticIn: stat <= refGroup.p90.static, dynamicIn: dyn <= refGroup.p90.dynamic,
      lobanov: { mean: m, sd: s },
    };
  }

  const api = { VOWELS, GROUP_SETTINGS, THRESHOLDS, toSound, voicedFrames, voicedRuns, detect12, detectSingle, makeFormant, formantsAt, measureWord, computeDistances };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VowelAnalysis = api;
})(typeof self !== "undefined" ? self : this);
