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

// 通过对比路径差异提取端口号
function extractPortFromScope(scope) {
    const scriptUrl = new URL(self.location.href);
    const scriptPath = scriptUrl.pathname.replace('/tunnel_service_worker.js', '');
    
    // 分割路径为数组
    const scriptParts = scriptPath.split('/').filter(p => p !== '');
    const scopeParts = scope.split('/').filter(p => p !== '');
    
    // 检查路径长度是否相同
    if (scriptParts.length !== scopeParts.length) {
        console.error('[Tunnel SW] 路径结构不匹配');
        return null;
    }
    
    // 找出唯一的差异
    let differenceIndex = -1;
    let differenceCount = 0;
    
    for (let i = 0; i < scriptParts.length; i++) {
        if (scriptParts[i] !== scopeParts[i]) {
            differenceIndex = i;
            differenceCount++;
        }
    }
    
    // 应该只有一个差异
    if (differenceCount !== 1) {
        console.error(`[Tunnel SW] 预期只有一个差异，实际发现${differenceCount}个`);
        return null;
    }
    
    // 验证差异是端口号
    const scopePort = parseInt(scopeParts[differenceIndex]);
    
    if (isNaN(scopePort) || scopePort <= 0 || scopePort > 65535) {
        console.error('[Tunnel SW] 差异不是有效的端口号');
        return null;
    }
    
    return scopePort;
}

// 检测是否包含编码字符
function hasEncodedChars(str) {
    return /%[0-9A-Fa-f]{2}/.test(str);
}

// 计算最长公共路径段
function longestCommonPathSegments(path1, path2) {
    if (path1 === path2) {
        return path1;
    }
    
    // 分割为路径段，过滤空字符串
    const segments1 = path1.split('/').filter(s => s !== '');
    const segments2 = path2.split('/').filter(s => s !== '');
    
    // 逐段比对
    let commonSegments = [];
    const minLength = Math.min(segments1.length, segments2.length);
    
    for (let i = 0; i < minLength; i++) {
        if (segments1[i] === segments2[i]) {
            commonSegments.push(segments1[i]);
        } else {
            break; // 一旦有段不匹配就停止
        }
    }
    
    // 重建路径
    if (commonSegments.length === 0) {
        return '/';
    }
    
    const result = '/' + commonSegments.join('/');
    
    // 如果原路径以/结尾且所有段都匹配，保持这个格式
    if (path1.endsWith('/') && commonSegments.length === segments1.length) {
        return result + '/';
    }
    
    return result;
}



// ==================== Service Worker 事件处理 ====================
self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    // 导航请求不处理 - 最优先判断
    if (event.request.mode === 'navigate') {
        return; // 直接放行
    }
    
    // 复用URL对象，避免重复创建
    const url = new URL(event.request.url);
    
    // 跨域请求不处理
    if (url.host !== self.location.host) {
        return; // 直接放行
    }
    
    // 避免隧道请求自己调用自己
    if (url.href === API_URL || url.pathname.endsWith('/api/http-tunnel')) {
        return; // 直接放行
    }
    
    const pathname = url.pathname;
    
    // 计算最长公共路径段（复用这个结果）
    const commonPath = longestCommonPathSegments(scope, pathname);
    
    // 条件1: 路径不完整（缺少子路径前缀）
    const pathIncomplete = commonPath !== scope;
    
    // 条件2: 路径中包含编码字符
    const hasEncoding = hasEncodedChars(pathname);
    
    // 只有满足以下条件之一才使用隧道：
    // 1. 路径不完整，需要补全子路径
    // 2. 路径包含编码字符，可能被nginx错误处理
    const needsTunnel = pathIncomplete || hasEncoding;
    
    if (!needsTunnel) {
        return; // 不需要隧道的请求直接放行
    }
    
    // 提前计算端口号，避免在异步函数中处理错误
    const port = extractPortFromScope(scope);
    if (!port) {
        console.error('[Tunnel SW] 无法从scope中提取端口号，降级处理');
        return; // 直接放行，让浏览器处理
    }
    
    // 提前构建目标URL（所有依赖都是同步的）
    let targetPath = pathname;
    
    // 复用之前计算的commonPath结果
    if (pathIncomplete) {
        // 路径不完整，需要补全子路径后再去除
        targetPath = targetPath.replace(commonPath, scope);
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
    
    // 构建完整的目标URL（复用url对象）
    const targetUrl = `http://localhost:${port}${targetPath}${url.search}${url.hash}`;
    
    // 提前定义常量
    const optionalProps = ['mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive'];
    
    // 提前构建请求对象的基础部分（所有同步操作）
    const packedRequest = {
        method: event.request.method,
        url: targetUrl,
        headers: Object.fromEntries(event.request.headers.entries())
    };
    
    // 添加可选属性
    for (const prop of optionalProps) {
        if (event.request[prop] !== undefined) {
            packedRequest[prop] = event.request[prop];
        }
    }
    
    event.respondWith((async () => {
        // 处理请求体
        if (event.request.body) {
            try {
                const arrayBuffer = await event.request.arrayBuffer();
                const body = Array.from(new Uint8Array(arrayBuffer));
                // 直接添加到已构建的对象上
                packedRequest.body = body;
            } catch (error) {
                console.warn('[Tunnel SW] 请求体读取失败:', error);
                // 继续处理，不添加body属性
            }
        }
        
        try {
            // 发送到隧道端点
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
            
            // 解包响应
            const responseData = await tunnelResponse.json();
            
            if (responseData.error) {
                throw new Error(`隧道处理错误: ${responseData.error}`);
            }
            
            // 解包响应数据
            const responseBody = responseData.body ? new Uint8Array(responseData.body).buffer : null;
            
            return new Response(responseBody, {
                status: responseData.status,
                statusText: responseData.statusText,
                headers: new Headers(responseData.headers)
            });
            
        } catch (error) {
            console.error('[Tunnel SW] 隧道请求失败:', error);
            
            // 降级处理：直接转发原始请求
            return fetch(event.request);
        }
    })());
});

