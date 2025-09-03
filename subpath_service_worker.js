
const scope = new URL(self.registration.scope).pathname
let registeredPaths = new Set([scope]);

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

// 子路径处理函数
function handleSubpathRedirect(request, requestUrl) {
    if (requestUrl.host === self.location.host && request.referrer) {
        const referrer = request.referrer;
        let matchedPath = null;
        
        for (const path of registeredPaths) {
            if (referrer && referrer.includes(path)) {
                matchedPath = path;
                break;
            }
        }
        
        if (matchedPath) {
            const lcp = longestCommonPrefix(matchedPath, requestUrl.pathname);
            if (lcp !== matchedPath) {
                console.log('[SW] 重定向:', requestUrl.pathname, '->', requestUrl.pathname.replace(lcp, matchedPath), 'registeredPaths:', Array.from(registeredPaths));
                if (request.method === 'GET') {
                    const newUrl = new URL(requestUrl);
                    newUrl.pathname = requestUrl.pathname.replace(lcp, matchedPath);
                    return { type: 'redirect', url: newUrl.href };
                } else {
                    requestUrl.pathname = requestUrl.pathname.replace(lcp, matchedPath);
                    return { type: 'modify', url: requestUrl.toString() };
                }
            }
        }
    }
    return { type: 'none' };
}

// ==================== Nginx 自动解码绕过模块 ====================
// 解决 Nginx 自动 URL 解码导致后端收到非 ASCII 字符的问题

// 检测是否包含 URL 编码字符（%XX 格式）
function hasUrlEncodedChars(str) {
    return /%[0-9A-Fa-f]{2}/.test(str);
}

// 双重编码策略：让 Nginx 解码后仍然是编码状态
function doubleEncodeForNginx(url) {
    try {
        const urlObj = new URL(url);
        let changed = false;
        
        // 处理路径中的编码字符 - 分段处理保持路径结构
        if (hasUrlEncodedChars(urlObj.pathname)) {
            const pathSegments = urlObj.pathname.split('/');
            const encodedSegments = pathSegments.map(segment => {
                if (hasUrlEncodedChars(segment)) {
                    // 对包含编码的段进行二次编码
                    return encodeURIComponent(segment);
                }
                return segment;
            });
            urlObj.pathname = encodedSegments.join('/');
            changed = true;
        }
        
        // 处理查询参数中的编码字符
        if (hasUrlEncodedChars(urlObj.search)) {
            const searchParams = new URLSearchParams(urlObj.search);
            const newSearchParams = new URLSearchParams();
            
            for (const [key, value] of searchParams) {
                let encodedKey = key;
                let encodedValue = value;
                
                if (hasUrlEncodedChars(key)) {
                    encodedKey = encodeURIComponent(key);
                }
                
                if (hasUrlEncodedChars(value)) {
                    encodedValue = encodeURIComponent(value);
                }
                
                newSearchParams.append(encodedKey, encodedValue);
            }
            
            urlObj.search = newSearchParams.toString();
            changed = true;
        }
        
        return { url: urlObj.toString(), changed };
    } catch (error) {
        self.console.error('Double encoding for Nginx failed:', error);
        return { url, changed: false };
    }
}

// Nginx 绕过处理函数
function handleNginxAutoDecodeBypass(originalUrl) {
    if (hasUrlEncodedChars(originalUrl)) {
        const result = doubleEncodeForNginx(originalUrl);
        if (result.changed) {
            self.console.log('Double encoding for Nginx bypass:', originalUrl, '->', result.url);
            return { bypassed: true, url: result.url };
        }
    }
    return { bypassed: false, url: originalUrl };
}

// ==================== Service Worker 事件处理 ====================
self.addEventListener('install', (event) => {
    console.log('[SW] registeredPaths:', Array.from(registeredPaths));
    
    event.waitUntil(
        (async () => {
            return self.skipWaiting();
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            return self.clients.claim();
        })()
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        (async () => {
            let requestUrl = new URL(event.request.url);
            let originalUrl = requestUrl.toString();
            let modifiedRequest = event.request;
            
            // 步骤1: 绕过 Nginx 自动解码（双重编码策略）
            const bypassResult = handleNginxAutoDecodeBypass(originalUrl);
            if (bypassResult.bypassed) {
                requestUrl = new URL(bypassResult.url);
                modifiedRequest = new Request(bypassResult.url, {
                    method: event.request.method,
                    headers: event.request.headers,
                    body: event.request.body,
                    mode: event.request.mode,
                    credentials: event.request.credentials,
                    cache: event.request.cache,
                    redirect: event.request.redirect,
                    referrer: event.request.referrer,
                    referrerPolicy: event.request.referrerPolicy,
                    integrity: event.request.integrity,
                    keepalive: event.request.keepalive,
                    signal: event.request.signal
                });
            }
            
            // 步骤2: 处理子路径重定向（独立模块）
            const subpathResult = handleSubpathRedirect(event.request, requestUrl);
            if (subpathResult.type === 'redirect') {
                return Response.redirect(subpathResult.url, 302);
            } else if (subpathResult.type === 'modify') {
                modifiedRequest = new Request(subpathResult.url, {
                    method: modifiedRequest.method,
                    headers: modifiedRequest.headers,
                    body: modifiedRequest.body,
                    redirect: modifiedRequest.redirect,
                    referrer: modifiedRequest.referrer,
                    integrity: modifiedRequest.integrity,
                    signal: modifiedRequest.signal,
                    duplex: 'half',
                });
            }
            
            // 步骤3: 处理跨域请求
            if (requestUrl.host !== self.location.host) {
                modifiedRequest.headers["cross-origin-resource-policy"] = "cross-origin";
            }
            
            return fetch(modifiedRequest);
        })()
    );
});