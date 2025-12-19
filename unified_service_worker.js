// Service Worker: subpath 修复与 tunnel 透传（动态配置）

const scriptUrl = new URL(self.location.href);
const scope = new URL(self.registration.scope).pathname;

// 默认策略：none（不处理任何请求）
let strategy = 'none';
let decodeDepth = 0;
let slashExtraDecoding = false;

// 工具函数

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
    _cache: new Set(),

    handleFetch(event) {
        const url = new URL(event.request.url);
        const cache = this._cache;

        if (cache.has(event.request.url)) {
            cache.delete(event.request.url);
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
            this._cache.add(url.href);
            event.respondWith(Response.redirect(url.href, 307));
        }
    }
};

const TunnelHandler = {
    handleFetch(event) {
        const url = new URL(event.request.url);

        // 跳过自身 API
        if (url.pathname.endsWith('/api/http-tunnel') || url.pathname.includes('/api/http-tunnel/')) {
            return;
        }

        // 判断是否需要处理（子路径不完整或包含编码字符）
        const pathname = url.pathname;
        const commonPath = longestCommonPathSegments(scope, pathname);
        const pathIncomplete = commonPath !== scope;

        if (!pathIncomplete && !hasEncodedChars(pathname)) {
            return;
        }

        // 仅在需要时再计算脚本与作用域分段
        const scriptPath = scriptUrl.pathname.replace('/unified_service_worker.js', '');
        const scriptParts = scriptPath.split('/').filter(p => p !== '');
        const scopeParts = scope.split('/').filter(p => p !== '');

        // 校验脚本路径与作用域结构一致
        if (scriptParts.length !== scopeParts.length) {
            console.error('[Tunnel SW] 路径结构不匹配');
            return;
        }

        // 找出 scope 与 scriptPath 的差异段，应该只有端口号
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

        // 计算目标路径：补全子路径不完整后，裁剪掉 scope 前缀得到余路径
        let finalPath = pathIncomplete ? pathname.replace(commonPath, scope) : pathname;

        let remainder;
        if (scope.endsWith('/')) {
            remainder = finalPath.substring(scope.length - 1);
        } else {
            remainder = finalPath.substring(scope.length);
            if (!remainder.startsWith('/')) {
                remainder = '/' + remainder;
            }
        }

        // 构造路径隧道 URL（暂不考虑反向代理层对参数的解码）
        const apiBase = scriptUrl.origin + scriptPath + `/api/http-tunnel/${port}`;
        const uParam = encodeURIComponent(remainder + url.search);
        const proxyUrl = `${apiBase}?u=${uParam}`;

        const optionalProps = ['credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive'];
        const init = {
            method: event.request.method,
            headers: new Headers(event.request.headers)
        };
        copyProperties(event.request, init, optionalProps);

        event.respondWith((async () => {
            try {
                if (event.request.body && event.request.method !== 'GET' && event.request.method !== 'HEAD') {
                    try {
                        const arrayBuffer = await event.request.arrayBuffer();
                        init.body = arrayBuffer;
                    } catch (error) {
                        console.warn('[Tunnel SW] 请求体读取失败:', error);
                    }
                }
                return await fetch(proxyUrl, init);
            } catch (error) {
                console.error('[Tunnel SW] 隧道请求失败，回退原始请求:', error);
                return fetch(event.request);
            }
        })());
    }
};

/* removed legacy JSON tunnel handler */

let NAVIGATION_INTERCEPTOR_CONTENT = '';

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            try {
                const interceptorUrl = new URL('./navigation_interceptor.js', scriptUrl.href).href;
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
    if (event.data && event.data.type === 'CONFIGURE') {
        // 配置 SW 策略
        const oldStrategy = strategy;
        const oldDepth = decodeDepth;
        const oldSlashExtra = slashExtraDecoding;
        const newStrategy = event.data.data.strategy || 'none';
        const newDepth = event.data.data.decodeDepth || 0;
        const newSlashExtra = event.data.data.slashExtraDecoding || false;
        
        // 检查策略是否真的改变了
        if (oldStrategy === newStrategy && oldDepth === newDepth && oldSlashExtra === newSlashExtra) {
            // 策略未改变，静默返回
            return;
        }
        
        // 更新策略
        strategy = newStrategy;
        decodeDepth = newDepth;
        slashExtraDecoding = newSlashExtra;
        
        // 策略变更后自动刷新所有客户端
        self.clients.matchAll({
            includeUncontrolled: true,
            type: 'window'
        }).then(clients => {
            clients.forEach(client => {
                client.navigate(client.url).catch(() => {});
            });
        }).catch(() => {});
    }
});

self.addEventListener('fetch', event => {
    // 如果策略是 none，不处理任何请求
    if (strategy === 'none') {
        return;
    }
    
    const urlStr = event.request.url;
    if (!(urlStr.startsWith('http://') || urlStr.startsWith('https://'))) {
        return;
    }
    if (new URL(urlStr).origin !== self.location.origin) {
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
    } else if (strategy === 'subpath') {
        SubpathHandler.handleFetch(event);
    } else if (strategy === 'hybrid') {
        // Hybrid 策略：智能路由
        const url = new URL(event.request.url);
        const pathname = url.pathname;
        
        // 只有当检测到 %2F 被额外解码，且路径包含 %2F 时，才走 tunnel
        if (slashExtraDecoding && /%2F/i.test(pathname)) {
            console.log(`[SW Hybrid] %2F detected, using tunnel: ${pathname}`);
            TunnelHandler.handleFetch(event);
        } else {
            SubpathHandler.handleFetch(event);
        }
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