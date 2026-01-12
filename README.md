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
| 场景 | 安装方式 | 用户界面 |
|-----|---------|---------|
| 独立 Web 版 | `pip install proxy-toolkit` | 端口管理界面 |
| JupyterLab 扩展 | `pip install jupyterlab-proxy-toolkit` | IFrame 嵌入 |
| VS Code 扩展 | 安装 `.vsix` 文件 | 端口面板右键菜单 |

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
├── jupyterlab-proxy-toolkit/       # JupyterLab 扩展（依赖 proxy-toolkit）
│   ├── src/index.ts                # 前端入口
│   └── jupyterlab_proxy_toolkit/   # Python 包（仅 labextension）
│
├── vscode-proxy-toolkit/           # VS Code 扩展
│   ├── src/                        # TypeScript 源码
│   └── resources/                  # 构建时复制的 JS 文件
```

## 快速开始

### 独立 Web 版

```bash
# 安装
pip install proxy-toolkit

# 启动服务（仅在子路径环境下启动）
python -m proxy_toolkit --port 3000

# 或使用命令
proxy-toolkit --port 3000
```

### JupyterLab 扩展

```bash
# 安装（会自动安装 proxy-toolkit 依赖）
pip install jupyterlab-proxy-toolkit

# 需要 jupyter-server-proxy
pip install jupyter-server-proxy

# 验证
jupyter labextension list
```

### VS Code 扩展

在 Code Server 环境中安装 `.vsix` 文件。

**启用条件**：
- `VSCODE_PROXY_URI` 环境变量存在
- 模板包含子路径（如 `/proxy/{{port}}/`）

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

### 构建 JupyterLab 扩展

```bash
cd jupyterlab-proxy-toolkit
npm install
npm run prebuild
npm run build:lib:prod
cd ..
uv run jupyter labextension build jupyterlab-proxy-toolkit
uv run python -m build jupyterlab-proxy-toolkit --wheel --no-isolation
# 生成 jupyterlab-proxy-toolkit/dist/jupyterlab_proxy_toolkit-0.1.0-py3-none-any.whl
```

### 构建 VS Code 扩展

```bash
cd vscode-proxy-toolkit
npm install
npm run build
npm run package
# 生成 vscode-proxy-toolkit-0.1.0.vsix
```

### 修改核心文件

核心文件在 `proxy_toolkit/` 目录，修改后：
- 独立 Web 版：直接生效
- JupyterLab 扩展：重新构建 wheel
- VS Code 扩展：运行 `npm run prebuild` 复制 JS 文件，然后重新构建

### 发布新版本

1. 更新版本号（三处需要同步）：
   - `proxy_toolkit/__init__.py` → `__version__ = "x.y.z"`
   - `jupyterlab-proxy-toolkit/package.json` → `"version": "x.y.z"`
   - `vscode-proxy-toolkit/package.json` → `"version": "x.y.z"`

2. 提交代码：
   ```bash
   git add -A
   git commit -m "bump version to x.y.z"
   ```

3. 打 tag 并推送：
   ```bash
   git tag vx.y.z
   git push origin main --tags
   ```

4. GitHub Actions 自动构建并发布到 Releases：
   - `proxy_toolkit-x.y.z-py3-none-any.whl`
   - `jupyterlab_proxy_toolkit-x.y.z-py3-none-any.whl`
   - `vscode-proxy-toolkit-x.y.z.vsix`

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

## 许可证

MIT License
