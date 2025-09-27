const scope = new URL(self.registration.scope).pathname;

function buildApiUrl() {
    const scriptUrl = new URL(self.location.href);
    const basePath = scriptUrl.pathname.replace('/tunnel_service_worker.js', '');
    const apiPath = basePath + '/api/http-tunnel';
    return scriptUrl.origin + apiPath;
}

const API_URL = buildApiUrl();

function extractPortFromScope(scope) {
    const scriptUrl = new URL(self.location.href);
    const scriptPath = scriptUrl.pathname.replace('/tunnel_service_worker.js', '');
    
    const scriptParts = scriptPath.split('/').filter(p => p !== '');
    const scopeParts = scope.split('/').filter(p => p !== '');
    
    if (scriptParts.length !== scopeParts.length) {
        console.error('[Tunnel SW] 路径结构不匹配');
        return null;
    }
    
    let differenceIndex = -1;
    let differenceCount = 0;
    
    for (let i = 0; i < scriptParts.length; i++) {
        if (scriptParts[i] !== scopeParts[i]) {
            differenceIndex = i;
            differenceCount++;
        }
    }
    
    if (differenceCount !== 1) {
        console.error(`[Tunnel SW] 预期只有一个差异，实际发现${differenceCount}个`);
        return null;
    }
    
    const scopePort = parseInt(scopeParts[differenceIndex]);
    
    if (isNaN(scopePort) || scopePort <= 0 || scopePort > 65535) {
        console.error('[Tunnel SW] 差异不是有效的端口号');
        return null;
    }
    
    return scopePort;
}

function hasEncodedChars(str) {
    return /%[0-9A-Fa-f]{2}/.test(str);
}

function longestCommonPathSegments(path1, path2) {
    if (path1 === path2) {
        return path1;
    }
    
    const segments1 = path1.split('/').filter(s => s !== '');
    const segments2 = path2.split('/').filter(s => s !== '');
    
    let commonSegments = [];
    const minLength = Math.min(segments1.length, segments2.length);
    
    for (let i = 0; i < minLength; i++) {
        if (segments1[i] === segments2[i]) {
            commonSegments.push(segments1[i]);
        } else {
            break;
        }
    }
    
    if (commonSegments.length === 0) {
        return '/';
    }
    
    const result = '/' + commonSegments.join('/');
    
    if (path1.endsWith('/') && commonSegments.length === segments1.length) {
        return result + '/';
    }
    
    return result;
}

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'FORCE_NAVIGATE_ALL_CLIENTS') {
        console.log('[Tunnel SW] 收到强制刷新指令');
        
        // 立即处理，不使用 async/await 避免被注销中断
        self.clients.matchAll({
            includeUncontrolled: false,
            type: 'window'
        }).then(clients => {
            console.log(`[Tunnel SW] 强制刷新 ${clients.length} 个客户端`);
            
            // 立即触发所有导航，不等待完成
            clients.forEach(client => {
                client.navigate(client.url).catch(error => {
                    console.warn(`[Tunnel SW] 导航失败: ${client.url}`, error);
                });
            });
        }).catch(error => {
            console.warn('[Tunnel SW] 获取客户端失败:', error);
        });
    }
});

self.addEventListener('fetch', event => {
    if (event.request.mode === 'navigate') {
        return;
    }
    
    const url = new URL(event.request.url);
    
    if (url.host !== self.location.host) {
        return;
    }
    
    if (url.href === API_URL || url.pathname.endsWith('/api/http-tunnel')) {
        return;
    }
    
    const pathname = url.pathname;
    const commonPath = longestCommonPathSegments(scope, pathname);
    const pathIncomplete = commonPath !== scope;
    const hasEncoding = hasEncodedChars(pathname);
    const needsTunnel = pathIncomplete || hasEncoding;
    
    if (!needsTunnel) {
        return;
    }
    
    const port = extractPortFromScope(scope);
    if (!port) {
        console.error('[Tunnel SW] 无法从scope中提取端口号，降级处理');
        return;
    }
    
    let targetPath = pathname;
    
    if (pathIncomplete) {
        targetPath = targetPath.replace(commonPath, scope);
    }
    
    if (scope.endsWith('/')) {
        targetPath = targetPath.substring(scope.length - 1);
    } else {
        targetPath = targetPath.substring(scope.length);
        if (!targetPath.startsWith('/')) {
            targetPath = '/' + targetPath;
        }
    }
    
    const targetUrl = `http://localhost:${port}${targetPath}${url.search}${url.hash}`;
    const optionalProps = ['mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive'];
    
    const packedRequest = {
        method: event.request.method,
        url: targetUrl,
        headers: Object.fromEntries(event.request.headers.entries())
    };
    
    for (const prop of optionalProps) {
        if (event.request[prop] !== undefined) {
            packedRequest[prop] = event.request[prop];
        }
    }
    
    event.respondWith((async () => {
        if (event.request.body) {
            try {
                const arrayBuffer = await event.request.arrayBuffer();
                const body = Array.from(new Uint8Array(arrayBuffer));
                packedRequest.body = body;
            } catch (error) {
                console.warn('[Tunnel SW] 请求体读取失败:', error);
            }
        }
        
        try {
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
            
            const responseData = await tunnelResponse.json();
            
            if (responseData.error) {
                throw new Error(`隧道处理错误: ${responseData.error}`);
            }
            
            const responseBody = responseData.body ? new Uint8Array(responseData.body).buffer : null;
            
            return new Response(responseBody, {
                status: responseData.status,
                statusText: responseData.statusText,
                headers: new Headers(responseData.headers)
            });
            
        } catch (error) {
            console.error('[Tunnel SW] 隧道请求失败:', error);
            return fetch(event.request);
        }
    })());
});

