# 子路径访问方案对比分析

历史分析记录：以下能力与限制描述保留原状，结论待后续验证。

## 问题本质

前端服务开发时未考虑子路径访问需求。通过反向代理（如 nginx `/proxy/{{port}}/`）从子路径访问时，应用内部产生的根路径 URL（`/api/...`、`/static/...`、`/page2`）逃逸出代理 scope，导致资源 404、导航失控、功能异常。

**关键前提**：这些服务原本是能正常闭环访问的独立应用，所有根路径 URL 都指向自身资源，不会合法地访问自身路径之外的路径服务。这是我们能放心将所有根路径请求重写到 scope 内的安全性前提。

**目标**：通用机制，使未适配子路径的前端服务能从子路径完美正常访问。

## 核心约束

### 1. SW scope 限制

- SW 注册在 `/proxy/{{port}}/`，仅控制该 scope 下的页面
- **普通请求**（`fetch`/`XHR`/`<img>` 等）：SW 拦截受控页面发出的所有请求，无论目标 URL 是否在 scope 内 — 这是 SW 方案可行的前提
- **导航请求**（`mode === 'navigate'`）：SW 仅在导航目标 URL 在 scope 内时才触发 fetch 事件 — 导航到 scope 外 URL 时 SW 完全无法拦截
- 不能将 scope 设为 `/`：会影响 `/` 下所有服务，且 `/` 可能已有其他 SW，注册会冲突覆盖

### 2. 浏览器 API 限制

- `location.href` 赋值**无法被 patch**（属性 setter 不触发拦截）
- Navigation API（`navigation.addEventListener`）可拦截，但**仅 Chromium 可用**
- `location.assign`/`replace` patch 在部分浏览器无效
- `<base>` 方案排除：仅影响相对 URL，破坏绝对路径，不处理动态构造的 URL

### 3. 跨域导航

- 标签页导航到其他域后，SW 完全无法控制

### 4. WebSocket 限制

- SW fetch 事件**不触发** WebSocket 连接升级请求
- 唯一处理方式：客户端 patch `WebSocket` 构造函数重写 URL

## 方案架构

3 种方案都基于 **SW fetch 拦截 + 导航注入 `navigation_interceptor.js`** 的双层机制：

- **SW 层**：拦截受控页面的所有 fetch 请求，重写逃逸出 scope 的根路径 URL
- **客户端层**：`navigation_interceptor.js` patch 导航相关 API（`pushState`/`replaceState`/click/submit/popstate/`window.open`/`WebSocket`/Navigation API），防止客户端路由产生 scope 外 URL

### 已解决的情形

| 情形 | 解决方式 |
|------|----------|
| `<img src="/static/...">` | SW fetch 拦截 → 重写/重定向/隧道 |
| `<script src="/js/...">` | 同上 |
| `<link href="/css/...">` | 同上 |
| `fetch("/api/...")` | 同上 |
| `XMLHttpRequest("/api/...")` | 同上 |
| `import("/js/module.js")` | 同上（SW 拦截 import 的请求） |
| `history.pushState("/page2")` | `navigation_interceptor.js` patch |
| `history.replaceState("/page2")` | 同上 |
| `<a href="/page2">` 点击 | 同上（click 事件拦截） |
| `<form action="/submit">` | 同上（submit 事件拦截） |
| `popstate` 路径修正 | 同上（popstate 事件补救） |
| `window.open("/page")` | `navigation_interceptor.js` patch `window.open` |
| `new WebSocket("ws://host/ws")` | `navigation_interceptor.js` patch `WebSocket` 构造函数 |
| `location.href = '/page'`（Chromium） | `navigation_interceptor.js` Navigation API 拦截 |
| 反向代理多层解码 | `decodeDepth` 重新编码 |
| `%2F` 被额外解码 | Tunnel/Hybrid 隧道透传 |

### 3 种方案的差异

差异仅在 **SW 层处理根路径请求的方式**：

| 维度 | Subpath | Tunnel | Hybrid |
|------|---------|--------|--------|
| 处理方式 | 307 重定向到 scope 内 | 转发到后端隧道 `/api/http-tunnel/{port}` | 按需路由 |
| 编码处理 | `decodeDepth` 重新编码 | 后端透传，不涉及 | `%2F` 检测切换 |
| 后端依赖 | 无 | 需要 | 需要 |
| 性能 | 307 额外往返 | 无重定向 | 混合 |
| 适用 | 正常编码环境 | 编码问题严重 | 编码行为不确定 |

### 未解决的少数情形（所有方案的共同硬限制）

以下情形**所有方案都无法解决**，根因是浏览器限制或 SW scope 机制：

1. **`location.href = '/page'`（非 Chromium）**
   - 无法 patch 属性赋值
   - Navigation API 仅 Chromium 可用
   - 全页导航到 `/page`（scope 外）→ SW 不拦截导航请求 → 浏览器直接导航 → 新页面不受 SW 控制

2. **`location.assign('/page')`/`location.replace('/page')`（部分浏览器）**
   - patch 在部分浏览器无效
   - 同上失控

3. **`<meta http-equiv="refresh" content="0;url=/page">`**
   - 无法拦截

4. **跨域导航后**
   - 标签页离开当前域，SW 完全无法控制

## 能力对比

| 能力 | Subpath | Tunnel | Hybrid |
|------|---------|--------|--------|
| 根路径资源请求 | ✅ 307 | ✅ 隧道 | ✅ |
| `fetch`/`XHR` | ✅ SW | ✅ SW | ✅ SW |
| `import()` | ✅ SW | ✅ SW | ✅ SW |
| `pushState`/`replaceState` | ✅ patch | ✅ patch | ✅ patch |
| click/submit | ✅ patch | ✅ patch | ✅ patch |
| `window.open` | ✅ patch | ✅ patch | ✅ patch |
| WebSocket | ✅ patch | ✅ patch | ✅ patch |
| `location.href`（Chromium） | ✅ Nav API | ✅ Nav API | ✅ Nav API |
| `location.href`（非 Chromium） | ❌ | ❌ | ❌ |
| `<meta refresh>` | ❌ | ❌ | ❌ |
| 跨域导航 | ❌ | ❌ | ❌ |
| 编码修正 | ✅ | ✅ | ✅ |
| 客户端侵入性 | 低 | 低 | 低 |
| 后端依赖 | 无 | 需要 | 需要 |
