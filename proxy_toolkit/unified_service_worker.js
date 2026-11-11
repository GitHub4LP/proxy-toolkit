// Service Worker: subpath 修复与 tunnel 透传（动态配置）

const scriptUrl = new URL(self.location.href);
const scope = new URL(self.registration.scope).pathname;

// 默认策略：none（不处理任何请求）
let strategy = 'none';
let decodeDepth = 0;
let slashExtraDecoding = false;
let urlTemplate = '';

// 工具函数

function hasEncodedChars(str) {
    return /%[0-9A-Fa-f]{2}/.test(str);
}

// 从 scope 路径中用模板提取端口号
function extractPortFromScope(scopePath, template) {
    if (!template) return null;
    // 提取路径部分（模板可能是绝对 URL）
    let tplPath = template;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(template)) {
        try { tplPath = new URL(template).pathname; } catch (e) { return null; }
    }
    // 构造正则：转义特殊字符，{{port}} → (\d+)
    const escaped = tplPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace('\\{\\{port\\}\\}', '(\\d+)');
    const match = scopePath.match(new RegExp('^' + regexStr));
    if (match && match[1]) {
        const port = parseInt(match[1]);
        if (port > 0 && port <= 65535) return port;
    }
    return null;
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

// 预取缓存：307 重定向后的正确 URL → Promise<Response>
const _prefetchCache = new Map();

function startPrefetch(key, fetchFn) {
    const promise = fetchFn();
    _prefetchCache.set(key, promise);
    setTimeout(() => { if (_prefetchCache.has(key)) _prefetchCache.delete(key); }, 5000);
}

// 构造 fetch init（提取公共逻辑）
async function buildFetchInit(event) {
    const init = {
        method: event.request.method,
        headers: new Headers(event.request.headers),
        mode: event.request.mode,
        credentials: event.request.credentials,
        redirect: event.request.redirect
    };
    copyProperties(event.request, init, ['cache', 'integrity', 'keepalive', 'referrer', 'referrerPolicy']);
    if (event.request.body && event.request.method !== 'GET' && event.request.method !== 'HEAD') {
        init.body = await event.request.arrayBuffer();
    }
    return init;
}

const SubpathHandler = {
    handleFetch(event) {
        const url = new URL(event.request.url);

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

        if (!needsProcessing) return;

        url.pathname = finalPathname;
        const correctedUrl = url.href;

        startPrefetch(correctedUrl, async () => {
            const init = await buildFetchInit(event);
            return await fetch(correctedUrl, init);
        });

        event.respondWith(Response.redirect(correctedUrl, 307));
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

        // 用模板从 scope 提取端口号
        const port = extractPortFromScope(scope, urlTemplate);
        if (!port) {
            console.error('[Tunnel SW] 无法从 scope 提取端口号:', scope, urlTemplate);
            return;
        }

        // 计算修正路径（含编码修正）
        let finalPath = pathIncomplete ? pathname.replace(commonPath, scope) : pathname;
        if (decodeDepth > 0 && hasEncodedChars(finalPath)) {
            finalPath = selectiveMultiEncodePath(finalPath);
        }

        // 计算余路径（裁剪 scope 前缀）
        let remainder;
        if (scope.endsWith('/')) {
            remainder = finalPath.substring(scope.length - 1);
        } else {
            remainder = finalPath.substring(scope.length);
            if (!remainder.startsWith('/')) {
                remainder = '/' + remainder;
            }
        }

        // 构造隧道 API URL
        const scriptPath = scriptUrl.pathname.replace('/unified_service_worker.js', '');
        const apiBase = scriptUrl.origin + scriptPath + `/api/http-tunnel/${port}`;
        const uParam = encodeURIComponent(remainder + url.search);
        const proxyUrl = `${apiBase}?u=${uParam}`;

        // 构造 307 重定向 URL
        const correctedUrl = url.origin + finalPath + url.search + url.hash;

        // 预取隧道结果 + 307 重定向
        startPrefetch(correctedUrl, async () => {
            const init = await buildFetchInit(event);
            return await fetch(proxyUrl, init);
        });

        event.respondWith(Response.redirect(correctedUrl, 307));
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
    if (!event.data || !event.data.type) return;

    const replyPort = event.ports && event.ports[0];

    if (event.data.type === 'CONFIGURE') {
        // 配置 SW 策略
        const oldStrategy = strategy;
        const oldDepth = decodeDepth;
        const oldSlashExtra = slashExtraDecoding;
        const newStrategy = event.data.data.strategy || 'none';
        const newDepth = event.data.data.decodeDepth || 0;
        const newSlashExtra = event.data.data.slashExtraDecoding || false;
        const newTemplate = event.data.data.urlTemplate || '';
        
        // 更新策略
        strategy = newStrategy;
        decodeDepth = newDepth;
        slashExtraDecoding = newSlashExtra;
        urlTemplate = newTemplate;

        // none 时：navigate 前 fire-and-forget 注销自身
        if (newStrategy === 'none') {
            self.registration.unregister().catch(() => {});
        }
        
        // 策略变更后自动刷新所有客户端
        self.clients.matchAll({
            includeUncontrolled: true,
            type: 'window'
        }).then(clients => {
            clients.forEach(client => {
                client.navigate(client.url).catch(() => {});
            });
        }).catch(() => {});

        // 回传确认
        if (replyPort) replyPort.postMessage({ ok: true });

    } else if (event.data.type === 'GET_CONFIG') {
        // 查询当前配置，通过 MessageChannel 返回
        if (replyPort) {
            replyPort.postMessage({
                strategy: strategy,
                decodeDepth: decodeDepth,
                slashExtraDecoding: slashExtraDecoding,
                urlTemplate: urlTemplate
            });
        }
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
    
    // 预取缓存命中（307 跟随请求）
    if (_prefetchCache.has(urlStr)) {
        const promise = _prefetchCache.get(urlStr);
        _prefetchCache.delete(urlStr);
        event.respondWith((async () => {
            try {
                return await promise;
            } catch (e) {
                console.error('[SW] Prefetch failed, fallback:', e);
                return fetch(event.request);
            }
        })());
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
