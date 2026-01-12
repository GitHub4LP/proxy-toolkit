/**
 * SW Client - Service Worker 客户端工具库
 * 提供编码检测、SW 注册/配置/注销、URL 模板处理等共用功能
 */

(function (global) {
  'use strict';

  // ==================== 编码检测 ====================

  const ENCODING_CACHE_KEY = 'sw_client_encoding_config';

  /**
   * 检测反向代理编码行为（带缓存）
   * @param {string} testEndpoint - 测试端点基础路径，如 '/api/test-encoding'
   * @param {object} [options] - 选项
   * @param {boolean} [options.useCache=true] - 是否使用缓存
   * @param {boolean} [options.forceRefresh=false] - 是否强制刷新缓存
   * @returns {Promise<{decodeDepth: number, slashExtraDecoding: boolean}>}
   */
  async function detectProxyEncoding(testEndpoint, options = {}) {
    const { useCache = true, forceRefresh = false } = options;

    // 尝试读取缓存
    if (useCache && !forceRefresh) {
      try {
        const cached = localStorage.getItem(ENCODING_CACHE_KEY);
        if (cached) {
          const config = JSON.parse(cached);
          if (typeof config.decodeDepth === 'number' && typeof config.slashExtraDecoding === 'boolean') {
            console.log('[SW Client] Using cached encoding config:', config);
            return config;
          }
        }
      } catch (e) {
        // 缓存读取失败，继续检测
      }
    }

    const result = { decodeDepth: 0, slashExtraDecoding: false };

    try {
      // 检测解码深度
      const testSegment = "test path";
      let maxLayers = 4;
      const maxAttempts = 8;
      const baseEncoded = encodeURIComponent(testSegment);

      while (maxLayers <= maxAttempts) {
        let encodedSegment = baseEncoded;
        for (let i = 0; i < maxLayers; i++) {
          encodedSegment = encodeURIComponent(encodedSegment);
        }

        const response = await fetch(`${testEndpoint}/${encodedSegment}`);
        if (!response.ok) {
          break;
        }

        const data = await response.json();
        let current = data.path;
        let encodeSteps = 0;

        while (current !== encodedSegment && encodeSteps < maxLayers) {
          current = encodeURIComponent(current);
          encodeSteps++;
        }

        const detectedDepth = (current === encodedSegment) ? encodeSteps : 0;
        const verified = await verifyDecodeDepth(testEndpoint, baseEncoded, detectedDepth);

        if (verified) {
          result.decodeDepth = detectedDepth;
          break;
        }
        maxLayers++;
      }

      // 检测 %2F 是否被额外解码
      if (result.decodeDepth >= 0) {
        result.slashExtraDecoding = await detectSlashExtraDecoding(testEndpoint, result.decodeDepth);
      }

      console.log(`[SW Client] Encoding detection: depth=${result.decodeDepth}, slashExtraDecoding=${result.slashExtraDecoding}`);

      // 保存到缓存
      if (useCache) {
        try {
          localStorage.setItem(ENCODING_CACHE_KEY, JSON.stringify(result));
        } catch (e) {
          // 缓存写入失败，忽略
        }
      }
    } catch (error) {
      console.warn('[SW Client] Encoding detection failed:', error);
    }

    return result;
  }

  /**
   * 验证解码深度
   */
  async function verifyDecodeDepth(testEndpoint, baseEncoded, detectedDepth) {
    try {
      let verifySegment = baseEncoded;
      for (let i = 0; i < detectedDepth; i++) {
        verifySegment = encodeURIComponent(verifySegment);
      }
      const response = await fetch(`${testEndpoint}/${verifySegment}`);
      if (response.ok) {
        const data = await response.json();
        return data.path === baseEncoded;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 检测 %2F 是否被额外解码
   */
  async function detectSlashExtraDecoding(testEndpoint, decodeDepth) {
    try {
      const testSegment = "test/path";
      const baseEncoded = encodeURIComponent(testSegment);

      let encoded = baseEncoded;
      for (let i = 0; i < decodeDepth; i++) {
        encoded = encodeURIComponent(encoded);
      }

      const response = await fetch(`${testEndpoint}/${encoded}`);
      if (!response.ok) {
        return false;
      }

      const data = await response.json();
      const pathParts = data.path.split('/');
      const hasRealSlash = pathParts.filter(p => p !== '').length > 1;
      return hasRealSlash;
    } catch {
      return false;
    }
  }

  // ==================== Service Worker 管理 ====================

  /**
   * 注册 Service Worker
   * @param {string} scriptUrl - SW 脚本 URL
   * @param {string} scope - SW 作用域
   * @returns {Promise<ServiceWorkerRegistration>}
   */
  async function registerServiceWorker(scriptUrl, scope) {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service Worker not supported');
    }

    const registration = await navigator.serviceWorker.register(scriptUrl, { scope });

    // 等待激活
    if (registration.installing) {
      await waitForActivation(registration.installing);
    }

    return registration;
  }

  /**
   * 等待 Service Worker 激活
   */
  function waitForActivation(installingWorker) {
    return Promise.race([
      new Promise(resolve => {
        installingWorker.addEventListener('statechange', () => {
          if (installingWorker.state === 'activated' || installingWorker.state === 'redundant') {
            resolve();
          }
        });
      }),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }

  /**
   * 配置 Service Worker
   * @param {ServiceWorker} worker - SW 实例
   * @param {object} config - {strategy, decodeDepth, slashExtraDecoding}
   */
  function configureServiceWorker(worker, config) {
    worker.postMessage({
      type: 'CONFIGURE',
      data: {
        strategy: config.strategy || 'none',
        decodeDepth: config.decodeDepth || 0,
        slashExtraDecoding: config.slashExtraDecoding || false
      }
    });
  }

  /**
   * 查询 Service Worker 当前配置
   * @param {ServiceWorker} worker - SW 实例
   * @param {number} [timeout=3000] - 超时时间（毫秒）
   * @returns {Promise<{strategy: string, decodeDepth: number, slashExtraDecoding: boolean}|null>}
   */
  function getServiceWorkerConfig(worker, timeout = 3000) {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      
      const timer = setTimeout(() => {
        resolve(null);
      }, timeout);

      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };

      channel.port1.onmessageerror = () => {
        clearTimeout(timer);
        resolve(null);
      };

      try {
        worker.postMessage({ type: 'GET_CONFIG' }, [channel.port2]);
      } catch (err) {
        clearTimeout(timer);
        console.warn('[SW Client] Failed to query config:', err);
        resolve(null);
      }
    });
  }

  /**
   * 注销 Service Worker
   * @param {string} scope - SW 作用域
   * @returns {Promise<boolean>}
   */
  async function unregisterServiceWorker(scope) {
    if (!('serviceWorker' in navigator)) {
      return false;
    }

    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const normalizedScope = normalizeUrl(scope);

      for (const registration of registrations) {
        if (normalizeUrl(registration.scope) === normalizedScope) {
          return await registration.unregister();
        }
      }
      return false;
    } catch (error) {
      console.warn('[SW Client] Unregister failed:', error);
      return false;
    }
  }

  /**
   * 获取所有已注册的 Service Worker
   * @param {function} [filter] - 可选的过滤函数，接收 registration 返回 boolean
   * @returns {Promise<ServiceWorkerRegistration[]>}
   */
  async function getRegistrations(filter) {
    if (!('serviceWorker' in navigator)) {
      return [];
    }

    const registrations = await navigator.serviceWorker.getRegistrations();
    return filter ? registrations.filter(filter) : registrations;
  }

  // ==================== URL 模板处理 ====================

  /**
   * 检测模板是否包含子路径
   * @param {string} template - URL 模板
   * @returns {boolean}
   */
  function hasSubpath(template) {
    if (!template) return false;

    let path;
    if (template.startsWith('http://') || template.startsWith('https://')) {
      try {
        const url = new URL(template.replace('{{port}}', '8080'));
        path = url.pathname;
      } catch {
        return false;
      }
    } else {
      path = template;
    }

    // 规范化路径：移除端口占位符，合并多个斜杠
    const normalized = path.replace('{{port}}', '').replace(/\/+/g, '/');

    // 根路径（/ 或空）不需要 SW
    return normalized !== '/' && normalized !== '';
  }

  /**
   * 生成端口代理 URL
   * @param {string} template - URL 模板
   * @param {number} port - 端口号
   * @returns {string}
   */
  function generateProxyUrl(template, port) {
    if (!template) return '';
    return template.replace('{{port}}', port.toString());
  }

  /**
   * 从模板编译正则表达式（用于从 URL 提取端口）
   * @param {string} template - URL 模板
   * @returns {RegExp|null}
   */
  function compileTemplateRegex(template) {
    if (!template) return null;

    const templatePath = extractTemplatePath(template);
    const escaped = templatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace('\\{\\{port\\}\\}', '(\\d+)');
    return new RegExp(pattern);
  }

  /**
   * 从模板提取路径部分
   * @param {string} template - URL 模板
   * @returns {string}
   */
  function extractTemplatePath(template) {
    if (template.startsWith('http://') || template.startsWith('https://')) {
      const protocolEnd = template.indexOf('://') + 3;
      const hostEnd = template.indexOf('/', protocolEnd);
      return hostEnd !== -1 ? template.substring(hostEnd) : '/';
    }
    return template.startsWith('/') ? template : '/' + template;
  }

  /**
   * 规范化 URL（提取路径部分）
   * @param {string} url - URL
   * @returns {string}
   */
  function normalizeUrl(url) {
    try {
      if (url.startsWith('http')) {
        return new URL(url).pathname;
      }
      return url.startsWith('/') ? url : '/' + url;
    } catch {
      return url;
    }
  }

  // ==================== 导出 ====================

  const SwClient = {
    // 编码检测
    detectProxyEncoding,

    // SW 管理
    registerServiceWorker,
    configureServiceWorker,
    getServiceWorkerConfig,
    unregisterServiceWorker,
    getRegistrations,

    // URL 模板处理
    hasSubpath,
    generateProxyUrl,
    compileTemplateRegex,
    extractTemplatePath,
    normalizeUrl
  };

  // 支持多种模块系统
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SwClient;
  } else if (typeof define === 'function' && define.amd) {
    define(function () { return SwClient; });
  } else {
    global.SwClient = SwClient;
  }

})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
