# 工程记录（PLANS.md）

攻山模式网页原型的关键决策与踩坑记录。改相关代码前先读对应小节，避免重走弯路。

## 瞄准系统：枪管 / 准星 / 弹道一线（2026-07-18 定稿）

用户两次明确要求"枪管、准星、弹道在一条直线上"。最终方案三层分离：

1. **弹道（实际命中）**：从相机（眼睛）发射线 `castRay` 求 `aimPoint`，子弹从眼睛射向它。
   → 保证"准星指哪打哪"，这是不可妥协的语义。
2. **曳光（视觉）**：从枪口 `muzzle` 画到命中点。
   → 视觉上子弹从枪出膛，但落点永远等于准星命中点。
3. **枪管姿态**：`player.js updateGunConvergence()` 每帧把枪管旋到指向 `aimPoint`
   （仅 `aimBlend > 0.5` 时生效，否则复位 `gun.rotation.set(1.35, 0, 0)`）。

### 已否决的做法（不要再加回来）

- ❌ 子弹从枪口沿枪管方向射出：与准星存在视差，近距明显打偏。
- ❌ 角色侧倾 / 内扣 / 大角度扭身（曾尝试让枪"看起来更指向目标"）：
  会导致枪管偏离真实弹道。只保留 `body.rotation.y = -0.15 * aimBlend`。
- ❌ 相机低视角：看不到枪。现相机在越肩基础上抬高 1.0m（ADS 时 0.45m），
  朝向严格等于瞄准方向（和平精英式）。
- ❌ 相机直接跟随地形高度：陡坡附近画面来回抖动（用户报过两次）。
  现用 `camEye / camT / liftY` 平滑，**快升慢降**。

### 相关操作

- 机瞄：右键**点按切换**（不是长按），代码里别再改回按住。
- 命中角色冒绿烟（`weapons.js` fire → `effects.smoke(end, 0x35d04a)`），
  命中地形为雪/土色火花；受击闪屏保留。

## 背包与治疗（2026-07-19）

- `actor.bag = { aid, med, frag, smoke }`（每回合 2/1/2/2 补给），替代原 `nades` 字段。
- 治疗引导 `actor.heal = { type, until, total }`：急救箱 5s → 回至 75（≥75 不可用），
  全能医疗箱 7s → 回满。**完成才扣物品，打断不消耗**；打断条件：移动/跳跃/开火/受击
  （AI 侧由 `moveTo`/`tryFire`/`applyDamage` 统一取消，人机通用）。
- **AI 也会打药**（2026-07-19）：无目标且 4s 未受击时，hp<60 用急救箱（→75）。
  bot 背包只发 1 个急救箱、不发全能医疗箱（平衡测量：bot 全量补给把进攻胜率
  从 53% 推到 67%——治疗对打波次的一方增益更大，且守方打药会离哨位；
  砍到 aid×1 + med×0 后回到 ~56%）。全能医疗箱是玩家专属奢侈。
- HUD 三件套：底部快捷栏（计数+激活高亮）、倒计时圈、Tab 背包面板
  （可点击用药；**打开背包会解锁指针 → 游戏暂停，这是刻意取舍**，pause-tip 让位）。
- 倒计时圈 `hud.channel(label, num, p, color)`（2026-07-19，和平精英式）：
  换弹（黄）/治疗（绿）/救援（绿）统一走这一个组件，优先级 治疗 > 换弹 > 救援，
  同一时刻只显示一个；`setReloading` 已变成空操作，"换弹中"文案别再加回 reloadTip。
- `hud._onUseMed` 由 main.js 注入（用药成功 → 关面板 + 恢复指针锁定）。

## 投掷物（2026-07-19）

- `grenades.js`：G 手榴弹 / H 烟雾弹（每回合各 2 颗补给，HUD 右下角计数）。
- 手雷：2.6s 引信，7m 范围伤害（中心 92 线性衰减），**伤敌也伤己伤队友**
  （和平精英规则）；遮挡判定复用 `castRay`——爆心到胸口第一命中是本人才掉血，
  所以岩石/地形能挡手雷（与子弹同一套规则，`?test=grenade` 有断言）。
- 烟雾：落地 1.2s 起烟，云团 18s（半径 5.5m）。注册在 `weapons.js smokeClouds`，
  `ai.js losClear` 第一道工序查它——**AI 看不见烟后目标（已有目标也会丢），
  但子弹照常穿过**（烟雾不挡子弹，这是刻意的）。
- 物理从简：质点 + 地面反弹衰减；驾驶中禁用投掷（防车速叠加弹道）。
- bot 暂不会用投掷物（玩家独享战术手段）。

## 掩体系统（2026-07-18）

- 碰撞体：`terrain.js colliders = { classic, mc }`，竖直圆柱 `{x, z, y0, y1, r}`，
  按画风分开登记；`activeColliders()` 取当前画风，`coverSpots()` 是 r≥1.0 的子集（AI 躲掩体用）。
- 子弹：`weapons.js rayCovers()` 进 `castRay`，命中掩体 `onCover=true`（灰色火花）。
- 视线：`ai.js losClear` 里 `segmentBlockedByCover`——**只有 r≥0.9 的岩石挡视线，
  树干只挡子弹**（细树干不该让 AI 变瞎，这是刻意的）。
- 树位模块级缓存（`_treeSpotsCache`）：两种画风共用同一批树，别再放开每次随机——
  否则切画风树会"搬家"，碰撞体也对不上。
- 进攻路线沿途有程序化掩体链（ROUTES 每个中途航点旁 1~2 块石头）。

## 载具（2026-07-18）

- `vehicle.js`：MC 风沙滩车，两个进攻出生点各一辆；F 上下车，W/S 油门刹车、A/D 转向。
- 物理刻意从简：质点 + 地形贴地 + 坡度/圆柱碰撞 + 分轴滑动；车身姿态用四点高度差。
- 已定的范围取舍：bot 不开车；驾驶员可被击中（命中框吸附座位）；车本身无血量/无敌。
- 上车隐藏角色 mesh，但 `actor.pos` 每帧吸附座位（`v.seatPos`），命中框随车走——
  别再给车里的玩家单独摆姿态。
- 上车瞬间把 `p.yaw/pitch` 掰到车头方向（司机视角），之后鼠标自由环顾；用户明确要求。
- 载具战斗三件套（2026-07-19，和平精英规则）：
  - **血量**：`v.hp = 600`，子弹承伤 ×1.5（步枪 ~17 发爆）；<40% 冒灰烟；
    打爆 → `setWrecked()` 熏黑不可用（下回合 reset 恢复），爆炸复用 `grenades.explodeAt`
    （**车里人照样挨炸**，先 `_eject` 再爆，击杀算 attacker 的）。
  - **子弹命中**：`weapons.js rayVehicle`（载具本地系 AABB slab）进 `castRay`，
    命中返回 `hit.vehicle`、金属火花；载具因此能给乘员挡子弹（头露出车窗可爆头）。
  - **撞人**：`game._updateRamming()`，|speed|>5 且 2.2m 内 → 伤害 = speed×7（30~140，
    ≈直接撞倒），不分敌我，撞完车速 ×0.55，每人 1s 冷却；残骸/低速不触发。
  - 残骸不可上车（toggleVehicle 过滤）；车况 % 显示在驾驶提示里。
- 倒地/死亡/回合重开都会 `_eject` 强制下车；引擎音效用 `Audio.engineStart/Update/Stop`。

## HUD 反馈（2026-07-18）

- 事件横幅 `hud.eventBanner`：击倒/淘汰且与玩家有关时触发（金=我方得手，红=玩家遭殃）。
- 枪声方向标记 `hud.soundMark`：非玩家开枪即登记，围绕准星的方位弧，橙=敌、灰=友，
  1.4s 淡出，>150m 不显示。**不做敌人位置标记**（用户明确否过，说不合理）。
- 方位角换算：世界方位 `atan2(dx,dz)` 减相机 yaw，yaw 增大=向左、CSS 顺时针=向右，
  所以旋转角取负（`rotate(${-rel}rad)`）——改这里前先想清这个约定。
- 圆形小地图（2026-07-19）：`#minimap` canvas，北向上固定盘（±205m→168px，x→右、z→下），
  地形底图离屏渲染一次（`_mmBg`）；动态画载具/队友/枪声点/玩家箭头
  （yaw→屏幕旋转角 = π − yaw）。`hud.updateOverheads(game, camera)` 签名是 game，别传错。

## 输入层（2026-07-19，键盘/触控同构）

- `js/input.js`：`Input`（连续状态 moveX/moveZ/sprint/state{fire,jump,revive} +
  lookDX/DY 增量 + 动作事件队列）+ `KeyboardMouseSource` + `TouchSource`。
  `player.js` 只消费 `input`，不碰 DOM 事件——**未来手柄源同构插入即可**
  （写同样状态和事件）。动作一律走事件队列（reload/weapon/med/throw/interact/
  backpack/mute/terrain/ads），连续态走 poll。
- 模式判定（已定论）：`pointerType` last-input-wins，不做设备探测；
  偏好 auto/touch/kbd 存 localStorage('ub-input-mode')，`?touch` 强制。
  Pointer Lock 仅键鼠模式请求；触屏 pixelRatio 降 1.5；静音键挪左侧（避开火键）。
- 触控布局（和平精英式）：左下摇杆（模拟量，推满疾跑）、右半屏滑屏视角、
  右侧按钮集群（开火按住/瞄/跳/换弹/雷/烟）；快捷栏格子+武器名可点
  （触屏无 1/2/3/4 键的补偿）。
- 测试：`?test=input` 双源断言（键盘移动/事件队列/摇杆模拟量+推满疾跑/松手归零/滑屏视角）。
- 注意：平衡模拟只跑 `game.update`，输入层改动**不可能**影响 BALANCE 数值；
  若 BALANCE 波动，先看样本量（≥60 才有意义）。

## 攻守平衡（2026-07-19，大样本定稿）

- 测试器：`?test=balance&rounds=N`——玩家也挂 AI（公平 4v4），20Hz 离屏快模，跨多场
  连续模拟，`BALANCE` 输出 atkWins/atkRounds。**教训：N<20 的批次全是噪声
  （同一配置曾测出 67% 和 33%），结论必须基于 ≥60 回合。**
- 大样本测量史（60 回合 × 2）：
  - 基线（西南后山 + 0.4 混入 + ATK_SPRINT 8.4）：进攻 ~35%
  - 南北对向拉开出生点（验证用户"分散守方"假设）：~25%，**假设不成立**——
    4v4 规模下进攻 2+2 分兵被内线防守逐个吃掉（兰切斯特平方律），分散对进攻方更伤
  - 全员一路（另一极端）：~21%，同样不行
  - ✅ 扇区防守（守方只守 ±60° 巡逻、只响应哨位 ±75° 内的警觉）：进攻 **~53%**
- 结论：守方"4 枪集火先露头者"才是进攻弱的主因；有效的"分散守方火力"是改
  守方 AI 的注意力分配（`ai.js sectorPoints` + `game.js _defenseAcceptsAlert`），
  不是改地图几何。地图不需要扩大。
- AI 治疗的影响（2026-07-19 补测）：bot 全量补给（2 急救+1 医疗箱）→ 进攻 67%，
  说明治疗对打波次的一方增益更大；砍到 bot 只带 1 个急救箱（无医疗箱）→ 回到 ~56%。
- 之前的"45%"结论是小样本噪声，以本节为准。

## 回合与 AI

- 第 1 回合我方**进攻**开局，之后攻守互换。
  （用户改过两次：防守→进攻，以代码为准。）
  ⚠️ `attackSide` 在 constructor 和 `startMatch()` 里都有初始化——改开局攻守必须改
  `startMatch()` 那处，否则开赛即被重置（踩过一次）。
- 防守方 AI 无活动范围限制（leash 已删除），全员全图移动。
- `setupRound` 防守分支必须是 `actor.isPlayer ? null : new AIController`
  ——玩家永远不被挂 AI（出过一次"防守回合玩家失控"的 bug）。
- `game.combatUntil` 在 prep 阶段结束才设置，调试时注意别在 prep 内判开火。

## 双画风

- `V` 键切换经典平滑地形 / MC 方块地形；角色恒为 MC 关节小人。
- `toggleTerrainMode()` 结尾必须调 `this.onTerrainModeChanged?.()`（main.js 注册为
  `playerCtl.resetCamera()`），否则切换后相机穿地/悬空。

## 验证管线（视觉改动必须走一遍，禁止只改不验）

```bash
# 起服务（禁缓存，必须用它而不是 python3 -m http.server）
cd /Users/aleon/src/game && python3 serve.py   # 端口 8123

# 无头截图（--enable-unsafe-swiftshader 必须加，否则 WebGL 全黑）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --enable-unsafe-swiftshader --hide-scrollbars --window-size=1280,720 \
  --virtual-time-budget=8000 --screenshot=/tmp/shot.png \
  "http://localhost:8123/?autostart&ff=2&fire"
```

- main.js 调试参数（保留勿删）：`?autostart` 直接开赛、`&fire` 自动开火、
  `&ff=N` 固定步长快进 N 秒（无头时钟不走，必须用它推进游戏时间）、
  `&report` 在 ff 后向 console 导出全员+载具位置/状态（配 `--enable-logging=stderr` 抓）、
  `&attack` 玩家第 1 回合改进攻、`&incar` 玩家直接坐进 1 号车、`&drive` 模拟按住 W 驾驶、
  `?test=cover` 断言掩体挡子弹/视线、`?test=hud` 触发横幅+枪声标记、`?test=vehicle` 断言上下车。
- 截图后必须真的看图确认，再让用户刷新；浏览器缓存坑过一次"改了没变化"。
- 语法检查：`node --check --input-type=module < 文件`。
- 子代理自测一律用 8199 端口，**绝不杀 8123**。

## 路线图（用户确认过的优先级）

1. ~~载具~~（2026-07-18 已做）。
2. ~~投掷物~~（2026-07-19 已做：G 手雷 / H 烟雾，扇区防守 + 烟雾是绝配）。
3. 多人联网——下一个大里程碑（时机与架构见下节）。
4. GLB 角色模型 + 动画状态机（资源：Quaternius / Poly Pizza，CC0），
   枪已试水 `models/assault-rifle.glb`；多人之前若时间紧可后置。

## 多人联网评估（2026-07-19 结论）

- **时机**：等单机战术套件稳定（投掷物 ✅、队友乘车/占点可选），并且真人试玩确认
  核心循环好玩之后再接。每多一个玩法系统，联网改造成本就涨一截。
- **架构推荐 host-relay**：房主端跑完整 Game 模拟，其余客户端发输入、收快照
  （20Hz actor 位姿/状态），不做确定性锁步——代码里 Math.random 遍地都是，
  锁步不现实；Node 服务端跑 Game 则要把模拟从 three/DOM 里剥出来，工作量更大。
- **现状友好点**：GameState 集中在 game.js、输入已抽象（keys/vehicleInput），
  快照序列化有现成抓手（就是 `&report` 输出那套结构）。
- 预估：能玩的原型 3~5 天；房间/延迟补偿/断线重连做到舒服 1~2 周。

候选优化（用户尚未拍板）：队友乘车、山顶占点、M249 独立枪模、
帧率实测（MC 7 万方块 + 2048 阴影 + 419 碰撞体查询）、车辆血量/爆炸。
