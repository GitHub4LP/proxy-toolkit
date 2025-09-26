// HTTP隧道Service Worker
// 通过将原始HTTP请求完整打包，绕过nginx的URL解码限制

const scope = new URL(self.registration.scope).pathname;

// 构建API端点URL - 基于Service Worker脚本位置
function buildApiUrl() {
    const scriptUrl = new URL(self.location.href);
    const basePath = scriptUrl.pathname.replace('/tunnel_service_worker.js', '');
    const apiPath = basePath + '/api/http-tunnel';
    return scriptUrl.origin + apiPath;
}

const API_URL = buildApiUrl();

// ==================== 工具函数 ====================

// 从scope中提取端口号
function extractPortFromScope(scope) {
    // 从 /proxy/8080/ 或类似格式中提取端口号
    const match = scope.match(/\/proxy\/(\d+)\//);
    return match ? parseInt(match[1]) : null;
}

// 检测是否包含编码字符
function hasEncodedChars(str) {
    return /%[0-9A-Fa-f]{2}/.test(str);
}

// 计算最长公共前缀
function longestCommonPrefix(str1, str2) {
    if (str1 === str2) {
        return str1;
    }
    let minLength = Math.min(str1.length, str2.length);
    let prefix = [];
    for (let i = 0; i < minLength; i++) {
        if (str1[i] === str2[i]) {
            prefix.push(str1[i]);
        } else {
            break;
        }
    }
    return prefix.join('');
}

// 构建目标URL（去除子路径前缀）
function buildTargetUrl(originalUrl, scope) {
    const url = new URL(originalUrl);
    const port = extractPortFromScope(scope);
    
    if (!port) {
        throw new Error('无法从scope中提取端口号');
    }
    
    let targetPath = url.pathname;
    const lcp = longestCommonPrefix(scope, targetPath);
    
    if (lcp !== scope) {
        // 路径不完整，需要补全子路径后再去除
        // 例如（假设scope="/jupyter/proxy/8080/"）：
        // 1. /api/data (lcp="/") -> /jupyter/proxy/8080/api/data -> /api/data
        // 2. /jupyter/api/data (lcp="/jupyter/") -> /jupyter/proxy/8080/api/data -> /api/data  
        // 3. /jupyter/proxy/api/data (lcp="/jupyter/proxy/") -> /jupyter/proxy/8080/api/data -> /api/data
        targetPath = targetPath.replace(lcp, scope);
    }
    
    // 现在targetPath一定以scope开头，根据scope格式去除子路径前缀
    if (scope.endsWith('/')) {
        // scope以/结尾，如 "/jupyter/proxy/8080/"
        // 移除scope但保留一个前导斜杠
        targetPath = targetPath.substring(scope.length - 1);
    } else {
        // scope不以/结尾，如 "/jupyter/proxy/8080"
        // 完全移除scope，然后确保有前导斜杠
        targetPath = targetPath.substring(scope.length);
        if (!targetPath.startsWith('/')) {
            targetPath = '/' + targetPath;
        }
    }
    
    // 构建完整的目标URL
    return `http://localhost:${port}${targetPath}${url.search}${url.hash}`;
}

// 判断是否需要隧道处理
function shouldTunnel(request) {
    const url = new URL(request.url);
    
    // 跨域请求不处理
    if (url.host !== self.location.host) {
        return false;
    }
    
    // 避免隧道请求自己调用自己
    if (url.href === API_URL || url.pathname.endsWith('/api/http-tunnel')) {
        return false;
    }
    
    // 导航请求不处理
    if (request.mode === 'navigate') {
        return false;
    }
    
    const pathname = url.pathname;
    
    // 计算最长公共前缀
    const lcp = longestCommonPrefix(scope, pathname);
    
    // 条件1: 路径不完整（缺少子路径前缀）
    const pathIncomplete = lcp !== scope;
    
    // 条件2: 路径中包含编码字符
    const hasEncoding = hasEncodedChars(pathname);
    
    // 只有满足以下条件之一才使用隧道：
    // 1. 路径不完整，需要补全子路径
    // 2. 路径包含编码字符，可能被nginx错误处理
    const needsTunnel = pathIncomplete || hasEncoding;
    

    
    return needsTunnel;
}

// 打包原始请求
async function packRequest(request) {
    let body = null;
    
    // 处理请求体
    if (request.body) {
        try {
            const arrayBuffer = await request.arrayBuffer();
            body = Array.from(new Uint8Array(arrayBuffer));
        } catch (error) {
            console.warn('[Tunnel SW] 请求体读取失败:', error);
            body = null;
        }
    }
    
    // 构建目标URL（去除子路径前缀）
    const targetUrl = buildTargetUrl(request.url, scope);
    
    // 构建请求对象，只包含必需的基础属性
    const packedRequest = {
        method: request.method,
        url: targetUrl,  // 使用转换后的目标URL
        headers: Object.fromEntries(request.headers.entries())
    };
    
    // 动态添加body（只有存在时才添加）
    if (body !== null) {
        packedRequest.body = body;
    }
    
    // 动态添加其他存在的属性
    const optionalProps = ['mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive'];
    
    for (const prop of optionalProps) {
        if (request[prop] !== undefined) {
            packedRequest[prop] = request[prop];
        }
    }
    
    return packedRequest;
}

// 解包响应数据
function unpackResponse(responseData) {
    let body = null;
    
    if (responseData.body) {
        body = new Uint8Array(responseData.body).buffer;
    }
    
    return new Response(body, {
        status: responseData.status,
        statusText: responseData.statusText,
        headers: new Headers(responseData.headers)
    });
}

// 执行隧道请求
async function tunnelRequest(originalRequest) {
    try {
        // 1. 打包原始请求
        const packedRequest = await packRequest(originalRequest);
        
        // 2. 发送到隧道端点
        const tunnelResponse = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(packedRequest)
        });
        
        if (!tunnelResponse.ok) {
            throw new Error(`隧道请求失败: ${tunnelResponse.status} ${tunnelResponse.statusText}`);
        }
        
        // 3. 解包响应
        const responseData = await tunnelResponse.json();
        
        if (responseData.error) {
            throw new Error(`隧道处理错误: ${responseData.error}`);
        }
        
        return unpackResponse(responseData);
        
    } catch (error) {
        console.error('[Tunnel SW] 隧道请求失败:', error);
        
        // 降级处理：直接转发原始请求
        return fetch(originalRequest);
    }
}

// ==================== Service Worker 事件处理 ====================
self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    if (shouldTunnel(event.request)) {
        event.respondWith(tunnelRequest(event.request));
    }
    // 不需要隧道的请求直接放行
});

