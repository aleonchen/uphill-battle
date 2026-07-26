// 音频：WebAudio 程序化合成（无外部音频文件），单例对外只暴露简洁 API
// 用法：Audio.init()（用户手势内）、Audio.play('shot', {dist, weapon})、Audio.toggleMuted()

class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._noiseBuf = null;
  }

  // 必须在用户手势里调用（点击开始 / Pointer Lock 获取）
  init() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    // 主增益 + 压缩限幅（连发叠加也不会爆音）
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    // 预生成 1 秒白噪声
    const len = this.ctx.sampleRate;
    this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
    if (this._eng) this._eng.g.gain.value = m ? 0 : 0.1;
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // ---------------- 合成原语 ----------------
  // 噪声脉冲：枪声/脚步/闷响
  _burst({ dur, peak, type = 'lowpass', freq = 1000, q = 0.8, pitch = 1, delay = 0 }) {
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq * pitch;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // 音调滑音：提示音/蜂鸣/stinger
  _blip({ f0, f1 = f0, type = 'sine', dur, peak, pitch = 1, delay = 0 }) {
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * pitch), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // 简短音阶（stinger / 琶音）
  _notes(freqs, step, dur, peak, type = 'triangle') {
    freqs.forEach((f, i) => this._blip({ f0: f, type, dur, peak, delay: i * step }));
  }

  // ---------------- 载具引擎（持续音，转速随车速） ----------------
  engineStart() {
    if (!this.ctx || this._eng) return;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 55;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const g = this.ctx.createGain();
    g.gain.value = this.muted ? 0 : 0.1;
    o.connect(f); f.connect(g); g.connect(this.master);
    o.start();
    this._eng = { o, g };
  }

  engineUpdate(u) {
    if (this._eng) this._eng.o.frequency.value = 55 + u * 105;
  }

  engineStop() {
    if (!this._eng) return;
    const { o, g } = this._eng;
    this._eng = null;
    g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.25);
    o.stop(this.ctx.currentTime + 0.3);
  }

  // ---------------- 事件音效 ----------------
  play(name, opts = {}) {
    if (!this.ctx || this.muted) return;
    const r = 0.92 + Math.random() * 0.16; // 随机音高扰动
    switch (name) {
      case 'shot': {
        // dist：与玩家的距离，按距离衰减，80m 外几乎听不见
        const dist = opts.dist || 0;
        const g = dist <= 0 ? 1 : Math.max(0, 1 - dist / 80) ** 2;
        if (g < 0.02) return;
        if (opts.weapon === 1) {
          // M249：更低沉
          this._burst({ dur: 0.12, peak: 0.42 * g, type: 'bandpass', freq: 700, q: 0.7, pitch: r });
          this._blip({ f0: 200, f1: 70, type: 'square', dur: 0.09, peak: 0.16 * g, pitch: r });
        } else {
          // 步枪：清脆短促
          this._burst({ dur: 0.08, peak: 0.4 * g, type: 'bandpass', freq: 1600, q: 0.6, pitch: r });
          this._blip({ f0: 700, f1: 180, type: 'square', dur: 0.05, peak: 0.13 * g, pitch: r });
        }
        break;
      }
      case 'hit':   // 命中 tick
        this._blip({ f0: 1100, f1: 900, type: 'triangle', dur: 0.05, peak: 0.2 });
        break;
      case 'ding':  // 爆头/击倒
        this._blip({ f0: 1600, f1: 2200, type: 'sine', dur: 0.12, peak: 0.25 });
        break;
      case 'reload_start': // 卸弹匣咔哒
        this._burst({ dur: 0.05, peak: 0.22, type: 'lowpass', freq: 900 });
        this._blip({ f0: 320, f1: 200, type: 'square', dur: 0.04, peak: 0.12 });
        break;
      case 'reload_end':   // 上膛
        this._burst({ dur: 0.04, peak: 0.2, type: 'lowpass', freq: 1200 });
        this._burst({ dur: 0.05, peak: 0.24, type: 'lowpass', freq: 800, delay: 0.07 });
        this._blip({ f0: 500, f1: 700, type: 'square', dur: 0.05, peak: 0.12, delay: 0.07 });
        break;
      case 'step':  // 脚步
        this._burst({
          dur: 0.07, peak: opts.sprint ? 0.16 : 0.1,
          type: 'lowpass', freq: 350, pitch: 0.8 + Math.random() * 0.4,
        });
        break;
      case 'hurt':  // 玩家受击：闷响
        this._burst({ dur: 0.18, peak: 0.42, type: 'lowpass', freq: 250 });
        this._blip({ f0: 130, f1: 60, type: 'sine', dur: 0.18, peak: 0.28 });
        break;
      case 'throw': // 投掷挥臂风声
        this._burst({ dur: 0.12, peak: 0.12, type: 'bandpass', freq: 900, q: 1.2, pitch: 1.3 });
        break;
      case 'boom': { // 手雷爆炸：低频轰 + 次声压（160m 内可闻）
        const dist = opts.dist || 0;
        const g = dist <= 0 ? 1 : Math.max(0, 1 - dist / 160) ** 1.5;
        if (g < 0.02) return;
        this._burst({ dur: 0.5, peak: 0.6 * g, type: 'lowpass', freq: 300 });
        this._blip({ f0: 90, f1: 35, type: 'sine', dur: 0.45, peak: 0.5 * g });
        break;
      }
      case 'nade_bounce': { // 手雷磕地
        const dist = opts.dist || 0;
        const g = Math.max(0, 1 - dist / 40);
        if (g < 0.05) return;
        this._burst({ dur: 0.04, peak: 0.14 * g, type: 'bandpass', freq: 2000, q: 2 });
        break;
      }
      case 'smoke_pop': { // 烟雾弹起烟：嘶嘶白噪
        const dist = opts.dist || 0;
        const g = dist <= 0 ? 1 : Math.max(0, 1 - dist / 60);
        if (g < 0.05) return;
        this._burst({ dur: 0.9, peak: 0.18 * g, type: 'highpass', freq: 2500, q: 0.5 });
        break;
      }
      case 'ram': { // 载具撞人：闷响
        const dist = opts.dist || 0;
        const g = dist <= 0 ? 1 : Math.max(0, 1 - dist / 60);
        if (g < 0.05) return;
        this._burst({ dur: 0.15, peak: 0.35 * g, type: 'lowpass', freq: 200 });
        this._blip({ f0: 110, f1: 55, type: 'sine', dur: 0.12, peak: 0.2 * g });
        break;
      }
      case 'down':  // 己方倒地提示
        this._notes([520, 370], 0.12, 0.15, 0.22);
        break;
      case 'revive': // 救援成功：上行琶音
        this._notes([523, 659, 784], 0.08, 0.1, 0.22);
        break;
      case 'count': // 倒计时蜂鸣
        this._blip({ f0: 880, type: 'sine', dur: 0.09, peak: 0.2 });
        break;
      case 'heal_start': // 治疗开始：包扎窸窣
        if (opts.dist && opts.dist > 40) return;
        this._burst({ dur: 0.25, peak: 0.1, type: 'bandpass', freq: 1400, q: 0.8 });
        break;
      case 'heal_done': // 治疗完成：上行两音
        if (opts.dist && opts.dist > 40) return;
        this._notes([660, 880], 0.09, 0.1, 0.2);
        break;
      case 'round_win':
        this._notes([523, 784], 0.15, 0.3, 0.28);
        break;
      case 'round_lose':
        this._notes([392, 262], 0.18, 0.35, 0.26);
        break;
      case 'match_win':
        this._notes([523, 659, 784, 1047], 0.14, 0.35, 0.28);
        break;
      case 'match_lose':
        this._notes([392, 330, 262, 196], 0.16, 0.4, 0.26);
        break;
    }
  }
}

export const Audio = new AudioSystem();
