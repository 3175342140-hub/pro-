const recordBtn = document.getElementById("recordBtn");
const recordBtnText = document.getElementById("recordBtnText");
const resetBtn = document.getElementById("resetBtn");
const statusText = document.getElementById("statusText");
const timerDisplay = document.getElementById("timerDisplay");
const sysDot = document.getElementById("sysDot");
const sysText = document.getElementById("sysText");
const waveCanvas = document.getElementById("waveCanvas");
const canvasOverlay = document.getElementById("canvasOverlay");
const ctx = waveCanvas.getContext("2d");

// 物理指标 DOM
const mShimmer = document.getElementById("mShimmer");
const mPause = document.getElementById("mPause");
const mHesitation = document.getElementById("mHesitation");
const mZcr = document.getElementById("mZcr");
const mRmsStd = document.getElementById("mRmsStd");
const mSpeed = document.getElementById("mSpeed");

// 诊断结果 DOM
const gaugeCircle = document.getElementById("gaugeCircle");
const scoreValue = document.getElementById("scoreValue");
const levelValue = document.getElementById("levelValue");
const bandValue = document.getElementById("bandValue");
const summaryText = document.getElementById("summaryText");
const subTensionVal = document.getElementById("subTensionVal");
const subTensionBar = document.getElementById("subTensionBar");
const subFluencyVal = document.getElementById("subFluencyVal");
const subFluencyBar = document.getElementById("subFluencyBar");
const subRhythmVal = document.getElementById("subRhythmVal");
const subRhythmBar = document.getElementById("subRhythmBar");
const transcriptBox = document.getElementById("transcriptBox");
const traitText = document.getElementById("traitText");
const evidenceList = document.getElementById("evidenceList");
const suggestionList = document.getElementById("suggestionList");
const ctaDynamicText = document.getElementById("ctaDynamicText");

let mediaRecorder = null;
let audioContext = null;
let analyser = null;
let mediaStream = null;
let animId = null;
let timerInterval = null;
let isRecording = false;
let startTime = 0;
let audioChunks = [];

// DSP 统计累加器（支持首尾静音裁剪 VAD 与元音核心提取）
let dspFrames = [];
let zcrList = [];

function resizeCanvas() {
  const rect = waveCanvas.parentElement.getBoundingClientRect();
  waveCanvas.width = rect.width * window.devicePixelRatio;
  waveCanvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// 绘制静态网格背景
function drawGrid(w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
  ctx.lineWidth = 1;
  const step = 28;
  for (let x = 0; x < w; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
}
drawGrid(waveCanvas.clientWidth, waveCanvas.clientHeight);

// 自动探测浏览器最佳录音 MIME 类型
function getSupportedMimeType() {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];
  for (const t of types) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

// 计算单帧 RMS 与 过零率 (ZCR)
function extractFrameDSP(timeData) {
  let sumSq = 0;
  let zeroCrossings = 0;
  let prev = (timeData[0] - 128) / 128;

  for (let i = 0; i < timeData.length; i++) {
    const norm = (timeData[i] - 128) / 128;
    sumSq += norm * norm;
    if ((norm >= 0 && prev < 0) || (norm < 0 && prev >= 0)) {
      zeroCrossings++;
    }
    prev = norm;
  }
  const rms = Math.sqrt(sumSq / timeData.length);
  const zcr = zeroCrossings / timeData.length;
  return { rms, zcr };
}

// 科学版特征提取：自动剔除首尾操作空白 + 元音平滑微扰计算
function computeCurrentMetrics(durationSec) {
  if (dspFrames.length < 10) {
    return {
      durationSec: Number(durationSec.toFixed(2)),
      rmsAvg: 0, rmsPeak: 0, rmsStd: 0,
      pauseRatio: 0, hesitationCount: 0, shimmerProxy: 0, zcrAvg: 0
    };
  }

  // 1. 动态阈值：取前 15% 最小值的 2.2 倍作为环境底噪阈值（限制在 0.014 ~ 0.035 之间）
  const sortedRms = [...dspFrames].sort((a, b) => a - b);
  const noiseFloor = sortedRms[Math.floor(sortedRms.length * 0.15)] || 0.01;
  const VAD_THRESHOLD = Math.min(0.035, Math.max(0.014, noiseFloor * 2.2));

  // 2. 首尾静音裁剪 (VAD Trimming)：只截取真正开口说话到说完最后一个字之间的帧
  let firstVoiceIdx = dspFrames.findIndex((r) => r >= VAD_THRESHOLD);
  let lastVoiceIdx = dspFrames.length - 1;
  while (lastVoiceIdx > firstVoiceIdx && dspFrames[lastVoiceIdx] < VAD_THRESHOLD) {
    lastVoiceIdx--;
  }

  // 如果还没开口说话
  if (firstVoiceIdx === -1 || lastVoiceIdx - firstVoiceIdx < 5) {
    return {
      durationSec: Number(durationSec.toFixed(2)),
      rmsAvg: 0, rmsPeak: 0, rmsStd: 0,
      pauseRatio: 0, hesitationCount: 0, shimmerProxy: 0, zcrAvg: 0
    };
  }

  const activeFrames = dspFrames.slice(firstVoiceIdx, lastVoiceIdx + 1);
  const totalActive = activeFrames.length;

  // 3. 统计内部静音停顿比 (Internal Pause Ratio) 与 真正犹豫卡顿次数 (>350ms 即连续 21 帧静音)
  let internalSilentFrames = 0;
  let hesitationCount = 0;
  let silenceRun = 0;

  for (let i = 0; i < totalActive; i++) {
    if (activeFrames[i] < VAD_THRESHOLD) {
      internalSilentFrames++;
      silenceRun++;
      // 只有句中停顿超过约 350ms (21帧) 才算一次认知犹豫卡顿（过滤掉正常换气）
      if (silenceRun === 21) {
        hesitationCount++;
      }
    } else {
      silenceRun = 0;
    }
  }

  const pauseRatio = Math.round((internalSilentFrames / totalActive) * 100);

  // 4. 科学计算 Shimmer Proxy：只取高能量元音稳态段，并做 3 帧移动平均滤波，滤除辅音跳变
  const voicedFrames = activeFrames.filter((r) => r >= VAD_THRESHOLD * 1.3);
  let shimmerProxy = 0;
  if (voicedFrames.length > 6) {
    const smoothed = [];
    for (let i = 1; i < voicedFrames.length - 1; i++) {
      smoothed.push((voicedFrames[i - 1] + voicedFrames[i] + voicedFrames[i + 1]) / 3);
    }
    let diffSum = 0;
    for (let i = 1; i < smoothed.length; i++) {
      const relDiff = Math.abs(smoothed[i] - smoothed[i - 1]) / ((smoothed[i] + smoothed[i - 1]) / 2 + 0.001);
      // 剔除音节切换时的断崖跳变 (>0.35 属于字间切换，不属于声带颤抖)
      if (relDiff < 0.35) {
        diffSum += relDiff;
      }
    }
    // 归一化到符合临床直觉的百分比 (平稳说话约 3%~8%，声音发抖时 14%~30%)
    shimmerProxy = Math.min(45, Math.round((diffSum / smoothed.length) * 65));
  }

  // 5. 计算能量均值与标准差
  const avgRms = voicedFrames.length
    ? voicedFrames.reduce((a, b) => a + b, 0) / voicedFrames.length
    : 0;
  const peakRms = Math.max(...activeFrames);
  const variance = voicedFrames.length
    ? voicedFrames.reduce((a, b) => a + Math.pow(b - avgRms, 2), 0) / voicedFrames.length
    : 0;
  const rmsStd = Math.sqrt(variance);

  const zcrAvg = zcrList.length
    ? zcrList.reduce((a, b) => a + b, 0) / zcrList.length
    : 0;

  return {
    durationSec: Number(durationSec.toFixed(2)),
    rmsAvg: Number(avgRms.toFixed(4)),
    rmsPeak: Number(peakRms.toFixed(4)),
    rmsStd: Number(rmsStd.toFixed(4)),
    pauseRatio,
    hesitationCount,
    shimmerProxy,
    zcrAvg: Number(zcrAvg.toFixed(3))
  };
}

// 启动录音与实时 DSP 示波
async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const mimeType = getSupportedMimeType();
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);

    audioChunks = [];
    dspFrames = [];
    zcrList = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = handleStopAndAnalyze;

    mediaRecorder.start(200);
    isRecording = true;
    startTime = performance.now();

    // 更新 UI 状态
    canvasOverlay.style.opacity = "0";
    recordBtn.classList.add("recording");
    recordBtnText.textContent = "停止并生成多模态报告";
    resetBtn.disabled = true;
    sysDot.classList.add("recording");
    sysText.textContent = "正在实时捕获声学时频信号...";
    statusText.textContent = "请自然说话（例如：“你好你好，我叫某某某，我……”），再次点击按钮结束采集。";

    timerInterval = setInterval(() => {
      const elapsed = (performance.now() - startTime) / 1000;
      const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const secs = (elapsed % 60).toFixed(1).padStart(4, "0");
      timerDisplay.textContent = `${mins}:${secs}`;
    }, 100);

    const timeData = new Uint8Array(analyser.fftSize);
    const freqData = new Uint8Array(analyser.frequencyBinCount);

    function renderLoop() {
      if (!isRecording) return;
      analyser.getByteTimeDomainData(timeData);
      analyser.getByteFrequencyData(freqData);

      const { rms, zcr } = extractFrameDSP(timeData);
      dspFrames.push(rms);
      if (rms > 0.016) {
        zcrList.push(zcr);
      }

      // 实时刷新左侧遥测卡片
      const elapsedSec = (performance.now() - startTime) / 1000;
      const live = computeCurrentMetrics(elapsedSec);
      mShimmer.textContent = `${live.shimmerProxy} %`;
      mPause.textContent = `${live.pauseRatio} %`;
      mHesitation.textContent = `${live.hesitationCount} 次`;
      mZcr.textContent = live.zcrAvg;
      mRmsStd.textContent = live.rmsStd;

      // 绘制示波器
      const w = waveCanvas.clientWidth;
      const h = waveCanvas.clientHeight;
      drawGrid(w, h);

      // 底部频谱能量柱
      const barCount = 48;
      const barWidth = w / barCount;
      for (let i = 0; i < barCount; i++) {
        const val = freqData[i * 2] / 255;
        const barH = val * (h * 0.45);
        ctx.fillStyle = `rgba(20, 184, 166, ${0.12 + val * 0.25})`;
        ctx.fillRect(i * barWidth, h - barH, barWidth - 2, barH);
      }

      // 时域波形发光曲线
      ctx.beginPath();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = rms > 0.08 ? "#f59e0b" : "#2dd4bf";
      ctx.shadowBlur = 10;
      ctx.shadowColor = ctx.strokeStyle;

      const sliceWidth = w / timeData.length;
      let x = 0;
      for (let i = 0; i < timeData.length; i++) {
        const v = timeData[i] / 128.0;
        const y = (v * h) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      animId = requestAnimationFrame(renderLoop);
    }

    renderLoop();
  } catch (err) {
    alert("无法访问麦克风，请检查浏览器权限设置：" + err.message);
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearInterval(timerInterval);
  cancelAnimationFrame(animId);

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
  }
  if (audioContext) {
    audioContext.close();
  }

  recordBtn.classList.remove("recording");
  recordBtn.disabled = true;
  recordBtnText.textContent = "多模态引擎推理中...";
  sysDot.classList.remove("recording");
  sysText.textContent = "正在执行 Whisper 转写与声学交叉分析...";
  statusText.textContent = "正在将端侧 DSP 物理特征矩阵与音频流发送至云端推理引擎，请稍候（约 3–6 秒）...";
}

// 高亮转写文本中的重复词、省略号与犹豫词
function highlightParalinguistics(text) {
  if (!text) return "";
  return text.replace(
    /((?:[\u4e00-\u9fa5]{1,3})\1+|呃+|啊+|嗯+|那个|就是|……|\.{2,})/g,
    '<span class="hl-hesitation">$1</span>'
  );
}

async function handleStopAndAnalyze() {
  const durationSec = Math.max(1, (performance.now() - startTime) / 1000);
  const finalMetrics = computeCurrentMetrics(durationSec);

  const cleanMime = (mediaRecorder.mimeType || "audio/webm").split(";")[0].trim();
  const audioBlob = new Blob(audioChunks, { type: cleanMime });

  const formData = new FormData();
  formData.append("audio", audioBlob, "sample.webm");
  formData.append("metrics", JSON.stringify(finalMetrics));

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      body: formData
    });
    const data = await res.json();

    if (!res.ok || data.error || data.ok === false) {
      throw new Error(data.error || "分析请求失败");
    }

    renderResult(data);
    statusText.textContent = "✅ 多模态声学与副语言交叉评估完成。";
    sysText.textContent = "评估完成 · 数据已同步";
  } catch (err) {
    statusText.textContent = "❌ 评估出错：" + err.message;
    sysText.textContent = "引擎异常";
  } finally {
    recordBtn.disabled = false;
    recordBtnText.textContent = "重新语音采集";
    resetBtn.disabled = false;
  }
}

function getScoreColor(score) {
  if (score <= 40) return "#10b981"; // 翠绿
  if (score <= 65) return "#f59e0b"; // 琥珀黄
  return "#ef4444";                  // 朱砂红
}

function renderResult(data) {
  const color = getScoreColor(data.score);

  // 1. 圆环进度条动画 (周长 2 * PI * 50 = 314.16)
  const circumference = 314.16;
  const offset = circumference - (data.score / 100) * circumference;
  gaugeCircle.style.strokeDashoffset = offset;
  gaugeCircle.style.stroke = color;

  scoreValue.textContent = data.score;
  scoreValue.style.color = color;
  levelValue.textContent = `${data.level}焦虑表现`;
  levelValue.style.color = color;
  bandValue.textContent = `指数区间 ${data.band}`;
  summaryText.textContent = data.oneLineSummary;

  // 2. 更新语速与三维子量表
  mSpeed.textContent = `${data.speechRateCPM || "--"} 字/分`;

  const { vocalTension, fluencyBlock, rhythmInstability } = data.subScores || {};
  subTensionVal.textContent = `${vocalTension}/100`;
  subTensionBar.style.width = `${vocalTension}%`;
  subTensionBar.style.background = getScoreColor(vocalTension);

  subFluencyVal.textContent = `${fluencyBlock}/100`;
  subFluencyBar.style.width = `${fluencyBlock}%`;
  subFluencyBar.style.background = getScoreColor(fluencyBlock);

  subRhythmVal.textContent = `${rhythmInstability}/100`;
  subRhythmBar.style.width = `${rhythmInstability}%`;
  subRhythmBar.style.background = getScoreColor(rhythmInstability);

  // 3. 渲染高亮转写文本与特征剖析
  transcriptBox.classList.remove("muted");
  transcriptBox.innerHTML = highlightParalinguistics(data.transcript);

  traitText.classList.remove("muted");
  traitText.textContent = data.traitDescription;

  // 4. 渲染证据链与建议列表
  evidenceList.innerHTML = (data.evidence || [])
    .map((item) => `<li>${item}</li>`)
    .join("");

  suggestionList.innerHTML = (data.suggestions || [])
    .map((item) => `<li>${item}</li>`)
    .join("");

  // 5. 动态联动底部草本喷剂干预话术
  if (data.score >= 55) {
    ctaDynamicText.textContent = `当前检测到较高声带微扰(${data.metrics?.shimmerProxy}%)与言语阻滞，建议即刻使用「青囊安神芳香喷剂」进行嗅觉边缘系统降频干预。`;
  } else {
    ctaDynamicText.textContent = `当前声学节律整体平稳（指数 ${data.score}），可配合日常草本香囊维持自主神经张力平衡。`;
  }
}

recordBtn.addEventListener("click", () => {
  if (!isRecording) startRecording();
  else stopRecording();
});

resetBtn.addEventListener("click", () => {
  timerDisplay.textContent = "00:00.0";
  canvasOverlay.style.opacity = "1";
  drawGrid(waveCanvas.clientWidth, waveCanvas.clientHeight);

  mShimmer.textContent = "-- %";
  mPause.textContent = "-- %";
  mHesitation.textContent = "-- 次";
  mZcr.textContent = "--";
  mRmsStd.textContent = "--";
  mSpeed.textContent = "-- 字/分";

  gaugeCircle.style.strokeDashoffset = 314.16;
  scoreValue.textContent = "--";
  scoreValue.style.color = "#f1f5f9";
  levelValue.textContent = "待采集评估";
  levelValue.style.color = "#f1f5f9";
  bandValue.textContent = "区间 --";
  summaryText.textContent = "等待语音样本输入后生成多模态辨证定性结论...";

  subTensionVal.textContent = "--"; subTensionBar.style.width = "0%";
  subFluencyVal.textContent = "--"; subFluencyBar.style.width = "0%";
  subRhythmVal.textContent = "--"; subRhythmBar.style.width = "0%";

  transcriptBox.classList.add("muted");
  transcriptBox.textContent = "暂无语音转写内容。系统将自动捕获并高亮口语中的叠词、犹豫词与断句停顿。";
  traitText.classList.add("muted");
  traitText.textContent = "等待分析完成后显示状态洞察...";

  evidenceList.innerHTML = '<li class="empty-li">待提取声学与副语言证据链</li>';
  suggestionList.innerHTML = '<li class="empty-li">待生成个性化生理与感官调节建议</li>';
  statusText.textContent = "已重置，点击「开始语音采集」进行新一轮测试。";
  resetBtn.disabled = true;
});