// 编码配置 - 由后端模板替换
const NEEDS_CHINESE_ENCODING = {{NEEDS_CHINESE_ENCODING}};
const NEEDS_SLASH_ENCODING = {{NEEDS_SLASH_ENCODING}};

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

function selectiveDoubleEncodeUrl(url) {
    try {
        const urlObj = new URL(url);
        const originalPath = urlObj.pathname;
        const segments = originalPath.split('/');
        
        const encodedSegments = segments.map(segment => {
            let needsEncoding = false;
            
            // 根据配置检查是否需要对该段进行编码
            if (NEEDS_SLASH_ENCODING && hasSlashEncodedChars(segment)) {
                needsEncoding = true;
            }
            
            if (NEEDS_CHINESE_ENCODING && hasChineseEncodedChars(segment)) {
                needsEncoding = true;
            }
            
            // 如果需要编码，对整个段进行 encodeURIComponent
            if (needsEncoding) {
                return encodeURIComponent(segment);
            }
            
            return segment;
        });
        
        const newPath = encodedSegments.join('/');
        if (newPath !== originalPath) {
            urlObj.pathname = newPath;
            console.log(`[SW] 选择性双重编码: ${originalPath} → ${newPath}`);
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
                    if (matchedPath) {
                        const lcp = longestCommonPrefix(matchedPath, requestUrl.pathname);
                        if (lcp !== matchedPath) {
                            if (event.request.method === 'GET') {
                                const newUrl = new URL(event.request.url);
                                newUrl.pathname = requestUrl.pathname.replace(lcp, matchedPath);
                                
                                // 对 URL 进行选择性双重编码处理
                                if (NEEDS_CHINESE_ENCODING || NEEDS_SLASH_ENCODING) {
                                    const encodedUrl = selectiveDoubleEncodeUrl(newUrl.toString());
                                    return Response.redirect(encodedUrl, 302);
                                }
                                
                                return Response.redirect(newUrl.href, 302);
                            } else {
                                requestUrl.pathname = requestUrl.pathname.replace(lcp, matchedPath);
                                
                                // 对 URL 进行选择性双重编码处理
                                if (NEEDS_CHINESE_ENCODING || NEEDS_SLASH_ENCODING) {
                                    requestUrl = new URL(selectiveDoubleEncodeUrl(requestUrl.toString()));
                                }
                                
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