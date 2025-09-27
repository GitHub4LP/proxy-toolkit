const NGINX_DECODE_DEPTH = {{NGINX_DECODE_DEPTH}};
const LOOP_STRATEGY = 'url_param';
const scope = new URL(self.registration.scope).pathname;

function hasEncodedChars(str) {
    return /%[0-9A-Fa-f]{2}/.test(str);
}

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

const strategy = LoopStrategies[LOOP_STRATEGY];

function multiLayerEncodeSegment(segment, layers) {
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
            if (NGINX_DECODE_DEPTH > 0 && hasEncodedChars(segment)) {
                return multiLayerEncodeSegment(segment, NGINX_DECODE_DEPTH);
            }
            return segment;
        });
        
        return encodedSegments.join('/');
    } catch (error) {
        return pathname;
    }
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

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    if (event.request.mode === 'navigate') {
        return;
    }
    
    const requestUrl = new URL(event.request.url);
    
    if (requestUrl.host !== self.location.host) {
        return;
    }

    if (strategy.isProcessed(event.request.url)) {
        const cleanRequest = strategy.removeMark(event.request);
        event.respondWith(fetch(cleanRequest));
        return;
    }

    let finalPathname = requestUrl.pathname;
    let needsProcessing = false;
    
    if (NGINX_DECODE_DEPTH > 0 && hasEncodedChars(finalPathname)) {
        finalPathname = selectiveMultiEncodePath(finalPathname);
        needsProcessing = true;
    }
    
    const commonPath = longestCommonPathSegments(scope, finalPathname);
    if (commonPath !== scope) {
        finalPathname = finalPathname.replace(commonPath, scope);
        needsProcessing = true;
    }
    
    if (needsProcessing) {
        requestUrl.pathname = finalPathname;
        const markedUrl = strategy.addMark(requestUrl.href);
        event.respondWith(Response.redirect(markedUrl, 307));
    }
});