# 端口管理服务 (Proxy Toolkit)

一个面向子路径代理环境的端口访问与导航修复工具，自动探测平台代理模板、生成端口代理链接，并提供统一的 Service Worker（子路径修复或 HTTP 隧道）以提升在 JupyterLab、Code Server、AI Studio 等环境下的可用性。

## 核心特性

### 🔍 智能环境检测
- 自动识别运行环境：JupyterLab、Code Server、AI Studio
- 代理URL模板生成：返回最短子路径模板（如 `/proxy/{{port}}/` 或平台变量拼接）
- nginx解码深度辅助检测：前端探测代理层对参数的解码深度（用于子路径策略编码补偿）

### 🖥️ 端口监控管理
- 实时检测端口监听状态（TCP connect_ex）
- 展示进程信息（PID、名称、完整命令行）
- 输入端口号自动添加（1秒防抖）
- 合并浏览器已注册SW的端口视图（即便后端不在监听）

### 🔧 统一Service Worker（双模式）
- 子路径修复（mode=s{depth}）：修正请求路径前缀与多层编码错位，必要时重定向到正确URL
- HTTP隧道（mode=t）：改写请求到后端 `/api/http-tunnel/{port}?u=...` 透传至本机服务，适配更严格的同源/解码场景
- 导航拦截器注入：在导航响应中自动注入前端脚本，修复 a/link/history/location/form 等导航行为的子路径问题
- 一键注册/注销与模式切换（前端UI，按端口保存策略）

## 项目架构

### 核心模块

#### 1. server.py — 主服务（aiohttp）
- 路由：
  - GET `/` 静态首页
  - GET `/api/ports` 端口列表
  - GET `/api/port/{port}` 单端口刷新
  - GET `/api/url-template` 环境URL模板与是否支持代理
  - GET `/api/test-encoding/{path:.*}` 返回服务端看到的路径（用于前端探测解码层）
  - ANY `/api/http-tunnel/{port}` 路径式HTTP隧道，余路径通过查询参数 `u`
  - GET `/unified_service_worker.js` 统一Service Worker脚本（根作用域允许头）
  - GET `/navigation_interceptor.js` 导航拦截器脚本
  - `/static/*` 静态资源
- 端口与进程：psutil.net_connections 定位进程，返回 PID/名称/完整 cmdline
- 启动条件：仅在检测到子路径环境且非根路径时由 `server.py` 的 `main()` 启动（Gradio启动器除外）

#### 2. port_proxy.py — 环境检测与模板生成
- JupyterLab：枚举运行中的服务器，校验 `base_url + proxy/{port}/?token=...` 可达，返回 `base_url + proxy/{{port}}/`
- Code Server：进程环境变量 `VSCODE_PROXY_URI` 作为模板
- AI Studio：`STUDIO_MODEL_API_URL_PREFIX + JUPYTERHUB_SERVICE_PREFIX + gradio/{{port}}/`，并更新 `~/.webide/proxy_config.json`
- detect_service_config：在本机进程与端口的交叉中识别服务类型，返回路径段数最短的模板
- generate_proxy_url(port)：用模板替换 `{{port}}`，在 AI Studio 写入配置

#### 3. main.gradio.py — Gradio环境启动器
- 自动安装依赖（aiohttp、jupyter-server、psutil、requests）
- 以 `GRADIO_SERVER_PORT`（默认7860）启动 `PortServer`，不做子路径检查

#### 4. 前端（static/）
- index.html / style.css：简洁表格；端口状态、进程信息、代理URL、SW模式列
- app.js：
  - 拉取 `/api/url-template` 判断代理支持
  - 探测nginx解码深度（调用 `/api/test-encoding`，多层编码与验证）
  - 管理端口列表与SW状态；按端口保存策略（none/subpath/tunnel）
  - 注册SW：`/unified_service_worker.js?mode=s{depth}|t`，作用域为模板生成的端口路径

#### 5. 浏览器脚本
- unified_service_worker.js：子路径修复或隧道，导航拦截器注入与客户端强制刷新消息处理
- navigation_interceptor.js：在子路径环境下拦截并修正导航相关API与交互

## 关键算法与流程片段

### nginx解码深度探测（前端）
```javascript
// 简化版：逐层额外编码，与服务端返回对照并验证
async function detectNginxEncoding(basePath) {
  const base = encodeURIComponent("test/path"); // 浏览器一次编码的基准
  let maxLayers = 4, attempts = 8;
  for (; maxLayers <= attempts; maxLayers++) {
    let seg = base;
    for (let i = 0; i < maxLayers; i++) seg = encodeURIComponent(seg);
    const r = await fetch(`${basePath}/api/test-encoding/${seg}`);
    if (!r.ok) break;
    const { path } = await r.json();
    let cur = path, steps = 0;
    while (cur !== seg && steps < maxLayers) { cur = encodeURIComponent(cur); steps++; }
    const depth = (cur === seg) ? steps : 0;
    if (await verify(base, depth, basePath)) return depth;
  }
  return 0;
}
```

### 路径式HTTP隧道（SW端）
```javascript
// 仅在需要时对同源请求进行改写：/api/http-tunnel/{port}?u=...
event.respondWith(fetch(proxyUrl, init)); // proxyUrl 由 scope 与余路径拼装
```

## API接口

### RESTful
```
GET  /                           # 主界面
GET  /api/ports                  # 端口列表
GET  /api/port/{port}            # 单端口信息
GET  /api/url-template           # 代理模板与支持标记
GET  /api/test-encoding/{path}   # 返回服务端看到的路径
*    /api/http-tunnel/{port}?u=/...  # HTTP隧道透传到 localhost:{port}
GET  /unified_service_worker.js  # 统一SW脚本
GET  /navigation_interceptor.js  # 导航拦截器
GET  /static/*                   # 静态资源
```

### 数据结构
```python
class PortInfo:
    port: int
    is_listening: bool
    process_name: str | None
    process_pid: int | None
    process_cmdline: str | None
    proxy_url: str | None
```

## 代理策略对比

### 子路径修复（mode=s{depth}）
- 适用：标准子路径代理，存在URL编码/解码不一致
- 原理：修正scope前缀与选择性多次编码；对子路径不完整进行 307 重定向
- 优势：轻量、性能好、兼容度高
- 限制：依赖代理对编码/路径的可预测行为

### HTTP隧道（mode=t）
- 适用：子路径策略仍失败、同源/CSRF严格或特殊代理限制
- 原理：改写为后端隧道端点，重写 Origin/Referer，保持方法与体
- 优势：绕过代理URL处理，覆盖更广
- 限制：增加一次后端透传与潜在性能开销

## 使用方式

### 标准/开发环境
```bash
# 仅在检测到子路径环境且非根路径时，server.py 的 main 会启动
python server.py --host 0.0.0.0 --port 3000
```

### Gradio环境
```bash
# 自动安装依赖并启动到 GRADIO_SERVER_PORT（默认7860）
python main.gradio.py
# 或指定端口
GRADIO_SERVER_PORT=8080 python main.gradio.py
```

### 依赖
```bash
pip install -r requirements.txt
# main.gradio.py 会自动安装：aiohttp, jupyter-server, psutil, requests
```

