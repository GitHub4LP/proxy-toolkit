# proxy_toolkit_go 设计与机制

## 定位

纯 Go 单二进制代理工具，零外部依赖（仅 `gorilla/websocket`）。解决受限平台（外层反向代理限制方法/不支持 WS Upgrade）下的端口转发问题。

## 架构总览

```
浏览器 ──→ 外层反向代理 ──→ Go 服务(--port) ──→ 本地目标端口(:8188 等)
         (剥离子路径前缀)      反向代理 + WS 桥接
```

Go 服务监听端口由 `--port` 决定。本服务子路径取决于外层代理部署，与监听端口无必然联系。

**核心设计**：Go 服务既是静态资源服务器，也是反向代理，还是 WS 桥接网关。前端通过 Service Worker + 导航拦截器适配各种部署环境。

## 文件结构

```
proxy_toolkit_go/
├── main.go              # 入口，路由注册
├── proxy.go             # 统一反向代理（subpath + tunnel + WS 桥接路由）
├── api.go               # 端口查询、编码检测、WS 探测 API
├── wsbridge.go          # WebSocket-over-HTTP 桥接（SSE 下行 + POST 上行）
├── assets.go            //go:embed 静态资源
├── go.mod
└── assets/
    ├── sw_client.js                 # 前端工具库：编码检测、SW 管理、URL 模板
    ├── unified_service_worker.js    # Service Worker：请求拦截、导航注入
    ├── navigation_interceptor.js    # 导航拦截器：URL 重写、WS Polyfill
    └── static/
        ├── index.html               # 端口管理 UI
        ├── app.js                   # 前端主逻辑
        └── style.css
```

## Go 后端

### 路由表

| 路由 | 方法 | 处理函数 | 说明 |
|------|------|----------|------|
| `/proxy/` | * | `handleProxy` | 统一反向代理入口 |
| `/api/service-info` | GET | `handleServiceInfo` | 返回本服务监听端口 |
| `/api/port/{port}` | GET | `handlePortInfo` | 单端口状态查询 |
| `/api/ports/batch` | POST | `handleBatchPorts` | 批量端口状态查询 |
| `/api/test-encoding/` | GET | `handleTestEncoding` | 编码检测端点 |
| `/api/ws-probe` | * | `handleWsProbe` | WS 连通性探测 |
| `/unified_service_worker.js` | GET | `handleSWScript` | SW 脚本（no-store） |
| `/navigation_interceptor.js` | GET | `handleNavInterceptor` | 导航拦截器脚本 |
| `/sw_client.js` | GET | `handleSwClient` | 前端工具库脚本 |
| `/static/` | GET | `http.FileServer` | 静态资源 |
| `/` | GET | `handleIndex` | 首页 HTML |

### 反向代理（proxy.go）

**统一路由** `/proxy/{port}`，按路径结构自动分两种模式：

**Subpath 模式**：`/proxy/8188/real/path`
- port 后有 `/`，剩余路径直接转发到 `localhost:8188`
- 适用于浏览器直接访问代理 URL

**Tunnel 模式**：`/proxy/8188?u=/real/path`
- port 后无 `/`，目标路径从 `u` 参数读取
- 支持 `m` 参数方法覆盖（PUT/DELETE → POST + `m=PUT`）
- 支持 `ws=1` 参数路由到 WS 桥接

**关键处理**：
- `Rewrite` 钩子重写 `Origin/Referer` → 目标 origin（绕过 CSRF）
- 过滤 `X-Forwarded-*` / `X-Proxy-*` 头（避免目标服务检测代理）
- `DisableCompression: true`（透明转发，不干预压缩）
- tunnel 模式 `u` 参数用 `url.Parse` 正确分离 path/query

### WS 桥接（wsbridge.go）

将 WebSocket 全双工通信拆分为 HTTP 请求：

```
浏览器 Polyfill          Go 服务              目标服务
     │                      │                     │
     │── GET ?ws=1&u=/ws ──→│ Dial ws://localhost:│
     │                      │   8188/ws            │
     │←── SSE: open ────────│←─────────────────────│
     │←── SSE: message ─────│←── WS message ───────│
     │── POST (msg body) ──→│── WS message ───────→│
     │── POST ?action=close→│── WS close ─────────→│
     │←── SSE: close ───────│                      │
```

**会话管理**：`sid` 标识会话，全局 `map[sid]*WSSession`，`sync.RWMutex` 保护。

**下行通道**（Go → 浏览器）：
- SSE（`text/event-stream`）：默认模式，`EventSource` 兼容
- Fetch Streaming（`application/octet-stream`，`?stream=1`）：SSE 不可用时降级
- 两者数据格式相同：`data: {json}\n\n`
- `X-Accel-Buffering: no` 防止部分代理（如 Nginx）缓冲，对其他代理无害

**上行通道**（浏览器 → Go）：POST 请求，body 为消息内容
- `Content-Type: text/plain` → 文本消息
- `Content-Type: application/octet-stream` → 二进制消息
- `?action=close` → 关闭连接

**消息类型**：`sseEvent.MsgType`（1=text, 2=binary），前端按类型解码为 string 或 Uint8Array。

### 静态资源（assets.go）

`//go:embed all:assets` 编译时打包所有前端资源到二进制。SW 脚本设 `Service-Worker-Allowed: /` + `no-store`。

## 前端

### 三个路径概念

| 概念 | 示例 | 说明 |
|------|------|------|
| 本服务子路径 `basePath` | `/`、`/myapp` | 浏览器访问本服务的路径前缀，由外层代理配置决定，与监听端口无必然联系。取 `location.pathname` 目录部分（去掉文件名和尾部 `/`） |
| 自动代理模板 `urlTemplate` | `{basePath}/proxy/{{port}}/` | auto 模板 = `basePath` + `/proxy/{{port}}/`，与 basePath 共用同一目录推导逻辑 |
| 用户自定义模板 | 含 `{{port}}` 的字符串 | manual 模板，用户手动指定，唯一确定的是 `{{port}}` 替换为端口号；不假设其他结构 |

**关键派生路径**：

| 派生项 | 来源 | 用途 |
|--------|------|------|
| SW 脚本 URL | `{basePath}/unified_service_worker.js` | SW 注册脚本地址 |
| SW scope | `urlTemplate` 替换 `{{port}}` 为目标端口 | SW 控制范围，如 `/myapp/proxy/8188/` |
| `bridgeBase` | SW 脚本所在目录 = `basePath` | 导航拦截器中构造 WS 桥接 URL、tunnel 代理 URL |

### 自适应模板

auto 模板 = `basePath` + `/proxy/{{port}}/`，basePath 取 `location.pathname` 目录部分：
- `/` → basePath `` → `/proxy/{{port}}/`
- `/myapp/` → basePath `/myapp` → `/myapp/proxy/{{port}}/`
- `/myapp/index.html` → basePath `/myapp` → `/myapp/proxy/{{port}}/`

用户可手动覆盖（localStorage 持久化）。模板变更触发编码检测 + WS 检测 + SW 重新配置。

### 初始化流程

1. 构造：推导 `basePath`，加载端口列表和手动模板（localStorage）
2. `loadUrlTemplate()`：确定模板（manual 优先，否则 auto）
3. 获取本服务端口（`/api/service-info`）
4. 若有代理支持：编码检测 + WS 检测
5. `syncServiceWorkers()`：发现已有 SW 注册，恢复状态
6. `refreshPorts()`：批量查询端口状态 + 渲染
7. 定时刷新（5s 间隔）

### 自动检测链

页面加载时按序执行：

| 检测项 | 方法 | 缓存 | 触发时机 |
|--------|------|------|----------|
| 编码检测 | HTTP GET 多层 encode 对比 | localStorage（按模板 key） | 页面加载 + 模板变更 |
| WS 支持 | `new WebSocket(probeUrl)` + 2s 超时 | sessionStorage（按模板 key） | 页面加载 + 模板变更 |

**检测路径推导**：
- auto 模板：直连 `basePath/api/...`（与模板路径 `basePath/proxy/{port}/...` 经过同一外层代理前缀，编码行为一致，少一跳 ReverseProxy）
- manual 模板：走模板路径（`{{port}}` 替换为本服务端口），测试完整链路 `浏览器→外层代理→handleProxy→目标`

**编码检测**：探测外层代理的 URL 解码行为（解码深度、`%2F` 额外解码），结果用于 SW 的路径编码修正。

**WS 检测**：`/api/ws-probe` 端点接受 WS 连接后发送 `ok` 关闭。前端 2s 超时：`onopen` → 不降级，超时/`onerror` → 降级。

### Service Worker（unified_service_worker.js）

**作用**：拦截 scope 内的请求，修正子路径和编码问题。

**注册**：脚本 URL = `{basePath}/unified_service_worker.js`，scope = `urlTemplate` 替换 `{{port}}` 为目标端口（如 `{basePath}/proxy/8188/`）。SW 安装时预加载 `navigation_interceptor.js` 内容。

**配置**：通过 `postMessage` 接收 `{strategy, decodeDepth, slashExtraDecoding, urlTemplate, wsFallback}`。

**策略**：

| 策略 | 机制 | 适用场景 |
|------|------|----------|
| none | 不处理，注销自身 | 无需代理 |
| subpath | 307 重定向修正路径 + 预取 | 代理仅改路径前缀 |
| tunnel | 307 重定向到 `/proxy/{port}?u=` | 代理解码行为异常 |
| hybrid | `%2F` 路径走 tunnel，其余走 subpath | 代理部分解码 |

**307 + 预取模式**：SW 发起 307 重定向，同时预取正确结果缓存到 `_prefetchCache`（5s TTL）。浏览器跟随重定向时直接命中缓存，避免二次请求。

**导航注入**：拦截 `navigate` 请求，在 HTML `<head>` 注入 `_NavigationInterceptorConfig` + `navigation_interceptor.js` 内容。注入信息：`scopeBase`（= SW scope）、`wsFallback`、`bridgeBase`（= `basePath`）、`targetPort`（从 scope + 模板提取）。

### 导航拦截器（navigation_interceptor.js）

**注入方式**：SW 在 HTML 响应中内联注入（非 `<script src>`），确保在页面 JS 执行前生效。

**拦截项**：

| 拦截 | 方法 | 说明 |
|------|------|------|
| 链接点击 | `document.addEventListener('click', ..., true)` | 重写 `href` |
| history | `pushState` / `replaceState` | 重写 URL |
| popstate | `popstate` 事件 | 补救修正 |
| 表单 | `submit` 事件 | 重写 `action` |
| window.open | 替换 `global.open` | 重写 URL |
| Navigation API | `navigation.addEventListener('navigate')` | Chromium 专用，拦截 `location.href` 赋值 |
| WebSocket | 替换 `global.WebSocket` | 见下文 |

**URL 重写逻辑**：相对根路径 `/api` → `{scopeBase}api`，同源绝对 URL 同理处理。跨域/特殊协议不处理。

### WebSocket Polyfill

`wsFallback=true` 时替换原生 `WebSocket` 为 `WsPolyfill`：

**连接建立**：
1. `rewriteUrl` 重写 WS URL（子路径修正）
2. 剥离 `scopeBase` 前缀得到目标服务路径
3. 用 `cfg.bridgeBase` + `cfg.targetPort` 构造桥接 URL
4. 生成 `sid`，发起 SSE 连接

**下行降级链**：
```
EventSource(SSE) ──失败──→ fetch() + ReadableStream(Fetch Streaming)
```
- SSE 连接阶段失败 → 自动降级 Fetch Streaming
- SSE 已连接后断开 → 直接报错（不降级，避免重复连接）
- 两种模式共用 `handleEvent()` 处理事件

**上行**：`fetch(POST)` 发送消息，Blob 先转 ArrayBuffer。

**消息解码**：`msgType=1` → `TextDecoder` 解码为 string；`msgType=2` → 保留 Uint8Array。

### 端口管理

| 操作 | 流程 |
|------|------|
| 添加端口 | 持久化（localStorage）→ 注册 SW（scope = 模板替换端口）→ 刷新 |
| 停止转发 | 清除状态 → 刷新 UI → 异步注销 SW |
| 切换模式 | `none` → 配置 SW none + 清状态；其他 → 确保 SW 已注册 → 发送配置 |

策略持久化到 localStorage，页面刷新后从 SW 查询实际配置恢复。

## 数据流

### 普通 HTTP 请求（subpath 模式）

```
浏览器 http://host{basePath}/proxy/8188/api/data
  → 外层代理剥离 {basePath} → Go 收到 /proxy/8188/api/data
  → handleProxy: subpath 模式, port=8188, path=/api/data
  → ReverseProxy → localhost:8188/api/data
```

### 普通 HTTP 请求（tunnel 模式）

```
SW 拦截 → 307 重定向 + 预取
  → Go 收到 /proxy/8188?u=/api/data
  → handleProxy: tunnel 模式, port=8188, u=/api/data
  → ReverseProxy → localhost:8188/api/data
```

### WebSocket（原生模式）

```
浏览器 new WebSocket("ws://host/ws")
  → 拦截器 rewriteUrl → ws://host{basePath}/proxy/8188/ws
  → 外层代理剥离 {basePath}, Upgrade 转发
  → Go 收到 /proxy/8188/ws (带 Upgrade 头)
  → handleProxy: subpath 模式, port=8188
  → ReverseProxy 透传 Upgrade → ws://localhost:8188/ws
```

### WebSocket（降级模式）

```
浏览器 new WebSocket("ws://host/ws")
  → Polyfill: rewriteUrl → ws://host{basePath}/proxy/8188/ws
  → 剥离 scopeBase → wsPath=/ws
  → GET /proxy/8188?u=/ws&ws=1&sid=xxx
  → 外层代理剥离 {basePath}
  → Go: ws=1 → handleWsBridge → Dial ws://localhost:8188/ws
  → SSE 下行 + POST 上行
```

## 部署示例

外层反向代理将某子路径代理到 Go 服务，浏览器通过该子路径访问。添加端口 `8188` 后，通过 `{basePath}/proxy/8188/` 访问目标服务。Go 服务通过 `--port` 指定监听端口，固定监听 `0.0.0.0`。

### 编译

```bash
# Windows
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o proxy_toolkit.exe .

# Linux
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o proxy_toolkit_linux_amd64 .
```

## 设计决策

| 决策 | 理由 |
|------|------|
| 统一 `/proxy/{port}` 路由 | subpath 和 tunnel 共用入口，按路径结构自动分流 |
| 307 + 预取 | SW 无法直接修改请求 URL，用 307 重定向 + 预取缓存避免二次请求 |
| 导航拦截器内联注入 | SW 无法拦截 `location.href` 赋值，需在页面 JS 执行前 patch |
| WS 桥接 SSE + POST | 拆分全双工为单向 HTTP，绕过平台 WS Upgrade 限制 |
| SSE → Fetch Streaming 降级 | SSE 可能被某些平台缓冲/限制，Fetch Streaming 兼容性更广 |
| WS 支持自动检测 | auto 模板直连检测（等价），manual 模板走模板路径检测，按模板缓存 |
| 编码检测 | 外层代理可能多次解码 URL，需检测实际行为修正路径 |
| 方法覆盖 `m` 参数 | 平台限制非 GET/POST 方法，映射为 POST + `m=原始方法` |
