# dsh-mobile-compose

DSH 网页界面插件：**手机端输入体验** —— 把输入框左下角的「添加文件」「调用指令」收编为一个「＋」入口，点击弹出 **QQ 式动作面板**（手机宽度：底部滑出宫格 + 蒙层 + 返回键关闭；桌面宽度：锚点弹层）。面板动作按**文件来源细分**（相册 / 拍照 / 文档 / 指令），为安卓专门路由预留标准缝；选中的文件全部回流**官方上传通道**（校验 / 上传 / 附件预览零重复）。

当前版本 0.3.x：**指令接管**（原生命令菜单的列表收编进面板「指令」tab，执行走官方裁决通道）、**多 tab 左右滑**、**面板 dock 化**（插在对话框下方文档流内，不重叠）、**DSH 设置页配置项**（动作开关 / 隐藏原生按钮，改动实时生效）与**安卓端对接契约**（[docs/android-bridge.md](docs/android-bridge.md)）。

## 职责划分：插件做什么，外部做什么

| 职责 | 归属 | 说明 |
|---|---|---|
| 输入框「＋」入口、动作面板 UI、动画、返回键关闭 | **插件** | 全部走官方插槽（`conversation.input.left` + `conversation.composer.dock`），零 DOM 注入 |
| 动作注册表与来源标记（gallery/camera/document/internal） | **插件** | 面板宫格的单一事实来源 |
| 指令菜单接管 | **插件** | 「指令」tab 内嵌指令列表（首次从原生菜单隐蔽采集名称+描述）；执行走官方 `setDraft('/x') + submit()` 裁决通道；采集失败回退原生菜单点选 |
| 桌面端文件选取 | **插件** | 图片动作对接**原始文件打开器**并附**显式图片后缀过滤**（`image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif`）；文件动作程序化点击官方 input（无过滤） |
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
2. 面板顶部「常用 / 指令」两个 tab：宫格列数随面板宽度自适应；触摸左右滑动可切换 tab；
3. 「图片」→ 原生文件打开器弹出且**默认过滤到图片类型**（显式后缀 accept）；选 1-2 张 → 附件预览条出现、走官方上传（进度 / receipt）；
4. 「文件」→ 原生文件打开器（无类型过滤）；
5. 「指令」→ 切到「指令」tab，首次自动从原生命令菜单**隐蔽采集**指令列表（不弹原生列表）；点任一指令 → 官方裁决通道执行（等价于输入 `/指令` 回车）；
6. 把窗口缩到 <700px（或 DevTools 设备模拟）→ 变为底部滑出面板，蒙层点击 / Esc / 系统返回键均可关闭；
7. 设置页 → Plugins → dsh-mobile-compose：关掉任一动作 → 不重载页面，再点「＋」该瓦片已消失。

## 架构

```
web GUI ──▶ __ModuleLoader__ 装载 lib/client.js（closure factory，形状对齐 dsh-hardssh 客户端产物）
   ├─ ctx.slots 注册 conversation.input.left ←「＋」入口（flex order 最左 = 原生两键原位置）
   ├─ ctx.slots 注册 conversation.composer.dock ← 动作面板（对话框下方文档流内；
   │    手机宽度切换为 portal 底部滑出面板 + 蒙层）
   ├─ 面板 = 多 tab（常用 / 指令），触摸左右滑切换；宫格列数随宽度自适应
   ├─ 动作注册表：pick-image(相册) / take-photo(拍照) / pick-file(文档) / command(指令)
   │    每项带 source 标记（gallery/camera/document/internal）——安卓专门路由的缝
   ├─ 指令接管：首次进入「指令」tab → 程序化打开原生命令菜单（visibility:hidden）
   │    → 采集 [role=option] 的名称+描述 → 收起原生菜单；执行 = setDraft('/x')+submit()
   │    （官方裁决通道）；采集失败回退原生菜单点选
   ├─ 桌面：图片动作 = 自带 input + 显式图片后缀 accept（原始文件打开器按类型过滤）；
   │        文件动作 = 程序化点击官方 input
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

## 验证

```sh
npm test        # 单测（node:test，21 项：config / capabilities / 宿主接线含设置页 / jsdom 客户端行为）
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
