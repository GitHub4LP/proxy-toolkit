# VS Code Proxy Toolkit

VS Code / Code Server 扩展，通过 Service Worker 解决子路径代理环境下的 URL 重写问题。

## 功能

- Service Worker 自动修正子路径 URL
- 支持四种代理策略：None / Subpath / Tunnel / Hybrid
- 自动检测反向代理编码行为
- 端口面板右键菜单快速切换策略

## 启用条件

扩展仅在以下条件下启用：
1. `VSCODE_PROXY_URI` 环境变量存在
2. 代理模板包含子路径（如 `/proxy/{{port}}/`）

## 安装

```bash
# 从 vsix 安装
code --install-extension vscode-proxy-toolkit-0.0.1.vsix
```

## 使用

1. 在端口面板中右键点击端口
2. 选择代理策略：
   - **Enable Subpath Mode** - 标准子路径修正
   - **Enable Tunnel Mode** - HTTP 隧道透传
   - **Enable Hybrid Mode** - 智能混合模式
   - **Disable Proxy** - 禁用 SW

## 代理策略

| 策略 | 适用场景 |
|-----|---------|
| Subpath | 标准反向代理，路径前缀修正 |
| Tunnel | 复杂代理环境，完整请求透传 |
| Hybrid | `%2F` 被额外解码的环境 |

## License

MIT
