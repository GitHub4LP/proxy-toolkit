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

// 计算最长公共路径段
function longestCommonPathSegments(path1, path2) {
    if (path1 === path2) {
        return path1;
    }
    
    // 分割为路径段，过滤空字符串
    const segments1 = path1.split('/').filter(s => s !== '');
    const segments2 = path2.split('/').filter(s => s !== '');
    
    // 逐段比对
    let commonSegments = [];
    const minLength = Math.min(segments1.length, segments2.length);
    
    for (let i = 0; i < minLength; i++) {
        if (segments1[i] === segments2[i]) {
            commonSegments.push(segments1[i]);
        } else {
            break; // 一旦有段不匹配就停止
        }
    }
    
    // 重建路径
    if (commonSegments.length === 0) {
        return '/';
    }
    
    const result = '/' + commonSegments.join('/');
    
    // 如果原路径以/结尾且所有段都匹配，保持这个格式
    if (path1.endsWith('/') && commonSegments.length === segments1.length) {
        return result + '/';
    }
    
    return result;
}

// ==================== Service Worker 事件处理 ====================
self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    // 导航请求放行 - 最优先判断
    if (event.request.mode === 'navigate') {
        return;
    }
    
    const requestUrl = new URL(event.request.url);
    
    // 跨域请求放行
    if (requestUrl.host !== self.location.host) {
        return;
    }

    // 清理已处理请求的标记
    if (strategy.isProcessed(event.request.url)) {
        // 提前准备清理后的请求对象
        const cleanRequest = strategy.removeMark(event.request);
        
        event.respondWith(fetch(cleanRequest));
        return;
    }

    // 提前进行所有同步处理和判断
    let finalPathname = requestUrl.pathname;
    let needsProcessing = false;
    
    // 编码处理检查和应用
    if (NGINX_DECODE_DEPTH > 0 && hasEncodedChars(finalPathname)) {
        finalPathname = selectiveMultiEncodePath(finalPathname);
        needsProcessing = true;
    }
    
    // 路径匹配处理
    const commonPath = longestCommonPathSegments(scope, finalPathname);
    if (commonPath !== scope) {
        finalPathname = finalPathname.replace(commonPath, scope);
        needsProcessing = true;
    }
    
    // 只有需要处理时才进行重定向
    if (needsProcessing) {
        // 提前构建重定向URL（所有操作都是同步的）
        requestUrl.pathname = finalPathname;
        const markedUrl = strategy.addMark(requestUrl.href);
        
        event.respondWith(Response.redirect(markedUrl, 307));
    }
});