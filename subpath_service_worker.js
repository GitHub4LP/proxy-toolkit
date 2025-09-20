// 编码配置 - 由后端模板替换
const NEEDS_CHINESE_ENCODING = {{NEEDS_CHINESE_ENCODING}};
const NGINX_DECODE_DEPTH = {{NGINX_DECODE_DEPTH}};

const scope = new URL(self.registration.scope).pathname
let registeredPaths = new Set([scope]);

// ==================== URL 编码处理函数 ====================
function hasEncodedChars(str) {
    // 检测是否包含已编码的字符（%XX 格式）
    return /%[0-9A-Fa-f]{2}/.test(str);
}

function hasChineseEncodedChars(str) {
    // 检测是否包含已编码的中文字符（%E4-%E9 开头的UTF-8编码）
    return /%[E][4-9A-F]%[0-9A-F]{2}%[0-9A-F]{2}/i.test(str);
}

function hasSlashEncodedChars(str) {
    // 检测是否包含已编码的斜杠（%2F）
    return /%2F/i.test(str);
}

function hasPercentEncodedChars(str) {
    // 检测是否包含已编码的百分号（%25）
    return /%25/i.test(str);
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
            let needsEncoding = false;
            let encodingReason = '';
            
            // 检查中文编码需求
            if (NEEDS_CHINESE_ENCODING && hasChineseEncodedChars(segment)) {
                needsEncoding = true;
                encodingReason += 'Chinese ';
            }
            
            // 如果 nginx 有解码深度，对特殊字符进行编码
            if (NGINX_DECODE_DEPTH > 0 && (hasSlashEncodedChars(segment) || hasPercentEncodedChars(segment))) {
                needsEncoding = true;
                encodingReason += 'Special ';
            }
            
            if (needsEncoding) {
                const layers = Math.max( NGINX_DECODE_DEPTH + 1);
                const encoded = multiLayerEncodeSegment(segment, layers);
                console.log(`[SW] 检测到 ${encodingReason.trim()}，对段进行 ${layers} 层编码: ${segment} → ${encoded}`);
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
                    const needsEncoding = (NGINX_DECODE_DEPTH > 0 && (requestUrl.pathname.includes('%2F') || requestUrl.pathname.includes('%25'))) ||
                                         (NEEDS_CHINESE_ENCODING && /%[E][4-9A-F]%[0-9A-F]{2}%[0-9A-F]{2}/i.test(requestUrl.pathname));
                    
                    if (needsEncoding) {
                        console.log(`[SW] 检测到需要编码的字符，进行多层编码处理: ${requestUrl.pathname}`);
                        const encodedUrl = selectiveMultiEncodeUrl(requestUrl.toString());
                        if (encodedUrl !== requestUrl.toString()) {
                            if (event.request.method === 'GET') {
                                return Response.redirect(encodedUrl, 302);
                            } else {
                                const modifiedRequest = new Request(encodedUrl, {
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