// HUD：DOM 层，负责所有界面元素的更新（准星/血量/弹药/比分/播报/横幅/倒计时圈/观战/头顶血槽/小地图）
import * as THREE from 'three';
import { heightAt, slopeAt, SNOW_LINE } from './terrain.js';
import { WEAPONS } from './weapons.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.el = {
      topbar: $('topbar'), scoreEnemy: $('score-enemy'), scoreUs: $('score-us'),
      timer: $('timer'), roundNum: $('round-num'), sideBadge: $('side-badge'),
      dotsUs: $('dots-us'), dotsEnemy: $('dots-enemy'),
      killfeed: $('killfeed'),
      bottomLeft: $('bottom-left'), hpNum: $('hp-num'), hpFill: $('hp-fill'),
      bottomRight: $('bottom-right'), weaponName: $('weapon-name'),
      quickbar: $('quickbar'),
      backpack: $('backpack'),
      mag: $('mag'), reserve: $('reserve'), reloadTip: $('reload-tip'),
      crosshair: $('crosshair'), hitmarker: $('hitmarker'), vignette: $('vignette'),
      banner: $('banner'), bannerTitle: $('banner-title'), bannerSub: $('banner-sub'),
      eventBanner: $('event-banner'), soundMarks: $('sound-marks'),
      prepCount: $('prep-count'),
      channel: $('channel'), channelArc: $('channel-arc'),
      channelNum: $('channel-num'), channelLabel: $('channel-label'),
      spectate: $('spectate'),
      interactTip: $('interact-tip'),
      startScreen: $('start-screen'), endScreen: $('end-screen'),
      endTitle: $('end-title'), endScore: $('end-score'), endStats: $('end-stats'),
      muteIcon: $('mute-icon'),
      overheads: $('overheads'),
      minimap: $('minimap'),
    };
    this._mmCtx = this.el.minimap.getContext('2d');
    this._mmBg = null;            // 小地图地形底图（一次性离屏渲染）
    this._hitTimer = null;
    this._vigOpacity = 0;
    this._aliveCache = '';
    this._bagCache = '';
    this._quickSlots = this.el.quickbar.querySelectorAll('.slot');
    // 背包面板点击用药（回调由 main.js 注入：用药成功则关面板并重新锁定指针）
    this.el.backpack.addEventListener('click', (e) => {
      const it = e.target.closest('.bp-item[data-use]');
      if (it && this._onUseMed) this._onUseMed(it.dataset.use);
    });
    this._ohs = new Map();        // actor.id → 头顶条 DOM
    this._smarks = [];            // 枪声标记：{x, z, mate, t}
    this._smEls = [];             // 复用的标记 DOM
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  // ---------------- 开局/回合 ----------------
  onMatchStart() {
    this.el.startScreen.classList.add('hidden');
    this.el.endScreen.classList.add('hidden');
    for (const k of ['topbar', 'bottomLeft', 'bottomRight', 'minimap', 'quickbar']) this.el[k].classList.remove('hidden');
  }

  onRoundStart(round, wins, weAttack) {
    this.onMatchStart();
    this.el.roundNum.textContent = `第 ${round} 回合`;
    this.setScore(wins);
    this.el.sideBadge.textContent = weAttack ? '进攻方' : '防守方';
    this.el.sideBadge.classList.toggle('defend', !weAttack);
    this.el.banner.classList.add('hidden');
    this.el.killfeed.innerHTML = '';
    this.el.spectate.classList.add('hidden');
    this.el.backpack.classList.add('hidden');
    this.el.channel.classList.add('hidden');
    this.el.prepCount.classList.remove('hidden');
    this.el.timer.textContent = '4:30';
  }

  setPrepCount(n) {
    this.el.prepCount.textContent = n > 0 ? n : '';
  }

  onCombatStart() {
    this.el.prepCount.classList.add('hidden');
    this.el.banner.classList.add('hidden');
  }

  setScore(wins) {
    this.el.scoreEnemy.textContent = wins.blue;
    this.el.scoreUs.textContent = wins.red;
  }

  setTimer(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    this.el.timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  onRoundEnd(weWon, wins) {
    this.setScore(wins);
    this.el.bannerTitle.textContent = weWon ? '回合胜利' : '回合失败';
    this.el.bannerTitle.style.color = weWon ? '#ffd76a' : '#ff5b4d';
    this.el.bannerSub.textContent = `敌方 ${wins.blue} : ${wins.red} 我方`;
    this.el.banner.classList.remove('hidden');
    this.el.prepCount.classList.add('hidden');
    this.el.channel.classList.add('hidden');
  }

  onMatchEnd(weWon, wins, player) {
    this.el.endTitle.textContent = weWon ? '胜利' : '失败';
    this.el.endTitle.style.color = weWon ? '#ffd76a' : '#ff5b4d';
    this.el.endScore.textContent = `敌方 ${wins.blue} : ${wins.red} 我方`;
    this.el.endStats.innerHTML = `你的击倒数：${player.kills}`;
    this.el.endScreen.classList.remove('hidden');
    document.exitPointerLock();
  }

  // ---------------- 每帧玩家状态 ----------------
  updatePlayer(p, game) {
    if (!p) return;
    // 血量
    this.el.hpNum.textContent = p.state === 'downed'
      ? `倒地 ${Math.max(0, Math.ceil(p.bleedUntil - game.now))}s`
      : Math.ceil(p.hp);
    const hpPct = p.state === 'alive' ? p.hp : 0;
    this.el.hpFill.style.width = `${hpPct}%`;
    this.el.hpFill.classList.toggle('low', hpPct <= 30);
    // 弹药
    const a = p.ammo[p.weaponIndex];
    this.el.mag.textContent = a.mag;
    this.el.reserve.textContent = a.reserve;
    this.el.reloadTip.textContent = p.reloadUntil <= 0 && a.mag === 0 ? '按 R 换弹' : '';
    // 快捷栏计数
    const bagKey = `${p.bag.aid},${p.bag.med},${p.bag.frag},${p.bag.smoke},${p.heal ? p.heal.type : ''}`;
    if (bagKey !== this._bagCache) {
      this._bagCache = bagKey;
      for (const s of this._quickSlots) {
        const k = s.dataset.k;
        s.querySelector('b').textContent = `×${p.bag[k]}`;
        s.classList.toggle('empty', p.bag[k] <= 0);
        s.classList.toggle('active', !!p.heal && p.heal.type === k);
      }
    }
    // 倒计时圈：治疗 > 换弹 > 救援（任何时刻只显示一个，和平精英式醒目）
    let chShown = false;
    if (p.heal) {
      const remain = Math.max(0, p.heal.until - game.now);
      this.channel(p.heal.type === 'aid' ? '急救箱' : '全能医疗箱',
        remain.toFixed(1), 1 - remain / p.heal.total, '#4cd964');
      chShown = true;
    } else if (p.reloadUntil > 0 && p.state === 'alive') {
      const w = WEAPONS[p.weaponIndex];
      const remain = Math.max(0, p.reloadUntil - game.now);
      this.channel('换弹中', remain.toFixed(1), 1 - remain / w.reload, '#ffd76a');
      chShown = true;
    }
    // 观战提示
    if (p.state !== 'alive') {
      const spec = game.getSpectateTarget();
      this.el.spectate.textContent = p.state === 'downed'
        ? (spec ? `你已倒地，等待救援 · 观战中：${spec.name}` : '你已倒地，等待救援…')
        : (spec ? `你已被淘汰 · 观战中：${spec.name}` : '你已被淘汰');
      this.el.spectate.classList.remove('hidden');
      if (!chShown) this.el.channel.classList.add('hidden');
      return;
    }
    this.el.spectate.classList.add('hidden');
    // 救援：3 米内倒地队友 → 圈内显示进度（未按 E 时提示）
    let target = null;
    for (const m of game.actors) {
      if (m.team !== p.team || m.state !== 'downed') continue;
      if (p.pos.distanceTo(m.pos) <= 3) { target = m; break; }
    }
    if (!chShown && target) {
      if (target.reviveProgress > 0) {
        const remain = (1 - target.reviveProgress) * 4;
        this.channel(`救援 ${target.name}`, remain.toFixed(1), target.reviveProgress, '#4cd964');
      } else {
        this.channel(`按住 E 救援：${target.name}`, 'E', 0, '#4cd964');
      }
      chShown = true;
    }
    if (!chShown) this.el.channel.classList.add('hidden');
  }

  // 倒计时圈：label 动作名，num 中心数字（秒），p 进度 0..1
  channel(label, num, p, color) {
    this.el.channel.classList.remove('hidden');
    this.el.channelArc.style.strokeDashoffset = String(201 * (1 - Math.max(0, Math.min(1, p))));
    this.el.channelArc.style.stroke = color;
    this.el.channelNum.textContent = num;
    this.el.channelLabel.textContent = label;
  }

  onPlayerDowned() { /* 观战提示由 updatePlayer 接管 */ }
  onPlayerDead() {}
  onPlayerRevived() { this.el.spectate.classList.add('hidden'); }

  setWeapon(name) { this.el.weaponName.textContent = name; }
  setReloading() { /* 换弹提示已由倒计时圈接管，此处不再重复 */ }
  setMute(m) { this.el.muteIcon.textContent = m ? '🔇' : '🔊'; }

  // 交互提示（按 F 上车 / 驾驶操作说明），相同文本不重复写 DOM
  interact(text) {
    if (text === this._interactCache) return;
    this._interactCache = text;
    this.el.interactTip.textContent = text || '';
    this.el.interactTip.classList.toggle('hidden', !text);
  }

  // 背包面板开关：打开时渲染计数并解锁指针（游戏随之暂停），返回是否打开
  toggleBackpack(game, show) {
    const el = this.el.backpack;
    const willShow = show === undefined ? el.classList.contains('hidden') : show;
    el.classList.toggle('hidden', !willShow);
    if (willShow) {
      for (const it of el.querySelectorAll('.bp-item')) {
        it.querySelector('span').textContent = `×${game.player.bag[it.dataset.k]}`;
      }
      document.exitPointerLock();
    }
    return willShow;
  }

  get backpackOpen() { return !this.el.backpack.classList.contains('hidden'); }

  // 顶部短提示（复用横幅样式，1.5 秒淡出；不覆盖回合横幅）
  toast(text) {
    this.el.bannerTitle.textContent = text;
    this.el.bannerTitle.style.color = '#fff';
    this.el.bannerSub.textContent = '';
    this.el.banner.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      if (this.el.bannerTitle.textContent === text) this.el.banner.classList.add('hidden');
    }, 1500);
  }

  // ---------------- 双方存活圆点 ----------------
  updateAlive(actors) {
    const key = actors.map((a) => a.state).join(',');
    if (key === this._aliveCache) return;
    this._aliveCache = key;
    const render = (team) => actors
      .filter((a) => a.team === team)
      .map((a) => `<span class="${a.state === 'alive' ? '' : a.state}"></span>`)
      .join('');
    this.el.dotsUs.innerHTML = render('red');
    this.el.dotsEnemy.innerHTML = render('blue');
  }

  // ---------------- 头顶血槽（DOM overlay，每帧投影定位） ----------------
  _ohEl(a) {
    let e = this._ohs.get(a.id);
    if (!e) {
      const root = document.createElement('div');
      root.className = `oh ${a.team}`;
      root.innerHTML = '<div class="name"></div><div class="bar"><div class="fill"></div></div>';
      this.el.overheads.appendChild(root);
      e = { root, name: root.querySelector('.name'), fill: root.querySelector('.fill'), nameCache: '' };
      this._ohs.set(a.id, e);
    }
    return e;
  }

  updateOverheads(game, camera) {
    const actors = game.actors;
    const w = window.innerWidth, h = window.innerHeight;
    for (const a of actors) {
      if (a.isPlayer) continue;
      const e = this._ohEl(a);
      let show = false;

      if (a.char.group.visible && a.state !== 'dead') {
        if (a.team === 'red') {
          show = true; // 队友常显（穿墙可见）
        } else if (a.hurtAgo < 4) {
          show = true; // 敌人：最近 4 秒受过伤
        } else {
          // 敌人：玩家准星大致瞄着（夹角 < ~2°，距离 < 120m）
          const v = this._v1.set(a.pos.x, a.pos.y + 1.5, a.pos.z).sub(camera.position);
          const d = v.length();
          if (d < 120) {
            camera.getWorldDirection(this._v2);
            if (v.normalize().dot(this._v2) > 0.9994) show = true; // cos(2°)
          }
        }
        // 投影到屏幕；在相机背后或出屏幕时隐藏
        if (show) {
          const v = this._v1.set(a.pos.x, a.pos.y + 2.15, a.pos.z).project(camera);
          if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.1) {
            show = false;
          } else {
            e.root.style.left = `${(v.x * 0.5 + 0.5) * w}px`;
            e.root.style.top = `${(-v.y * 0.5 + 0.5) * h}px`;
          }
        }
      }

      e.root.style.display = show ? '' : 'none';
      if (!show) continue;
      // 内容：血量/倒地倒计时（倒地时橙色闪烁）
      const downed = a.state === 'downed';
      e.root.classList.toggle('downed', downed);
      e.fill.style.width = `${downed ? (a.bleedRemain / 25) * 100 : a.hp}%`;
      const nameText = downed ? `${a.name} · ${Math.ceil(a.bleedRemain)}s` : a.name;
      if (nameText !== e.nameCache) { e.name.textContent = nameText; e.nameCache = nameText; }
    }
    this._updateSoundMarks(camera);
    this._updateMinimap(game);
  }

  // ---------------- 圆形小地图 ----------------
  // 底图：±205m 世界 → 168px 圆盘，雪/岩/草按高度坡度着色，只渲染一次
  _buildMinimapBg() {
    const S = 168, HALF = 205;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(S, S);
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const idx = (j * S + i) * 4;
        const dx = i - S / 2, dy = j - S / 2;
        if (dx * dx + dy * dy > (S / 2) * (S / 2)) { img.data[idx + 3] = 0; continue; }
        const x = (i / (S - 1) - 0.5) * 2 * HALF;
        const z = (j / (S - 1) - 0.5) * 2 * HALF;
        const hh = heightAt(x, z);
        let r, g, b;
        if (hh >= SNOW_LINE) { r = 226; g = 234; b = 244; }
        else if (slopeAt(x, z) > 0.55) { r = 110; g = 105; b = 98; }
        else {
          const t = Math.min(1, hh / SNOW_LINE);
          r = 74 - 20 * t; g = 122 - 24 * t; b = 52 - 10 * t;
        }
        img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = b; img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // 北向上圆盘：地形底图 + 载具 + 队友 + 枪声方位 + 玩家箭头
  _updateMinimap(game) {
    if (this.el.minimap.classList.contains('hidden')) return;
    if (!this._mmBg) this._mmBg = this._buildMinimapBg();
    const ctx = this._mmCtx, S = 168, C = S / 2, HALF = 205;
    const k = S / (2 * HALF); // px / m
    const px = (x) => C + x * k, pz = (z) => C + z * k;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this._mmBg, 0, 0);

    // 载具（深灰方块）
    ctx.fillStyle = '#2f343b';
    for (const v of game.vehicles) ctx.fillRect(px(v.pos.x) - 2.5, pz(v.pos.z) - 2.5, 5, 5);
    // 队友（红点，倒地橙点；敌人不显示——与"不做敌人标记"的约定一致）
    for (const a of game.actors) {
      if (a.isPlayer || a.team !== 'red' || a.state === 'dead') continue;
      ctx.fillStyle = a.state === 'downed' ? '#ff9f43' : '#ff5b4d';
      ctx.beginPath(); ctx.arc(px(a.pos.x), pz(a.pos.z), 2.6, 0, 7); ctx.fill();
    }
    // 枪声方位（橙=敌，灰=友，随年龄淡出）
    const now = performance.now();
    for (const m of this._smarks) {
      ctx.globalAlpha = Math.max(0, 1 - (now - m.t) / 1400);
      ctx.fillStyle = m.mate ? 'rgba(255,255,255,.85)' : '#ff9f43';
      ctx.beginPath(); ctx.arc(px(m.x), pz(m.z), 3, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // 玩家箭头：地图 x→右、z→下，yaw → 屏幕旋转角 = π - yaw
    const p = game.player;
    ctx.save();
    ctx.translate(px(p.pos.x), pz(p.pos.z));
    ctx.rotate(Math.PI - p.yaw);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.beginPath();
    ctx.moveTo(0, -5.5); ctx.lineTo(3.6, 4.5); ctx.lineTo(-3.6, 4.5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // ---------------- 反馈 ----------------
  hitmarker(strong) {
    const el = this.el.hitmarker;
    el.classList.toggle('kill', !!strong);
    el.style.opacity = 1;
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => { el.style.opacity = 0; }, strong ? 220 : 120);
  }

  vignette() {
    this._vigOpacity = 0.85;
    this.el.vignette.style.transition = 'none';
    this.el.vignette.style.opacity = 0.85;
    requestAnimationFrame(() => {
      this.el.vignette.style.transition = 'opacity .6s';
      this.el.vignette.style.opacity = 0;
    });
  }

  // 击倒/击杀事件横幅（比分栏下方，1.6s 后开始淡出；新事件直接顶替旧的）
  eventBanner(text, color = '#ffd76a') {
    const el = this.el.eventBanner;
    el.textContent = text;
    el.style.color = color;
    el.classList.remove('hidden');
    el.style.opacity = 1;
    clearTimeout(this._evFade); clearTimeout(this._evHide);
    this._evFade = setTimeout(() => { el.style.opacity = 0; }, 1600);
    this._evHide = setTimeout(() => { el.classList.add('hidden'); }, 2100);
  }

  // 枪声方向标记：登记一次枪声（世界坐标），由 updateOverheads 按相机方位渲染
  soundMark(pos, team) {
    this._smarks.push({ x: pos.x, z: pos.z, mate: team === 'red', t: performance.now() });
    if (this._smarks.length > 8) this._smarks.shift();
  }

  _updateSoundMarks(camera) {
    const now = performance.now();
    this._smarks = this._smarks.filter((m) => now - m.t < 1400);
    while (this._smEls.length < this._smarks.length) {
      const div = document.createElement('div');
      div.className = 'smark';
      div.appendChild(document.createElement('i'));
      this.el.soundMarks.appendChild(div);
      this._smEls.push(div);
    }
    camera.getWorldDirection(this._v2);
    const camYaw = Math.atan2(this._v2.x, this._v2.z);
    this._smEls.forEach((el, i) => {
      const m = this._smarks[i];
      if (!m) { el.style.display = 'none'; return; }
      const dx = m.x - camera.position.x, dz = m.z - camera.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 150) { el.style.display = 'none'; return; }
      // 相对视线的方位角；yaw 增大=向左，CSS 顺时针=向右，故取负
      const rel = Math.atan2(dx, dz) - camYaw;
      const age = (now - m.t) / 1400;
      el.style.display = '';
      el.style.transform = `rotate(${-rel}rad)`;
      el.classList.toggle('mate', m.mate);
      el.firstChild.style.opacity =
        String((1 - age) * (dist < 40 ? 0.95 : Math.max(0.25, 1 - (dist - 40) / 110)));
    });
  }

  killfeed(attacker, target, verb) {
    const div = document.createElement('div');
    div.className = 'entry';
    const tName = `<span class="${target.team}">${target.name}</span>`;
    div.innerHTML = attacker
      ? `<span class="${attacker.team}">${attacker.name}</span> ${verb} ${tName}`
      : `${tName} ${verb}`;
    this.el.killfeed.appendChild(div);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.firstChild.remove();
    setTimeout(() => { div.style.opacity = 0; }, 4200);
    setTimeout(() => div.remove(), 5000);
  }
}
