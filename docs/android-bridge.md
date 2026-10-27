# dsh-mobile-compose ↔ DSH Android 端对接契约

> 版本 1（对应插件 0.2.x）。本文档是**插件侧与安卓端（DSH Mobile APK）的分工协议**：
> 插件负责什么、安卓端负责什么、双方交换什么数据、出错怎么办。安卓端按本文实现
> 后，输入框动作面板的「拍照 / 相册」等动作即可路由到原生 Intent，无需改动插件 UI。

## 0. 一图看懂分工

```
┌─────────────────── 插件（已完成，无需安卓参与） ───────────────────┐
│ 输入框左下角「＋」入口 + QQ 式动作面板（DOM/样式/动画/返回键）        │
│ 动作注册表（pick-image / take-photo / pick-file / command + source）│
│ 能力协商路由 GET /api/dsh-mobile-compose/capabilities               │
│ DSH 设置页 namespace（动作开关 / 隐藏原生按钮，落盘持久化）           │
│ 文件回流：任何来源的文件 → 官方 addFiles 通道（校验/上传/预览）       │
│ 桌面端：图片动作对接原生文件打开器（显式图片后缀过滤）                │
└──────────────────────────────────────────────────────────────────┘
                              ↕ 唯一接缝：capabilities 响应 + JS 桥
┌─────────────────── 安卓端（APK 需要完成的全部工作） ───────────────┐
│ ① 在 WebView 注入 window.DshComposeBridge（addJavascriptInterface）│
│ ② 按 capabilities 声明 routed:'native' 的动作，接原生 Intent：      │
│    take-photo → CameraX / ACTION_IMAGE_CAPTURE（含压缩）           │
│    pick-image → Photo Picker / ACTION_GET_CONTENT(image)          │
│ ③ 把选中的文件编码回传（base64 + 元数据，见 §3 返回格式）            │
│ ④ 运行时权限（CAMERA、READ_MEDIA_IMAGES）由 APK 自行请求            │
└──────────────────────────────────────────────────────────────────┘
```

## 1. 能力协商契约（安卓端必须先读懂这个）

客户端每次打开面板都会拉取：

```
GET /api/dsh-mobile-compose/capabilities
```

响应（v1）：

```json
{
  "version": 1,
  "plugin": "dsh-mobile-compose",
  "platform": { "android": true, "web": true },
  "client": { "hideNativeButtons": true },
  "actions": [
    { "id": "pick-image", "source": "gallery",   "label": "图片", "enabled": true, "routed": "native" },
    { "id": "take-photo", "source": "camera",    "label": "拍照", "enabled": true, "routed": "native" },
    { "id": "pick-file",  "source": "document",  "label": "文件", "enabled": true, "routed": "web" },
    { "id": "command",    "source": "internal",  "label": "指令", "enabled": true, "routed": "web" }
  ]
}
```

| 字段 | 谁写 | 含义 |
|---|---|---|
| `platform.android` | 插件（宿主探测） | 引擎跑在安卓运行时；**APK 侧不需要也不能改它** |
| `actions[].enabled` | 插件（读 DSH 设置页） | 用户在设置页关掉的动作，面板不渲染 |
| `actions[].routed` | **未来由安卓端与插件共同约定** | `web`=客户端自己解决（现状）；`native`=交 App 桥 |

**安卓端的接入开关就是这个 `routed` 字段**：插件 v0.2.0 客户端的分发逻辑是——
`routed === 'web'` 时走浏览器 input 方案；`routed === 'native'` 时优先调
`window.DshComposeBridge`（见 §2），桥不存在**自动回退 web 路径**（所以 APK 可以
分动作灰度，坏了也不会白屏）。

## 2. JS 桥接口（安卓端实现，插件调用）

APK 在 WebView 初始化时注入（Android 端标准做法）：

```kotlin
webView.addJavascriptInterface(DshComposeBridge(context), "DshComposeBridge")
```

插件侧按**以下签名**调用（安卓端必须精确实现；`@JavascriptInterface` 注解的
public 方法）：

```java
class DshComposeBridge {
    /** 桥协议版本，插件要求 >= 1。返回 JSON 字符串：{"bridgeVersion":1} */
    @JavascriptInterface String getMeta()

    /**
     * 发起一次原生选取。同步返回 null（接受请求），结果经回调事件送回。
     * 不支持该方法的老桥 → 插件回退 web 路径。
     */
    @JavascriptInterface String pick(String requestJson)   // 返回 null 或 {"requestId":"..."}

    /** 取消一次进行中的选取（可选实现；返回 "ok"） */
    @JavascriptInterface String cancel(String requestId)
}
```

`requestJson`（插件 → 安卓）：

```json
{
  "version": 1,
  "action": "take-photo",          // 动作 id，与 capabilities 一致
  "source": "camera",              // 期望的来源路由键
  "multiple": false,               // take-photo 恒为 false；pick-image 可 true
  "accept": ["image/png", "image/jpeg", "image/webp", "image/gif"],
  "maxBytes": 10485760             // 单文件上限（10MiB），超限由安卓端压缩或拒绝
}
```

结果回传（安卓 → 插件）二选一：

- **推荐：桥回调**。安卓端选取完成后在主线程执行：
  `webView.evaluateJavascript("window.__dshComposeBridgeResult('<requestId>', <resultJson>)", null)`
- 兼容：轮询 `DshComposeBridge.result(requestId)`（仅当回调方式不可用时）。

**约定**：`requestId` 由安卓端生成（UUID），插件侧对未知的 requestId 忽略；
同一 requestId 的结果只消费一次。

## 3. 返回数据格式（安卓端 → 插件）

`resultJson`：

```json
{
  "version": 1,
  "requestId": "…",
  "status": "ok",                    // ok | cancelled | error
  "code": null,                      // status=error 时见 §4 错误码
  "message": null,                   // 人类可读错误（仅 error 时）
  "files": [
    {
      "name": "IMG_20261027_080901.jpg",   // 展示用文件名（必填）
      "mime": "image/jpeg",                // 必填；插件按官方 intake 规则校验
      "size": 482133,                      // 字节数（必填，与 data 解码后一致）
      "width": 3000, "height": 4000,       // 可选；图片类强烈建议提供（预览排版）
      "data": "<base64>"                   // 必填；原始字节（已按 mime 编码）的 base64
    }
  ]
}
```

硬性要求（安卓端自检清单）：

1. `data` 是**未加 data: 前缀的裸 base64**，解码后字节数必须等于 `size`；
2. 单文件解码后不得超过请求里的 `maxBytes` —— 相机原图必须先压缩（推荐长边
   ≤4096px、质量 85 的 JPEG；PNG 仅用于截图类内容）；
3. `cancelled`（用户在系统选择器按返回）不是错误，插件收到后面板回到打开态；
4. 非图片来源（未来的 pick-file native 路由）`mime` 用真实 MIME；取不到时
   `application/octet-stream`，插件侧不做图片预览。

## 4. 错误码（`status:"error"` 时的 `code`）

| code | 含义 | 插件侧行为 |
|---|---|---|
| `bridge_unsupported` | 桥存在但动作未实现 | 面板 toast 提示，动作回退 web 路径 |
| `permission_denied` | 安卓运行时权限被拒 | 面板 toast「未获得相机/相册权限」 |
| `too_large` | 文件超 maxBytes 且无法压缩 | 面板 toast「文件过大」 |
| `cancelled_by_policy` | APK 策略拦截（如禁用相机） | 面板 toast 展示 message |
| `unknown` | 其他 | 面板 toast 展示 message |

错误 toast 属于插件 UI 职责，安卓端只负责返回结构化错误，**不需要自己画任何 UI**。

## 5. 安全要求（安卓端）

1. **只对官方页面暴露桥**：注入前校验当前 WebView 加载的 origin 是 DSH Host 的
   本机地址（127.0.0.1 / APK 内置 origin），禁止对任意网页注入；
2. `pick(requestJson)` 解析容错：畸形 JSON 返回 `{"error":"bad_request"}`，不抛异常；
3. base64 回传大文件在 JS 桥上走字符串，单次建议 ≤8MB（超出分段或压缩）；
4. 桥不提供任何文件系统读写之外的能力（不落盘到共享存储，不启动任意 Intent）。

## 6. 配置入口（DSH 设置页，无需改 APK）

插件在 DSH 设置页注册 `dsh-mobile-compose` namespace，用户可直接配置：

| 字段 | 默认 | 说明 |
|---|---|---|
| `hideNativeButtons` | `true` | 隐藏原生「添加文件 / 调用指令」小按钮 |
| `actions.pick-image` | `true` | 相册动作开关（关闭后面板不渲染该瓦片） |
| `actions.take-photo` | `true` | 拍照动作开关（仅安卓运行时展示） |
| `actions.pick-file` | `true` | 文件动作开关 |
| `actions.command` | `true` | 指令动作开关 |
| `hiddenCommands` | `file` | 不展示的指令名（逗号分隔）；`/file` 与图片/文件瓦片重复，默认剔除 |

设置改动实时生效：客户端每次打开面板重拉 capabilities，无需刷新页面或重载插件。
安卓端如需「管理员禁用相机」类策略，直接把 `actions.take-photo` 写进宿主侧
settings 的用户层即可（或按 §4 `cancelled_by_policy` 拦截）。

## 7. 联调路径建议

1. 先只做 `getMeta` + `pick(take-photo)`（单文件、base64 回传）——面板「拍照」
   瓦片立即原生化，其余动作继续走 web 路径；
2. 再加 `pick(pick-image)`（multiple=true、Photo Picker）；
3. 最后补 `cancel` 与错误码全量。

插件侧对桥的调用全部带 try/catch 与超时（30s 无回调按 `unknown` 报错），安卓端
任何不符合 §2/§3 的实现都会退化为「该动作回退 web 路径」，不会阻塞面板其余功能。
