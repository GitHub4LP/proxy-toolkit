// 统一Service Worker - 支持子路径修复和HTTP隧道两种策略
// 参数格式: mode=<strategy><depth><loop>
// 示例: mode=s2u (subpath, decode_depth=2, url_param), mode=t (tunnel)

const scriptUrl = new URL(self.location.href);
const mode = scriptUrl.searchParams.get('mode') || 's0u';
const scope = new URL(self.registration.scope).pathname;

let strategy, decodeDepth = 0, loopStrategy = 'url_param';

if (mode.startsWith('s')) {
    strategy = 'subpath';
    
    if (mode.length >= 2) {
        const depthChar = mode[1];
        decodeDepth = parseInt(depthChar) || 0;
    }
    
    if (mode.length >= 3) {
        const loopChar = mode[2];
        loopStrategy = loopChar === 'm' ? 'memory_set' : 'url_param';
    }
} else if (mode.startsWith('t')) {
    strategy = 'tunnel';
} else {
    strategy = 'subpath';
}

console.log(`[SW] Mode: ${mode}, Strategy: ${strategy}, Depth: ${decodeDepth}, Loop: ${loopStrategy}`);

// ==================== 通用工具函数 ====================

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

function selectiveMultiEncodePath(pathname) {
    try {
        const segments = pathname.split('/');
        
        const encodedSegments = segments.map(segment => {
            if (decodeDepth > 0 && hasEncodedChars(segment)) {
                let encoded = segment;
                for (let i = 0; i < decodeDepth; i++) {
                    encoded = encodeURIComponent(encoded);
                }
                return encoded;
            }
            return segment;
        });
        
        return encodedSegments.join('/');
    } catch (error) {
        console.warn('[Subpath SW] Path encoding error:', error);
        return pathname;
    }
}

function copyProperties(source, target, properties) {
    for (const prop of properties) {
        if (source[prop] !== undefined) {
            target[prop] = source[prop];
        }
    }
}

const SubpathHandler = {
    LoopStrategies: {
        url_param: {
            isProcessed(url) {
                return new URL(url).searchParams.has('_sw');
            },
            
            addMark(url) {
                const urlObj = new URL(url);
                urlObj.searchParams.set('_sw', '');
                return urlObj.toString();
            },
            
            removeMark(event) {
                const request = event.request;
                const urlObj = new URL(request.url);
                urlObj.searchParams.delete('_sw');
                const cleanUrl = urlObj.toString();
                const finalUrl = cleanUrl.endsWith('?') ? cleanUrl.slice(0, -1) : cleanUrl;
                
                const requestProps = ['method', 'headers', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive'];
                const requestInit = {};
                
                if (request.body) {
                    requestInit.body = request.body;
                    requestInit.duplex = 'half';
                }
                
                copyProperties(request, requestInit, requestProps);
                event.respondWith(fetch(new Request(finalUrl, requestInit)));
            }
        },
        
        memory_set: {
            _cache: new Set(),
            
            isProcessed(url) {
                return this._cache.has(url);
            },
            
            addMark(url) {
                this._cache.add(url);
                return url;
            },
            
            removeMark(event) {
                this._cache.delete(event.request.url);
            }
        }
    },

    handleFetch(event) {
        const url = new URL(event.request.url);
        const strategy = this.LoopStrategies[loopStrategy];

        if (strategy.isProcessed(event.request.url)) {
            strategy.removeMark(event);
            return;
        }

        let finalPathname = url.pathname;
        let needsProcessing = false;
        
        if (decodeDepth > 0 && hasEncodedChars(finalPathname)) {
            finalPathname = selectiveMultiEncodePath(finalPathname);
            needsProcessing = true;
        }
        
        const commonPath = longestCommonPathSegments(scope, finalPathname);
        if (commonPath !== scope) {
            finalPathname = finalPathname.replace(commonPath, scope);
            needsProcessing = true;
        }
        
        if (needsProcessing) {
            url.pathname = finalPathname;
            const markedUrl = strategy.addMark(url.href);
            event.respondWith(Response.redirect(markedUrl, 307));
        }
    }
};

const TunnelHandler = {
    handleFetch(event) {
        const url = new URL(event.request.url);
        const scriptPath = scriptUrl.pathname.replace('/unified_service_worker.js', '');
        const API_URL = scriptUrl.origin + scriptPath + '/api/http-tunnel';
        
        if (url.href === API_URL || url.pathname.endsWith('/api/http-tunnel')) {
            return;
        }
        
        const pathname = url.pathname;
        const commonPath = longestCommonPathSegments(scope, pathname);
        const pathIncomplete = commonPath !== scope;
        
        if (!pathIncomplete && !hasEncodedChars(pathname)) {
            return;
        }
        const scriptParts = scriptPath.split('/').filter(p => p !== '');
        const scopeParts = scope.split('/').filter(p => p !== '');
        
        if (scriptParts.length !== scopeParts.length) {
            console.error('[Tunnel SW] 路径结构不匹配');
            return;
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
            return;
        }
        
        const port = parseInt(scopeParts[differenceIndex]);
        
        if (isNaN(port) || port <= 0 || port > 65535) {
            console.error('[Tunnel SW] 差异不是有效的端口号');
            return;
        }
        
        let targetPath = pathIncomplete ? pathname.replace(commonPath, scope) : pathname;
        
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
        
        copyProperties(event.request, packedRequest, optionalProps);
        
        event.respondWith((async () => {
            if (event.request.body) {
                try {
                    const arrayBuffer = await event.request.arrayBuffer();
                    packedRequest.body = Array.from(new Uint8Array(arrayBuffer));
                } catch (error) {
                    console.warn('[Tunnel SW] 请求体读取失败:', error);
                }
            }
            
            try {
                const tunnelResponse = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
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
    }
};

let NAVIGATION_INTERCEPTOR_CONTENT = '';

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            try {
                const interceptorUrl = new URL('./navigation_interceptor.js', scriptUrl.href).href;
                console.log(`[SW] Loading interceptor from:`, interceptorUrl);
                
                const response = await fetch(interceptorUrl);
                if (response.ok) {
                    NAVIGATION_INTERCEPTOR_CONTENT = await response.text();
                } else {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
            } catch (error) {
                console.error(`[SW] Failed to load navigation interceptor:`, error);
                throw error;
            }
            await self.skipWaiting();
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'FORCE_NAVIGATE_ALL_CLIENTS') {
        console.log(`[SW] 收到强制刷新指令`);
        
        self.clients.matchAll({
            includeUncontrolled: false,
            type: 'window'
        }).then(clients => {
            console.log(`[SW] 强制刷新 ${clients.length} 个客户端`);
            
            clients.forEach(client => {
                client.navigate(client.url).catch(() => {});
            });
        }).catch(() => {});
    }
});

self.addEventListener('fetch', event => {
    const urlStr = event.request.url;
    if (!(urlStr.startsWith('http://') || urlStr.startsWith('https://'))) {
        return;
    }
    try {
        const u = new URL(urlStr);
        if (u.origin !== self.location.origin) {
            return;
        }
    } catch {
        return;
    }
    
    if (event.request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const response = await fetch(event.request);
                
                if (!response.ok) {
                    return response;
                }
                
                const contentType = response.headers.get('content-type') || '';
                if (!contentType.includes('text/html')) {
                    return response;
                }
                
                return await injectNavigationInterceptor(response, event.request);
                
            } catch (error) {
                console.error(`[SW] Navigation request failed:`, error);
                return fetch(event.request);
            }
        })());
        return;
    }

    if (strategy === 'tunnel') {
        TunnelHandler.handleFetch(event);
    } else {
        SubpathHandler.handleFetch(event);
    }
});



async function injectNavigationInterceptor(response, request) {
    try {
        const htmlText = await response.text();
        
        const scriptTag = `<script>
window._NavigationInterceptorConfig = { scopeBase: '${scope}' };
${NAVIGATION_INTERCEPTOR_CONTENT}
</script>`;
        
        let modifiedHTML;
        
        const headMatch = htmlText.match(/<head(\s[^>]*)?>/) || htmlText.match(/<head>/);
        if (headMatch) {
            const insertPos = headMatch.index + headMatch[0].length;
            modifiedHTML = htmlText.slice(0, insertPos) + scriptTag + htmlText.slice(insertPos);
        }
        else if (htmlText.match(/<html(\s[^>]*)?>/) || htmlText.match(/<html>/)) {
            const htmlMatch = htmlText.match(/<html(\s[^>]*)?>/) || htmlText.match(/<html>/);
            const insertPos = htmlMatch.index + htmlMatch[0].length;
            const headSection = `<head>${scriptTag}</head>`;
            modifiedHTML = htmlText.slice(0, insertPos) + headSection + htmlText.slice(insertPos);
        }
        else {
            const navPath = new URL(request.url).pathname;
            console.warn(`[SW] Invalid HTML structure, navigation interceptor not injected for: ${navPath}`);
            return response;
        }
        
        return new Response(modifiedHTML, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
        
    } catch (error) {
        console.error(`[SW] Failed to inject navigation interceptor:`, error);
        return response;
    }
}

console.log(`[SW] Initialized with mode: ${mode}`);