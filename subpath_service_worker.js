// 编码配置 - 由后端模板替换
const NGINX_DECODE_DEPTH = {{NGINX_DECODE_DEPTH}};

// 防循环策略选择: 'url_param' 或 'memory_set'
const LOOP_STRATEGY = 'url_param';

const scope = new URL(self.registration.scope).pathname;

// ==================== URL 编码处理函数 ====================
function hasEncodedChars(str) {
    // 检测是否包含已编码的字符（%XX 格式）
    return /%[0-9A-Fa-f]{2}/.test(str);
}

// 两种防循环方案，接口完全一致
const LoopStrategies = {
    url_param: {
        isProcessed(url) {
            return new URL(url).searchParams.has('_sw');
        },
        
        addMark(url) {
            const urlObj = new URL(url);
            urlObj.searchParams.set('_sw', '');
            return urlObj.toString();
        },
        
        removeMark(request) {
            const urlObj = new URL(request.url);
            urlObj.searchParams.delete('_sw');
            const cleanUrl = urlObj.toString();
            const finalUrl = cleanUrl.endsWith('?') ? cleanUrl.slice(0, -1) : cleanUrl;
            return new Request(finalUrl, {
                ...request,
                duplex: request.body ? 'half' : undefined
            });
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
        
        removeMark(request) {
            this._cache.delete(request.url);
            return request;
        }
    }
};

// 当前使用的策略
const strategy = LoopStrategies[LOOP_STRATEGY];

function multiLayerEncodeSegment(segment, layers) {
    // 多层编码函数
    let encoded = segment;
    for (let i = 0; i < layers; i++) {
        encoded = encodeURIComponent(encoded);
    }
    return encoded;
}

function selectiveMultiEncodePath(pathname) {
    try {
        const segments = pathname.split('/');
        
        const encodedSegments = segments.map(segment => {
            // 如果 nginx 有解码深度且段包含已编码字符，进行多层编码
            if (NGINX_DECODE_DEPTH > 0 && hasEncodedChars(segment)) {
                return multiLayerEncodeSegment(segment, NGINX_DECODE_DEPTH);
            }
            return segment;
        });
        
        return encodedSegments.join('/');
    } catch (error) {
        // console.error('[SW] 编码处理错误:', error);
        return pathname;
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
            if (strategy.isProcessed(event.request.url)) {
                // 移除处理标记并转发请求
                const cleanRequest = strategy.removeMark(event.request);
                return fetch(cleanRequest);
            }

            // 同域请求处理
            let finalPathname = requestUrl.pathname;
            
            // 1. 编码处理
            if (NGINX_DECODE_DEPTH > 0 && hasEncodedChars(finalPathname)) {
                finalPathname = selectiveMultiEncodePath(finalPathname);
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
                const markedUrl = strategy.addMark(requestUrl.href);
                return Response.redirect(markedUrl, 307);
            }
            
            // 同域请求无需处理，直接转发
            return fetch(event.request);
        })()
    );
});