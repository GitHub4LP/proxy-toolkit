// 端口管理服务前端应用
class PortApp {
    constructor() {
        this.basePath = window.location.pathname.replace(/\/$/, '');
        this.serviceWorkerStates = new Map(); // 存储每个端口的 Service Worker 状态
        this.addPortTimeout = null; // 防抖定时器
        this.needsUrlEncoding = null; // nginx 编码检测结果
        this.needsChineseEncoding = false; // 中文字符是否需要编码
        this.needsSlashEncoding = false; // %2F 是否需要编码
        this.needsPercentEncoding = false; // %25 是否需要编码
        this.needsDoubleEncoding = false; // 双重编码是否需要处理
        this.nginxDecodeDepth = 0; // nginx 解码深度
        this.recommendedEncodingLayers = 2; // 推荐编码层数
        this.setupPortInput();
        this.initServiceWorkerSupport();
        
        // 先检测Service Worker状态，再刷新端口
        this.initializeApp();
        
        // 定期刷新端口信息
        setInterval(() => {
            this.refreshPorts();
        }, 5000);
    }

    async initializeApp() {
        // 首先检测 nginx 编码行为
        await this.detectNginxEncoding();
        
        // 然后更新Service Worker状态
        await this.updateServiceWorkerStates();
        
        // 最后刷新端口列表
        await this.refreshPorts();
    }

    async detectNginxEncoding() {
        try {
            console.log('[编码检测] 开始检测 nginx 编码行为...');
            
            // 获取测试配置
            const response = await fetch(`${this.basePath}/api/nginx-encoding-test`);
            const testInfo = await response.json();
            console.log('[编码检测] 测试配置:', testInfo);
            
            // 检测中文字符编码
            await this.testChineseEncoding(testInfo.chinese_test_path);
            
            // 检测 %2F 编码
            await this.testSlashEncoding(testInfo.slash_test_path);
            
            // 检测 %25 编码
            await this.testPercentEncoding(testInfo.percent_test_path);
            
            // 检测双重编码
            await this.testDoubleEncoding(testInfo.double_encoding_test_path);
            
            // 检测多层编码 - 测试 nginx 递归解码深度
            await this.testMultiEncoding(testInfo.multi_encoding_test_path);
            
            // 渐进式编码检测 - 测试1层、2层、3层编码
            if (testInfo.progressive_encoding_tests) {
                await this.testProgressiveEncoding(testInfo.progressive_encoding_tests);
            }
            
            // 综合判断
            this.needsUrlEncoding = this.needsChineseEncoding || this.needsSlashEncoding || this.needsPercentEncoding || this.needsDoubleEncoding;
            
            console.log('[编码检测] 检测完成:');
            console.log('  - 中文字符需要编码:', this.needsChineseEncoding);
            console.log('  - %2F 需要编码:', this.needsSlashEncoding);
            console.log('  - %25 需要编码:', this.needsPercentEncoding);
            console.log('  - 双重编码需要处理:', this.needsDoubleEncoding);
            console.log('  - nginx 解码深度:', this.nginxDecodeDepth);
            console.log('  - 推荐编码层数:', this.recommendedEncodingLayers);
            console.log('  - 总体需要URL编码:', this.needsUrlEncoding);
            
        } catch (error) {
            console.error('[编码检测] 发生异常:', error);
            console.log('[编码检测] 异常类型:', error.constructor.name);
            console.log('[编码检测] 异常消息:', error.message);
            this.needsChineseEncoding = false;
            this.needsSlashEncoding = false;
            this.needsPercentEncoding = false;
            this.needsDoubleEncoding = false;
            this.nginxDecodeDepth = 0;
            this.recommendedEncodingLayers = 2;
            this.needsUrlEncoding = false; // 异常时默认不启用编码
        }
    }

    async testChineseEncoding(testPath) {
        console.log('[中文编码检测] 测试路径:', testPath);
        console.log('[中文编码检测] 完整URL:', `${this.basePath}${testPath}`);
        
        try {
            const testResponse = await fetch(`${this.basePath}${testPath}`);
            console.log('[中文编码检测] 响应状态:', testResponse.status);
            
            if (testResponse.ok) {
                const result = await testResponse.json();
                console.log('[中文编码检测] 成功 - nginx 没有自动解码中文');
                console.log('[中文编码检测] 响应内容:', result);
                this.needsChineseEncoding = false;
                
            } else if (testResponse.status === 400) {
                console.log('[中文编码检测] 400错误 - nginx 自动解码中文导致错误');
                this.needsChineseEncoding = true;
                
            } else {
                console.log('[中文编码检测] 其他错误，状态码:', testResponse.status);
                this.needsChineseEncoding = false;
            }
        } catch (error) {
            console.log('[中文编码检测] 请求异常:', error.message);
            this.needsChineseEncoding = false;
        }
    }

    async testSlashEncoding(testPath) {
        console.log('[%2F编码检测] 测试路径:', testPath);
        console.log('[%2F编码检测] 完整URL:', `${this.basePath}${testPath}`);
        
        try {
            const testResponse = await fetch(`${this.basePath}${testPath}`);
            console.log('[%2F编码检测] 响应状态:', testResponse.status);
            
            if (testResponse.ok) {
                const result = await testResponse.json();
                console.log('[%2F编码检测] 响应内容:', result);
                
                // 检查 %2F 是否被自动解码为 /
                if (result.contains_slash) {
                    console.log('[%2F编码检测] %2F 被自动解码为 / - 需要编码处理');
                    this.needsSlashEncoding = true;
                } else {
                    console.log('[%2F编码检测] %2F 保持编码状态 - 正常');
                    this.needsSlashEncoding = false;
                }
                
            } else if (testResponse.status === 400) {
                console.log('[%2F编码检测] 400错误 - 可能是路径解析问题');
                this.needsSlashEncoding = true;
                
            } else {
                console.log('[%2F编码检测] 其他错误，状态码:', testResponse.status);
                this.needsSlashEncoding = false;
            }
        } catch (error) {
            console.log('[%2F编码检测] 请求异常:', error.message);
            this.needsSlashEncoding = false;
        }
    }

    async testPercentEncoding(testPath) {
        console.log('[%25编码检测] 测试路径:', testPath);
        console.log('[%25编码检测] 完整URL:', `${this.basePath}${testPath}`);
        
        try {
            const testResponse = await fetch(`${this.basePath}${testPath}`);
            console.log('[%25编码检测] 响应状态:', testResponse.status);
            
            if (testResponse.ok) {
                const result = await testResponse.json();
                console.log('[%25编码检测] 响应内容:', result);
                
                // 检查 %25 是否被自动解码为 %
                if (result.has_percent) {
                    console.log('[%25编码检测] %25 被自动解码为 % - 需要编码处理');
                    this.needsPercentEncoding = true;
                } else {
                    console.log('[%25编码检测] %25 保持编码状态 - 正常');
                    this.needsPercentEncoding = false;
                }
                
            } else if (testResponse.status === 400) {
                console.log('[%25编码检测] 400错误 - 可能是路径解析问题');
                this.needsPercentEncoding = true;
                
            } else {
                console.log('[%25编码检测] 其他错误，状态码:', testResponse.status);
                this.needsPercentEncoding = false;
            }
        } catch (error) {
            console.log('[%25编码检测] 请求异常:', error.message);
            this.needsPercentEncoding = false;
        }
    }

    async testDoubleEncoding(testPath) {
        console.log('[双重编码检测] 测试路径:', testPath);
        console.log('[双重编码检测] 完整URL:', `${this.basePath}${testPath}`);
        
        try {
            const testResponse = await fetch(`${this.basePath}${testPath}`);
            console.log('[双重编码检测] 响应状态:', testResponse.status);
            
            if (testResponse.ok) {
                const result = await testResponse.json();
                console.log('[双重编码检测] 响应内容:', result);
                
                // 检查是否检测到双重解码
                if (result.double_decode_detected && result.double_decode_detected !== 'none') {
                    console.log(`[双重编码检测] 检测到双重解码: ${result.double_decode_detected} - 需要处理`);
                    this.needsDoubleEncoding = true;
                } else {
                    console.log('[双重编码检测] 未检测到双重解码 - 正常');
                    this.needsDoubleEncoding = false;
                }
                
            } else if (testResponse.status === 400) {
                console.log('[双重编码检测] 400错误 - 可能存在双重解码问题');
                this.needsDoubleEncoding = true;
                
            } else {
                console.log('[双重编码检测] 其他错误，状态码:', testResponse.status);
                this.needsDoubleEncoding = false;
            }
        } catch (error) {
            console.log('[双重编码检测] 请求异常:', error.message);
            this.needsDoubleEncoding = false;
        }
    }

    async testMultiEncoding(testPath) {
        console.log('[多层编码检测] 测试路径:', testPath);
        console.log('[多层编码检测] 完整URL:', `${this.basePath}${testPath}`);
        
        try {
            const testResponse = await fetch(`${this.basePath}${testPath}`);
            console.log('[多层编码检测] 响应状态:', testResponse.status);
            
            if (testResponse.ok) {
                const result = await testResponse.json();
                console.log('[多层编码检测] 响应内容:', result);
                
                // 分析 nginx 解码深度
                if (result.decode_depth !== undefined) {
                    this.nginxDecodeDepth = result.decode_depth;
                    this.recommendedEncodingLayers = result.recommended_encoding_layers || (this.nginxDecodeDepth + 2);
                    
                    console.log(`[多层编码检测] nginx 解码深度: ${this.nginxDecodeDepth}`);
                    console.log(`[多层编码检测] 推荐编码层数: ${this.recommendedEncodingLayers}`);
                    
                    // 显示详细的解码分析
                    if (result.decode_analysis && result.decode_analysis.length > 0) {
                        console.log(`[多层编码检测] 解码分析:`);
                        result.decode_analysis.forEach(analysis => {
                            console.log(`  - ${analysis}`);
                        });
                    }
                    
                    // 显示检测到的编码层次
                    if (result.encoding_layers_detected && result.encoding_layers_detected.length > 0) {
                        console.log(`[多层编码检测] 检测到的编码层次:`);
                        result.encoding_layers_detected.forEach(layer => {
                            console.log(`  - ${layer}`);
                        });
                    }
                } else {
                    console.log('[多层编码检测] 未获取到解码深度信息');
                    this.nginxDecodeDepth = 0;
                    this.recommendedEncodingLayers = 2;
                }
                
            } else if (testResponse.status === 400) {
                console.log('[多层编码检测] 400错误 - 可能存在多层解码问题');
                this.nginxDecodeDepth = 1; // 至少有一层解码
                this.recommendedEncodingLayers = 3;
                
            } else {
                console.log('[多层编码检测] 其他错误，状态码:', testResponse.status);
                this.nginxDecodeDepth = 0;
                this.recommendedEncodingLayers = 2;
            }
        } catch (error) {
            console.log('[多层编码检测] 请求异常:', error.message);
            this.nginxDecodeDepth = 0;
            this.recommendedEncodingLayers = 2;
        }
    }

    async testProgressiveEncoding(progressiveTests) {
        console.log('[渐进式编码检测] 开始测试 1-3 层编码...');
        
        const results = {};
        
        // 测试1层编码
        if (progressiveTests.layer_1) {
            console.log('[渐进式编码检测] 测试1层编码:', progressiveTests.layer_1);
            try {
                const response = await fetch(`${this.basePath}${progressiveTests.layer_1}`);
                if (response.ok) {
                    const result = await response.json();
                    results.layer_1 = result;
                    console.log('[渐进式编码检测] 1层编码结果:', result.nginx_strategy);
                } else {
                    console.log('[渐进式编码检测] 1层编码请求失败:', response.status);
                }
            } catch (error) {
                console.log('[渐进式编码检测] 1层编码异常:', error.message);
            }
        }
        
        // 测试2层编码
        if (progressiveTests.layer_2) {
            console.log('[渐进式编码检测] 测试2层编码:', progressiveTests.layer_2);
            try {
                const response = await fetch(`${this.basePath}${progressiveTests.layer_2}`);
                if (response.ok) {
                    const result = await response.json();
                    results.layer_2 = result;
                    console.log('[渐进式编码检测] 2层编码结果:', result.nginx_strategy);
                } else {
                    console.log('[渐进式编码检测] 2层编码请求失败:', response.status);
                }
            } catch (error) {
                console.log('[渐进式编码检测] 2层编码异常:', error.message);
            }
        }
        
        // 测试3层编码
        if (progressiveTests.layer_3) {
            console.log('[渐进式编码检测] 测试3层编码:', progressiveTests.layer_3);
            try {
                const response = await fetch(`${this.basePath}${progressiveTests.layer_3}`);
                if (response.ok) {
                    const result = await response.json();
                    results.layer_3 = result;
                    console.log('[渐进式编码检测] 3层编码结果:', result.nginx_strategy);
                } else {
                    console.log('[渐进式编码检测] 3层编码请求失败:', response.status);
                }
            } catch (error) {
                console.log('[渐进式编码检测] 3层编码异常:', error.message);
            }
        }
        
        // 分析nginx解码策略
        this.analyzeNginxDecodingStrategy(results);
    }

    analyzeNginxDecodingStrategy(progressiveResults) {
        console.log('[nginx解码策略分析] 开始分析...');
        
        let decodingStrategy = '未知';
        let confidence = '低';
        let decodeLayers = 0;
        
        // 分析1层编码结果
        if (progressiveResults.layer_1) {
            const layer1Strategy = progressiveResults.layer_1.nginx_strategy;
            console.log(`[nginx解码策略分析] 1层编码策略: ${layer1Strategy}`);
            
            if (layer1Strategy.includes('完全解码为原始字符')) {
                decodeLayers = Math.max(decodeLayers, 1);
            }
        }
        
        // 分析2层编码结果
        if (progressiveResults.layer_2) {
            const layer2Strategy = progressiveResults.layer_2.nginx_strategy;
            console.log(`[nginx解码策略分析] 2层编码策略: ${layer2Strategy}`);
            
            if (layer2Strategy.includes('完全解码为原始字符')) {
                decodeLayers = Math.max(decodeLayers, 2);
                decodingStrategy = '递归解码';
                confidence = '高';
            } else if (layer2Strategy.includes('解码1层为%2F')) {
                decodeLayers = Math.max(decodeLayers, 1);
                decodingStrategy = '单次解码一层';
                confidence = '高';
            } else if (layer2Strategy.includes('未解码')) {
                decodingStrategy = '不解码';
                confidence = '中';
            }
        }
        
        // 分析3层编码结果
        if (progressiveResults.layer_3) {
            const layer3Strategy = progressiveResults.layer_3.nginx_strategy;
            console.log(`[nginx解码策略分析] 3层编码策略: ${layer3Strategy}`);
            
            if (layer3Strategy.includes('完全解码为原始字符')) {
                decodeLayers = Math.max(decodeLayers, 3);
                decodingStrategy = '深度递归解码';
                confidence = '很高';
            } else if (layer3Strategy.includes('解码2层为%2F')) {
                decodeLayers = Math.max(decodeLayers, 2);
                decodingStrategy = '递归解码';
                confidence = '很高';
            } else if (layer3Strategy.includes('解码1层为%252F')) {
                decodeLayers = Math.max(decodeLayers, 1);
                if (decodingStrategy === '单次解码一层') {
                    confidence = '很高';
                }
            }
        }
        
        console.log(`[nginx解码策略分析] 检测到解码层数: ${decodeLayers}`);
        console.log(`[nginx解码策略分析] 最终结论: ${decodingStrategy} (置信度: ${confidence})`);
        
        // 根据策略调整编码建议
        if (decodeLayers >= 2) {
            console.log(`[nginx解码策略分析] 建议: nginx会解码${decodeLayers}层，建议使用${decodeLayers + 2}层编码`);
            this.recommendedEncodingLayers = decodeLayers + 2;
            this.nginxDecodeDepth = decodeLayers;
        } else if (decodeLayers === 1) {
            console.log('[nginx解码策略分析] 建议: nginx只解码1层，使用2-3层编码即可');
            this.recommendedEncodingLayers = 3;
            this.nginxDecodeDepth = 1;
        } else {
            console.log('[nginx解码策略分析] 建议: nginx不解码或解码行为未知，保持默认策略');
        }
    }

    setupPortInput() {
        const portInput = document.getElementById('portInput');
        
        // 监听输入事件，实现防抖自动添加
        portInput.addEventListener('input', (e) => {
            const port = e.target.value.trim();
            
            // 清除之前的定时器
            if (this.addPortTimeout) {
                clearTimeout(this.addPortTimeout);
            }
            
            // 如果输入为空，不处理
            if (!port) return;
            
            // 验证端口号格式
            const portNum = parseInt(port);
            if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
                return;
            }
            
            // 设置防抖定时器，1秒后自动添加
            this.addPortTimeout = setTimeout(() => {
                this.addPortAuto(portNum);
            }, 1000);
        });
        
        // 保留回车键直接添加的功能
        portInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                // 清除防抖定时器
                if (this.addPortTimeout) {
                    clearTimeout(this.addPortTimeout);
                }
                this.addPort();
            }
        });
    }

    initServiceWorkerSupport() {
        // 检查浏览器是否支持 Service Worker
        this.swSupported = 'serviceWorker' in navigator;
        this.isSubpath = this.basePath !== '';
    }

    async cleanupExistingServiceWorkers() {
        if ('serviceWorker' in navigator) {
            try {
                const registrations = await navigator.serviceWorker.getRegistrations();
                for (const registration of registrations) {
                    // 注销所有相关的Service Worker
                    if (registration.scope.includes('/proxy/')) {
                        await registration.unregister();
                        // 已清理Service Worker
                    }
                }
                // 清理后刷新显示
                this.displayServiceWorkerInfo();
            } catch (error) {
                console.error('清理Service Worker失败:', error);
            }
        }
    }

    async updateServiceWorkerStates() {
        if (!('serviceWorker' in navigator)) return;

        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            
            // 只处理 subpath_service_worker.js 相关的 Service Worker
            const subpathSWs = registrations.filter(registration => {
                const scriptURL = registration.active ? registration.active.scriptURL : 
                                 registration.waiting ? registration.waiting.scriptURL :
                                 registration.installing ? registration.installing.scriptURL : '';
                return scriptURL.includes('subpath_service_worker.js');
            });
            
            // 清空现有状态
            this.serviceWorkerStates.clear();
            
            // 为每个已注册的Service Worker更新状态
            subpathSWs.forEach(registration => {
                const scope = registration.scope;
                
                // 从scope中提取端口号
                const port = this.extractPortFromScope(scope);
                if (port) {
                    const state = registration.active ? 'active' : 
                                 registration.waiting ? 'waiting' : 
                                 registration.installing ? 'installing' : 'unknown';
                    
                    this.serviceWorkerStates.set(port, {
                        registered: true,
                        loading: false,
                        scope: new URL(scope).pathname,
                        registration: registration,
                        state: state
                    });
                }
            });
            
        } catch (error) {
            // Service Worker状态更新失败
        }
    }

    extractPortFromScope(scope) {
        // 从scope URL中提取端口号
        // 支持多种格式:
        // - https://domain.com/notebook_xxx/proxy/8188/ -> 8188
        // - /proxy/3000/ -> 3000
        // - /user/xxx/proxy/8080/ -> 8080
        try {
            const url = new URL(scope);
            const pathParts = url.pathname.split('/').filter(part => part !== '');
            
            // 查找 'proxy' 关键字后面的数字
            const proxyIndex = pathParts.indexOf('proxy');
            if (proxyIndex !== -1 && proxyIndex + 1 < pathParts.length) {
                const portStr = pathParts[proxyIndex + 1];
                const port = parseInt(portStr);
                if (!isNaN(port) && port > 0 && port <= 65535) {
                    return port;
                }
            }
            
            // 如果没找到 proxy 关键字，尝试查找路径中的数字端口
            for (const part of pathParts) {
                const port = parseInt(part);
                if (!isNaN(port) && port > 1000 && port <= 65535) {
                    // 只考虑大于1000的端口，避免误识别
                    return port;
                }
            }
            
        } catch (error) {
            // 解析scope失败
        }
        return null;
    }

    generateProxyUrlForPort(port) {
        // 基于当前路径生成代理URL
        // 支持多种路径格式:
        // - /notebook_xxx/proxy/3000/ -> /notebook_xxx/proxy/8188/
        // - /user/xxx/proxy/3000/ -> /user/xxx/proxy/8188/
        // - /proxy/3000/ -> /proxy/8188/
        
        const currentPath = window.location.pathname;
        const pathParts = currentPath.split('/').filter(part => part !== '');
        const proxyIndex = pathParts.indexOf('proxy');
        
        if (proxyIndex !== -1) {
            // 构建新的路径，替换端口号
            const newPathParts = [...pathParts];
            newPathParts[proxyIndex + 1] = port.toString();
            return '/' + newPathParts.join('/') + '/';
        }
        
        // 如果当前路径没有proxy，尝试基于basePath构建
        if (this.basePath) {
            // 移除末尾的端口管理服务路径，添加proxy路径
            const basePathParts = this.basePath.split('/').filter(part => part !== '');
            return '/' + basePathParts.join('/') + '/proxy/' + port + '/';
        }
        
        // 默认格式
        return `/proxy/${port}/`;
    }



    async unregisterSubpathServiceWorker(scope) {
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            const targetRegistration = registrations.find(reg => reg.scope === scope);
            
            if (targetRegistration) {
                const port = this.extractPortFromScope(scope);
                await targetRegistration.unregister();
                
                // 更新状态
                if (port) {
                    this.serviceWorkerStates.delete(port);
                }
                
                // 刷新显示
                this.refreshPorts();
            } else {
                console.warn('未找到对应的 Service Worker');
            }
        } catch (error) {
            // 注销失败
        }
    }

    async addPort() {
        const portInput = document.getElementById('portInput');
        const port = portInput.value;
        
        if (!port || port < 1 || port > 65535) {
            console.warn('请输入有效的端口号');
            return;
        }

        try {
            await fetch(`${this.basePath}/api/port/${port}`);
            portInput.value = '';
            this.refreshPorts();
        } catch (error) {
            // 添加端口失败
        }
    }

    async addPortAuto(port) {
        // 自动添加端口，不显示警告信息
        try {
            await fetch(`${this.basePath}/api/port/${port}`);
            // 清空输入框
            document.getElementById('portInput').value = '';
            this.refreshPorts();
        } catch (error) {
            // 自动添加失败，静默处理
        }
    }

    async refreshPorts() {
        try {
            const response = await fetch(`${this.basePath}/api/ports`);
            const ports = await response.json();
            
            // 同时更新Service Worker状态
            await this.updateServiceWorkerStates();
            
            this.displayPorts(ports);
        } catch (error) {
            document.getElementById('portTableBody').innerHTML = '<tr><td colspan="5" class="error">获取端口列表失败</td></tr>';
        }
    }

    displayPorts(ports) {
        const tbody = document.getElementById('portTableBody');
        
        // 合并后端端口和已注册Service Worker的端口
        const allPorts = new Map();
        
        // 添加后端返回的端口
        ports.forEach(port => {
            allPorts.set(port.port, {
                ...port,
                source: 'backend'
            });
        });
        
        // 添加已注册Service Worker的端口（如果不在后端列表中）
        this.serviceWorkerStates.forEach((swState, port) => {
            if (!allPorts.has(port)) {
                // 仅Service Worker的端口，生成代理URL
                const proxyUrl = this.generateProxyUrlForPort(port);
                allPorts.set(port, {
                    port: port,
                    is_listening: false,
                    process_name: null,
                    proxy_url: proxyUrl,
                    source: 'service_worker',
                    sw_state: swState.state
                });
            } else {
                // 如果端口在后端列表中，标记它有Service Worker
                const existingPort = allPorts.get(port);
                existingPort.has_service_worker = true;
                existingPort.sw_state = swState.state;
            }
        });
        
        const allPortsArray = Array.from(allPorts.values()).sort((a, b) => a.port - b.port);
        
        if (allPortsArray.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="no-ports">暂无端口数据</td></tr>';
            return;
        }

        tbody.innerHTML = allPortsArray.map(port => {
            // 监听状态图标 - 只显示端口的监听状态
            let listenIcon;
            if (port.source === 'service_worker') {
                // 仅Service Worker的端口，显示为未监听
                listenIcon = '<span class="status-icon closed" title="未监听">●</span>';
            } else if (port.is_listening) {
                listenIcon = '<span class="status-icon listening" title="监听中">●</span>';
            } else {
                listenIcon = '<span class="status-icon closed" title="未监听">●</span>';
            }
            
            // 进程信息
            const processInfo = this.formatProcessInfo(port);
            
            // URL链接
            const urlCell = port.proxy_url ? 
                `<a href="${this.getAbsoluteUrl(port.proxy_url)}" target="_blank" class="url-link">${port.proxy_url}</a>` : 
                'N/A';
            
            // Service Worker 补丁图标
            const swState = this.serviceWorkerStates.get(port.port) || { registered: false, loading: false };
            const swIcon = this.swSupported && this.isSubpath && port.proxy_url ? 
                this.generateSwIcon(port.port, swState) : 
                '<span class="sw-icon disabled" title="不支持">⚫</span>';
            
            return `
                <tr class="${port.source === 'service_worker' ? 'sw-only-row' : ''}">
                    <td class="status-cell">${listenIcon}</td>
                    <td class="port-cell">${port.port}</td>
                    <td class="url-cell">${urlCell}</td>
                    <td class="process-cell">${processInfo}</td>
                    <td class="sw-cell">${swIcon}</td>
                </tr>
            `;
        }).join('');
    }

    generateSwIcon(port, swState) {
        if (swState.loading) {
            return '<span class="sw-icon loading" title="处理中...">🔄</span>';
        }
        
        const isRegistered = swState.registered;
        const action = isRegistered ? 'unregisterServiceWorker' : 'registerServiceWorker';
        
        if (isRegistered) {
            // 注册成功 - 绿色补丁图标
            const stateInfo = swState.state ? ` (${swState.state})` : '';
            return `<span class="sw-icon registered" onclick="app.${action}(${port})" title="已注册 subpath_service_worker.js${stateInfo}，点击注销">🟢</span>`;
        } else if (swState.failed) {
            // 注册失败 - 红色补丁图标
            return `<span class="sw-icon failed" onclick="app.${action}(${port})" title="注册失败，点击重试">🔴</span>`;
        } else {
            // 未注册 - 黄色补丁图标
            return `<span class="sw-icon unregistered" onclick="app.${action}(${port})" title="未注册 subpath_service_worker.js，点击注册">🟡</span>`;
        }
    }

    formatProcessInfo(port) {
        // 当端口未被监听时，显示为空
        if (!port.is_listening || port.source === 'service_worker') {
            return '';
        }
        
        // 当端口被监听时，显示完整的PID和命令行信息
        if (port.process_pid && port.process_cmdline) {
            const pid = port.process_pid;
            const fullCmdline = port.process_cmdline;
            
            // 截断过长的命令行，保持合理的显示长度
            const maxLength = 60;
            let displayCmdline = fullCmdline;
            if (fullCmdline.length > maxLength) {
                displayCmdline = fullCmdline.substring(0, maxLength) + '...';
            }
            
            // 如果命令行被截断，添加title属性显示完整内容
            const titleAttr = fullCmdline.length > maxLength ? ` title="${this.escapeHtml(fullCmdline)}"` : '';
            
            return `<span class="process-info"${titleAttr}>(${pid}) ${this.escapeHtml(displayCmdline)}</span>`;
        }
        
        // 如果只有进程名，显示进程名
        if (port.process_name) {
            return `<span class="process-info">${this.escapeHtml(port.process_name)}</span>`;
        }
        
        // 其他情况显示为空
        return '';
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getAbsoluteUrl(url) {
        // 如果URL以/开头，说明是绝对路径，需要加上协议和域名
        if (url.startsWith('/')) {
            return window.location.protocol + '//' + window.location.host + url;
        }
        // 否则返回原URL
        return url;
    }



    async checkServiceWorkerStatus(port, proxyUrl) {
        if (!this.swSupported) return;
        
        try {
            const url = new URL(proxyUrl, window.location.origin);
            let scope = url.pathname;
            
            // 确保作用域以 / 结尾
            if (!scope.endsWith('/')) {
                scope += '/';
            }
            
            const registrations = await navigator.serviceWorker.getRegistrations();
            const matchedRegistration = registrations.find(reg => {
                // 精确匹配作用域
                const regScope = new URL(reg.scope).pathname;
                return regScope === scope;
            });
            
            this.serviceWorkerStates.set(port, { 
                registered: !!matchedRegistration, 
                loading: false,
                scope: scope,
                registration: matchedRegistration
            });
        } catch (error) {
            // 检查Service Worker状态失败
        }
    }

    async registerServiceWorker(port) {
        if (!this.swSupported) {
            console.warn('浏览器不支持 Service Worker');
            return;
        }

        // 设置加载状态
        this.serviceWorkerStates.set(port, { 
            ...this.serviceWorkerStates.get(port), 
            loading: true 
        });
        this.refreshPortDisplay();

        try {
            // 获取端口信息
            const response = await fetch(`${this.basePath}/api/port/${port}`);
            const portInfo = await response.json();
            
            if (!portInfo.proxy_url) {
                throw new Error('该端口没有代理 URL');
            }

            const url = new URL(portInfo.proxy_url, window.location.origin);
            let scope = url.pathname;
            
            // 确保作用域以 / 结尾
            if (!scope.endsWith('/')) {
                scope += '/';
            }
            
            // 使用模板 Service Worker，通过 URL 参数传递编码配置
            // 暂时关闭中文编码，处理 %2F 和 %25 编码，以及多层编码
            const swScriptPath = `${this.basePath}/subpath_service_worker.js?chinese=false&slash=${this.needsSlashEncoding}&percent=${this.needsPercentEncoding}&decode_depth=${this.nginxDecodeDepth}&encoding_layers=${this.recommendedEncodingLayers}`;
            
            console.log(`[SW注册] 使用模板 Service Worker，中文编码: ${this.needsChineseEncoding} (暂时关闭)，%2F编码: ${this.needsSlashEncoding}，%25编码: ${this.needsPercentEncoding}，解码深度: ${this.nginxDecodeDepth}，编码层数: ${this.recommendedEncodingLayers}`);
            
            // 注册 Service Worker
            const registration = await navigator.serviceWorker.register(
                swScriptPath,
                { scope: scope }
            );

            // 等待 Service Worker 激活（带超时）
            if (registration.installing) {
                const installingWorker = registration.installing;
                await Promise.race([
                    new Promise((resolve) => {
                        installingWorker.addEventListener('statechange', () => {
                            if (installingWorker.state === 'activated' || installingWorker.state === 'redundant') {
                                resolve();
                            }
                        });
                    }),
                    new Promise((resolve) => setTimeout(resolve, 5000)) // 5秒超时
                ]);
            }

            this.serviceWorkerStates.set(port, { 
                registered: true, 
                loading: false,
                scope: scope,
                registration: registration
            });
            
            // 刷新界面显示
            this.refreshPortDisplay();
            
        } catch (error) {
            // 注册Service Worker失败
            this.serviceWorkerStates.set(port, { 
                registered: false, 
                loading: false,
                failed: true
            });
        }
        
        this.refreshPortDisplay();
    }

    async unregisterServiceWorker(port) {
        if (!this.swSupported) return;

        // 设置加载状态
        this.serviceWorkerStates.set(port, { 
            ...this.serviceWorkerStates.get(port), 
            loading: true 
        });
        this.refreshPortDisplay();

        try {
            const swState = this.serviceWorkerStates.get(port);
            
            // 优先使用保存的 registration 对象
            if (swState && swState.registration) {
                await swState.registration.unregister();
            } else {
                // 回退到查找方式
                const registrations = await navigator.serviceWorker.getRegistrations();
                let found = false;
                
                for (const registration of registrations) {
                    // 检查作用域是否匹配
                    if (swState && swState.scope) {
                        const regScope = new URL(registration.scope).pathname;
                        if (regScope === swState.scope) {
                            await registration.unregister();
                            found = true;
                            break;
                        }
                    }
                }
                
                if (found) {
                    console.log(`端口 ${port} 的 Service Worker 注销成功！`);
                } else {
                    console.warn(`未找到端口 ${port} 对应的 Service Worker，可能已经被注销`);
                }
            }

            this.serviceWorkerStates.set(port, { 
                registered: false, 
                loading: false 
            });
            
        } catch (error) {
            // 注销Service Worker失败
            this.serviceWorkerStates.set(port, { 
                ...this.serviceWorkerStates.get(port), 
                loading: false 
            });
        }
        
        this.refreshPortDisplay();
    }

    async refreshPortDisplay() {
        // 重新渲染端口列表（不重新获取数据）
        try {
            const response = await fetch(`${this.basePath}/api/ports`);
            const ports = await response.json();
            this.displayPorts(ports);
        } catch (error) {
            // 刷新端口显示失败
        }
    }


}

// 全局函数已移除，现在使用自动添加功能

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    window.app = new PortApp();
});