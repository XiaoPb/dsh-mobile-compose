# Changelog

## 0.6.5

**发布流水线修复，插件运行时行为无变化。**

- **修复「npm 接受了请求但版本没公开」被当成成功**：原 release 工作流只看 `npm publish` 的退出码，而账号处于 stage-only 策略、或包首次发布时，npm 会返回 0 但版本进入 Staged Packages 等人工 2FA 批准，于是流程跑到「确认公开」才失败、前面全部步骤看起来都是绿的（0.6.4 的 tag 发布即卡在这里）。现在发布逻辑抽成 `scripts/publish-npm.sh`：**每种方式都是「发布 → 轮询 `npm view` 确认真实可见」**，确认不到才算失败。
- **token 兜底真正生效**：OIDC（Trusted Publishing）发布后若版本仍未公开，自动回退 `NPM_TOKEN` 再发一次并同样确认；`--provenance` 因缺少 OIDC 权限失败时自动去掉该参数重试。两种方式都失败才报错。
- **失败时自带诊断**：打印 npm / node 版本、`NPM_TOKEN` 对应账号、registry 上该版本的 status 端点、`npm stage list`（npm ≥ 11.15）与发布日志里的报错行，并在错误信息里给出三条处置建议（先 Approve staged 版本 / 先本地发一次让包名存在 / 换可发布的 granular token）。
- **凭据探测步骤**：发布前先输出 `npm whoami` 与 OIDC 是否可用（`ACTIONS_ID_TOKEN_REQUEST_URL`），缺 `NPM_TOKEN` 时给 warning 而不是静默降级。
- **新增单测** `test/publish-npm.test.js`（6 项，用假 npm）：已公开跳过、无凭据直接诊断、OIDC 一次成功、OIDC 假成功→token 救回、provenance 失败自动重试、两条路都失败给出 staged 建议。`npm run check` 现在共 34 项。

## 0.6.4

**工程化版本，插件运行时行为无变化。**

- **CI（`.github/workflows/ci.yml`）**：push main / PR 时在 Node 22 与 24 上跑 `npm run check`（28 项单测 + 离线冒烟 + 包清单 / patch / bundle 契约自检），再做 `npm pack` + 发布说明生成器校验 + **消费端安装测试**（把打出来的 tarball 装进干净目录，校验 `dsh.bundle.patch`、`dsh.client.platform`、宿主 `apply` 可加载、开发目录未混入包里）。
- **Release（`.github/workflows/release.yml`）**：打 `v*` tag 或手动触发 → 校验 tag ↔ 版本 → 自检 → 发布 npm（优先 Trusted Publishing / OIDC，失败回退 `NPM_TOKEN`，均带 `--provenance`）→ 校验版本已在 npm 公开 → 打包 tarball + SHA-256 → 用 `scripts/release-notes.sh` 生成发布说明（版本信息 / 安装命令 / 产物校验和 / 按 conventional commit 分类的变更 / 质量校验 / 贡献者 / 对比链接）→ 创建 GitHub Release。
- **UI verify（`.github/workflows/ui-verify.yml`，可选）**：手动触发或每天定时，用真实 DSH 引擎跑无头验收（面板全流程 / 换页交互 / 指令决策表 / 语言跟随）；`dsh_url` 留空时 CI 自己 `npm i -g @deepseek-ai/dsh` 起引擎并把本仓库装进 web profile。
- **新增 `scripts/verify-package.mjs`**：离线校验清单字段、exports 指向、files 白名单、`cordis.patch.yml` roster 契约、客户端 bundle 的 `__ModuleLoader__` 包装与关键标记、宿主导出、CHANGELOG 版本小节。
- **新增 `scripts/release-notes.sh`**：发布说明生成器（CI 与 Release 共用同一脚本，生成器坏掉会在 CI 先失败而不是发版时）。
- **打包元数据**：`publishConfig`（public + 官方 registry）、`repository` / `homepage` / `bugs` / `keywords` / `author`，`files` 增加 `CHANGELOG.md`；`package-lock.json` 入库（`npm ci` 可复现），新增 `.gitattributes`（统一 LF、PNG 视为二进制）。
- 验收脚本改用 `tools/lib/browser.js` 统一解析 Chromium 路径（Windows 仍用本机 Playwright 缓存，CI/Linux 交给 Playwright 自带浏览器，可用 `DSH_CHROMIUM` 覆盖）。

## 0.6.3

- **去掉卡片底部提示行**：面板内不再渲染「选中的文件走官方上传通道」等提示文案，卡片高度明显降低；采集指令期间的加载反馈改为分页条位置的 6px 呼吸点（`.dmc-loading`，只占 8px，不增高）。
- **「＋」更好按、展开即「×」**：入口按钮 26px → **32px** 触摸区（图标 14 → 18），圆角 8px；面板展开时按钮带 `.dmc-open`，图标旋转 45° 变成「×」（0.18s 过渡），点它或 Esc 均可收起，`aria-expanded` 同步。
- **瓦片整体收紧**：瓦片 84px → **72px**（图标盒 52 → 48、行距 14px），卡片内边距 12/10 → 10/8 —— 1280px 视口下整卡高度约 247px → **194px**。
- 测试：28 项（新增展开态 `dmc-open` / `aria-expanded` 断言、去提示断言）；真机截图核对收起/展开两种状态。

## 0.6.2

- **适配 DSH Android v1.4.27 的系统 Photo Picker 路由（上游 issue #54）**：host 的 `onShowFileChooser` 对「accept 全为图片 MIME」的请求改走系统照片选择器（缩略图网格 / 原生多选 / 免存储权限），判据是 `acceptTypes` 每个条目都以 `image/` 开头——扩展名条目（`.jpg` 等）会使判定失败。
  - `pick-image`（安卓）：accept 从「MIME+扩展名混写」收敛为纯 MIME `image/*` → 命中 Photo Picker；旧版 host 与桌面走 `createIntent()` / 原生对话框，`image/*` 过滤同样成立，无行为回归。
  - `take-photo`（安卓）：**保留**混写 accept——混入扩展名让 host 全图片判定失败、回落 `createIntent()`，`capture` 属性得以保留（照常拉起相机，而不是被 Photo Picker 抢走）。
  - 桌面端维持原样（MIME+后缀，供原生文件对话框按后缀过滤）。
- 测试：新增「安卓 host Photo Picker accept 适配」用例（28 项全过）。

## 0.6.1

- **去掉瓦片第二行**：指令瓦片不再显示「中文主标签 + `/别名` 次行小字」，只保留**一行**当前语言的名字；斜杠别名与描述移入 `title`（悬停可见，不占行）。所有瓦片固定等高（84px），面板内卡片高度完全一致。
- **文案跟随 DSH 语言**：动作名（图片/文件/拍照/指令）、提示、无障碍标签全部内置 zh/en 双语，语言取官方 locale 服务快照（`active`，兜底 `<html lang>`）；`locale/change` 事件触发即时重渲染，切语言无需刷新页面。指令标签本来就走官方 locale（中文环境「目标/压缩/…」，英文环境官方英文名），现在整体一致。
- 入口/面板 `aria-label` 跟随语言，选择器测试改用稳定的 `button.dmc-entry-btn` / `data-dmc-entry`。
- 测试：新增「en → 英文单行标签，切回 zh 即时更新」用例（27 项）；`tools/verify-lang.js` 真机验证：中文基线（单行、12 瓦片全部 84px）→ 设置页切 English（`Add content` / `Images` / `Files` / `Goal`，html lang=en）→ 切回中文即时恢复，全程零页面错误。

## 0.6.0

- **统一面板形态**：移除窄窗口 / 触屏设备的「底部滑出面板 + 蒙层」形态，**所有窗口宽度都用 dock 形态**（面板插在输入框正下方、与其等宽，文档流内不遮挡内容）——窄宽度下 card 位置不再切换。
- 关闭方式统一：Esc / 系统返回键 / 点击面板外（原先窄窗口靠蒙层点击关闭）。
- 清理：删除 `isSheetPresentation`、`.dmc-mask`、`.dmc-panel`、`dmc-rise` 动画与 `SHEET_Z` 层级常量；相关 effect 依赖收敛为 `[open]`。
- 测试：窄窗口用例改为断言 dock 形态 + 无蒙层 + 等宽 + 点击面板外关闭；`tools/verify-paging.js` 移动端期望 dock；`tools/diag-browser.js` ⑤ 改为「窄窗口 dock 形态 + 等宽硬断言 + 面板外点击关闭」。

## 0.5.3

- **换页交互按端分流**：移动端用**左右滑**（横向 ≥40px 且明显大于纵向位移，斜向滚动不误翻页），桌面端用**鼠标滚轮**（向下=下一页、向上=上一页，触控板横向 `deltaX` 同样生效）。取代 0.5.2 的上下滑。
- 纵向手势交还页面：多页时面板只加 `.dmc-swipe{touch-action:pan-y}`（横向归脚本、纵向仍可滚页面），不再用 `touch-action:none` 抢走纵向滚动。
- 滚轮实现用**原生非 passive** 监听（React 的 `onWheel` 是 passive，`preventDefault` 无效）：累积 40 像素翻一页、翻页后冷却 260ms、`deltaMode` 行/页模式统一折算，并把 `wheel` 事件按 ref 回调绑到面板节点（卸载即解绑）。
- 测试：单测改为「纵向滑动不翻页 / 右滑 / 左滑 / 滚轮上下 / 冷却期不连翻 / 滚轮阻止页面滚动」；`tools/verify-paging.js` 用真机触摸（CDP）+ `mouse.wheel` 在移动 sheet（390×844）与桌面 dock（1280×900）验证，页面零滚动。

## 0.5.2

- **上滑手势翻页**（0.5.3 起改为「桌面滚轮 / 移动端左右滑」）：在面板上**上滑 = 下一页、下滑 = 上一页**（纵向阈值 36px），与原有左右滑（40px）并存；按主导轴判定方向，斜向滑动不会误翻。
- 多页时面板加 `.dmc-swipe{touch-action:none}`，把纵向手势从浏览器页面滚动中接管过来——否则一次上滑会先滚动页面再翻页；单页时不加该类，不影响页面滚动。
- 手势翻页后的 350ms 内忽略由同一次触摸派生的 click（部分 WebView 会在 `touch-action:none` 下继续派发 click），避免「翻页顺手执行了一条指令」。
- 测试：单测新增上滑/下滑/阈值内不翻页三条断言；真机（CDP 真实触摸）在移动 sheet 形态（390×844）与桌面 dock 形态（1280×900）验证上滑、下滑、左滑全部生效且页面零滚动。

## 0.5.1

- **面板宽度与输入框严格同步**：宽度改以官方输入卡片 `[data-composer-card]` 的实测外框为准（此前按「向上找够宽的祖先」估算，宽窗口下量到的是含 side-clearance 的容器，面板会比输入框宽）。
- **独占一行的实现换成 slot 容器**：外层 `.dmc-dock-slot`（`flex-basis:100%`）负责强制换行，内层卡片用实测像素宽度 —— 不再用 `flex-basis:100%` 撑满，避免容器比卡片宽时面板被撑大。
- **窗口缩放 / 侧栏开合 / 换会话实时跟随**：`resize` + `ResizeObserver(card)` 触发重算（此前只在打开瞬间算一次）。
- 修掉一个自锁陷阱：不再用 dock 容器宽度做上限（容器宽度由面板自身内容撑开，会导致放大窗口后面板停在旧宽度）。
- 验收脚本 `tools/diag-browser.js` 增加「面板与输入卡片等宽（±1px）」硬断言；多视口（1920/1440/1280/1024/820）实测 Δwidth ≤ 0.4px、左边缘对齐。

## 0.5.0

- **指令中文标签修复**：RPC `commands.list` 只返回英文名，主标签改由**官方 locale**（`command` namespace：目标/计划/反馈/压缩/权限/下载日志）+ 原生菜单采集兜底；瓦片 = 中文主标签 + `/别名` 次行小字。
- **指令执行对齐原生流程（决策表）**：带 `input` 的指令（如 /goal）→ 只把本地化 token（`/目标 `）写入草稿，**不代发**，用户补参数后自行发送；裸指令（如 /compact）→ `setDraft('/x')+submit()` 官方 Enter 通道分离执行（与官方菜单点选行为一致）；目录来源缺失时一律按 claim 处理。
- **图片/文件统一为 file 的两个视图**：图片 = file + 显式图片后缀 accept；文件 = file、accept 留空（全部后缀）。自带 input 点击打开选择器，选择期间面板保持挂载（避免部分浏览器取消对话框），onChange 后统一回流官方上传通道。
- **默认隐藏 `/file` 指令**：它是官方客户端注册的「添加文件」动作，与面板的 图片/文件 瓦片完全重复；新增设置页 `hiddenCommands`（逗号分隔指令名，清空 = 全部展示）。
- **dock 面板独占一行**：官方 dock 容器开启期间允许换行，面板 `flex-basis:100%` + `order:-1` —— 会话进度等其他插件条目换行到最后一行，不再与面板挤兑。
- 测试：26 项单测（新增指令执行决策表 + hiddenCommands 用例）。

## 0.4.0

- **指令与技能全量接入官方 RPC**（不再依赖原生菜单能显示多少条）：
  - 指令：`remote.commands.list(sessionId)`（包在 `sessions.using(...)` 会话保留上下文内，与官方 ui-commands 一致）；
  - 技能：`remote.skills.list({sessionId})`（同官方 ui-skill）。
  - 原生菜单 DOM 采集降级为**兜底 + 中文标签补全 + 官方顺序**来源；实测面板拿到 8 条指令 + 7 个技能 = 15 条，与官方 `/` 菜单完全一致。
- **去掉「常用 / 指令」分页语义**：单一列表，常用动作在最前，指令/技能紧随其后；超出单页容量自动生成页码点（可点、可左右滑），不再用 tab 标签区分类型。
- **每条指令专属图标**：文件 / 目标 / 计划 / 反馈 / 压缩 / 权限 / 模型 / 下载日志 各自独立 SVG，未知指令回退通用图标；技能使用独立图标。
- **技能点选只插入草稿**：写入 `/技能名 ` 到聊天框（不提交），与官方 `/` 菜单行为一致；指令仍走 `setDraft('/x')` + `submit()` 裁决通道执行。
- 打开面板即预取（RPC 就绪后自动重拉），`commands/change`、`plugin-manager/changed` 事件自动失效缓存。
- 测试：22 项单测（新增 RPC 全量 + 自动分页用例）+ smoke + 无头 Chromium 真机验收全绿。

## 0.3.1

- **修复「＋」点击无反应（hero 态）**：官方 `conversation.composer.dock` 插槽只在 `variant==="composer"` 时渲染，新建/空会话（hero 态）下面板组件根本不挂载。面板改为由「＋」入口组件内渲染并 portal 到官方 `[data-composer-dock]` 容器（hero / composer 两态都存在），不再依赖 dock 插槽。
- **修复点击后「＋」消失（钩子链表损坏）**：render 期 `try { props.useInput() } catch {}` —— `useInput` 是 hook，中途抛错被吞后 React 钩子链表损坏，第二次渲染 `areHookInputsEqual` 读到 undefined 崩溃，官方错误边界卸载整个入口。移除 render 期 hook 调用。
- **修复指令采集**：适配 dsh 0.2.1 菜单结构（`[role=listbox]` 取含 option 的那个；option = svg/中文标签/别名/描述 四段 span）；轮询等浮层渲染（至多 1.6s）；收尾顺序修正——原生菜单关闭完成后才复位 `harvesting`，避免自身派发的 Escape 关掉面板。
- **面板布局重做**：面板与聊天框**等宽**（从「＋」按钮向上测宽），**固定 2 行**，列数按宽度自动计算（88px/列，2-6 列）；指令渲染为**同款选项瓦片**（不再竖排列表），放不下时**自动生成「指令·2」「指令·3」…多个 tab**，支持左右滑动切换。
- 修复图片/文件瓦片无图标（动作 id 与图标 key 映射错位）。
- 打开面板即自动预取指令表（无需先切到指令页）。
- 验收：无头 Chromium 真机全流程通过（入口 → 面板 → 指令采集 8 条 → Esc/外部点击关闭 → 底部面板形态），21 项单测 + smoke 全绿。

## 0.3.0

- **「＋」原位替换**：入口经 flex `order:-1` 站到工具行最左，占据原生「添加文件」的原位置（不再是行尾后增）。
- **面板 dock 化**：桌面端动作面板改挂在官方 `conversation.composer.dock` 插槽 —— 对话框卡片**正下方的文档流内**，不再浮动遮挡；手机宽度保持底部滑出面板（蒙层 + 返回键关闭）。
- **指令接管**：面板新增「指令」tab —— 首次打开时从原生命令菜单**隐蔽采集**指令表（名称 + 描述，不弹原生列表），执行走官方裁决通道（`setDraft('/x')` + `submit()`）；采集失败自动回退原生命令菜单点选。输入机忙时禁点。
- **多 tab + 左右滑**：常用 / 指令两个 tab，支持触摸横向滑动切换；宫格列数随面板实际宽度自适应（`auto-fill`，默认约 4 列起步）。
- 客户端 jsdom 行为测试扩到覆盖双插槽注册、tab 切换、指令采集/执行、底部面板形态、卸载清理（共 21 项单测）。
- **真机验证**：dsh 0.2.1-rc.4 引擎 —— capabilities 路由在线、页面 roster 与 bundle 服务正常、引擎无报错。

## 0.2.0

- **DSH 设置页配置**：注册 `dsh-mobile-compose` namespace（schemastery schema，设置页自动渲染表单）——`hideNativeButtons` 与 4 个动作开关；改动实时生效（客户端每次打开面板重拉 capabilities），无需刷新页面。
- capabilities 路由改为读取设置页实时来源（`installSection` hooks + thunk）。
- 新增 `docs/android-bridge.md`：插件 ↔ DSH Android 端对接契约（职责划分、JS 桥协议、返回数据格式、错误码、安全要求）。
- 桌面端图片动作对接原始文件打开器：`accept` 改为显式图片后缀（`image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif`）。
- 修复 `setCaps` 对 Set 误用 `splice` 导致能力协商静默失效的 bug（jsdom 实测暴露）。
- devDependencies 引入 react / react-dom / jsdom，客户端 bundle 可离线实测。

## 0.1.0

- 首版：「＋」入口（`conversation.input.left` 插槽）+ QQ 式动作面板（图片 / 拍照 / 文件 / 指令）。
- 文件来源细分（gallery / camera / document / internal），为安卓专门路由留缝。
- 文件回流官方通道：DataTransfer 注入官方隐藏 `input[type=file]` + change 派发。
- 宿主端 capabilities 路由（`/api/dsh-mobile-compose/capabilities`）。
- 原生「添加文件 / 调用指令」按钮作用域 CSS 隐藏（`hideNativeButtons` 可关）。
