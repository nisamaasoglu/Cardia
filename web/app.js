/*
 * Cardia dashboard
 * -----------------------------------------------------------------------------
 * Polls the Arduino's JSON endpoint and renders the single-lead ECG trace, the
 * detected heart rate and the derived signal metrics. Zero dependencies - plain
 * DOM + canvas, no build step.
 *
 * Data sources
 *   DeviceSource : GET http://<ip>/  -> live AD8232 data.
 *   DemoSource   : a synthetic ECG generator, used when no board is reachable so
 *                  the dashboard can be reviewed without hardware. While it runs,
 *                  the status pill reads DEMO and the trace is drawn amber. No
 *                  value is ever faked while the status reads LIVE.
 *
 * The "Simulated" panel (blood pressure / oxygen / cardiovascular index) is a UI
 * placeholder, kept from the original project scope. The AD8232 measures a single
 * ECG lead and nothing else, so those three values are generated here and marked
 * as simulated in the markup, in the label and in the styling. They are never
 * presented as measurements.
 *
 * Query parameters
 *   ?ip=192.168.1.50   override the device address
 *   ?demo=1            start in demo mode
 *
 * Author: Nisa Maasoglu
 * License: MIT
 */

(() => {
  'use strict';

  const CONFIG = {
    defaultIp: '192.168.1.177',
    pollMs: 250,          // the Uno serves one request comfortably at 4 Hz
    requestTimeoutMs: 900,
    waveSize: 96,         // must match WAVE_SIZE in the firmware
    restingMin: 60,
    restingMax: 100,
    adcMax: 1023,
    simUpdateMs: 3000
  };

  const el = {
    ip: document.getElementById('ip-input'),
    connect: document.getElementById('connect-btn'),
    demo: document.getElementById('demo-btn'),
    sound: document.getElementById('sound-btn'),
    status: document.getElementById('status'),
    alert: document.getElementById('alert'),
    alertTitle: document.getElementById('alert-title'),
    heart: document.getElementById('heart'),
    bpm: document.getElementById('bpm'),
    source: document.getElementById('beat-source'),
    ibi: document.getElementById('m-ibi'),
    amp: document.getElementById('m-amp'),
    quality: document.getElementById('m-quality'),
    beats: document.getElementById('m-beats'),
    simBp: document.getElementById('s-bp'),
    simSpo2: document.getElementById('s-spo2'),
    simCvi: document.getElementById('s-cvi'),
    wave: document.getElementById('wave'),
    audio: document.getElementById('beat-audio')
  };

  const params = new URLSearchParams(location.search);

  // ---------------------------------------------------------------- sources
  class DeviceSource {
    constructor(ip) {
      this.ip = ip;
    }

    async read() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
      try {
        const res = await fetch(`http://${this.ip}/?t=${Date.now()}`, {
          signal: controller.signal,
          cache: 'no-store'
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /*
   * Synthetic single-lead ECG.
   * One cardiac cycle is built from Gaussian components placed at their usual
   * positions in the cycle: P wave, the Q-R-S complex, and the T wave. Heart rate
   * wanders slowly between roughly 68 and 82 BPM so the display behaves like a
   * real one rather than ticking like a metronome.
   */
  class DemoSource {
    constructor() {
      this.t0 = performance.now();
      this.phase = 0;
      this.beats = 0;
      this.lastBeatAt = performance.now();
      this.ibi = 0;
      this.wave = new Array(CONFIG.waveSize).fill(512);
      this.lastSampleAt = performance.now();
    }

    currentBpm(now) {
      const drift = Math.sin((now - this.t0) / 9000) + 0.4 * Math.sin((now - this.t0) / 2300);
      return 75 + drift * 6;
    }

    // amplitude, centre (as a fraction of the cycle), width
    static get COMPONENTS() {
      return [
        { a:  0.13, c: 0.15, w: 0.028 },   // P wave
        { a: -0.12, c: 0.235, w: 0.008 },  // Q
        { a:  1.00, c: 0.255, w: 0.008 },  // R
        { a: -0.28, c: 0.278, w: 0.011 },  // S
        { a:  0.30, c: 0.44,  w: 0.042 }   // T wave
      ];
    }

    sampleAt(phase) {
      let v = 0;
      for (const k of DemoSource.COMPONENTS) {
        v += k.a * Math.exp(-Math.pow((phase - k.c) / k.w, 2));
      }
      v += 0.02 * Math.sin(phase * Math.PI * 2);   // slow baseline wander
      return v;
    }

    read() {
      const now = performance.now();
      const bpm = this.currentBpm(now);
      const period = 60000 / bpm;
      const stepMs = 8;                     // 125 Hz, same rate the firmware sends

      for (let t = this.lastSampleAt; t < now; t += stepMs) {
        this.phase += stepMs / period;
        if (this.phase >= 1) {
          this.phase -= 1;
          this.beats += 1;
          this.ibi = Math.round(now - this.lastBeatAt);
          this.lastBeatAt = now;
        }
        const noise = (Math.random() - 0.5) * 0.02;   // sensor noise floor
        this.wave.push(Math.round(400 + (this.sampleAt(this.phase) + noise) * 400));
        if (this.wave.length > CONFIG.waveSize) this.wave.shift();
      }
      this.lastSampleAt = now;

      const min = Math.min(...this.wave);
      const max = Math.max(...this.wave);

      return Promise.resolve({
        raw: this.wave[this.wave.length - 1],
        bpm: Math.round(bpm),
        ibi: this.ibi || Math.round(period),
        amplitude: max - min,
        quality: 1,
        beats: this.beats,
        uptime: Math.round(now - this.t0),
        wave: this.wave.slice()
      });
    }
  }

  /*
   * Simulated panel. A bounded random walk rather than an independent random draw
   * per tick, so the numbers drift instead of teleporting - but they are still
   * invented, which is why every one of them is labelled "sim" on screen.
   */
  const sim = {
    systolic: 118,
    diastolic: 76,
    spo2: 97,
    cvi: 82,

    step(value, delta, lo, hi) {
      const next = value + (Math.random() - 0.5) * delta;
      return Math.min(hi, Math.max(lo, next));
    },

    tick() {
      this.systolic = this.step(this.systolic, 4, 105, 135);
      this.diastolic = this.step(this.diastolic, 3, 65, 88);
      this.spo2 = this.step(this.spo2, 0.8, 94, 99);
      this.cvi = this.step(this.cvi, 3, 60, 95);

      const sys = Math.round(this.systolic);
      const dia = Math.round(this.diastolic);
      const spo2 = Math.round(this.spo2);
      const cvi = Math.round(this.cvi);

      el.simBp.textContent = `${sys}/${dia}`;
      el.simBp.className = `metric-value ${sys > 130 || dia > 85 ? 'bad' : ''}`;
      el.simSpo2.textContent = `${spo2}%`;
      el.simSpo2.className = `metric-value ${spo2 < 95 ? 'bad' : ''}`;
      el.simCvi.textContent = `${cvi}%`;
      el.simCvi.className = `metric-value ${cvi < 70 ? 'bad' : ''}`;
    }
  };

  // ---------------------------------------------------------------- renderer
  const ctx = el.wave.getContext('2d');

  function resizeWave() {
    const dpr = window.devicePixelRatio || 1;
    const rect = el.wave.getBoundingClientRect();
    el.wave.width = Math.max(1, Math.round(rect.width * dpr));
    el.wave.height = Math.max(1, Math.round(220 * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawWave(samples, live) {
    const w = el.wave.clientWidth;
    const h = 220;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(120, 160, 220, 0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (!samples || samples.length < 2) return;

    // Autoscale to the visible window: the ADC rarely uses its full 0-1023 range,
    // so a fixed axis would flatten the trace into a straight line.
    let min = Math.min(...samples);
    let max = Math.max(...samples);
    if (max - min < 30) { const mid = (max + min) / 2; min = mid - 15; max = mid + 15; }
    const pad = (max - min) * 0.12;
    min -= pad; max += pad;

    const x = i => (i / (samples.length - 1)) * w;
    const y = v => h - ((v - min) / (max - min)) * h;

    ctx.beginPath();
    ctx.moveTo(x(0), y(samples[0]));
    for (let i = 1; i < samples.length; i++) ctx.lineTo(x(i), y(samples[i]));

    ctx.strokeStyle = live ? '#2de08a' : '#ffb02e';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = live ? 'rgba(45, 224, 138, 0.55)' : 'rgba(255, 176, 46, 0.5)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(x(samples.length - 1), y(samples[samples.length - 1]), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = live ? '#2de08a' : '#ffb02e';
    ctx.fill();
  }

  function drawBackgroundGrid() {
    const c = document.getElementById('grid');
    const g = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    c.width = window.innerWidth * dpr;
    c.height = window.innerHeight * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    g.strokeStyle = 'rgba(30, 60, 110, 0.35)';
    g.lineWidth = 1;
    const step = 37;
    for (let px = 0; px <= window.innerWidth; px += step) {
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, window.innerHeight); g.stroke();
    }
    for (let py = 0; py <= window.innerHeight; py += step) {
      g.beginPath(); g.moveTo(0, py); g.lineTo(window.innerWidth, py); g.stroke();
    }
  }

  // ---------------------------------------------------------------- state
  let source = null;
  let timer = null;
  let lastBeats = null;
  let soundOn = false;
  let consecutiveErrors = 0;

  function setStatus(kind, text) {
    el.status.className = `status status--${kind}`;
    el.status.textContent = text;
  }

  function pulseHeart() {
    el.heart.classList.add('beat');
    setTimeout(() => el.heart.classList.remove('beat'), 130);
    if (soundOn) {
      el.audio.currentTime = 0;
      el.audio.play().catch(() => { /* autoplay blocked until a user gesture */ });
    }
  }

  function render(data) {
    const live = source instanceof DeviceSource;
    const known = data.quality === 1 && data.bpm > 0;

    el.bpm.textContent = known ? data.bpm : '--';
    el.bpm.className = 'bpm';
    if (!known) {
      el.bpm.classList.add('unknown');
    } else if (data.bpm < CONFIG.restingMin || data.bpm > CONFIG.restingMax) {
      el.bpm.classList.add('out-of-range');
    }

    el.source.textContent = live
      ? (known ? `live from ${source.ip} · updated ${new Date().toLocaleTimeString()}`
               : `connected to ${source.ip} · check the electrode contact`)
      : 'simulated ECG — no board connected';

    el.ibi.textContent = data.ibi ? `${data.ibi} ms` : '--';
    el.amp.textContent = `${data.amplitude} / ${CONFIG.adcMax}`;
    el.quality.textContent = data.quality === 1 ? 'good' : 'weak';
    el.quality.className = `metric-value ${data.quality === 1 ? 'good' : 'bad'}`;
    el.beats.textContent = data.beats;

    drawWave(data.wave, live);

    // The firmware counts R-peaks; a change in that counter is the only trigger
    // for the animation and the sound, so both stay locked to real detections.
    if (lastBeats !== null && data.beats > lastBeats) pulseHeart();
    lastBeats = data.beats;

    const outOfRange = known && (data.bpm < CONFIG.restingMin || data.bpm > CONFIG.restingMax);
    el.alert.hidden = !outOfRange;
    if (outOfRange) {
      el.alertTitle.textContent = data.bpm > CONFIG.restingMax
        ? `Heart rate above the resting range (${data.bpm} BPM)`
        : `Heart rate below the resting range (${data.bpm} BPM)`;
    }
  }

  async function tick() {
    if (!source) return;
    try {
      const data = await source.read();
      consecutiveErrors = 0;
      if (source instanceof DeviceSource) setStatus('live', 'Live');
      render(data);
    } catch (err) {
      if (!(source instanceof DeviceSource)) return;
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        setStatus('offline', 'Offline');
        el.source.textContent = `no response from ${source.ip} — check the cable, the IP and that both devices are on the same network`;
        el.bpm.textContent = '--';
        el.bpm.className = 'bpm unknown';
      }
    }
  }

  function start(newSource) {
    if (timer) clearInterval(timer);
    source = newSource;
    lastBeats = null;
    consecutiveErrors = 0;

    if (source instanceof DemoSource) {
      setStatus('demo', 'Demo');
      timer = setInterval(tick, 60);
    } else {
      setStatus('offline', 'Connecting');
      timer = setInterval(tick, CONFIG.pollMs);
    }
    tick();
  }

  // ---------------------------------------------------------------- wiring
  el.connect.addEventListener('click', () => {
    const ip = el.ip.value.trim() || CONFIG.defaultIp;
    el.ip.value = ip;
    start(new DeviceSource(ip));
  });

  el.demo.addEventListener('click', () => start(new DemoSource()));

  el.sound.addEventListener('click', () => {
    soundOn = !soundOn;
    el.sound.setAttribute('aria-pressed', String(soundOn));
    el.sound.textContent = `Sound: ${soundOn ? 'on' : 'off'}`;
    if (soundOn) { el.audio.play().then(() => el.audio.pause()).catch(() => {}); }
  });

  el.ip.addEventListener('keydown', e => { if (e.key === 'Enter') el.connect.click(); });

  window.addEventListener('resize', () => { resizeWave(); drawBackgroundGrid(); });

  // ---------------------------------------------------------------- boot
  el.ip.value = params.get('ip') || CONFIG.defaultIp;
  resizeWave();
  drawBackgroundGrid();

  sim.tick();
  setInterval(() => sim.tick(), CONFIG.simUpdateMs);

  if (params.get('demo') === '1') {
    start(new DemoSource());
  } else {
    // Try the board first; fall back to the demo generator if it is not there,
    // so the page is never a dead screen for a reviewer without hardware.
    start(new DeviceSource(el.ip.value));
    setTimeout(() => {
      if (consecutiveErrors >= 3) start(new DemoSource());
    }, CONFIG.pollMs * 5);
  }
})();
