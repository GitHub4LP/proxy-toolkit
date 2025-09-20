// 编码配置 - 由后端模板替换
const NEEDS_CHINESE_ENCODING = {{NEEDS_CHINESE_ENCODING}};
const NEEDS_SLASH_ENCODING = {{NEEDS_SLASH_ENCODING}};

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

// URL 编码处理函数
function encodeUrlForNginx(url) {
    if (!NEEDS_CHINESE_ENCODING && !NEEDS_SLASH_ENCODING) {
        return url; // 不需要任何编码
    }
    
    let encoded = url;
    
    // 处理中文字符编码
    if (NEEDS_CHINESE_ENCODING) {
        // 对中文字符进行双重编码
        encoded = encoded.replace(/[\u4e00-\u9fff]/g, function(match) {
            return encodeURIComponent(encodeURIComponent(match));
        });
    }
    
    // 处理 %2F 编码
    if (NEEDS_SLASH_ENCODING) {
        // 将 / 编码为 %252F (双重编码的 %2F)
        encoded = encoded.replace(/\//g, '%252F');
    }
    
    return encoded;
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
                                let newPathname = requestUrl.pathname.replace(lcp, matchedPath);
                                
                                // 应用编码处理
                                if (NEEDS_CHINESE_ENCODING || NEEDS_SLASH_ENCODING) {
                                    newPathname = encodeUrlForNginx(newPathname);
                                }
                                
                                newUrl.pathname = newPathname;
                                return Response.redirect(newUrl.href, 302);
                            } else {
                                let newPathname = requestUrl.pathname.replace(lcp, matchedPath);
                                
                                // 应用编码处理
                                if (NEEDS_CHINESE_ENCODING || NEEDS_SLASH_ENCODING) {
                                    newPathname = encodeUrlForNginx(newPathname);
                                }
                                
                                requestUrl.pathname = newPathname;
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