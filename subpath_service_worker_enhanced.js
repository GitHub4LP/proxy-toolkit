const scope = new URL(self.registration.scope).pathname
let registeredPaths = new Set([scope]);

// ==================== URL 编码处理函数 ====================
function hasEncodedChars(str) {
    // 检测是否包含已编码的字符（%XX 格式）
    return /%[0-9A-Fa-f]{2}/.test(str);
}

function doubleEncodeUrl(url) {
    try {
        const urlObj = new URL(url);
        
        if (hasEncodedChars(urlObj.pathname)) {
            const originalPath = urlObj.pathname;
            const segments = originalPath.split('/');
            const encodedSegments = segments.map(segment => {
                if (hasEncodedChars(segment)) {
                    return encodeURIComponent(segment);
                }
                return segment;
            });
            urlObj.pathname = encodedSegments.join('/');
            
            console.log(`[SW] URL编码: ${originalPath} → ${urlObj.pathname}`);
        }
        
        return urlObj.toString();
    } catch (error) {
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
    console.log('[SW Enhanced] registeredPaths:', Array.from(registeredPaths));
    
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
                                
                                // 对 URL 进行双重编码处理
                                if (hasEncodedChars(newUrl.pathname)) {
                                    const encodedUrl = doubleEncodeUrl(newUrl.toString());
                                    return Response.redirect(encodedUrl, 302);
                                }
                                
                                return Response.redirect(newUrl.href, 302);
                            } else {
                                requestUrl.pathname = requestUrl.pathname.replace(lcp, matchedPath);
                                
                                // 对 URL 进行双重编码处理
                                if (hasEncodedChars(requestUrl.pathname)) {
                                    requestUrl = new URL(doubleEncodeUrl(requestUrl.toString()));
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