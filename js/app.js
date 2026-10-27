/* 영어 모음 점검기: 화면과 녹음 처리 */
(function () {
  "use strict";
  const VA = window.VowelAnalysis;
  const REF = window.VOWEL_REFERENCE;
  const VOWELS = VA.VOWELS;
  const byCode = Object.fromEntries(VOWELS.map(v => [v.code, v]));
  const MIN_FOR_RESULT = 11; // 논문도 소음 토큰 1개를 빼고 11모음으로 계산한 블록이 있다
  const MAX_REC_SEC = 4;
  const MAX_FILE_MB = 30;

  // 논문에서 나온 결과(교정 팁 근거). 10번 논문 4.2절·5.2절
  const TIPS = {
    iy: "한국어 '이'보다 입꼬리를 옆으로 당기고 조금 길게 냅니다.",
    ih: "'이'와 '에' 사이의 짧고 느슨한 소리입니다. 혀에 힘을 빼고 짧게 끊습니다.",
    ei: "'에'로 시작해 끝을 '이' 쪽으로 미끄러뜨립니다(에이).",
    eh: "한국어 '에'보다 턱을 조금 더 내립니다. 논문에서 연구자(P1)의 head는 hayed(/e/) 쪽으로 올라가 있었습니다(거리 1.39).",
    ae: "턱을 크게 내리고 혀끝을 아랫니 뒤에 붙인 채 혀를 앞으로 밉니다. '애'보다 입을 더 벌립니다. 논문에서 P1의 had는 F2가 원어민보다 약 420 Hz 낮아 혀가 뒤에 있었습니다(거리 1.52).",
    ah: "철자 o에 끌려 'ㅗ'로 읽지 말고, 입을 크게 벌린 '아'로 냅니다. 논문에서 여동생·어머니의 hod는 F1이 원어민의 절반 정도로 'ㅗ'에 가까웠습니다(거리 2.50, 2.46).",
    aw: "'오'와 '아' 사이입니다. 턱을 내리고 입술은 살짝만 둥글게 합니다.",
    oa: "'오'로 시작해 끝을 '우' 쪽으로 미끄러뜨립니다(오우).",
    oo: "'우'보다 입술 힘을 빼고 짧게 냅니다.",
    uw: "입술을 앞으로 내밀어 둥글게 하고 길게 '우'를 냅니다.",
    uh: "입을 반쯤 벌린 짧은 '어'입니다. 힘을 빼고 짧게 냅니다.",
    er: "혀끝을 살짝 말거나 혀 가운데를 뭉쳐 r 색깔을 냅니다. '어'로 끝내지 않습니다.",
  };

  // ---------- 상태 ----------
  const state = {
    group: "men",
    raw: {},     // code -> {samples, fs, url, source}
    meas: {},    // code -> measureWord 결과 또는 {error}
    virtual: false,
    result: null,
    practice: { code: null, before: null },
    rec: null,
    busy: new Set(),
  };

  // ---------- 공통 ----------
  const $ = s => document.querySelector(s);
  const fmt = (x, d = 2) => (isFinite(x) ? x.toFixed(d) : "-");
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5200);
  }
  window.addEventListener("error", e => { toast("처리 중 문제가 생겼어요. 같은 단계를 다시 해 주세요. (" + (e.message || "알 수 없는 오류") + ")"); });
  window.addEventListener("unhandledrejection", e => { toast("처리 중 문제가 생겼어요. 같은 단계를 다시 해 주세요. (" + ((e.reason && e.reason.message) || "알 수 없는 오류") + ")"); });
  const nextFrame = () => new Promise(r => setTimeout(r, 30));

  // ---------- 오디오 읽기 ----------
  let audioCtx = null;
  function getCtx() {
    if (!audioCtx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) throw new Error("이 브라우저는 소리 해독을 지원하지 않아요.");
      audioCtx = new C();
    }
    return audioCtx;
  }
  // WAV(PCM 8/16/24/32비트, float32)는 직접 읽어 원래 표본화율을 지킨다
  function parseWav(buf) {
    try {
      const dv = new DataView(buf);
      if (dv.byteLength < 44) return null;
      const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
      let p = 12, fmt = null, data = null;
      while (p + 8 <= dv.byteLength) {
        const id = tag(p), size = dv.getUint32(p + 4, true);
        if (id === "fmt ") fmt = { format: dv.getUint16(p + 8, true), ch: dv.getUint16(p + 10, true), fs: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
        if (id === "data") { data = { off: p + 8, len: Math.min(size, dv.byteLength - p - 8) }; break; }
        p += 8 + size + (size & 1);
      }
      if (!fmt || !data || !fmt.ch || !fmt.fs) return null;
      const B = fmt.bits / 8;
      if (!(fmt.format === 1 || fmt.format === 3 || fmt.format === 65534) || ![1, 2, 3, 4].includes(B)) return null;
      const n = Math.floor(data.len / B / fmt.ch);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < fmt.ch; c++) {
          const o = data.off + (i * fmt.ch + c) * B;
          if (fmt.format === 3 && B === 4) s += dv.getFloat32(o, true);
          else if (B === 1) s += (dv.getUint8(o) - 128) / 128;
          else if (B === 2) s += dv.getInt16(o, true) / 32768;
          else if (B === 3) { let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); if (v & 0x800000) v -= 0x1000000; s += v / 8388608; }
          else s += dv.getInt32(o, true) / 2147483648;
        }
        out[i] = s / fmt.ch;
      }
      return { samples: out, fs: fmt.fs };
    } catch (e) { return null; }
  }
  async function decodeAudio(arrayBuffer) {
    const w = parseWav(arrayBuffer);
    if (w) return w;
    const ctx = getCtx();
    const ab = await new Promise((resolve, reject) => {
      const pr = ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
      if (pr && pr.then) pr.then(resolve, reject);
    }).catch(() => { throw new Error("소리 파일로 읽을 수 없어요. wav, m4a, mp3 같은 녹음 파일인지 확인해 주세요."); });
    const n = ab.length, ch = ab.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
    return { samples: out, fs: ab.sampleRate };
  }
  function b64ToBuf(b64) {
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  // ---------- 단어 카드 ----------
  const cards = {};
  function buildCards() {
    const ul = $("#words"), tpl = $("#word-tpl");
    for (const v of VOWELS) {
      const li = tpl.content.firstElementChild.cloneNode(true);
      li.dataset.code = v.code;
      li.querySelector(".w-ipa").textContent = "/" + v.ipa + "/";
      li.querySelector(".w-text").textContent = v.word;
      const rec = li.querySelector(".w-rec");
      rec.setAttribute("aria-label", v.word + " 녹음");
      rec.addEventListener("click", () => toggleRecord(v.code, "word"));
      const file = li.querySelector("input[type=file]");
      file.setAttribute("aria-label", v.word + " 녹음 파일 올리기");
      file.addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) handleFile(v.code, f, "word"); });
      li.querySelector(".w-play").addEventListener("click", () => play(v.code));
      ul.appendChild(li);
      cards[v.code] = li;
    }
  }
  function setCard(code, cls, text) {
    const li = cards[code];
    li.classList.remove("done", "out", "err", "busy");
    if (cls) cls.split(" ").forEach(c => li.classList.add(c));
    li.querySelector(".w-status").textContent = text;
    li.querySelector(".w-play").hidden = !(state.raw[code] && state.raw[code].url);
  }
  function refreshCards() {
    for (const v of VOWELS) {
      const c = v.code, m = state.meas[c];
      if (state.busy.has(c)) continue;
      if (!m) { setCard(c, "", "아직 녹음하지 않았습니다."); continue; }
      if (m.error) { setCard(c, "err", m.error); continue; }
      let text = `F1 ${Math.round(m.F1_50)} Hz, F2 ${Math.round(m.F2_50)} Hz`;
      let cls = "done";
      const pv = state.result && state.result.perVowel[c];
      if (pv) {
        text += pv.inRange ? `. 원어민 범위 안(거리 ${fmt(pv.static)})` : `. 원어민 범위 밖(거리 ${fmt(pv.static)})`;
        if (!pv.inRange) cls += " out";
      }
      if (m.warn && m.warn.length) text += ". " + m.warn.join(" ");
      if (m.virtual) text += " (가상 값)";
      setCard(c, cls, text);
    }
    const n = VOWELS.filter(v => state.meas[v.code] && !state.meas[v.code].error).length;
    $("#done-count").textContent = n;
    $("#progress-hint").textContent = n >= 12 ? "모두 녹음했습니다." : n >= MIN_FOR_RESULT ? "결과를 볼 수 있어요. 12개를 모두 녹음하면 더 정확합니다." : "";
  }

  // ---------- 측정 ----------
  async function analyze(code, samples, fs) {
    state.busy.add(code);
    setCard(code, "busy", "분석 중입니다...");
    await nextFrame();
    let m;
    try { m = VA.measureWord(samples, fs, state.group); }
    catch (e) { m = { ok: false, reason: "분석하지 못했어요. 다시 녹음해 주세요." }; }
    state.busy.delete(code);
    state.meas[code] = m.ok ? m : { error: m.reason };
    return m;
  }
  async function reanalyzeAll() {
    for (const v of VOWELS) {
      const r = state.raw[v.code];
      if (r && r.samples) await analyze(v.code, r.samples, r.fs);
    }
    update();
  }

  // ---------- 녹음 ----------
  function stopRecording() { if (state.rec && state.rec.mr && state.rec.mr.state !== "inactive") state.rec.mr.stop(); }
  async function toggleRecord(code, target) {
    if (state.rec) {
      const same = state.rec.code === code && state.rec.target === target;
      stopRecording();
      if (same) return;
      await new Promise(r => setTimeout(r, 150));
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast("이 브라우저에서는 녹음을 쓸 수 없어요. 파일을 올리거나 다른 브라우저(크롬, 사파리)에서 열어 주세요.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    } catch (e) {
      const msg = e && e.name === "NotAllowedError" ? "마이크 권한이 꺼져 있어요. 주소창의 자물쇠 아이콘에서 마이크를 허용한 뒤 다시 눌러 주세요."
        : e && e.name === "NotFoundError" ? "마이크를 찾지 못했어요. 마이크를 연결하거나 파일을 올려 주세요."
        : "마이크를 켜지 못했어요. 다른 앱이 마이크를 쓰고 있는지 확인해 주세요.";
      toast(msg);
      return;
    }
    const chunks = [];
    let mr;
    try { mr = new MediaRecorder(stream); }
    catch (e) { stream.getTracks().forEach(t => t.stop()); toast("녹음을 시작하지 못했어요. 파일을 올려 주세요."); return; }
    const btn = target === "word" ? cards[code].querySelector(".w-rec") : $("#p-rec");
    const t0 = Date.now();
    const rec = { code, target, mr, stream, btn };
    state.rec = rec;
    btn.classList.add("recording");
    const tick = () => { btn.textContent = `멈추기 ${Math.max(0, MAX_REC_SEC - (Date.now() - t0) / 1000).toFixed(1)}`; };
    tick();
    rec.timer = setInterval(() => { tick(); if (Date.now() - t0 >= MAX_REC_SEC * 1000) stopRecording(); }, 100);
    if (target === "word") setCard(code, "busy", `"${byCode[code].word}"라고 말하세요.`);
    else $("#p-status").textContent = `"${byCode[code].word}"라고 말하세요.`;
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      clearInterval(rec.timer);
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove("recording");
      btn.textContent = target === "word" ? "녹음" : "다시 녹음";
      if (state.rec === rec) state.rec = null;
      const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      if (!blob.size) { failWord(code, target, "녹음된 소리가 없어요. 다시 눌러 주세요."); return; }
      try {
        const audio = await decodeAudio(await blob.arrayBuffer());
        await takeAudio(code, audio, URL.createObjectURL(blob), "mic", target);
      } catch (e) { failWord(code, target, e.message || "녹음을 읽지 못했어요."); }
    };
    mr.start();
  }
  function failWord(code, target, msg) {
    if (target === "practice") { $("#p-status").textContent = msg; return; }
    state.meas[code] = { error: msg };
    state.busy.delete(code);
    update();
  }
  async function handleFile(code, file, target) {
    if (file.size > MAX_FILE_MB * 1024 * 1024) { failWord(code, target, `파일이 너무 커요(${MAX_FILE_MB} MB 초과). 단어 하나만 담긴 짧은 파일을 올려 주세요.`); return; }
    if (target === "word") setCard(code, "busy", "파일을 읽는 중입니다...");
    else $("#p-status").textContent = "파일을 읽는 중입니다...";
    try {
      const audio = await decodeAudio(await file.arrayBuffer());
      await takeAudio(code, audio, URL.createObjectURL(file), "file", target);
    } catch (e) { failWord(code, target, e.message || "파일을 읽지 못했어요."); }
  }
  async function takeAudio(code, audio, url, source, target) {
    if (state.virtual) clearVirtual();
    if (target === "practice") snapshotBefore(code);
    const old = state.raw[code], oldMeas = state.meas[code];
    state.raw[code] = { samples: audio.samples, fs: audio.fs, url, source };
    const m = await analyze(code, audio.samples, audio.fs);
    if (target === "practice" && !m.ok && oldMeas && !oldMeas.error) {
      // 연습 녹음이 실패하면 앞의 측정을 그대로 둔다
      state.raw[code] = old; state.meas[code] = oldMeas; state.practice.before = null;
      if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
      $("#p-status").textContent = m.reason + " 앞의 녹음은 그대로 둡니다.";
    } else {
      if (old && old.url && old.url.startsWith("blob:") && old.url !== url) URL.revokeObjectURL(old.url);
      if (target === "practice") $("#p-status").textContent = m.ok ? "다시 쟀습니다." : m.reason;
    }
    update();
  }
  let player = null;
  function play(code) {
    const r = state.raw[code];
    if (!r || !r.url) return;
    if (player) player.pause();
    player = new Audio(r.url);
    player.play().catch(() => toast("소리를 재생하지 못했어요."));
  }

  // ---------- 예시 ----------
  let loadingExample = false;
  function setExampleButtons(disabled) { ["#ex-native", "#ex-virtual", "#clear-all"].forEach(s => { $(s).disabled = disabled; }); }
  async function loadNativeExample() {
    if (loadingExample) return;
    if (!window.EXAMPLE_NATIVE) { toast("예시 음성을 아직 불러오는 중이에요. 잠시 뒤 다시 눌러 주세요."); return; }
    loadingExample = true; setExampleButtons(true);
    try { await loadNativeExampleInner(); } finally { loadingExample = false; setExampleButtons(false); }
  }
  async function loadNativeExampleInner() {
    clearAll(true);
    setGroup("men");
    showExampleNote("원어민 예시: Hillenbrand 자료의 성인 남성 m22(원어민 남성 45명 가운데 거리가 중간인 화자)의 실제 녹음 12개를 같은 방법으로 분석합니다. 원어민이라 대부분 범위 안에 들어야 합니다.");
    for (const v of VOWELS) {
      const buf = b64ToBuf(window.EXAMPLE_NATIVE[v.code]);
      const w = parseWav(buf);
      state.raw[v.code] = { samples: w.samples, fs: w.fs, url: URL.createObjectURL(new Blob([buf], { type: "audio/wav" })), source: "example" };
      await analyze(v.code, w.samples, w.fs);
      refreshCards();
    }
    update();
    document.getElementById("result").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  function loadVirtualExample() {
    if (loadingExample) return;
    clearAll(true);
    setGroup("men");
    const H = REF.groups.men.meanHz50;
    // 원어민 남성 평균에 논문에서 관찰된 세 경향을 얹은 가상 값(실제 사람이 아님)
    const shift = { eh: { dF1: -120, dF2: 180 }, ae: { dF1: 0, dF2: -420 }, ah: { f1x: 0.62, f2x: 0.75 } };
    for (const v of VOWELS) {
      const h = H[v.code], s = shift[v.code] || {};
      const adj = (f1, f2) => [s.f1x ? f1 * s.f1x : f1 + (s.dF1 || 0), s.f2x ? f2 * s.f2x : f2 + (s.dF2 || 0)];
      const [a20, b20] = adj(h.F1_20, h.F2_20), [a50, b50] = adj(h.F1, h.F2), [a80, b80] = adj(h.F1_80, h.F2_80);
      state.meas[v.code] = { ok: true, virtual: true, F1_20: a20, F2_20: b20, F1_50: a50, F2_50: b50, F1_80: a80, F2_80: b80, warn: [] };
    }
    state.virtual = true;
    showExampleNote("가상 예시: 원어민 남성 평균값에 논문에서 관찰된 세 경향(head가 /e/ 쪽으로 올라감, had의 혀가 뒤로 감, hod를 'ㅗ'처럼 냄)을 얹어 만든 값입니다. 실제 사람의 녹음이 아닙니다. 녹음을 하면 이 예시는 지워집니다.");
    update();
    document.getElementById("result").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  function showExampleNote(t) { const n = $("#example-note"); n.textContent = t; n.hidden = !t; }
  function clearVirtual() {
    for (const v of VOWELS) if (state.meas[v.code] && state.meas[v.code].virtual) delete state.meas[v.code];
    state.virtual = false;
    showExampleNote("");
  }
  function clearAll(silent) {
    stopRecording();
    for (const r of Object.values(state.raw)) if (r.url && r.url.startsWith("blob:")) URL.revokeObjectURL(r.url);
    state.raw = {}; state.meas = {}; state.virtual = false; state.result = null;
    state.practice = { code: null, before: null };
    $("#p-compare").hidden = true; $("#p-status").textContent = "";
    showExampleNote("");
    update();
    if (!silent) toast("녹음을 모두 지웠습니다.");
  }

  // ---------- 기준 집단 ----------
  function setGroup(g) {
    state.group = g;
    const r = document.querySelector(`input[name=group][value=${g}]`);
    if (r) r.checked = true;
  }
  async function onGroupChange(g) {
    if (g === state.group) return;
    if (state.virtual) { clearVirtual(); toast("가상 예시는 성인 남성 기준이라 지웠습니다."); }
    setGroup(g);
    state.practice.before = null; $("#p-compare").hidden = true;
    if (Object.keys(state.raw).length) { toast("기준이 바뀌어 녹음을 새 기준으로 다시 쟀습니다."); await reanalyzeAll(); }
    else update();
  }

  // ---------- 결과 ----------
  function computeResult() {
    const ok = {};
    for (const v of VOWELS) { const m = state.meas[v.code]; if (m && !m.error) ok[v.code] = m; }
    if (Object.keys(ok).length < MIN_FOR_RESULT) return null;
    return VA.computeDistances(ok, REF.groups[state.group]);
  }
  function direction(code) {
    const pv = state.result && state.result.perVowel[code];
    if (!pv) return [];
    const ref = REF.groups[state.group].meanZ50[code];
    const dF1 = pv.z50[0] - ref[0], dF2 = pv.z50[1] - ref[1];
    const out = [];
    if (dF1 < -0.3) out.push("입을 조금 더 벌리고 턱을 내리세요(혀가 원어민보다 높습니다).");
    if (dF1 > 0.3) out.push("입을 조금 덜 벌리세요(혀가 원어민보다 낮습니다).");
    if (dF2 < -0.3) out.push("혀를 조금 더 앞으로 내미세요(혀가 원어민보다 뒤에 있습니다).");
    if (dF2 > 0.3) out.push("혀를 조금 뒤로 당기세요(혀가 원어민보다 앞에 있습니다).");
    return out;
  }
  function renderResult() {
    const res = state.result, g = REF.groups[state.group];
    const n = VOWELS.filter(v => state.meas[v.code] && !state.meas[v.code].error).length;
    $("#result-empty").hidden = !!res;
    $("#result-body").hidden = !res;
    $("#result-need").textContent = Math.max(0, MIN_FOR_RESULT - n);
    $("#practice-empty").hidden = !!res;
    $("#practice-body").hidden = !res;
    if (!res) return;
    const badge = ok => ok ? '<span class="badge in">원어민 범위 안</span>' : '<span class="badge out">원어민 범위 밖</span>';
    $("#m-static").innerHTML = `<div class="m-name">정적 거리(모음 위치)</div><div class="m-value">${fmt(res.static)}${badge(res.staticIn)}</div><div class="m-ref">${g.label} 원어민 90%가 ${fmt(g.p90.static, 3)} 이하입니다. 중간값은 ${fmt(g.median.static, 3)}. 0에 가까울수록 원어민 평균과 같습니다.</div>`;
    $("#m-dynamic").innerHTML = `<div class="m-name">동적 거리(모음 안의 움직임, 보조)</div><div class="m-value">${fmt(res.dynamic)}${badge(res.dynamicIn)}</div><div class="m-ref">원어민 90%가 ${fmt(g.p90.dynamic, 3)} 이하입니다.</div>`;
    const outN = Object.values(res.perVowel).filter(p => !p.inRange).length;
    let ctx = `${res.n}개 모음 가운데 ${outN}개가 원어민 범위 밖입니다. `;
    if (res.n < 12) ctx += `12개를 모두 녹음하지 않아 ${res.n}개로 계산했습니다. `;
    ctx += "논문에서 가족 4명의 정적 거리는 0.70~1.12로 모두 원어민 범위 밖이었고, 한국어 화자에게 특히 먼 모음은 head·had(/ɛ/와 /æ/)와 hod(/ɑ/)였습니다.";
    $("#context").textContent = ctx;
    // 모음 목록
    const list = $("#vowel-list"); list.innerHTML = "";
    const order = Object.keys(res.perVowel).sort((a, b) => res.perVowel[b].static - res.perVowel[a].static);
    const maxV = Math.max(1.5, ...order.map(c => res.perVowel[c].static), ...order.map(c => g.vowelP90[c])) * 1.05;
    for (const c of order) {
      const pv = res.perVowel[c], v = byCode[c];
      const li = document.createElement("li"); li.className = "vrow";
      const dirs = direction(c);
      const tip = pv.inRange ? "원어민 범위 안입니다." : (dirs.length ? dirs.join(" ") : TIPS[c]);
      li.innerHTML = `<div class="v-id"><span class="i">/${v.ipa}/</span><span class="w">${v.word}</span></div>
        <div class="v-bar" role="img" aria-label="${v.word} 거리 ${fmt(pv.static)}, 원어민 범위 ${fmt(g.vowelP90[c])} 이하">
          <div class="fill ${pv.inRange ? "" : "out"}" style="width:${Math.min(100, pv.static / maxV * 100)}%"></div>
          <div class="tick" style="left:${Math.min(100, g.vowelP90[c] / maxV * 100)}%"></div>
          <span class="val">${fmt(pv.static)}</span></div>
        <div class="v-tip">${pv.inRange ? "" : "<b>범위 밖.</b> "}${tip}</div>`;
      list.appendChild(li);
    }
    renderPracticeSelect(order);
  }

  // ---------- 연습 ----------
  function renderPracticeSelect(order) {
    const sel = $("#practice-select");
    const res = state.result;
    if (!state.practice.code || !res.perVowel[state.practice.code]) state.practice.code = order[0];
    sel.innerHTML = "";
    order.forEach((c, i) => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = `${byCode[c].word} /${byCode[c].ipa}/  거리 ${fmt(res.perVowel[c].static)}${i === 0 ? " (가장 멂)" : ""}${res.perVowel[c].inRange ? "" : ", 범위 밖"}`;
      sel.appendChild(o);
    });
    sel.value = state.practice.code;
    renderPracticeCard();
  }
  function renderPracticeCard() {
    const c = state.practice.code, v = byCode[c], res = state.result;
    if (!c || !res) return;
    const pv = res.perVowel[c];
    $("#p-word").innerHTML = `<span class="i">/${v.ipa}/</span><span class="w">${v.word}</span> 지금 거리 <b>${fmt(pv.static)}</b>, 원어민 범위는 ${fmt(REF.groups[state.group].vowelP90[c])} 이하`;
    const dirs = direction(c);
    $("#p-tips").innerHTML = "<ul>" + [...dirs, TIPS[c]].map(t => `<li>${t}</li>`).join("") + "</ul>";
    $("#p-rec").setAttribute("aria-label", v.word + " 다시 녹음");
    const b = state.practice.before;
    const cmp = $("#p-compare");
    if (b && b.code === c && pv) {
      const cls = (a, z) => (z < a ? "better" : z > a ? "worse" : "");
      cmp.hidden = false;
      cmp.innerHTML = `<div class="c"><div class="c-name">${v.word} 모음 거리</div><div class="c-val">${fmt(b.vowel)}<span class="arrow">에서</span><span class="${cls(b.vowel, pv.static)}">${fmt(pv.static)}</span></div><div class="c-note">${pv.static < b.vowel ? "원어민에 가까워졌습니다." : pv.static > b.vowel ? "원어민에서 멀어졌습니다. 팁을 보고 한 번 더 해 보세요." : "변화가 없습니다."} ${pv.inRange ? "지금은 원어민 범위 안입니다." : "아직 원어민 범위 밖입니다."}</div></div>
        <div class="c"><div class="c-name">전체 정적 거리</div><div class="c-val">${fmt(b.overall)}<span class="arrow">에서</span><span class="${cls(b.overall, res.static)}">${fmt(res.static)}</span></div><div class="c-note">모음 하나를 바꾸면 내 12모음의 평균·표준편차도 조금 바뀌어, 다른 모음의 거리도 함께 움직일 수 있습니다.</div></div>`;
    } else cmp.hidden = true;
  }
  function snapshotBefore(code) {
    const res = state.result;
    if (!res || !res.perVowel[code]) { state.practice.before = null; return; }
    state.practice.before = { code, vowel: res.perVowel[code].static, overall: res.static, z50: res.perVowel[code].z50.slice() };
  }

  // ---------- 모음 지도 ----------
  const SVGNS = "http://www.w3.org/2000/svg";
  function el(name, attrs, parent, text) {
    const e = document.createElementNS(SVGNS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function renderChart() {
    const svg = $("#chart"); svg.innerHTML = "";
    const g = REF.groups[state.group], res = state.result;
    const W = 520, H = 440, pad = { l: 40, r: 18, t: 22, b: 34 };
    // x = zF2(오른쪽이 혀 뒤 = zF2 작음), y = zF1(아래가 혀 낮음)
    const pts = [];
    for (const v of VOWELS) { const m = g.meanZ50[v.code], r = g.vowelP90[v.code]; pts.push([m[1] + r, m[0] + r], [m[1] - r, m[0] - r]); }
    if (res) for (const c in res.perVowel) { const z = res.perVowel[c].z50; pts.push([z[1], z[0]]); }
    if (state.practice.before && state.practice.before.z50) { const z = state.practice.before.z50; pts.push([z[1], z[0]]); }
    let x0 = Math.min(...pts.map(p => p[0])) - 0.25, x1 = Math.max(...pts.map(p => p[0])) + 0.25;
    let y0 = Math.min(...pts.map(p => p[1])) - 0.25, y1 = Math.max(...pts.map(p => p[1])) + 0.25;
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const sc = Math.min(pw / (x1 - x0), ph / (y1 - y0));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const X = zF2 => pad.l + pw / 2 - (zF2 - cx) * sc;
    const Y = zF1 => pad.t + ph / 2 + (zF1 - cy) * sc;
    // 격자
    for (let k = Math.ceil(cx - pw / 2 / sc); k <= cx + pw / 2 / sc; k++) el("line", { x1: X(k), x2: X(k), y1: pad.t, y2: H - pad.b, class: "grid" }, svg);
    for (let k = Math.ceil(cy - ph / 2 / sc); k <= cy + ph / 2 / sc; k++) el("line", { x1: pad.l, x2: W - pad.r, y1: Y(k), y2: Y(k), class: "grid" }, svg);
    el("text", { x: pad.l, y: H - 10, class: "axis-label" }, svg, "혀 앞 (F2 높음)");
    el("text", { x: W - pad.r, y: H - 10, class: "axis-label", "text-anchor": "end" }, svg, "혀 뒤 (F2 낮음)");
    el("text", { x: 12, y: pad.t + 8, class: "axis-label", transform: `rotate(90 12 ${pad.t + 8})` }, svg, "혀 높음 (F1 낮음)");
    el("text", { x: 12, y: H - pad.b, class: "axis-label", "text-anchor": "end", transform: `rotate(90 12 ${H - pad.b})` }, svg, "혀 낮음 (F1 높음)");
    // 원어민
    const gN = el("g", {}, svg);
    for (const v of VOWELS) {
      const m = g.meanZ50[v.code];
      el("circle", { cx: X(m[1]), cy: Y(m[0]), r: g.vowelP90[v.code] * sc, class: "native-ring" }, gN);
      el("circle", { cx: X(m[1]), cy: Y(m[0]), r: 3, class: "native-dot" }, gN);
      el("text", { x: X(m[1]) + 6, y: Y(m[0]) - 6, class: "native-label" }, gN, v.ipa);
    }
    if (!res) return;
    // 연습 전 위치
    const b = state.practice.before;
    if (b && b.z50 && res.perVowel[b.code]) {
      const col = "var(--ink-3)";
      el("circle", { cx: X(b.z50[1]), cy: Y(b.z50[0]), r: 7, class: "before-dot", stroke: col }, svg);
    }
    // 내 모음
    const gM = el("g", {}, svg);
    for (const c in res.perVowel) {
      const pv = res.perVowel[c], m = g.meanZ50[c], col = pv.inRange ? "var(--me)" : "var(--out)";
      el("line", { x1: X(m[1]), y1: Y(m[0]), x2: X(pv.z50[1]), y2: Y(pv.z50[0]), stroke: col, class: "me-line" }, gM);
      el("circle", { cx: X(pv.z50[1]), cy: Y(pv.z50[0]), r: 6, fill: col, class: "me-dot" }, gM);
      el("text", { x: X(pv.z50[1]) + 8, y: Y(pv.z50[0]) + 14, fill: col, class: "me-label" }, gM, byCode[c].ipa);
      if (c === state.practice.code) el("circle", { cx: X(pv.z50[1]), cy: Y(pv.z50[0]), r: 11, class: "hl" }, gM);
    }
  }

  // ---------- 전체 갱신 ----------
  function update() {
    try { state.result = computeResult(); } catch (e) { state.result = null; }
    refreshCards();
    renderResult();
    renderChart();
  }

  // ---------- 시작 ----------
  function init() {
    if (!VA || !REF) { document.body.insertAdjacentHTML("afterbegin", '<p style="padding:16px;background:#fdecef">앱 파일 일부를 불러오지 못했어요. 폴더 구조가 README와 같은지 확인해 주세요.</p>'); return; }
    buildCards();
    document.querySelectorAll("input[name=group]").forEach(r => r.addEventListener("change", e => onGroupChange(e.target.value)));
    $("#ex-native").addEventListener("click", loadNativeExample);
    $("#ex-virtual").addEventListener("click", loadVirtualExample);
    $("#clear-all").addEventListener("click", () => clearAll(false));
    $("#practice-select").addEventListener("change", e => { state.practice.code = e.target.value; state.practice.before = null; renderPracticeCard(); renderChart(); });
    $("#p-rec").addEventListener("click", () => { if (state.practice.code) toggleRecord(state.practice.code, "practice"); });
    $("#p-file").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f && state.practice.code) handleFile(state.practice.code, f, "practice"); });
    update();
  }
  init();

  // 점검용(자동 검사에서 사용): 화면 상태 읽기
  window.__vowelApp = { state, update, analyzeSamples: (code, samples, fs) => takeAudio(code, { samples, fs }, null, "test", "word"), practiceSamples: (code, samples, fs) => takeAudio(code, { samples, fs }, null, "test", "practice") };
})();
