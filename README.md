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
- **双策略支持**: 子路径修复和HTTP隧道两种代理策略
- **一键注册/注销**: 通过Web界面管理Service Worker
- **智能编码处理**: 根据nginx解码深度自动处理URL编码问题
- **HTTP隧道**: 完全绕过nginx限制，支持任意HTTP请求透传
- **状态可视化**: 直观的图标显示Service Worker运行状态
- **子路径支持**: 完美解决子路径环境下的跨域和代理问题

## 项目架构

### 核心模块

#### 1. **server.py** - 主服务器
- **基于aiohttp**: 异步Web服务器，高性能处理请求
- **端口信息管理**: 缓存和更新端口状态信息
- **nginx解码检测**: 提供解码深度检测API端点
- **Service Worker服务**: 动态生成配置化的Service Worker脚本
- **HTTP隧道端点**: 提供`/api/http-tunnel`接口，支持完整HTTP请求透传

#### 2. **port_proxy.py** - 环境检测与代理生成
- **多环境支持**: 
  - JupyterLab代理检测 (`check_jupyter_proxy`)
  - Code Server代理检测 (`check_code_server_proxy`)
  - AI Studio配置管理 (`AIStudioConfigManager`)
- **智能URL生成**: 根据检测到的环境生成最优代理URL
- **配置文件管理**: 自动更新AI Studio的 `~/.webide/proxy_config.json`

#### 3. **subpath_service_worker.js** - 子路径修复代理
- **核心问题**: 修复未考虑子路径运行的服务，补全缺失的子路径前缀
- **路径补全**: 通过`lcp !== scope`检测不完整路径并自动补全子路径
- **模板化配置**: 支持动态nginx解码深度配置
- **智能URL处理**: 
  - 多层编码检测和处理
  - 路径匹配和重定向
  - 选择性编码处理
- **跨域支持**: 处理跨域资源访问

#### 4. **tunnel_service_worker.js** - HTTP隧道代理
- **完整HTTP封装**: 将浏览器请求完整序列化为JSON格式
- **透明代理**: 通过`/api/http-tunnel`端点转发所有HTTP请求
- **绕过nginx限制**: 完全避开nginx URL解码问题
- **请求重构**: 在后端重新构建原始HTTP请求并转发
- **响应透传**: 保持HTTP状态码、头部和内容的完整性

#### 5. **static/** - 前端界面
- **app.js**: 
  - nginx解码深度自动检测算法
  - Service Worker状态管理和策略切换
  - 实时端口监控和展示
  - 双策略支持（子路径修复/HTTP隧道）
- **index.html**: 简洁的表格化界面，包含策略选择列
- **style.css**: 响应式设计，支持移动端

#### 6. **main.gradio.py** - Gradio环境启动器
- **环境变量驱动**: 通过 `GRADIO_SERVER_PORT` 确定端口
- **自动依赖安装**: 检测并安装必要的Python包
- **一键启动**: 专为Gradio环境优化的启动脚本

### 关键算法

#### HTTP隧道请求封装
```javascript
// 将浏览器Request对象完整序列化
async function packRequest(request) {
    const headers = {};
    for (const [key, value] of request.headers.entries()) {
        headers[key] = value;
    }
    
    let body = null;
    if (request.body) {
        const arrayBuffer = await request.arrayBuffer();
        body = Array.from(new Uint8Array(arrayBuffer));
    }
    
    return {
        method: request.method,
        url: request.url,
        headers: headers,
        body: body
    };
}

// 从后端响应重构Response对象
function unpackResponse(data) {
    let body = null;
    if (data.body) {
        body = new Uint8Array(data.body).buffer;
    }
    
    return new Response(body, {
        status: data.status,
        statusText: data.statusText,
        headers: data.headers
    });
}
```

#### nginx解码深度检测
```javascript
// 自动检测nginx URL解码深度
async detectNginxEncoding() {
    const testSegment = "test/path";  // 原始测试路径段
    const maxLayers = 5;  // 最大检测层数
    
    // 生成多层编码的测试路径
    let encodedSegment = testSegment;
    for (let i = 0; i < maxLayers; i++) {
        encodedSegment = encodeURIComponent(encodedSegment);
    }
    
    // 发送检测请求
    const response = await fetch(`/api/test-encoding/${encodedSegment}`);
    const result = await response.json();
    
    // 计算nginx解码深度：从收到的路径开始解码，看需要多少步回到原始字符串
    let current = result.path;
    let steps = 0;
    
    if (current === testSegment) {
        return maxLayers; // nginx解码了所有层
    }
    
    while (current !== testSegment && steps < maxLayers) {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break; // 无法继续解码
        current = decoded;
        steps++;
    }
    
    // nginx解码深度 = 发送的总层数 - 还需要解码的步数
    return (current === testSegment) ? maxLayers - steps : 0;
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
POST /api/http-tunnel                    # HTTP隧道端点
GET  /subpath_service_worker.js          # 子路径修复Service Worker脚本
GET  /tunnel_service_worker.js           # HTTP隧道Service Worker脚本
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

## 代理策略对比

### 子路径修复策略 (subpath_service_worker.js)
**适用场景**: nginx只对特定字符（如%2F）进行解码的环境

**工作原理**:
- 检测nginx解码深度配置
- 对URL进行预编码处理，补偿nginx解码行为
- 适用于大部分标准nginx配置

**优势**:
- 性能开销小，直接修改URL
- 兼容性好，适用于大多数应用
- 配置简单，自动检测解码深度

**限制**:
- 依赖nginx解码行为的一致性
- 无法处理nginx完全不解码或过度解码的情况

### HTTP隧道策略 (tunnel_service_worker.js)
**适用场景**: nginx解码行为不可预测或存在特殊限制的环境

**工作原理**:
- 将完整HTTP请求序列化为JSON格式
- 通过`/api/http-tunnel`端点透传所有请求
- 在后端重新构建原始HTTP请求并转发
- 完全绕过nginx的URL处理逻辑

**优势**:
- 完全绕过nginx限制，100%兼容性
- 支持任意HTTP方法和复杂请求
- 不依赖nginx配置，适用于所有环境

**限制**:
- 性能开销较大，需要序列化/反序列化
- 增加网络传输量
- 对后端服务器要求更高

### 策略选择建议
- **默认推荐**: 子路径修复策略，适用于大多数场景
- **特殊环境**: 当子路径修复无法正常工作时，切换到HTTP隧道策略
- **动态切换**: 支持在Web界面中为每个端口独立选择策略

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