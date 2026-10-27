# Changelog

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
