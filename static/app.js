// Port management service frontend app
class PortApp {
    constructor() {
        this.basePath = window.location.pathname.replace(/\/$/, '');
        this.serviceWorkerStates = new Map(); // Store Service Worker states for each port
        this.portDecodeDepths = new Map(); // Store decode depth settings for each port
        this.portStrategies = new Map(); // Store strategy selection for each port (subpath/tunnel)
        this.addPortTimeout = null; // Debounce timer
        this.nginxDecodeDepth = 0; // nginx decode depth
        
        // URL template related
        this.urlTemplate = null;
        this.hasProxySupport = false;
        this.templateRegex = null; // Cache compiled regex
        
        this.loadPortStrategies(); // Load saved strategy settings
        this.setupPortInput();
        this.initServiceWorkerSupport();
        
        // First detect Service Worker status, then refresh ports
        this.initializeApp();
        
        // 定期刷新端口信息
        setInterval(() => {
            this.refreshPorts();
        }, 5000);
    }

    async initializeApp() {
        // 1. 首先加载URL模板
        await this.loadUrlTemplate();
        
        // 2. 如果有代理支持，进行nginx编码检测
        if (this.hasProxySupport) {
            await this.detectNginxEncoding();
        }
        
        // 3. 更新Service Worker状态
        await this.updateServiceWorkerStates();
        
        // 4. 刷新端口列表
        await this.refreshPorts();
    }

    async loadUrlTemplate() {
        try {
            const response = await fetch(`${this.basePath}/api/url-template`);
            const data = await response.json();
            
            this.urlTemplate = data.template;
            this.hasProxySupport = data.has_proxy_support;
            
            // 预编译正则表达式
            if (this.urlTemplate) {
                this.templateRegex = this.compileTemplateRegex(this.urlTemplate);
                console.log(`[Template] ${this.urlTemplate}`);
            } else {
                console.log('[Template] No proxy support');
            }
            
            // 重新设置Service Worker启用状态
            this.swEnabled = this.swSupported && this.isSubpath && this.hasProxySupport;
            console.log(`[SW] Enabled: ${this.swEnabled}`);
            
        } catch (error) {
            console.warn('[Template] Load failed:', error);
            this.urlTemplate = null;
            this.hasProxySupport = false;
            this.swEnabled = false;
        }
    }

    compileTemplateRegex(template) {
        // 手动提取模板路径，避免URL构造函数对占位符的副作用
        const templatePath = this.extractTemplatePathManually(template);
        
        // 转义正则特殊字符
        const escaped = templatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 将{{port}}替换为数字捕获组
        const pattern = escaped.replace('\\{\\{port\\}\\}', '(\\d+)');
        

        return new RegExp(pattern);
    }

    extractTemplatePathManually(template) {
        // 手动提取路径部分，不使用 new URL() 避免对占位符的编码处理
        if (template.startsWith('http://') || template.startsWith('https://')) {
            const protocolEnd = template.indexOf('://') + 3;
            const hostEnd = template.indexOf('/', protocolEnd);
            return hostEnd !== -1 ? template.substring(hostEnd) : '/';
        }
        return template.startsWith('/') ? template : '/' + template;
    }

    normalizeUrl(url) {
        // 统一URL格式处理
        try {
            if (url.startsWith('http')) {
                return new URL(url).pathname;
            }
            return url.startsWith('/') ? url : '/' + url;
        } catch {
            return url;
        }
    }

    isOurServiceWorker(scriptURL) {
        // 检查Service Worker脚本是否来自当前服务
        if (!scriptURL) return false;
        
        try {
            const currentOrigin = window.location.origin;
            const currentBasePath = this.basePath;
            const expectedScriptPrefix = `${currentOrigin}${currentBasePath}/`;
            
            // 检查脚本URL是否以当前服务的前缀开始
            if (!scriptURL.startsWith(expectedScriptPrefix)) {
                return false;
            }
            
            // 检查是否是我们的Service Worker脚本
            const scriptName = scriptURL.substring(expectedScriptPrefix.length);
            const isOurScript = scriptName.startsWith('subpath_service_worker.js') || 
                               scriptName.startsWith('tunnel_service_worker.js');
            

            return isOurScript;
            
        } catch (error) {

            return false;
        }
    }

    async detectNginxEncoding() {
        try {
            const testSegment = "test/path";  // 原始测试路径段
            let maxLayers = 4;  // 初始最大检测层数
            const maxAttempts = 8;  // 最大尝试层数上限
            
            // 基准状态：编码一次后的状态（浏览器发送URL的标准状态）
            const baseEncoded = encodeURIComponent(testSegment);  // "test%2Fpath"
            
            while (maxLayers <= maxAttempts) {
                // 在基准状态基础上进行额外编码
                let encodedSegment = baseEncoded;
                for (let i = 0; i < maxLayers; i++) {
                    encodedSegment = encodeURIComponent(encodedSegment);
                }
                
                // 发送检测请求
                const response = await fetch(`${this.basePath}/api/test-encoding/${encodedSegment}`);
                
                if (!response.ok) {
                    this.nginxDecodeDepth = 0;
                    break;
                }
                
                const result = await response.json();
                
                // 计算nginx解码深度：将result.path重新编码，看需要编码多少次能回到原始发送的encodedSegment
                let current = result.path;
                let encodeSteps = 0;
                
                // 逐步编码，直到匹配原始发送的encodedSegment或达到最大层数
                while (current !== encodedSegment && encodeSteps < maxLayers) {
                    current = encodeURIComponent(current);
                    encodeSteps++;
                }
                
                // 如果能编码回到原始发送的encodedSegment，那么nginx解码深度就是encodeSteps
                const detectedDepth = (current === encodedSegment) ? encodeSteps : 0;
                
                // 验证检测结果
                const verified = await this.verifyNginxDecodeDepth(baseEncoded, detectedDepth);
                if (verified) {
                    this.nginxDecodeDepth = detectedDepth;
                    console.log(`[Encoding] Depth: ${this.nginxDecodeDepth}`);
                    return;
                } else {
                    console.warn(`[Encoding] Layer ${maxLayers} failed, retrying`);
                }
                
                // 增加检测层数重试
                maxLayers++;
            }
            
            // 所有尝试都失败，设置为0
            this.nginxDecodeDepth = 0;
            console.warn(`[Encoding] Max attempts reached, set to 0`);
            
        } catch (error) {
            console.error('[Encoding] Exception:', error);
            this.nginxDecodeDepth = 0;
        }
    }

    async verifyNginxDecodeDepth(baseEncoded, detectedDepth) {
        try {
            // 用检测到的解码深度进行反向验证
            let verifySegment = baseEncoded;
            for (let i = 0; i < detectedDepth; i++) {
                verifySegment = encodeURIComponent(verifySegment);
            }
            
            // 发送验证请求
            const verifyResponse = await fetch(`${this.basePath}/api/test-encoding/${verifySegment}`);
            if (verifyResponse.ok) {
                const verifyResult = await verifyResponse.json();
                // 验证nginx是否确实解码到了基准状态
                return verifyResult.path === baseEncoded;
            }
            return false;
        } catch (error) {
            console.error('[Encoding] Verification exception:', error);
            return false;
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
        
        // 只有在有代理支持时才启用Service Worker功能
        this.swEnabled = this.swSupported && this.isSubpath && this.hasProxySupport;
    }

    async cleanupExistingServiceWorkers() {
        if (!('serviceWorker' in navigator)) return;

        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            let cleanedCount = 0;
            
            for (const registration of registrations) {
                const scriptURL = registration.active?.scriptURL || 
                                 registration.waiting?.scriptURL ||
                                 registration.installing?.scriptURL || '';
                
                // 检查Service Worker是否来自当前服务
                if (this.isOurServiceWorker(scriptURL)) {
                    await registration.unregister();
                    cleanedCount++;
                    console.log(`[SW Cleanup] Cleaned: ${scriptURL}`);
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`[SW Cleanup] Cleaned ${cleanedCount} Service Workers`);
                this.displayServiceWorkerInfo();
            }
        } catch (error) {
            console.error('[SW Cleanup] Failed:', error);
        }
    }

    async updateServiceWorkerStates() {
        if (!('serviceWorker' in navigator) || !this.hasProxySupport) return;

        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            
            // 清空现有状态
            this.serviceWorkerStates.clear();
            
            for (const registration of registrations) {
                const scriptURL = registration.active?.scriptURL || 
                                 registration.waiting?.scriptURL ||
                                 registration.installing?.scriptURL || '';
                
                // 只处理来自当前服务的Service Worker
                if (!this.isOurServiceWorker(scriptURL)) {
                    continue;
                }
                
                // 从scope中提取端口号
                const port = this.extractPortFromScope(registration.scope);
                if (port) {
                    const state = registration.active ? 'active' : 
                                 registration.waiting ? 'waiting' : 
                                 registration.installing ? 'installing' : 'unknown';
                    
                    this.serviceWorkerStates.set(port, {
                        registered: true,
                        loading: false,
                        scope: this.normalizeUrl(registration.scope),
                        registration: registration,
                        state: state
                    });
                    
                    console.log(`[SW State] Port ${port}: ${state} (script: ${scriptURL})`);
                } else {
                    console.warn(`[SW State] Cannot extract port from scope, ignoring: ${registration.scope} (script: ${scriptURL})`);
                }
            }
            
        } catch (error) {
            console.error('[SW State] Update failed:', error);
        }
    }

    extractPortFromScope(scope) {
        if (!this.templateRegex) {

            return null;
        }
        
        // 规范化scope路径
        const normalizedScope = this.normalizeUrl(scope);
        
        // 使用预编译的正则匹配
        const match = normalizedScope.match(this.templateRegex);
        if (match && match[1]) {
            const port = parseInt(match[1]);

            return port;
        }
        
        // 对于无法匹配的scope，输出调试信息

        return null;
    }

    generateProxyUrlForPort(port) {
        if (!this.urlTemplate) {

            return null;
        }
        
        const proxyUrl = this.urlTemplate.replace('{{port}}', port.toString());

        return proxyUrl;
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
                console.warn('Service Worker not found');
            }
        } catch (error) {
            // 注销失败
        }
    }

    async addPort() {
        const portInput = document.getElementById('portInput');
        const port = portInput.value;
        
        if (!port || port < 1 || port > 65535) {
            console.warn('Please enter valid port number');
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
            document.getElementById('portTableBody').innerHTML = '<tr><td colspan="8" class="error">Failed to get port list</td></tr>';
        }
    }

    displayPorts(ports) {
        const tbody = document.getElementById('portTableBody');
        
        // 根据代理支持情况调整表头显示
        this.updateTableHeaders();
        
        // 合并端口数据
        const allPorts = this.mergePortData(ports);
        
        if (allPorts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="no-ports">No port data</td></tr>';
            return;
        }

        tbody.innerHTML = allPorts.map(port => this.renderPortRow(port)).join('');
    }

    updateTableHeaders() {
        // 根据hasProxySupport动态显示/隐藏相关列
        const proxyColumns = document.querySelectorAll('.proxy-column');
        proxyColumns.forEach(col => {
            col.style.display = this.hasProxySupport ? '' : 'none';
        });
    }

    mergePortData(ports) {
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
        
        return Array.from(allPorts.values()).sort((a, b) => a.port - b.port);
    }

    renderPortRow(port) {
        // 监听状态图标
        let listenIcon;
        if (port.source === 'service_worker') {
            listenIcon = '<span class="status-icon closed" title="Not listening">●</span>';
        } else if (port.is_listening) {
            listenIcon = '<span class="status-icon listening" title="Listening">●</span>';
        } else {
            listenIcon = '<span class="status-icon closed" title="Not listening">●</span>';
        }
        
        // 进程信息
        const processInfo = this.formatProcessInfo(port);
        
        // URL链接 - 只有在有代理支持时才显示
        const urlCell = this.hasProxySupport && port.proxy_url ? 
            `<a href="${this.getAbsoluteUrl(port.proxy_url)}" target="_blank" class="url-link">${port.proxy_url}</a>` : 
            '<span class="no-proxy">No proxy support</span>';
        
        // Service Worker相关控件 - 只有在有代理支持时才显示
        const swControls = this.hasProxySupport ? this.renderServiceWorkerControls(port) : 
            '<span class="no-proxy">N/A</span>';
        
        return `
            <tr class="${port.source === 'service_worker' ? 'sw-only-row' : ''}">
                <td class="status-cell">${listenIcon}</td>
                <td class="port-cell">${port.port}</td>
                <td class="url-cell proxy-column">${urlCell}</td>
                <td class="process-cell">${processInfo}</td>
                <td class="decode-depth-cell proxy-column">${swControls.decodeDepth}</td>
                <td class="sw-cell proxy-column">${swControls.swIcon}</td>
                <td class="strategy-cell proxy-column">${swControls.strategy}</td>
            </tr>
        `;
    }

    renderServiceWorkerControls(port) {
        // 解码深度输入框
        if (!this.portDecodeDepths.has(port.port)) {
            this.portDecodeDepths.set(port.port, this.nginxDecodeDepth);
        }
        const currentDecodeDepth = this.portDecodeDepths.get(port.port);
        const decodeDepthInput = this.swEnabled && port.proxy_url ? 
            `<input type="number" class="decode-depth-input" value="${currentDecodeDepth}" min="0" max="10" 
             onchange="app.updatePortDecodeDepth(${port.port}, this.value)" 
             title="nginx decode depth (default: ${this.nginxDecodeDepth})">` :
            '<span class="decode-depth-disabled">N/A</span>';
        
        // Service Worker 补丁图标
        const swState = this.serviceWorkerStates.get(port.port) || { registered: false, loading: false };
        const swIcon = this.swEnabled && port.proxy_url ? 
            this.generateSwIcon(port.port, swState) : 
            '<span class="sw-icon disabled" title="Not supported">⚫</span>';
        
        // 策略选择下拉框
        const currentStrategy = this.getPortStrategy(port.port);
        const strategySelect = this.swEnabled && port.proxy_url ? 
            `<select class="strategy-select" onchange="app.switchPortStrategy(${port.port}, this.value)">
                <option value="subpath" ${currentStrategy === 'subpath' ? 'selected' : ''}>Subpath Fix</option>
                <option value="tunnel" ${currentStrategy === 'tunnel' ? 'selected' : ''}>HTTP Tunnel</option>
            </select>` :
            '<span class="strategy-disabled">N/A</span>';
        
        return {
            decodeDepth: decodeDepthInput,
            swIcon: swIcon,
            strategy: strategySelect
        };
    }

    generateSwIcon(port, swState) {
        if (swState.loading) {
            return '<span class="sw-icon loading" title="Processing...">🔄</span>';
        }
        
        const currentStrategy = this.getPortStrategy(port);
        const isRegistered = swState.registered;
        const action = isRegistered ? 'unregisterPortServiceWorker' : 'registerPortServiceWorker';
        
        // 根据策略显示不同的Service Worker类型
        const strategyName = currentStrategy === 'tunnel' ? 'tunnel_service_worker.js' : 'subpath_service_worker.js';
        const strategyTitle = currentStrategy === 'tunnel' ? 'HTTP Tunnel' : 'Subpath Fix';
        
        if (isRegistered) {
            // 注册成功 - 绿色补丁图标
            const stateInfo = swState.state ? ` (${swState.state})` : '';
            return `<span class="sw-icon registered" onclick="app.${action}(${port})" title="Registered ${strategyName}${stateInfo} (${strategyTitle}), click to unregister">🟢</span>`;
        } else if (swState.failed) {
            // 注册失败 - 红色补丁图标
            return `<span class="sw-icon failed" onclick="app.${action}(${port})" title="Registration failed, click to retry (${strategyTitle})">🔴</span>`;
        } else {
            // 未注册 - 黄色补丁图标
            return `<span class="sw-icon unregistered" onclick="app.${action}(${port})" title="Not registered ${strategyName} (${strategyTitle}), click to register">🟡</span>`;
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

    async registerPortServiceWorker(port) {
        if (!this.swEnabled) {
            console.log(`[SW] Port ${port}: Service Worker not enabled`);
            return;
        }

        // 设置加载状态
        this.serviceWorkerStates.set(port, { 
            ...this.serviceWorkerStates.get(port), 
            loading: true 
        });
        this.refreshPortDisplay();

        try {
            // 使用模板生成代理URL
            const proxyUrl = this.generateProxyUrlForPort(port);
            if (!proxyUrl) {
                throw new Error('Cannot generate proxy URL');
            }

            // 确定Service Worker作用域
            let scope = proxyUrl;
            if (!scope.endsWith('/')) {
                scope += '/';
            }
            
            // 根据策略选择Service Worker脚本
            const currentStrategy = this.getPortStrategy(port);
            let swScriptPath;
            
            if (currentStrategy === 'tunnel') {
                swScriptPath = `${this.basePath}/tunnel_service_worker.js`;
            } else {
                const portDecodeDepth = this.portDecodeDepths.get(port) ?? this.nginxDecodeDepth;
                swScriptPath = `${this.basePath}/subpath_service_worker.js?decode_depth=${portDecodeDepth}`;
            }
            
            console.log(`[SW Register] Port ${port}: ${currentStrategy}`);
            
            // 注册Service Worker
            const registration = await navigator.serviceWorker.register(swScriptPath, { scope });

            // 等待激活
            if (registration.installing) {
                await this.waitForServiceWorkerActivation(registration.installing);
            }

            // 更新状态
            this.serviceWorkerStates.set(port, { 
                registered: true, 
                loading: false,
                scope: scope,
                registration: registration,
                state: 'active'
            });
            
            console.log(`[SW Register] Port ${port} registered successfully`);
            
        } catch (error) {
            console.error(`[SW Register] Port ${port} registration failed:`, error);
            this.serviceWorkerStates.set(port, { 
                registered: false, 
                loading: false,
                failed: true
            });
        }
        
        this.refreshPortDisplay();
    }

    async waitForServiceWorkerActivation(installingWorker) {
        return Promise.race([
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

    updatePortDecodeDepth(port, value) {
        // 更新端口的解码深度设置
        const decodeDepth = parseInt(value);
        if (isNaN(decodeDepth) || decodeDepth < 0) {
            // 如果输入无效，恢复为该端口当前设置的值
            const input = document.querySelector(`input[onchange*="${port}"]`);
            if (input) {
                input.value = this.portDecodeDepths.get(port);
            }
            return;
        }
        
        // 保存设置
        this.portDecodeDepths.set(port, decodeDepth);
        
        // 如果该端口已注册Service Worker，提示需要重新注册
        const swState = this.serviceWorkerStates.get(port);
        if (swState && swState.registered) {

        }
    }

    // ==================== 策略管理方法 ====================
    

    
    async unregisterPortServiceWorker(port) {
        if (!this.swEnabled) {
            console.log(`[SW] Port ${port}: Service Worker not enabled`);
            return;
        }

        const registrations = await navigator.serviceWorker.getRegistrations();
        const proxyUrl = this.generateProxyUrlForPort(port);
        
        if (!proxyUrl) return;
        
        // 统一转换为路径格式进行匹配
        let targetScope = this.normalizeUrl(proxyUrl);
        if (!targetScope.endsWith('/')) {
            targetScope += '/';
        }
        
        let targetRegistration = null;
        for (const registration of registrations) {
            const regScope = this.normalizeUrl(registration.scope);
            if (regScope === targetScope) {
                targetRegistration = registration;
                break;
            }
        }
        
        if (targetRegistration) {
            try {
                console.log(`[SW Unregister] Port ${port}`);
                await targetRegistration.unregister();
                if (targetRegistration.active) {

                    targetRegistration.active.postMessage({
                        type: 'FORCE_NAVIGATE_ALL_CLIENTS'
                    });
                }
                console.log(`[SW Unregister] Port ${port} unregistered successfully`);
            } catch (error) {
                console.warn(`[SW Unregister] Port ${port} unregister exception:`, error);
            }
        } else {
            console.warn(`[SW Unregister] Port ${port} not found`);
        }
        
        // 清理状态
        this.serviceWorkerStates.delete(port);
        this.refreshPortDisplay();
    }
    
    async switchPortStrategy(port, newStrategy) {
        const oldStrategy = this.getPortStrategy(port);
        
        if (oldStrategy === newStrategy) {
            return; // 策略没有变化，无需处理
        }
        
        console.log(`[Strategy Switch] Port ${port}: ${oldStrategy} -> ${newStrategy}`);
        
        // 如果当前端口已注册Service Worker，先注销
        const swState = this.serviceWorkerStates.get(port);
        if (swState && swState.registered) {

            await this.unregisterPortServiceWorker(port);
        }
        
        // 更新策略设置
        this.portStrategies.set(port, newStrategy);
        this.savePortStrategies();
        
        // 刷新界面显示
        this.refreshPortDisplay();
        
        console.log(`[Strategy Switch] Port ${port}: ${newStrategy}`);
    }

    getPortStrategy(port) {
        return this.portStrategies.get(port) || 'subpath'; // 默认策略
    }
    
    savePortStrategies() {
        try {
            const strategies = Object.fromEntries(this.portStrategies);
            localStorage.setItem('port-strategies', JSON.stringify(strategies));
        } catch (error) {
            console.warn('[Strategy Save] Save failed:', error);
        }
    }
    
    loadPortStrategies() {
        try {
            const saved = localStorage.getItem('port-strategies');
            if (saved) {
                const strategies = JSON.parse(saved);
                this.portStrategies = new Map(Object.entries(strategies));
            }
        } catch (error) {
            console.warn('[Strategy Load] Load failed:', error);
            this.portStrategies = new Map();
        }
    }

}

// 全局函数已移除，现在使用自动添加功能

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    window.app = new PortApp();
});