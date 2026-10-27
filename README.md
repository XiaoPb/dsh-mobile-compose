# dsh-mobile-compose

DSH 网页界面插件：**手机端输入体验** —— 把输入框左下角的「添加文件」「调用指令」收编为一个「＋」入口，点击弹出 **QQ 式动作面板**（手机宽度：底部滑出宫格 + 蒙层 + 返回键关闭；桌面宽度：锚点弹层）。面板动作按**文件来源细分**（相册 / 拍照 / 文档 / 指令），为安卓专门路由预留标准缝；选中的文件全部回流**官方上传通道**（校验 / 上传 / 附件预览零重复）。

当前版本 0.5.x：**指令/技能全量接入官方 RPC**（单列表自动分页、每条指令专属图标、中文标签来自官方 locale）、**执行决策表对齐原生菜单**（带参数的指令只写草稿不代发；裸指令走官方 Enter 通道分离执行）、**面板 dock 化且独占一行**（不与进度等条目挤兑）、**DSH 设置页配置项**（动作开关 / 隐藏原生按钮 / 隐藏指令，改动实时生效）与**安卓端对接契约**（[docs/android-bridge.md](docs/android-bridge.md)）。

## 职责划分：插件做什么，外部做什么

| 职责 | 归属 | 说明 |
|---|---|---|
| 输入框「＋」入口、动作面板 UI、动画、返回键关闭 | **插件** | 全部走官方插槽（`conversation.input.left` + `conversation.composer.dock`），零 DOM 注入 |
| 动作注册表与来源标记（gallery/camera/document/internal） | **插件** | 面板宫格的单一事实来源 |
| 指令接管 | **插件** | 指令/技能目录来自官方 RPC（`remote.commands.list` / `remote.skills.list`），中文标签来自官方 locale + 原生菜单采集兜底；执行按**官方 dispatch 决策表**：带 `input` 的指令只把 `/token ` 写进草稿（用户补参数后自行发送），裸指令走 `setDraft('/x')+submit()` 官方 Enter 通道 |
| 桌面端文件选取 | **插件** | 图片 / 文件都是同一个 file 输入的两个视图：图片附**显式图片后缀过滤**（`image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif`）；文件**不限后缀**（= 原始 file，处理全部类型） |
| 文件回流与上传 | **插件** | DataTransfer 注入官方隐藏 input → 官方 onPickFiles → addFiles 校验/上传/预览 |
| 动作能力协商 | **插件（宿主）** | `GET /api/dsh-mobile-compose/capabilities`，实时反映设置页配置 |
| 面板配置 UI | **插件（宿主）** | DSH 设置页 `dsh-mobile-compose` namespace，schema-form 自动渲染 |
| 错误 toast、加载态 | **插件** | 安卓端只返回结构化结果，不画 UI |
| 原生相机 / 相册 Intent、运行时权限、图片压缩 | **安卓端（外部）** | 按 [docs/android-bridge.md](docs/android-bridge.md) 注入 `window.DshComposeBridge` |
| 选取结果的回传 | **安卓端（外部）** | `{status, code, files:[{name, mime, size, width?, height?, data(base64)}]}`，契约见文档 §3 |

安卓端未实现（或 `routed:"web"`）时，一切照旧走浏览器方案——**安卓接入是渐进增强，不是门槛**。

## 安装

```sh
# 本地路径安装（开发验证）
dsh plugin --profile web add /path/to/dsh-mobile-compose
# 之后重启引擎（bundle 插件不热加载）
```

装好后打开桌面端 web GUI：输入框左下角出现「＋」按钮；原生「添加文件（回形针）」「调用指令」按钮默认隐藏（可在设置页关闭）。

## 桌面端验证清单

1. 宽窗口点击「＋」→ **对话框卡片正下方**展开 dock 面板（文档流内，不遮挡任何内容）；「＋」位于工具行**最左**（原「添加文件」的位置）；
2. 单一列表：常用动作在最前，指令/技能紧随其后；宫格列数随面板宽度自适应，放不下自动生成页码点（可点、可左右滑）；
3. 「图片」→ 原生文件打开器弹出且**默认过滤到图片类型**（显式后缀 accept）；选 1-2 张 → 附件预览条出现、走官方上传（进度 / receipt）；
4. 「文件」→ 原生文件打开器（不限后缀，即原始 file）；
5. 指令瓦片与动作同列：RPC 全量目录 + 中文主标签 + `/别名` 次行小字；点带参数的指令（如 /goal）→ 只插入 `/目标 ` 到聊天框（**不发送**，与原生菜单一致）；点裸指令（如 /compact）→ 官方 Enter 通道分离执行；
6. 把窗口缩到 <700px（或 DevTools 设备模拟）→ 变为底部滑出面板，蒙层点击 / Esc / 系统返回键均可关闭；
7. 设置页 → Plugins → dsh-mobile-compose：关掉任一动作 → 不重载页面，再点「＋」该瓦片已消失。

## 架构

```
web GUI ──▶ __ModuleLoader__ 装载 lib/client.js（closure factory，形状对齐 dsh-hardssh 客户端产物）
   ├─ ctx.slots 注册 conversation.input.left ←「＋」入口（flex order 最左 = 原生两键原位置）
   ├─ ctx.slots 注册 conversation.composer.dock ← 动作面板（对话框下方文档流内；
   │    手机宽度切换为 portal 底部滑出面板 + 蒙层）
   ├─ 面板 = 单一列表自动分页（页码点 + 左右滑）；宫格列数随宽度自适应
   ├─ 动作注册表：pick-image(相册) / take-photo(拍照) / pick-file(文档) / command(指令)
   │    每项带 source 标记（gallery/camera/document/internal）——安卓专门路由的缝
   ├─ 指令接管：RPC 全量目录为权威；原生菜单采集（visibility:hidden）仅补中文标签/顺序；
   │    执行 = 官方 dispatch 决策表（input→claim 写草稿不代发；裸指令→setDraft+submit）
   │    （官方裁决通道）；采集失败回退原生菜单点选
   ├─ 桌面：图片动作 = 自带 input + 显式图片后缀 accept（原始文件打开器按类型过滤）；
   │        文件动作 = 自带 input、accept 留空（全部后缀，即原始 file）
   ├─ 文件回流：DataTransfer 注入官方隐藏 input[type=file] → 派发 change
   │    → 官方 onPickFiles → addFiles 校验/上传/预览全链路原样生效
   └─ 能力协商：每次打开面板拉取 GET /api/dsh-mobile-compose/capabilities（失败走内置默认集）

宿主端（lib/index.js，cordis 插件）
   ├─ GET /api/dsh-mobile-compose/capabilities（动态 inject webServer，实时读设置页来源）
   └─ dsh-mobile-compose 设置页 namespace（ctx.settings.installSection + schemastery schema，
      DSH 设置页 schema-form 自动渲染；settings 服务缺席时静默降级为插件装载配置）
```

**原生按钮隐藏原理**（零 DOM 改动，插件样式卸载即恢复）：

```css
/* 调用指令按钮：aria-haspopup="listbox" 是它在工具行里的稳定标识 */
body.dmc-hide-native button[aria-haspopup="listbox"]{display:none!important}
/* 添加文件按钮：紧跟官方隐藏 input[type=file][multiple][hidden] 的那个按钮 */
body.dmc-hide-native button:has(+ input[type="file"][multiple][hidden]:not([data-dmc-input])){display:none!important}
```

## 安卓专门路由（外部工作，契约见 docs/android-bridge.md）

- 插件已备好**接缝**：`capabilities` 响应的 `routed` 字段 + `window.DshComposeBridge` 桥协议 + 结构化返回/错误码 + 失败自动回退 web 路径；
- 安卓端需要完成：WebView 注入桥、take-photo/pick-image 路由到原生 Intent、运行时权限、图片压缩、base64 回传（全部要求在 [docs/android-bridge.md](docs/android-bridge.md) §2–§5）；
- 安卓运行时探测与 dsh-hardssh 同约定（`ANDROID_DATA` / `DSH_ANDROID_USER_DATA` / `/system/build.prop`），capabilities 响应里的 `platform.android` 已就绪——客户端用它决定「拍照」瓦片只在安卓展示。

## 配置

**推荐入口：DSH 设置页**（实时生效，落盘持久化）。插件装载配置仅作初始默认。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled`（仅装载配置） | `true` | `false` 时装载但零路由，客户端走内置默认动作集 |
| `hideNativeButtons` | `true` | 隐藏原生「添加文件 / 调用指令」小按钮；`false` 时两套入口并存 |
| `actions.pick-image` | `true` | 相册动作开关 |
| `actions.take-photo` | `true` | 拍照动作开关（仅安卓运行时展示） |
| `actions.pick-file` | `true` | 文件动作开关 |
| `actions.command` | `true` | 指令动作开关 |
| `hiddenCommands` | `file` | 不展示的指令名（逗号分隔，不带斜杠）。`/file` 是官方「添加文件」指令，与图片/文件瓦片重复，默认剔除；清空 = 全部展示 |

## 验证

```sh
npm test        # 单测（node:test，26 项：config / capabilities / 宿主接线含设置页 / jsdom 客户端行为）
npm run smoke   # E2E 冒烟：真实 HTTP 往返 + 客户端产物形状 + patch 形状
```

客户端 bundle 在 **jsdom 里真实执行**（加载契约 → apply 接线 → 渲染 → tab 切换 → 指令采集与官方通道执行 → 底部面板形态 → 卸载清理），不依赖人工点检。

真实引擎验证（dsh 0.2.1-rc.4 已做过一轮）——

- `GET /api/dsh-mobile-compose/capabilities` 返回正确 JSON（`platform.android:false`）；
- 页面 roster 引用 `/plugins/@xiaopb/dsh-mobile-compose/client.js` 且内容完整（含全部新特性标记）；
- 引擎日志无本插件相关报错。

## 已知风险与验证点

- **DOM 标识漂移**：隐藏规则与文件回流依赖官方输入框的 DOM 结构（`aria-haspopup="listbox"`、隐藏 file input 的相邻关系）。DSH 升级若改变结构，表现为「原生按钮复现 / 图片动作失效」，console 会有 `[dsh-mobile-compose] 未找到…` 警告——更新选择器即可；设置页 `hideNativeButtons=false` 可临时回退到两套入口并存。
- **React change 去重**：文件注入已置空 `_valueTracker` 规避同值去重（jsdom 测试覆盖注入派发路径）。
- **`:has()` 选择器**：需要 Chrome/WebView 105+；旧 WebView 上表现为原生按钮保留（功能不受影响）。
- 「调用指令」走程序化点击官方按钮（其菜单由官方包内部件管理，不从外部重建）；若点击无响应，设置页回退方案同上。

## 许可

MIT。
