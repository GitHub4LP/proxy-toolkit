/**
 * 导航拦截器 - 修正子路径环境下的导航问题
 * 使用: NavigationInterceptor.init({ scopeBase: '/user/xxx/proxy/8080/' });
 */

(function(global) {
    'use strict';

    // 防止重复安装
    if (global._NavigationInterceptorInstalled) {
        console.warn('[Navigation Interceptor] Already installed, skipping');
        return;
    }

    const NavigationInterceptor = {
        config: {
            scopeBase: '',
            enableClickInterception: true,
            enableLocationInterception: true,
            enableHistoryInterception: true,
            enableWindowOpenInterception: true,
            enableFormInterception: true
        },
        originalMethods: {},
        initialized: false,

        /** 初始化 */
        init: function(options) {
            if (this.initialized) {
                this.log('Already initialized');
                return;
            }

            this.config = Object.assign({}, this.config, options);

            if (!this.config.scopeBase) {
                console.error('[Navigation Interceptor] scopeBase is required');
                return;
            }

            this.config.scopeBase = this.normalizeScopeBase(this.config.scopeBase);
            this.log('Initializing with config:', this.config);

            this.saveOriginalMethods();
            this.installInterceptors();

            this.initialized = true;
            global._NavigationInterceptorInstalled = true;

            let locationStatus = false;
            if (this.config.enableLocationInterception) {
                try {
                    const hrefDesc = Object.getOwnPropertyDescriptor(location, 'href');
                    locationStatus = !!(hrefDesc && hrefDesc.set && hrefDesc.configurable);
                } catch (error) {
                    locationStatus = false;
                }
            }
            
            this.log(`Click: ${this.config.enableClickInterception} | Location: ${locationStatus} | History: ${this.config.enableHistoryInterception} | Window: ${this.config.enableWindowOpenInterception} | Form: ${this.config.enableFormInterception}`);
        },

        normalizeScopeBase: function(scopeBase) {
            if (!scopeBase.startsWith('/')) {
                scopeBase = '/' + scopeBase;
            }
            if (!scopeBase.endsWith('/')) {
                scopeBase = scopeBase + '/';
            }
            return scopeBase;
        },

        saveOriginalMethods: function() {
            try {
                this.originalMethods.pushState = history.pushState.bind(history);
                this.originalMethods.replaceState = history.replaceState.bind(history);
                this.originalMethods.windowOpen = global.open.bind(global);
            } catch (error) {
                console.error('[Navigation Interceptor] Failed to save original methods:', error);
            }
        },

        installInterceptors: function() {
            if (this.config.enableClickInterception) {
                this.installClickInterceptor();
            }

            if (this.config.enableLocationInterception) {
                this.installLocationInterceptor();
            }

            if (this.config.enableHistoryInterception) {
                this.installHistoryInterceptor();
            }

            if (this.config.enableWindowOpenInterception) {
                this.installWindowOpenInterceptor();
            }

            if (this.config.enableFormInterception) {
                this.installFormInterceptor();
            }
        },

        installClickInterceptor: function() {
            const self = this;
            document.addEventListener('click', function(event) {
                try {
                    const link = event.target.closest('a[href]');
                    if (!link) return;

                    const href = link.getAttribute('href');
                    if (!self.needsPathFix(href)) return;

                    event.preventDefault();
                    event.stopPropagation();

                    const fixedHref = self.fixPath(href);
                    if (fixedHref !== href) {
                        self.log('Fixed href:', href, '->', fixedHref);
                    }

                    const target = link.getAttribute('target');
                    if (target === '_blank' || event.ctrlKey || event.metaKey) {
                        self.originalMethods.windowOpen(fixedHref, target || '_blank');
                    } else {
                        global.location.href = fixedHref;
                    }
                } catch (error) {
                    console.error('[Navigation Interceptor] Click handler error:', error);
                }
            }, true);
        },

        installLocationInterceptor: function() {
            const self = this;
            try {
                const hrefDesc = Object.getOwnPropertyDescriptor(location, 'href');
                if (hrefDesc && hrefDesc.set && hrefDesc.configurable) {
                    const originalSetter = hrefDesc.set;
                    Object.defineProperty(location, 'href', {
                        get: hrefDesc.get,
                        set: function(url) {
                            const fixedUrl = self.fixPath(url);
                            if (fixedUrl !== url) {
                                self.log('Fixed location.href:', url, '->', fixedUrl);
                            }
                            originalSetter.call(this, fixedUrl);
                        },
                        configurable: true
                    });
                }
            } catch (error) {}
        },

        installHistoryInterceptor: function() {
            const self = this;
            try {
                history.pushState = function(state, title, url) {
                    if (url !== undefined && url !== null) {
                        const fixedUrl = self.fixPath(url);
                        if (fixedUrl !== url) {
                            self.log('Fixed pushState:', url, '->', fixedUrl);
                        }
                        return self.originalMethods.pushState(state, title, fixedUrl);
                    }
                    return self.originalMethods.pushState(state, title, url);
                };

                history.replaceState = function(state, title, url) {
                    if (url !== undefined && url !== null) {
                        const fixedUrl = self.fixPath(url);
                        if (fixedUrl !== url) {
                            self.log('Fixed replaceState:', url, '->', fixedUrl);
                        }
                        return self.originalMethods.replaceState(state, title, fixedUrl);
                    }
                    return self.originalMethods.replaceState(state, title, url);
                };

                global.addEventListener('popstate', function(event) {
                    try {
                        const currentPath = global.location.pathname;
                        if (self.needsPathFix(currentPath)) {
                            self.log('Fixing path on popstate:', currentPath);
                            const fixedPath = self.fixPath(currentPath);
                            self.originalMethods.replaceState(event.state, '', fixedPath + global.location.search + global.location.hash);
                        }
                    } catch (error) {
                        console.error('[Navigation Interceptor] Popstate handler error:', error);
                    }
                });
            } catch (error) {
                console.error('[Navigation Interceptor] Failed to install history interceptor:', error);
            }
        },

        installWindowOpenInterceptor: function() {
            const self = this;
            try {
                global.open = function(url, target, features) {
                    if (url !== undefined && url !== null) {
                        const fixedUrl = self.fixPath(url);
                        if (fixedUrl !== url) {
                            self.log('Fixed window.open:', url, '->', fixedUrl);
                        }
                        return self.originalMethods.windowOpen(fixedUrl, target, features);
                    }
                    return self.originalMethods.windowOpen(url, target, features);
                };
            } catch (error) {
                console.error('[Navigation Interceptor] Failed to install window.open interceptor:', error);
            }
        },

        installFormInterceptor: function() {
            const self = this;
            document.addEventListener('submit', function(event) {
                try {
                    const form = event.target;
                    if (!form || form.tagName !== 'FORM') return;

                    const action = form.getAttribute('action');
                    if (!action || !self.needsPathFix(action)) return;

                    const fixedAction = self.fixPath(action);
                    if (fixedAction !== action) {
                        self.log('Fixed form action:', action, '->', fixedAction);
                    }
                    form.setAttribute('action', fixedAction);
                } catch (error) {
                    console.error('[Navigation Interceptor] Form submit handler error:', error);
                }
            }, true);
        },

        needsPathFix: function(url) {
            if (!url || typeof url !== 'string') return false;
            if (url.startsWith('http://') || url.startsWith('https://')) return false;
            if (url.startsWith('//')) return false;
            if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) return false;
            if (url.startsWith('#') || url.startsWith('?')) return false;
            if (url.startsWith('data:') || url.startsWith('blob:')) return false;
            if (url.startsWith(this.config.scopeBase)) return false;
            return url.startsWith('/');
        },

        fixPath: function(url) {
            if (!this.needsPathFix(url)) return url;
            const relativePath = url.substring(1);
            return this.config.scopeBase + relativePath;
        },

        log: function() {
            console.log('[Navigation Interceptor]', ...arguments);
        },

        uninstall: function() {
            try {
                if (this.originalMethods.pushState) {
                    history.pushState = this.originalMethods.pushState;
                }
                if (this.originalMethods.replaceState) {
                    history.replaceState = this.originalMethods.replaceState;
                }
                if (this.originalMethods.windowOpen) {
                    global.open = this.originalMethods.windowOpen;
                }
                this.initialized = false;
                delete global._NavigationInterceptorInstalled;
                this.log('Navigation Interceptor uninstalled');
            } catch (error) {
                console.error('[Navigation Interceptor] Failed to uninstall:', error);
            }
        }
    };

    global.NavigationInterceptor = NavigationInterceptor;

    if (global._NavigationInterceptorConfig) {
        NavigationInterceptor.init(global._NavigationInterceptorConfig);
    }

})(typeof window !== 'undefined' ? window : this);