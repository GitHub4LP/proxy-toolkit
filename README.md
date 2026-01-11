# Browser Proxy Toolkit

通过 Service Worker 拦截和重写请求 URL，解决 Web 应用在子路径反向代理环境下的资源加载问题。支持三种部署场景：独立 Web 版、JupyterLab 扩展、VS Code/Code Server 扩展。

## 核心特性

### 🔧 Service Worker URL 重写
- **四种策略**：None / Subpath / Tunnel / Hybrid
- **动态配置**：通过 `postMessage` 实时切换策略
- **导航拦截**：自动注入脚本修复链接点击、history API、表单提交

### 🔍 智能环境检测
- 自动识别：JupyterLab、Code Server、AI Studio
- 代理模板生成：返回最短子路径模板
- 编码深度检测：探测反向代理的解码行为

### 📦 三种部署场景
| 场景 | 后端 | SW 脚本提供 | 用户界面 |
|-----|------|------------|---------|
| 独立 Web 版 | Python (aiohttp) | HTTP 服务 | 端口管理界面 |
| JupyterLab 扩展 | Python (jupyter-server-proxy) | HTTP 服务 | IFrame 嵌入 |
| VS Code 扩展 | Node.js | 内嵌 HTTP 服务 | 端口面板右键菜单 |

## 项目结构

```
proxy-toolkit/
├── 核心文件（单一来源）
│   ├── unified_service_worker.js   # SW 核心脚本
│   ├── navigation_interceptor.js   # 导航拦截器
│   ├── sw_client.js                # 客户端工具库
│   ├── port_proxy.py               # 环境检测
│   ├── server.py                   # HTTP 服务
│   └── LICENSE                     # MIT 许可证
│
├── 独立 Web 版
│   ├── static/
│   │   ├── index.html              # 端口管理界面
│   │   ├── app.js                  # 前端逻辑
│   │   └── style.css               # 样式
│   └── main.gradio.py              # Gradio 环境启动器
│
├── JupyterLab 扩展
│   └── jupyterlab-proxy-toolkit/
│       ├── src/index.ts            # 扩展入口
│       ├── scripts/copy-shared-files.js  # 构建时复制共用文件
│       └── jupyterlab_proxy_toolkit/
│           └── server/             # 构建时复制（.gitignore）
│
└── VS Code 扩展
    └── vscode-proxy-toolkit/
        ├── src/                    # TypeScript 源码
        ├── scripts/copy-sw-files.js  # 构建时复制共用文件
        └── resources/              # 构建时复制（.gitignore）
```

## 共用文件策略

采用**单一来源 + 构建时复制**：

- 核心文件在根目录维护（Git 跟踪）
- 各扩展构建时复制到各自目录
- 复制的文件通过 `.gitignore` 忽略

```
构建时复制：
├── JupyterLab: npm run prebuild → server/ 目录
│   ├── JS 文件、Python 文件（自动修改 import）
│   └── static/ 目录（自动修改路径引用）
│
└── VS Code: npm run prebuild → resources/ 目录
    └── JS 文件
```

## 快速开始

### 独立 Web 版

```bash
# 安装依赖（使用 uv）
uv sync

# 或使用 pip
pip install -e .

# 启动服务（仅在子路径环境下启动）
python server.py --host 0.0.0.0 --port 3000

# Gradio 环境
python main.gradio.py
```

### JupyterLab 扩展

```bash
cd jupyterlab-proxy-toolkit

# 安装依赖
npm install
pip install -e .

# 构建
npm run build:prod

# 开发模式
npm run build
jupyter lab
```

**依赖**：需要安装 `jupyter-server-proxy`

### VS Code 扩展

```bash
cd vscode-proxy-toolkit

# 安装依赖
npm install

# 构建
npm run build

# 打包
npm run package
# 生成 vscode-proxy-toolkit-0.0.1.vsix
```

**启用条件**：
- `VSCODE_PROXY_URI` 环境变量存在
- 模板包含子路径（如 `/proxy/{{port}}/`）

## API 接口

```
GET   /                              # 主界面
GET   /api/url-template              # 代理模板
GET   /api/test-encoding/{path}      # 编码检测
GET   /api/port/{port}               # 端口信息
POST  /api/ports/batch               # 批量查询
*     /api/http-tunnel/{port}?u=/... # HTTP 隧道
GET   /unified_service_worker.js     # SW 脚本
GET   /navigation_interceptor.js     # 导航拦截器
GET   /sw_client.js                  # 客户端工具库
```

## 代理策略

| 策略 | 行为 | 适用场景 |
|-----|------|---------|
| None | 不处理任何请求 | 禁用 SW |
| Subpath | `/path` → `/proxy/port/path` | 标准反向代理 |
| Tunnel | 通过 HTTP 隧道转发 | 复杂代理环境 |
| Hybrid | 智能选择 Subpath 或 Tunnel | `%2F` 被额外解码的环境 |

## 核心算法

### 反向代理编码检测

```javascript
// 1. 解码深度检测
const testSegment = "test path";  // 避免 %2F 干扰
// 发送多层编码，通过反向编码计算解码深度

// 2. %2F 额外解码检测
const testSegment = "test/path";
// 如果返回包含真实斜杠，说明 %2F 被额外解码
```

### SW 配置协议

```javascript
worker.postMessage({
  type: 'CONFIGURE',
  data: {
    strategy: 'subpath',      // 'none' | 'subpath' | 'tunnel' | 'hybrid'
    decodeDepth: 0,           // 反向代理解码深度
    slashExtraDecoding: false // %2F 是否被额外解码
  }
});
```

## 架构设计思考

### JupyterLab 扩展：为什么使用 IFrame 而非原生 Widget？

**当前架构**：
```
JupyterLab 扩展
├── 前端 (TypeScript) → IFrame Widget → 嵌入独立 Web 版界面
└── 后端 (Python) → 独立 HTTP 服务 (端口 4000)
```

**原生 Widget 方案**：
```
JupyterLab 扩展
├── 前端 (TypeScript) → 原生 Lumino Widget + sw_client.js
└── 后端 (Jupyter Server 扩展) → 直接注册到 Jupyter Server
```

**权衡分析**：

| 维度 | IFrame 方案（当前） | 原生 Widget 方案 |
|-----|-------------------|-----------------|
| 代码复用 | ✅ 直接复用独立 Web 版 | ❌ 需要重写前端 |
| 开发复杂度 | ✅ 简单 | ❌ 需要学习 JupyterLab API |
| 额外端口 | ❌ 需要端口 4000 | ✅ 无需额外端口 |
| 样式统一 | ❌ IFrame 隔离 | ✅ 原生样式 |
| 依赖 | ❌ 需要 jupyter-server-proxy | ✅ 无额外依赖 |

**结论**：当前 IFrame 方案适合快速验证，长期可考虑重构为原生 Widget + Jupyter Server 扩展。

### VS Code 扩展：为什么需要内嵌 HTTP 服务？

**核心限制**：
1. Service Worker 脚本必须通过 HTTP 提供（不能从扩展文件系统直接加载）
2. VS Code Webview 与主页面同源，但扩展静态文件不可直接 HTTP 访问
3. 必须通过 Code Server 的代理层访问 SW 脚本

**解决方案**：
```
扩展启动 → Node.js HTTP 服务 (localhost:N)
         → Code Server 代理 → /proxy/N/unified_service_worker.js
         → 浏览器注册 SW 到 /proxy/{targetPort}/
```

## 开发指南

### 修改核心文件

1. 修改根目录的核心文件
2. 运行各扩展的 `npm run prebuild` 复制到扩展目录
3. 构建和测试

### 添加新的共用文件

1. 在根目录创建文件
2. 更新 `jupyterlab-proxy-toolkit/scripts/copy-shared-files.js`
3. 更新 `vscode-proxy-toolkit/scripts/copy-sw-files.js`
4. 更新 `.gitignore`

## 许可证

MIT License
