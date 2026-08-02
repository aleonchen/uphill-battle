// 通用输入层：InputState（每帧快照）+ 动作事件队列 + 输入模式管理
// 来源：KeyboardMouseSource（键鼠）/ TouchSource（触控）；未来 GamepadSource 同构插入
// 模式：auto（last-input-wins）/ touch / kbd；localStorage 记忆，?touch 强制
import { clamp } from './utils.js';

const LS_KEY = 'ub-input-mode';
const TOUCH_LOOK_SCALE = 1.7; // 触屏滑屏相对鼠标的灵敏度倍率

export class Input {
  constructor(params) {
    // 连续状态（player 每帧读）
    this.state = { fire: false, jump: false, revive: false };
    // 移动向量（模拟量 -1..1；键盘源在 pollMove 里从按键重建）
    this.moveX = 0; this.moveZ = 0; this.sprint = false;
    // 视角增量（本帧累计，takeLook 消费清零）
    this.lookDX = 0; this.lookDY = 0;
    this.events = []; // 动作边沿事件队列

    // 模式：pref 用户偏好（auto|touch|kbd），lastUsed 自动判定结果
    this.pref = 'auto';
    this.lastUsed = 'kbd';
    if (params && params.has('touch')) this.pref = 'touch';
    else {
      const saved = localStorage.getItem(LS_KEY);
      if (saved === 'touch' || saved === 'kbd') this.pref = saved;
    }
    this.onModeChanged = null; // main.js 注册：切换触控 UI 显隐
    this._bindAutoDetect();
  }

  // 自动检测：常驻全局监听（与触控源解耦——触控源要等 UI 显示才懒创建，
  // 检测若依赖它则永远触发不了，iPad 实测踩坑）。
  // 只用 pointer/touch 事件做判定：iPad 触摸后 Safari 会补发兼容性鼠标事件，
  // 若键鼠源也参与判定会被合成事件误判回键鼠。
  _bindAutoDetect() {
    const note = (e) => this.notePointerType(e.pointerType);
    window.addEventListener('pointerdown', note, { capture: true, passive: true });
    window.addEventListener('pointermove', note, { capture: true, passive: true });
    // 老 Safari（iOS 12-）无 pointer events 的兜底
    window.addEventListener('touchstart', () => this.notePointerType('touch'), { capture: true, passive: true });
  }

  // 当前生效模式
  mode() { return this.pref === 'auto' ? this.lastUsed : this.pref; }
  isTouch() { return this.mode() === 'touch'; }

  setPref(p) {
    this.pref = p;
    if (p === 'auto') localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, p);
    this._notify();
  }

  // last-input-wins：任何 pointer 事件进来都更新（仅 auto 档生效）
  notePointerType(t) {
    if (this.pref !== 'auto') return;
    const m = t === 'touch' ? 'touch' : 'kbd';
    if (m !== this.lastUsed) { this.lastUsed = m; this._notify(); }
  }
  noteKeyboard() {
    if (this.pref === 'auto' && this.lastUsed !== 'kbd') { this.lastUsed = 'kbd'; this._notify(); }
  }

  _notify() { if (this.onModeChanged) this.onModeChanged(this.mode()); }

  emit(type, data) { this.events.push({ type, data }); }
  drain() { const e = this.events; this.events = []; return e; }
  takeLook() { const r = { dx: this.lookDX, dy: this.lookDY }; this.lookDX = 0; this.lookDY = 0; return r; }
}

// ================= 键鼠源 =================
export class KeyboardMouseSource {
  constructor(input, dom) {
    this.input = input;
    this.dom = dom;
    this.keys = new Set();
    this._bind();
  }

  _bind() {
    const inp = this.input, dom = this.dom;
    window.addEventListener('keydown', (e) => {
      inp.noteKeyboard();
      if (e.repeat) return;
      this.keys.add(e.code);
      switch (e.code) {
        case 'KeyR': inp.emit('reload'); break;
        case 'Digit1': inp.emit('weapon', 0); break;
        case 'Digit2': inp.emit('weapon', 1); break;
        case 'Digit3': inp.emit('med', 'aid'); break;
        case 'Digit4': inp.emit('med', 'med'); break;
        case 'KeyG': inp.emit('throw', 'frag'); break;
        case 'KeyH': inp.emit('throw', 'smoke'); break;
        case 'KeyF': inp.emit('interact'); break;
        case 'KeyM': inp.emit('mute'); break;
        case 'KeyV': inp.emit('terrain'); break;
        case 'Tab': e.preventDefault(); inp.emit('backpack'); break;
        case 'Space': e.preventDefault(); break;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      inp.lookDX += e.movementX;
      inp.lookDY += e.movementY;
    });
    dom.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== dom) return;
      if (e.button === 0) inp.state.fire = true;
      if (e.button === 2) inp.emit('ads');
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) inp.state.fire = false;
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // 每帧从按键重建连续状态；非键鼠模式跳过——否则会每帧把触控源
  // 写入的摇杆/按钮状态清零（iPad/CDP 实测：摇杆被打死、按钮幸存，
  // 因为 poll 只覆盖移动/疾跑/跳/救援，不碰 fire）
  poll() {
    const inp = this.input;
    if (inp.mode() !== 'kbd') return;
    let ix = 0, iz = 0;
    if (this.keys.has('KeyW')) iz += 1;
    if (this.keys.has('KeyS')) iz -= 1;
    if (this.keys.has('KeyA')) ix -= 1;
    if (this.keys.has('KeyD')) ix += 1;
    inp.moveX = ix; inp.moveZ = iz;
    inp.sprint = this.keys.has('ShiftLeft');
    inp.state.jump = this.keys.has('Space');
    inp.state.revive = this.keys.has('KeyE');
  }
}

// ================= 触控源 =================
// 布局（和平精英式）：左下虚拟摇杆（模拟量，推满疾跑）、右半屏滑屏视角、右侧按钮集群
export class TouchSource {
  constructor(input, root) {
    this.input = input;
    this.root = root; // #touch-ui
    this.joyId = null;  // 摇杆跟踪的 pointerId
    this.lookId = null; // 滑屏跟踪的 pointerId
    this._lookX = 0; this._lookY = 0;
    this._bind();
  }

  _bind() {
    const inp = this.input, root = this.root;
    const joy = root.querySelector('#joystick');
    const knob = root.querySelector('#joy-knob');
    const R = 44; // 摇杆半径（px）

    // 摇杆：pointerdown 捕获，move 更新模拟量，up 归零
    joy.addEventListener('pointerdown', (e) => {
      inp.notePointerType('touch');
      this.joyId = e.pointerId;
      this._cap(joy, e.pointerId);
      this._joyMove(e, joy, knob, R);
      e.preventDefault();
    });
    joy.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.joyId) this._joyMove(e, joy, knob, R);
    });
    const joyEnd = (e) => {
      if (e.pointerId !== this.joyId) return;
      this.joyId = null;
      inp.moveX = 0; inp.moveZ = 0; inp.sprint = false;
      knob.style.transform = 'translate(0px, 0px)';
    };
    joy.addEventListener('pointerup', joyEnd);
    joy.addEventListener('pointercancel', joyEnd);

    // 滑屏视角：root 上非摇杆非按钮区域的触摸拖动
    root.addEventListener('pointerdown', (e) => {
      inp.notePointerType('touch');
      if (e.target.closest('#joystick') || e.target.closest('.tb')) return;
      if (e.clientX < window.innerWidth * 0.4) return; // 左侧留给摇杆区域
      this.lookId = e.pointerId;
      this._lookX = e.clientX; this._lookY = e.clientY;
      this._cap(root, e.pointerId);
      e.preventDefault();
    });
    root.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      inp.lookDX += (e.clientX - this._lookX) * TOUCH_LOOK_SCALE;
      inp.lookDY += (e.clientY - this._lookY) * TOUCH_LOOK_SCALE;
      this._lookX = e.clientX; this._lookY = e.clientY;
    });
    const lookEnd = (e) => { if (e.pointerId === this.lookId) this.lookId = null; };
    root.addEventListener('pointerup', lookEnd);
    root.addEventListener('pointercancel', lookEnd);

    // 按钮集群：data-act 分发（开火按住，其余点按/按住状态）
    for (const btn of root.querySelectorAll('.tb')) {
      const act = btn.dataset.act;
      btn.addEventListener('pointerdown', (e) => {
        inp.notePointerType('touch');
        e.preventDefault();
        e.stopPropagation();
        switch (act) {
          case 'fire': inp.state.fire = true; break;
          case 'jump': inp.state.jump = true; break;
          case 'ads': inp.emit('ads'); break;
          case 'reload': inp.emit('reload'); break;
          case 'frag': inp.emit('throw', 'frag'); break;
          case 'smoke': inp.emit('throw', 'smoke'); break;
          case 'interact': inp.emit('interact'); break;
          case 'weapon': inp.emit('weapon'); break; // 无 data = 轮换
        }
      });
      const up = (e) => {
        e.stopPropagation();
        if (act === 'fire') inp.state.fire = false;
        if (act === 'jump') inp.state.jump = false;
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    }
  }

  // 合成 pointerId（自动化测试）会捕获失败，静默降级（不影响跟踪逻辑）
  _cap(el, id) {
    try { el.setPointerCapture(id); } catch { /* 合成事件或指针已释放 */ }
  }

  _joyMove(e, joy, knob, R) {
    const rect = joy.getBoundingClientRect();
    let dx = e.clientX - (rect.left + rect.width / 2);
    let dy = e.clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const inp = this.input;
    inp.moveX = clamp(dx / R, -1, 1);
    inp.moveZ = clamp(-dy / R, -1, 1); // 上推=前进
    inp.sprint = Math.hypot(inp.moveX, inp.moveZ) > 0.85; // 推满疾跑
  }

  poll() { /* 连续状态由事件直接写入，无需轮询 */ }
}
