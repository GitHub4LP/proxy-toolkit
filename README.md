# Browser Proxy Toolkit

通过 Service Worker 拦截和重写请求 URL，解决 Web 应用在子路径反向代理环境下的资源加载问题。当前聚焦核心代理方案的研究与验证。

## 核心特性

### 🔧 Service Worker URL 重写
- **四种策略**：None / Subpath / Tunnel / Hybrid
- **动态配置**：通过 `postMessage` 实时切换策略
- **导航拦截**：自动注入脚本修复链接点击、history API、表单提交

### 🔍 智能环境检测
- 自动识别：JupyterLab、Code Server、AI Studio
- 代理模板生成：返回最短子路径模板
- 编码深度检测：探测反向代理的解码行为

## 项目结构

```
proxy-toolkit/
├── proxy_toolkit/                  # 核心 Python 包
│   ├── __init__.py
│   ├── __main__.py                 # python -m proxy_toolkit
│   ├── server.py                   # HTTP 服务
│   ├── port_proxy.py               # 环境检测
│   ├── unified_service_worker.js   # SW 核心脚本
│   ├── navigation_interceptor.js   # 导航拦截器
│   ├── sw_client.js                # 客户端工具库
│   └── static/                     # Web 界面
│       ├── index.html
│       ├── app.js
│       └── style.css
│
└── proxy_toolkit_go/              # Go 重写实现，含前端与设计说明
```

Go 版重写并完善 Python 版，两者在同一仓库中保留，便于迁移和对照；前端目前存在差异。

## 快速开始

### Python 版

```bash
# 安装
pip install proxy-toolkit

# 启动服务
python -m proxy_toolkit --port 3000

# 或使用命令
proxy-toolkit --port 3000
```

### Go 版

```bash
cd proxy_toolkit_go
go run . --port 8080
```

机制与构建方式见 [Go 设计说明](proxy_toolkit_go/DESIGN.md)。

## 开发指南

### 环境准备

```bash
# 克隆仓库
git clone <repo>
cd proxy-toolkit

# 安装依赖
uv sync --group dev
```

### 构建核心包

```bash
uv run python -m build --wheel --no-isolation
# 生成 dist/proxy_toolkit-0.1.0-py3-none-any.whl
```

### 发布新版本

Python 包版本在 `pyproject.toml` 和 `proxy_toolkit/__init__.py` 中同步维护。推送 `v*` 标签或手动运行 Release 工作流时，构建并发布核心 wheel。

## Python 版 API

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

## 许可证

MIT License
