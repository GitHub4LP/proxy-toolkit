# 端口管理服务 (Proxy Toolkit)

一个智能的端口监听状态管理工具，专为复杂网络环境设计，支持自动环境检测、Service Worker代理管理和nginx解码深度检测。

## 核心特性

### 🔍 智能环境检测
- **自动识别运行环境**: JupyterHub、AI Studio、Code Server等
- **代理URL自动生成**: 根据环境自动生成正确的代理访问链接
- **nginx解码深度检测**: 自动检测nginx URL解码配置，确保代理正常工作

### 🖥️ 端口监控管理
- **实时端口检测**: 自动检测系统端口监听状态
- **进程信息展示**: 显示端口对应的进程PID和完整命令行
- **自动添加端口**: 输入端口号1秒后自动添加到监控列表
- **跨平台支持**: 支持Linux/macOS/Windows系统

### 🔧 Service Worker代理
- **一键注册/注销**: 通过Web界面管理subpath_service_worker.js
- **智能编码处理**: 根据nginx解码深度自动处理URL编码问题
- **状态可视化**: 直观的图标显示Service Worker运行状态
- **子路径支持**: 完美解决子路径环境下的跨域和代理问题

## 项目架构

### 核心模块

#### 1. **server.py** - 主服务器
- **基于aiohttp**: 异步Web服务器，高性能处理请求
- **端口信息管理**: 缓存和更新端口状态信息
- **nginx解码检测**: 提供解码深度检测API端点
- **Service Worker服务**: 动态生成配置化的Service Worker脚本

#### 2. **port_proxy.py** - 环境检测与代理生成
- **多环境支持**: 
  - JupyterLab代理检测 (`check_jupyter_proxy`)
  - Code Server代理检测 (`check_code_server_proxy`)
  - AI Studio配置管理 (`AIStudioConfigManager`)
- **智能URL生成**: 根据检测到的环境生成最优代理URL
- **配置文件管理**: 自动更新AI Studio的 `~/.webide/proxy_config.json`

#### 3. **subpath_service_worker.js** - 代理核心
- **模板化配置**: 支持动态nginx解码深度配置
- **智能URL处理**: 
  - 多层编码检测和处理
  - 路径匹配和重定向
  - 选择性编码处理
- **跨域支持**: 处理跨域资源访问

#### 4. **static/** - 前端界面
- **app.js**: 
  - nginx解码深度自动检测算法
  - Service Worker状态管理
  - 实时端口监控和展示
- **index.html**: 简洁的表格化界面
- **style.css**: 响应式设计，支持移动端

#### 5. **main.gradio.py** - Gradio环境启动器
- **环境变量驱动**: 通过 `GRADIO_SERVER_PORT` 确定端口
- **自动依赖安装**: 检测并安装必要的Python包
- **一键启动**: 专为Gradio环境优化的启动脚本

### 关键算法

#### nginx解码深度检测
```javascript
// 前端发送5层编码的测试路径
generateTestPath(basePath, layer) {
    let encodedSlash = "%2F";
    for (let i = 1; i < layer; i++) {
        encodedSlash = encodedSlash.replace(/%/g, "%25");
    }
    return `${basePath}test${encodedSlash}path`;
}

// 通过逐步解码匹配来判断nginx解码了多少层
calculateDecodeDepth(path) {
    const originalEncoded = "test%252525252Fpath"; // 5层编码
    let currentPath = originalEncoded;
    let decodeSteps = 0;
    
    for (let i = 0; i < 5; i++) {
        if (currentPath === path) {
            return decodeSteps;
        }
        currentPath = decodeURIComponent(currentPath);
        decodeSteps++;
    }
    
    return decodeSteps;
}
```

#### 环境自动检测
```python
def detect_service_config():
    # 通过进程扫描检测运行的服务
    # 根据命令行特征识别JupyterLab、Code Server等
    # 返回子路径最短的URL模板
    return min(url_templates, key=get_path_length)
```

## API接口

### RESTful API
```
GET  /                                    # 主界面
GET  /api/ports                          # 获取所有端口信息
GET  /api/port/{port}                    # 获取指定端口信息
GET  /api/test-encoding/{path:.*}        # nginx解码深度检测
GET  /subpath_service_worker.js          # Service Worker脚本
GET  /static/*                           # 静态资源
```

### 数据结构
```python
class PortInfo:
    port: int                    # 端口号
    is_listening: bool          # 是否监听
    process_name: str           # 进程名
    process_pid: int            # 进程PID  
    process_cmdline: str        # 完整命令行
    proxy_url: str              # 代理访问URL
```

## 使用方式

### 标准启动
```bash
# 自动检测环境并启动
python server.py

# 指定端口启动
python server.py --port 8080
```

### Gradio环境启动
```bash
# 使用默认端口7860
python main.gradio.py

# 使用环境变量指定端口
GRADIO_SERVER_PORT=8080 python main.gradio.py
```

### 依赖安装
```bash
# 手动安装依赖
pip install -r requirements.txt

# main.gradio.py会自动安装依赖
```