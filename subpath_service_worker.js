// 编码配置 - 由后端模板替换
const NGINX_DECODE_DEPTH = {{NGINX_DECODE_DEPTH}};

const scope = new URL(self.registration.scope).pathname
let registeredPaths = new Set([scope]);

// ==================== URL 编码处理函数 ====================
function hasEncodedChars(str) {
    // 检测是否包含已编码的字符（%XX 格式）
    return /%[0-9A-Fa-f]{2}/.test(str);
}



function multiLayerEncodeSegment(segment, layers) {
    // 多层编码函数
    let encoded = segment;
    for (let i = 0; i < layers; i++) {
        encoded = encodeURIComponent(encoded);
    }
    return encoded;
}

function selectiveMultiEncodeUrl(url) {
    try {
        const urlObj = new URL(url);
        const originalPath = urlObj.pathname;
        const segments = originalPath.split('/');
        
        const encodedSegments = segments.map(segment => {
            // 如果 nginx 有解码深度且段包含已编码字符，进行多层编码
            if (NGINX_DECODE_DEPTH > 0 && hasEncodedChars(segment)) {
                const encoded = multiLayerEncodeSegment(segment, NGINX_DECODE_DEPTH);
                console.log(`[SW] 检测到已编码字符，进行 ${NGINX_DECODE_DEPTH} 层编码: ${segment} → ${encoded}`);
                return encoded;
            }
            
            return segment;
        });
        
        const newPath = encodedSegments.join('/');
        if (newPath !== originalPath) {
            urlObj.pathname = newPath;
            console.log(`[SW] 多层编码处理: ${originalPath} → ${newPath}`);
        }
        
        return urlObj.toString();
    } catch (error) {
        console.error('[SW] 编码处理错误:', error);
        return url;
    }
}

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
            if (requestUrl.host === self.location.host) {
                if (event.request.referrer) {
                    const referrer = event.request.referrer;
                    let matchedPath = null;
                    for (const path of registeredPaths) {
                        if (referrer && referrer.includes(path)) {
                            matchedPath = path;
                            break;
                        }
                    }
                    // 在路径匹配判断之前，先检查是否需要编码处理
                    const needsEncoding = NGINX_DECODE_DEPTH > 0 && hasEncodedChars(requestUrl.pathname);
                    
                    if (needsEncoding) {
                        console.log(`[SW] 检测到需要编码的字符，进行多层编码处理: ${requestUrl.pathname}`);
                        const encodedUrl = selectiveMultiEncodeUrl(requestUrl.toString());
                        if (encodedUrl !== requestUrl.toString()) {
                            // 更新 requestUrl 用于后续处理
                            requestUrl = new URL(encodedUrl);
                        }
                    }
                    
                    if (matchedPath) {
                        const lcp = longestCommonPrefix(matchedPath, requestUrl.pathname);
                        if (lcp !== matchedPath) {
                            if (event.request.method === 'GET') {
                                const newUrl = new URL(event.request.url);
                                newUrl.pathname = requestUrl.pathname.replace(lcp, matchedPath);
                                return Response.redirect(newUrl.href, 302);
                            } else {
                                requestUrl.pathname = requestUrl.pathname.replace(lcp, matchedPath);
                                const modifiedRequest = new Request(requestUrl, {
                                    ...event.request,
                                    method: event.request.method,
                                    headers: event.request.headers,
                                    body: event.request.body,
                                    redirect: event.request.redirect,
                                    referrer: event.request.referrer,
                                    integrity: event.request.integrity,
                                    signal: event.request.signal,
                                    duplex: 'half',
                                });
                                return fetch(modifiedRequest);
                            }
                        }
                    }
                }
            } else {
                event.request.headers["cross-origin-resource-policy"] = "cross-origin";
                return fetch(event.request);
            }
            return fetch(event.request);
        })()
    );
});