// Port management service frontend app
class PortApp {
    constructor() {
        this.basePath = window.location.pathname.replace(/\/$/, '');
        this.serviceWorkerStates = new Map();
        this.portStrategies = new Map();
        this.addPortTimeout = null;
        this.nginxDecodeDepth = 0;

        // URL template related
        this.urlTemplate = null;
        this.hasProxySupport = false;
        this.templateRegex = null;

        this.loadPortStrategies();
        this.initServiceWorkerSupport();

        this.initializeApp();

        setInterval(() => {
            this.refreshPorts();
        }, 5000);
    }

    async initializeApp() {
        await this.loadUrlTemplate();
        if (this.hasProxySupport) {
            await this.detectNginxEncoding();
        }
        this.setupPortInput(); // Call this after DOM is ready usually, but here is fine
        await this.updateServiceWorkerStates();
        await this.refreshPorts();
    }

    async loadUrlTemplate() {
        try {
            const response = await fetch(`${this.basePath}/api/url-template`);
            const data = await response.json();

            this.urlTemplate = data.template;
            this.hasProxySupport = data.has_proxy_support;

            if (this.urlTemplate) {
                this.templateRegex = this.compileTemplateRegex(this.urlTemplate);
            }

            this.swEnabled = this.swSupported && this.isSubpath && this.hasProxySupport;

        } catch (error) {
            console.warn('[Template] Load failed:', error);
            this.urlTemplate = null;
            this.hasProxySupport = false;
            this.swEnabled = false;
        }
    }

    compileTemplateRegex(template) {
        const templatePath = this.extractTemplatePathManually(template);
        const escaped = templatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = escaped.replace('\\{\\{port\\}\\}', '(\\d+)');
        return new RegExp(pattern);
    }

    extractTemplatePathManually(template) {
        if (template.startsWith('http://') || template.startsWith('https://')) {
            const protocolEnd = template.indexOf('://') + 3;
            const hostEnd = template.indexOf('/', protocolEnd);
            return hostEnd !== -1 ? template.substring(hostEnd) : '/';
        }
        return template.startsWith('/') ? template : '/' + template;
    }

    normalizeUrl(url) {
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
        if (!scriptURL) return false;
        try {
            const currentOrigin = window.location.origin;
            const currentBasePath = this.basePath;
            const expectedScriptPrefix = `${currentOrigin}${currentBasePath}/`;
            if (!scriptURL.startsWith(expectedScriptPrefix)) return false;
            const scriptName = scriptURL.substring(expectedScriptPrefix.length);
            return scriptName.startsWith('unified_service_worker.js');
        } catch {
            return false;
        }
    }

    async detectNginxEncoding() {
        try {
            const testSegment = "test/path";
            let maxLayers = 4;
            const maxAttempts = 8;
            const baseEncoded = encodeURIComponent(testSegment);

            while (maxLayers <= maxAttempts) {
                let encodedSegment = baseEncoded;
                for (let i = 0; i < maxLayers; i++) {
                    encodedSegment = encodeURIComponent(encodedSegment);
                }

                const response = await fetch(`${this.basePath}/api/test-encoding/${encodedSegment}`);
                if (!response.ok) {
                    this.nginxDecodeDepth = 0;
                    break;
                }

                const result = await response.json();
                let current = result.path;
                let encodeSteps = 0;

                while (current !== encodedSegment && encodeSteps < maxLayers) {
                    current = encodeURIComponent(current);
                    encodeSteps++;
                }

                const detectedDepth = (current === encodedSegment) ? encodeSteps : 0;
                const verified = await this.verifyNginxDecodeDepth(baseEncoded, detectedDepth);

                if (verified) {
                    this.nginxDecodeDepth = detectedDepth;
                    return;
                }
                maxLayers++;
            }
            this.nginxDecodeDepth = 0;
        } catch (error) {
            this.nginxDecodeDepth = 0;
        }
    }

    async verifyNginxDecodeDepth(baseEncoded, detectedDepth) {
        try {
            let verifySegment = baseEncoded;
            for (let i = 0; i < detectedDepth; i++) {
                verifySegment = encodeURIComponent(verifySegment);
            }
            const verifyResponse = await fetch(`${this.basePath}/api/test-encoding/${verifySegment}`);
            if (verifyResponse.ok) {
                const verifyResult = await verifyResponse.json();
                return verifyResult.path === baseEncoded;
            }
            return false;
        } catch {
            return false;
        }
    }

    setupPortInput() {
        const addPortBtn = document.getElementById('addPortBtn');
        const addPortInput = document.getElementById('addPortInput');

        if (!addPortBtn || !addPortInput) return;

        addPortBtn.addEventListener('click', () => {
            addPortBtn.style.display = 'none';
            addPortInput.style.display = 'block';
            addPortInput.focus();
        });

        addPortInput.addEventListener('blur', () => {
            if (!addPortInput.value) {
                addPortInput.style.display = 'none';
                addPortBtn.style.display = 'flex';
            }
        });

        addPortInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.addPort();
            }
        });
    }

    initServiceWorkerSupport() {
        this.swSupported = 'serviceWorker' in navigator;
        this.isSubpath = this.basePath !== '';
        this.swEnabled = this.swSupported && this.isSubpath && this.hasProxySupport;
    }

    async updateServiceWorkerStates() {
        if (!('serviceWorker' in navigator) || !this.hasProxySupport) return;

        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            this.serviceWorkerStates.clear();

            for (const registration of registrations) {
                const scriptURL = registration.active?.scriptURL ||
                    registration.waiting?.scriptURL ||
                    registration.installing?.scriptURL || '';

                if (!this.isOurServiceWorker(scriptURL)) continue;

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
                    
                    // 恢复配置：页面刷新后 SW 重新初始化，需要重新发送配置
                    if (registration.active) {
                        const savedStrategy = this.getPortStrategy(port);
                        if (savedStrategy && savedStrategy !== 'none') {
                            const config = {
                                strategy: savedStrategy === 'tunnel' ? 'tunnel' : 'subpath',
                                decodeDepth: this.nginxDecodeDepth
                            };
                            registration.active.postMessage({
                                type: 'CONFIGURE',
                                data: config
                            });
                            console.log(`[SW] Restored config for port ${port}:`, config);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[SW] Update states failed:', error);
        }
    }

    extractPortFromScope(scope) {
        if (!this.templateRegex) return null;
        const normalizedScope = this.normalizeUrl(scope);
        const match = normalizedScope.match(this.templateRegex);
        return (match && match[1]) ? parseInt(match[1]) : null;
    }

    generateProxyUrlForPort(port) {
        if (!this.urlTemplate) return null;
        return this.urlTemplate.replace('{{port}}', port.toString());
    }

    async addPort() {
        const portInput = document.getElementById('addPortInput');
        const port = parseInt(portInput.value);
        if (!port || port < 1 || port > 65535) return;

        try {
            // 1. 添加到后端
            await fetch(`${this.basePath}/api/port/${port}`);
            
            // 2. 自动注册 SW（默认策略为 none）
            if (this.hasProxySupport) {
                await this.registerPortServiceWorker(port);
            }
            
            // 3. 重置输入
            portInput.value = '';
            portInput.style.display = 'none';
            document.getElementById('addPortBtn').style.display = 'flex';
            
            await this.refreshPorts();
        } catch (error) {
            console.error('[Add Port] Failed:', error);
        }
    }

    async addPortAuto(port) {
        // Not used in new UI but kept for compatibility if needed
        try {
            await fetch(`${this.basePath}/api/port/${port}`);
            this.refreshPorts();
        } catch { }
    }

    async refreshPorts() {
        try {
            const response = await fetch(`${this.basePath}/api/ports`);
            const ports = await response.json();
            await this.updateServiceWorkerStates();
            this.displayPorts(ports);
        } catch (error) {
            console.error('Refresh ports failed:', error);
        }
    }

    displayPorts(ports) {
        const tbody = document.getElementById('portTableBody');
        const emptyState = document.getElementById('emptyState');
        const allPorts = this.mergePortData(ports);

        // 处理空状态
        if (allPorts.length === 0) {
            tbody.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';

        // 检查用户是否正在交互
        const activeElement = document.activeElement;
        const isInteracting = activeElement && tbody.contains(activeElement) &&
            (activeElement.tagName === 'SELECT' || 
             activeElement.tagName === 'BUTTON' ||
             activeElement.tagName === 'INPUT');

        if (isInteracting) {
            console.log('[Display] Skipped: user is interacting with', activeElement.tagName);
            return;
        }

        // 智能增量更新
        this.updatePortsIncremental(tbody, allPorts);
    }

    updatePortsIncremental(tbody, allPorts) {
        // 1. 构建现有行的映射
        const existingRows = new Map();
        Array.from(tbody.querySelectorAll('tr[data-port]')).forEach(row => {
            const port = parseInt(row.dataset.port);
            existingRows.set(port, row);
        });

        // 2. 构建新端口的集合
        const newPortsMap = new Map(allPorts.map(p => [p.port, p]));

        // 3. 删除不存在的端口
        existingRows.forEach((row, port) => {
            if (!newPortsMap.has(port)) {
                row.remove();
            }
        });

        // 4. 添加或更新端口
        allPorts.forEach((portData, index) => {
            const existingRow = existingRows.get(portData.port);

            if (!existingRow) {
                // 新端口：创建并插入到正确位置
                const newRow = this.createPortRowElement(portData);
                
                if (index === 0) {
                    tbody.prepend(newRow);
                } else {
                    // 找到前一个端口的行，插入到它后面
                    const prevPort = allPorts[index - 1];
                    const prevRow = tbody.querySelector(`tr[data-port="${prevPort.port}"]`);
                    if (prevRow) {
                        prevRow.after(newRow);
                    } else {
                        tbody.appendChild(newRow);
                    }
                }
            } else {
                // 已存在：只更新变化的部分
                this.updatePortRowIfNeeded(existingRow, portData);
            }
        });
    }

    createPortRowElement(portData) {
        const tr = document.createElement('tr');
        tr.dataset.port = portData.port;
        tr.innerHTML = this.renderPortRow(portData).replace(/<\/?tr[^>]*>/g, '');
        return tr;
    }

    updatePortRowIfNeeded(row, newData) {
        // 只更新变化的单元格，避免触碰交互元素

        // 1. 更新状态点
        const isListening = newData.is_listening && newData.source !== 'service_worker';
        const statusDot = row.querySelector('.status-dot');
        if (statusDot) {
            if (isListening) {
                statusDot.classList.add('active');
            } else {
                statusDot.classList.remove('active');
            }
        }

        // 2. 更新代理 URL
        const addressCell = row.querySelector('.col-address');
        if (addressCell) {
            const proxyUrl = this.hasProxySupport && newData.proxy_url ? newData.proxy_url : '';
            const absoluteUrl = proxyUrl ? this.getAbsoluteUrl(proxyUrl) : '#';
            const currentHtml = addressCell.innerHTML.trim();
            const newHtml = proxyUrl ? `<a href="${absoluteUrl}" target="_blank" class="address-link">${proxyUrl}</a>` : '';
            
            if (currentHtml !== newHtml) {
                addressCell.innerHTML = newHtml;
            }
        }

        // 3. 更新 Proxy Mode（只在没有焦点时更新）
        const proxyModeCell = row.querySelector('.col-proxy-mode');
        const proxyModeSelect = proxyModeCell?.querySelector('select');
        if (proxyModeCell && (!proxyModeSelect || document.activeElement !== proxyModeSelect)) {
            const newModeHtml = this.hasProxySupport ? this.renderProxyModeSelect(newData) :
                '<span class="process-info">N/A</span>';
            if (proxyModeCell.innerHTML.trim() !== newModeHtml.trim()) {
                proxyModeCell.innerHTML = newModeHtml;
            }
        }

        // 4. 更新进程信息
        const processCell = row.querySelector('.col-process .process-info');
        if (processCell) {
            const newProcessInfo = this.formatProcessInfo(newData);
            if (processCell.textContent !== newProcessInfo) {
                processCell.textContent = newProcessInfo;
            }
        }
    }

    mergePortData(ports) {
        const allPorts = new Map();

        ports.forEach(port => {
            allPorts.set(port.port, { ...port, source: 'backend' });
        });

        this.serviceWorkerStates.forEach((swState, port) => {
            if (!allPorts.has(port)) {
                // SW 注册的端口但后端没有信息
                // 主动请求后端获取该端口信息
                this.fetchPortInfoIfNeeded(port);
                
                const proxyUrl = this.generateProxyUrlForPort(port);
                allPorts.set(port, {
                    port: port,
                    is_listening: false,
                    process_name: null,
                    process_pid: null,
                    process_cmdline: null,
                    proxy_url: proxyUrl,
                    source: 'service_worker',
                    sw_state: swState.state
                });
            } else {
                const existingPort = allPorts.get(port);
                existingPort.has_service_worker = true;
                existingPort.sw_state = swState.state;
            }
        });

        return Array.from(allPorts.values()).sort((a, b) => a.port - b.port);
    }

    fetchPortInfoIfNeeded(port) {
        // 避免重复请求
        if (this.pendingPortRequests && this.pendingPortRequests.has(port)) {
            return;
        }
        
        if (!this.pendingPortRequests) {
            this.pendingPortRequests = new Set();
        }
        
        this.pendingPortRequests.add(port);
        
        // 异步请求端口信息
        fetch(`${this.basePath}/api/port/${port}`)
            .then(response => response.json())
            .then(() => {
                // 请求成功后，下次 refreshPorts 会获取到完整信息
                this.pendingPortRequests.delete(port);
            })
            .catch(error => {
                console.error(`[Fetch Port Info] Failed for port ${port}:`, error);
                this.pendingPortRequests.delete(port);
            });
    }

    renderPortRow(port) {
        const isListening = port.is_listening && port.source !== 'service_worker';
        const processInfo = this.formatProcessInfo(port);
        const proxyUrl = this.hasProxySupport && port.proxy_url ? port.proxy_url : '';
        const absoluteUrl = proxyUrl ? this.getAbsoluteUrl(proxyUrl) : '#';

        const swModeSelect = this.hasProxySupport ? this.renderProxyModeSelect(port) :
            '<span class="process-info">N/A</span>';

        return `
            <tr data-port="${port.port}">
                <td class="col-port">
                    <div class="port-cell-content">
                        <span>
                            <span class="status-dot ${isListening ? 'active' : ''}"></span>
                            ${port.port}
                        </span>
                        ${this.hasProxySupport ? `<button class="action-btn" title="Stop Forwarding" onclick="app.stopForwarding(${port.port})">×</button>` : ''}
                    </div>
                </td>
                <td class="col-address">
                    ${proxyUrl ? `<a href="${absoluteUrl}" target="_blank" class="address-link">${proxyUrl}</a>` : ''}
                </td>
                <td class="col-proxy-mode">
                    ${swModeSelect}
                </td>
                <td class="col-process">
                    <span class="process-info">${this.escapeHtml(processInfo)}</span>
                </td>
            </tr>
        `;
    }

    renderProxyModeSelect(port) {
        if (!this.swEnabled || !port.proxy_url) return '';

        const currentMode = this.getPortMode(port.port);
        const swState = this.serviceWorkerStates.get(port.port) || { loading: false };

        if (swState.loading) {
            return '<span class="process-info">Updating...</span>';
        }

        return `
            <select class="proxy-mode-select" onchange="app.switchPortMode(${port.port}, this.value)">
                <option value="none" ${currentMode === 'none' ? 'selected' : ''}>None</option>
                <option value="subpath" ${currentMode === 'subpath' ? 'selected' : ''}>Subpath</option>
                <option value="tunnel" ${currentMode === 'tunnel' ? 'selected' : ''}>Tunnel</option>
            </select>
        `;
    }

    formatProcessInfo(port) {
        if (!port.is_listening || port.source === 'service_worker') return '';
        
        // Format: (PID) full command line
        // If cmdline is available, use it; otherwise fall back to process name
        const pid = port.process_pid ? port.process_pid : '';
        const cmd = port.process_cmdline || port.process_name || 'Unknown';
        
        if (pid) {
            return `(${pid}) ${cmd}`;
        }
        return cmd;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getAbsoluteUrl(url) {
        if (url.startsWith('/')) {
            return window.location.protocol + '//' + window.location.host + url;
        }
        return url;
    }

    // Strategy Management
    loadPortStrategies() {
        try {
            const saved = localStorage.getItem('port_strategies');
            if (saved) {
                const parsed = JSON.parse(saved);
                this.portStrategies = new Map(Object.entries(parsed).map(([k, v]) => [parseInt(k), v]));
            }
        } catch { }
    }

    savePortStrategies() {
        try {
            const obj = Object.fromEntries(this.portStrategies);
            localStorage.setItem('port_strategies', JSON.stringify(obj));
        } catch { }
    }

    updatePortStrategy(port, mode) {
        this.portStrategies.set(port, mode);
        this.savePortStrategies();
    }

    clearPortStrategy(port) {
        this.portStrategies.delete(port);
        this.savePortStrategies();
    }

    getPortStrategy(port) {
        return this.portStrategies.get(port) || 'none'; // Default to none
    }

    getPortMode(port) {
        const swState = this.serviceWorkerStates.get(port);
        if (!swState || !swState.registered) return 'none';
        return this.getPortStrategy(port);
    }

    async switchPortMode(port, newMode) {
        const currentMode = this.getPortMode(port);
        if (currentMode === newMode) return;

        console.log(`[Mode Switch] Port ${port}: ${currentMode} -> ${newMode}`);
        this.setLoadingState(port, true);
        this.refreshPortDisplay();

        try {
            if (newMode === 'none') {
                // 切换到 none：发送 none 配置
                this.clearPortStrategy(port);
                const swState = this.serviceWorkerStates.get(port);
                if (swState && swState.registration && swState.registration.active) {
                    swState.registration.active.postMessage({
                        type: 'CONFIGURE',
                        data: { strategy: 'none', decodeDepth: 0 }
                    });
                    console.log(`[Mode Switch] Sent none config to SW for port ${port}`);
                }
            } else {
                // 切换到 subpath 或 tunnel
                this.updatePortStrategy(port, newMode);
                
                const swState = this.serviceWorkerStates.get(port);
                if (swState && swState.registered && swState.registration && swState.registration.active) {
                    // 已注册：发送新配置
                    const config = {
                        strategy: newMode === 'tunnel' ? 'tunnel' : 'subpath',
                        decodeDepth: this.nginxDecodeDepth
                    };
                    swState.registration.active.postMessage({
                        type: 'CONFIGURE',
                        data: config
                    });
                    console.log(`[Mode Switch] Sent config to SW for port ${port}:`, config);
                } else {
                    // 未注册：先注册，再发送配置
                    await this.registerPortServiceWorker(port);
                    const swState = this.serviceWorkerStates.get(port);
                    if (swState && swState.registration && swState.registration.active) {
                        const config = {
                            strategy: newMode === 'tunnel' ? 'tunnel' : 'subpath',
                            decodeDepth: this.nginxDecodeDepth
                        };
                        swState.registration.active.postMessage({
                            type: 'CONFIGURE',
                            data: config
                        });
                        console.log(`[Mode Switch] Registered and sent config to SW for port ${port}:`, config);
                    }
                }
            }
        } catch (error) {
            console.error(`[Mode Switch] Failed for port ${port}:`, error);
        } finally {
            this.setLoadingState(port, false);
            this.refreshPorts();
        }
    }

    setLoadingState(port, loading) {
        const currentState = this.serviceWorkerStates.get(port) || {};
        this.serviceWorkerStates.set(port, { ...currentState, loading: loading });
    }

    async unregisterSubpathServiceWorker(scope) {
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            const targetRegistration = registrations.find(reg => this.normalizeUrl(reg.scope) === this.normalizeUrl(scope));

            if (targetRegistration) {
                const port = this.extractPortFromScope(scope);
                await targetRegistration.unregister();
                if (port) this.serviceWorkerStates.delete(port);
            }
        } catch { }
    }

    async registerPortServiceWorker(port) {
        if (!this.swEnabled) return;

        const proxyUrl = this.generateProxyUrlForPort(port);
        if (!proxyUrl) return;

        let scope = proxyUrl;
        if (!scope.endsWith('/')) scope += '/';

        // 注册统一的 SW（无参数，默认策略为 none）
        const swScriptPath = `${this.basePath}/unified_service_worker.js`;

        try {
            const registration = await navigator.serviceWorker.register(swScriptPath, { scope });
            if (registration.installing) {
                await this.waitForServiceWorkerActivation(registration.installing);
            }

            this.serviceWorkerStates.set(port, {
                registered: true,
                loading: false,
                scope: scope,
                registration: registration,
                state: 'active'
            });
            
            console.log(`[SW] Registered for port ${port} with default strategy: none`);
        } catch (error) {
            console.error(`[SW Register] Failed for port ${port}:`, error);
            throw error;
        }
    }

    async waitForServiceWorkerActivation(installingWorker) {
        return Promise.race([
            new Promise(resolve => {
                installingWorker.addEventListener('statechange', () => {
                    if (installingWorker.state === 'activated' || installingWorker.state === 'redundant') resolve();
                });
            }),
            new Promise(resolve => setTimeout(resolve, 5000))
        ]);
    }

    refreshPortDisplay() {
        // Simplified: just do nothing here, let refreshPorts handle it.
    }

    async stopForwarding(port) {
        console.log(`[Stop Forwarding] Port ${port}`);
        
        try {
            // 1. 切换策略为 none（停止处理请求）
            const swState = this.serviceWorkerStates.get(port);
            if (swState && swState.registration && swState.registration.active) {
                swState.registration.active.postMessage({
                    type: 'CONFIGURE',
                    data: { strategy: 'none', decodeDepth: 0 }
                });
                console.log(`[Stop Forwarding] Set strategy to none for port ${port}`);
            }
            
            // 2. 注销 SW
            if (swState && swState.scope) {
                await this.unregisterSubpathServiceWorker(swState.scope);
                console.log(`[Stop Forwarding] Unregistered SW for port ${port}`);
            }
            
            // 3. 清理前端状态
            this.clearPortStrategy(port);
            this.serviceWorkerStates.delete(port);
            
            // 4. 删除后端缓存
            await fetch(`${this.basePath}/api/port/${port}`, {
                method: 'DELETE'
            });
            console.log(`[Stop Forwarding] Deleted port ${port} from backend`);
            
        } catch (error) {
            console.error(`[Stop Forwarding] Failed for port ${port}:`, error);
        }
        
        // 5. 刷新 UI
        await this.refreshPorts();
    }
}

// Initialize
const app = new PortApp();
window.app = app;