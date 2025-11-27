# 端口管理服务 (Proxy Toolkit)

一个面向子路径代理环境的端口访问与导航修复工具，自动探测平台代理模板、生成端口代理链接，并提供统一的 Service Worker（子路径修复或 HTTP 隧道）以提升在 JupyterLab、Code Server、AI Studio 等环境下的可用性。

## 核心特性

### 🔍 智能环境检测
- 自动识别运行环境：JupyterLab、Code Server、AI Studio
- 代理URL模板生成：返回最短子路径模板（如 `/proxy/{{port}}/` 或平台变量拼接）
- nginx解码深度辅助检测：前端探测代理层对参数的解码深度（用于子路径策略编码补偿）

### 🖥️ 端口监控管理
- 实时检测端口监听状态（TCP connect_ex）
- 展示进程信息（PID、完整命令行）
- 智能增量更新：只更新变化的端口，保护用户交互
- 自动同步：SW 注册的端口自动向后端请求信息

### 🔧 统一Service Worker（动态配置）
- **动态策略切换**：通过 `postMessage` 实时配置策略，策略变更时自动刷新客户端
- **四种模式**：
  - None：不处理任何请求（默认）
  - Subpath：修正请求路径前缀与多层编码错位
  - Tunnel：改写请求到后端 HTTP 隧道透传
  - Hybrid：智能混合策略，自动检测 `%2F` 特殊解码并路由
- **导航拦截器**：自动注入脚本，修复子路径环境下的导航行为
- **自动注册**：添加端口时自动注册 SW，默认策略为 None

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
- **index.html / style.css**：VSCode 风格端口管理界面
  - 端口状态指示（绿点表示监听中）
  - 进程信息显示（格式：`(PID) 完整命令行`）
  - 代理 URL 链接
  - Proxy Mode 下拉框（None/Subpath/Tunnel）
- **app.js**：
  - 智能增量更新：只更新变化的端口行，保护用户交互状态
  - 自动同步：SW 注册的端口自动向后端请求信息
  - 探测 nginx 解码深度，自动适配代理环境
  - 添加端口时自动注册 SW（默认策略 None）
  - 策略切换通过 `postMessage` 动态配置 SW

#### 5. 浏览器脚本
- **unified_service_worker.js**：统一 SW 脚本
  - 默认策略：None（不处理任何请求）
  - 通过 `postMessage` 动态配置策略（None/Subpath/Tunnel）
  - 策略变更时自动刷新客户端页面
  - 导航拦截器注入，修正子路径导航行为
- **navigation_interceptor.js**：拦截并修正 a/link/history/location/form 等导航 API

## 关键算法与流程片段

### %2F 特殊解码检测
```javascript
// 检测 %2F 是否被额外解码（独立于基准深度）
async detectSlashExtraDecoding() {
    // 1. 先检测基准深度（通过普通字符）
    const baseDepth = this.nginxDecodeDepth;
    
    // 2. 发送 baseDepth + 1 层编码的 %2F
    let encoded = '%2F';
    for (let i = 0; i < baseDepth + 1; i++) {
        encoded = encodeURIComponent(encoded);
    }
    
    // 3. 观察服务端返回
    const result = await fetch(`/api/test-encoding/${encoded}`);
    
    // 4. 判断：如果返回 '/' 或 '%2F'，说明被额外解码
    //    如果返回更高层编码（如 '%252F'），说明遵循基准深度
    if (result.path === '/' || result.path === '%2F') {
        this.slashExtraDecoding = true;  // 需要 Hybrid 策略
    } else {
        this.slashExtraDecoding = false; // Subpath 即可
    }
}
```

### 智能增量更新
```javascript
// 只更新变化的端口行，保护用户交互
displayPorts(ports) {
    // 检测用户是否正在操作
    if (document.activeElement.tagName === 'SELECT') {
        return; // 跳过更新，避免打断
    }
    
    // 增量更新：只添加/删除/更新变化的行
    allPorts.forEach(port => {
        const existingRow = tbody.querySelector(`tr[data-port="${port.port}"]`);
        if (!existingRow) {
            tbody.appendChild(createRow(port)); // 新端口
        } else {
            updateRowIfNeeded(existingRow, port); // 只更新变化的单元格
        }
    });
}
```

### Service Worker 动态配置
```javascript
// 前端：注册 SW（无参数）
await navigator.serviceWorker.register('/unified_service_worker.js', { scope });

// 前端：切换策略（包含检测结果）
registration.active.postMessage({
    type: 'CONFIGURE',
    data: { 
        strategy: 'hybrid',           // none | subpath | tunnel | hybrid
        decodeDepth: 2,               // 基准解码深度
        slashExtraDecoding: true      // %2F 是否被额外解码
    }
});

// SW：接收配置并智能路由
self.addEventListener('message', (event) => {
    if (event.data.type === 'CONFIGURE') {
        strategy = event.data.data.strategy;
        slashExtraDecoding = event.data.data.slashExtraDecoding;
        
        // Hybrid 策略：根据路径内容动态选择处理方式
        if (strategy === 'hybrid' && slashExtraDecoding && /%2F/i.test(pathname)) {
            TunnelHandler.handleFetch(event);  // 包含 %2F 走隧道
        } else {
            SubpathHandler.handleFetch(event); // 其他走子路径修复
        }
    }
});
```

## API接口

### RESTful
```
GET     /                              # 主界面
GET     /api/ports                     # 端口列表
GET     /api/port/{port}               # 单端口信息
DELETE  /api/port/{port}               # 删除端口
GET     /api/url-template              # 代理模板与支持标记
GET     /api/test-encoding/{path}      # 返回服务端看到的路径
*       /api/http-tunnel/{port}?u=/... # HTTP隧道透传到 localhost:{port}
GET     /unified_service_worker.js     # 统一SW脚本（无参数）
GET     /navigation_interceptor.js     # 导航拦截器
GET     /static/*                      # 静态资源
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

### None（默认）
- **适用**：刚添加端口，暂不需要代理修复
- **行为**：SW 已注册但不处理任何请求
- **优势**：零开销，不影响正常访问
- **使用场景**：端口服务本身已正确处理子路径

### Subpath（子路径修复）
- **适用**：标准子路径代理，存在 URL 编码/解码不一致
- **原理**：修正 scope 前缀与选择性多次编码；对子路径不完整进行 307 重定向
- **优势**：轻量、性能好、兼容度高
- **限制**：依赖代理对编码/路径的可预测行为
- **使用场景**：大多数子路径代理环境

### Tunnel（HTTP 隧道）
- **适用**：子路径策略仍失败、同源/CSRF 严格或特殊代理限制
- **原理**：改写为后端隧道端点，重写 Origin/Referer，保持方法与体
- **优势**：绕过代理 URL 处理，覆盖更广
- **限制**：增加一次后端透传与潜在性能开销
- **使用场景**：复杂代理环境或 Subpath 模式失效时

### Hybrid（智能混合）
- **适用**：代理环境对 `%2F` 有特殊解码处理
- **原理**：自动检测 `%2F` 是否被额外解码；大部分请求走 Subpath，包含 `%2F` 的请求走 Tunnel
- **优势**：兼顾性能与兼容性，自动适配特殊字符处理
- **检测逻辑**：通过发送多层编码的 `%2F`，判断是否被单独解码
- **使用场景**：推荐用于检测到 `%2F` 特殊解码的环境

## 使用方式

### 标准/开发环境
```bash
# 仅在检测到子路径环境且非根路径时，server.py 的 main 会启动
python server.py --host 0.0.0.0 --port 3000
```

### Gradio 环境
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
