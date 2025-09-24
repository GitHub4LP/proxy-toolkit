// 编码配置 - 由后端模板替换
const NGINX_DECODE_DEPTH = {{NGINX_DECODE_DEPTH}};

const scope = new URL(self.registration.scope).pathname;

// ==================== URL 编码处理函数 ====================
function hasEncodedChars(str) {
    // 检测是否包含已编码的字符（%XX 格式）
    return /%[0-9A-Fa-f]{2}/.test(str);
}

function isProcessedByServiceWorker(url) {
    // 检测URL是否包含我们的处理标记
    return new URL(url).searchParams.has('_sw_processed');
}

function addProcessingMark(url) {
    // 添加处理标记
    const urlObj = new URL(url);
    urlObj.searchParams.set('_sw_processed', '1');
    return urlObj.toString();
}

function removeProcessingMark(url) {
    // 移除处理标记，保持URL干净
    const urlObj = new URL(url);
    urlObj.searchParams.delete('_sw_processed');
    
    // 如果没有其他参数，移除问号
    const cleanUrl = urlObj.toString();
    return cleanUrl.endsWith('?') ? cleanUrl.slice(0, -1) : cleanUrl;
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
                return multiLayerEncodeSegment(segment, NGINX_DECODE_DEPTH);
            }
            return segment;
        });
        
        const newPath = encodedSegments.join('/');
        if (newPath !== originalPath) {
            urlObj.pathname = newPath;
            // console.log(`[SW] 多层编码处理: ${originalPath} → ${newPath}`);
        }
        
        return urlObj.toString();
    } catch (error) {
        // console.error('[SW] 编码处理错误:', error);
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
            const requestUrl = new URL(event.request.url);
            
            // 跨域请求直接转发
            if (requestUrl.host !== self.location.host) {
                return fetch(event.request);
            }

            // 检查是否已被我们处理过，防止重定向循环
            if (isProcessedByServiceWorker(event.request.url)) {
                // 移除处理标记并转发请求
                const cleanUrl = removeProcessingMark(event.request.url);
                const cleanRequest = new Request(cleanUrl, {
                    ...event.request,
                    duplex: event.request.body ? 'half' : undefined
                });
                return fetch(cleanRequest);
            }

            // 同域请求处理
            let finalPathname = requestUrl.pathname;
            
            // 1. 编码处理
            if (NGINX_DECODE_DEPTH > 0 && hasEncodedChars(finalPathname)) {
                const encodedUrl = selectiveMultiEncodeUrl(requestUrl.toString());
                if (encodedUrl !== requestUrl.toString()) {
                    finalPathname = new URL(encodedUrl).pathname;
                }
            }
            
            // 2. 路径匹配处理
            const lcp = longestCommonPrefix(scope, finalPathname);
            if (lcp !== scope) {
                finalPathname = finalPathname.replace(lcp, scope);
            }
            
            // 3. 如果 pathname 有变化，使用307重定向统一处理
            if (finalPathname !== requestUrl.pathname) {
                requestUrl.pathname = finalPathname;
                // 添加处理标记，防止重定向循环
                const markedUrl = addProcessingMark(requestUrl.href);
                return Response.redirect(markedUrl, 307);
            }
            
            // 同域请求无需处理，直接转发
            return fetch(event.request);
        })()
    );
});