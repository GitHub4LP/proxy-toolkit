// Port management service frontend app
class PortApp {
    constructor() {
        this.basePath = window.location.pathname.replace(/\/$/, '');
        
        // 端口列表（localStorage 持久化）
        this.ports = new Set();
        this.loadPorts();
        
        // Service Worker 状态
        this.serviceWorkerStates = new Map();
        this.portStrategies = new Map();
        this.swConfiguredPorts = new Set();
        this.deletingPorts = new Set();
        
        // 代理检测
        this.proxyDecodeDepth = 0;
        this.slashExtraDecoding = false;

        // URL template
        this.urlTemplate = null;
        this.hasProxySupport = false;
        this.templateRegex = null;

        this.loadPortStrategies();
        this.initServiceWorkerSupport();
        this.initializeApp();

        setInterval(() => this.refreshPorts(), 5000);
    }

    // ==================== 端口持久化 ====================
    
    loadPorts() {
        try {
            const saved = localStorage.getItem('forwarded_ports');
            if (saved) {
                const arr = JSON.parse(saved);
                this.ports = new Set(arr.filter(p => Number.isInteger(p) && p > 0 && p <= 65535));
            }
        } catch { }
    }

    savePorts() {
        try {
            localStorage.setItem('forwarded_ports', JSON.stringify([...this.ports]));
        } catch { }
    }

    addPortToList(port) {
        if (port > 0 && port <= 65535) {
            this.ports.add(port);
            this.savePorts();
        }
    }

    removePortFromList(port) {
        this.ports.delete(port);
        this.savePorts();
    }

    // ==================== 初始化 ====================

    async initializeApp() {
        await this.loadUrlTemplate();
        if (this.hasProxySupport) {
            await this.detectProxyEncoding();
            await this.detectSlashExtraDecoding();
        }
        this.setupPortInput();
        await this.syncServiceWorkers();
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

    initServiceWorkerSupport() {
        this.swSupported = 'serviceWorker' in navigator;
        this.isSubpath = this.basePath !== '';
        this.swEnabled = this.swSupported && this.isSubpath && this.hasProxySupport;
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
            if (e.key === 'Enter') this.addPort();
        });
    }

    // ==================== 代理编码检测 ====================

    async detectProxyEncoding() {
        try {
            const testSegment = "test path";
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
                    this.proxyDecodeDepth = 0;
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
                const verified = await this.verifyProxyDecodeDepth(baseEncoded, detectedDepth);

                if (verified) {
                    this.proxyDecodeDepth = detectedDepth;
                    return;
                }
                maxLayers++;
            }
            this.proxyDecodeDepth = 0;
        } catch {
            this.proxyDecodeDepth = 0;
        }
    }

    async detectSlashExtraDecoding() {
        try {
            const testSegment = "test/path";
            const baseEncoded = encodeURIComponent(testSegment);
            
            let encoded = baseEncoded;
            for (let i = 0; i < this.proxyDecodeDepth; i++) {
                encoded = encodeURIComponent(encoded);
            }

            const response = await fetch(`${this.basePath}/api/test-encoding/${encoded}`);
            if (!response.ok) {
                this.slashExtraDecoding = false;
                return;
            }

            const result = await response.json();
            const pathParts = result.path.split('/');
            const hasRealSlash = pathParts.filter(p => p !== '').length > 1;
            this.slashExtraDecoding = hasRealSlash;
            
            console.log(`[Encoding Detection] depth: ${this.proxyDecodeDepth}, %2F extra decoding: ${this.slashExtraDecoding}`);
        } catch (error) {
            console.warn('[Encoding Detection] Slash detection failed:', error);
            this.slashExtraDecoding = false;
        }
    }

    async verifyProxyDecodeDepth(baseEncoded, detectedDepth) {
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

    // ==================== URL 模板处理 ====================

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
            if (url.startsWith('http')) return new URL(url).pathname;
            return url.startsWith('/') ? url : '/' + url;
        } catch {
            return url;
        }
    }

    generateProxyUrlForPort(port) {
        if (!this.urlTemplate) return null;
        return this.urlTemplate.replace('{{port}}', port.toString());
    }

    getAbsoluteUrl(url) {
        if (url.startsWith('/')) {
            return window.location.protocol + '//' + window.location.host + url;
        }
        return url;
    }

    // ==================== Service Worker 管理 ====================

    isOurServiceWorker(scriptURL) {
        if (!scriptURL) return false;
        try {
            const expectedScriptPrefix = `${window.location.origin}${this.basePath}/`;
            if (!scriptURL.startsWith(expectedScriptPrefix)) return false;
            const scriptName = scriptURL.substring(expectedScriptPrefix.length);
            return scriptName.startsWith('unified_service_worker.js');
        } catch {
            return false;
        }
    }

    extractPortFromScope(scope) {
        if (!this.templateRegex) return null;
        const normalizedScope = this.normalizeUrl(scope);
        const match = normalizedScope.match(this.templateRegex);
        return (match && match[1]) ? parseInt(match[1]) : null;
    }

    async syncServiceWorkers() {
        if (!('serviceWorker' in navigator) || !this.hasProxySupport) return;

        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            const foundPorts = new Set();

            for (const registration of registrations) {
                const scriptURL = registration.active?.scriptURL ||
                    registration.waiting?.scriptURL ||
                    registration.installing?.scriptURL || '';

                if (!this.isOurServiceWorker(scriptURL)) continue;

                const port = this.extractPortFromScope(registration.scope);
                if (port && !this.deletingPorts.has(port)) {
                    foundPorts.add(port);
                    
                    // 同步到端口列表
                    this.addPortToList(port);
                    
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
                    
                    // 恢复配置
                    if (registration.active && !this.swConfiguredPorts.has(port)) {
                        const savedStrategy = this.getPortStrategy(port);
                        if (savedStrategy && savedStrategy !== 'none') {
                            this.sendSwConfig(registration.active, savedStrategy);
                            this.swConfiguredPorts.add(port);
                        }
                    }
                }
            }
            
            // 清理已注销的 SW 状态
            for (const port of this.serviceWorkerStates.keys()) {
                if (!foundPorts.has(port)) {
                    this.serviceWorkerStates.delete(port);
                    this.swConfiguredPorts.delete(port);
                }
            }
        } catch (error) {
            console.error('[SW] Sync failed:', error);
        }
    }

    sendSwConfig(worker, strategy) {
        const config = {
            strategy: strategy,
            decodeDepth: this.proxyDecodeDepth,
            slashExtraDecoding: this.slashExtraDecoding
        };
        worker.postMessage({ type: 'CONFIGURE', data: config });
    }

    async registerPortServiceWorker(port) {
        if (!this.swEnabled) return;

        const proxyUrl = this.generateProxyUrlForPort(port);
        if (!proxyUrl) return;

        let scope = proxyUrl;
        if (!scope.endsWith('/')) scope += '/';

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

    async unregisterServiceWorker(scope) {
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            const target = registrations.find(reg => this.normalizeUrl(reg.scope) === this.normalizeUrl(scope));
            if (target) {
                await target.unregister();
            }
        } catch { }
    }

    // ==================== 策略管理 ====================

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

    getPortStrategy(port) {
        return this.portStrategies.get(port) || 'none';
    }

    updatePortStrategy(port, mode) {
        this.portStrategies.set(port, mode);
        this.savePortStrategies();
    }

    clearPortStrategy(port) {
        this.portStrategies.delete(port);
        this.savePortStrategies();
    }

    getPortMode(port) {
        const swState = this.serviceWorkerStates.get(port);
        if (!swState || !swState.registered) return 'none';
        return this.getPortStrategy(port);
    }

    // ==================== 端口操作 ====================

    async addPort() {
        const portInput = document.getElementById('addPortInput');
        const port = parseInt(portInput.value);
        if (!port || port < 1 || port > 65535) return;

        try {
            // 1. 添加到持久化列表
            this.addPortToList(port);
            
            // 2. 注册 SW（如果支持）
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

    async stopForwarding(port) {
        console.log(`[Stop Forwarding] Port ${port}`);
        
        this.deletingPorts.add(port);
        const swState = this.serviceWorkerStates.get(port);
        
        // 清理状态
        this.removePortFromList(port);
        this.clearPortStrategy(port);
        this.serviceWorkerStates.delete(port);
        this.swConfiguredPorts.delete(port);
        
        // 立即刷新 UI
        this.refreshPorts();
        
        // 异步注销 SW
        if (swState && swState.scope) {
            this.unregisterServiceWorker(swState.scope)
                .finally(() => this.deletingPorts.delete(port));
        } else {
            this.deletingPorts.delete(port);
        }
    }

    async switchPortMode(port, newMode) {
        const currentMode = this.getPortMode(port);
        if (currentMode === newMode) return;

        console.log(`[Mode Switch] Port ${port}: ${currentMode} -> ${newMode}`);
        this.setLoadingState(port, true);

        try {
            this.swConfiguredPorts.delete(port);
            
            if (newMode === 'none') {
                this.clearPortStrategy(port);
                const swState = this.serviceWorkerStates.get(port);
                if (swState?.registration?.active) {
                    swState.registration.active.postMessage({
                        type: 'CONFIGURE',
                        data: { strategy: 'none', decodeDepth: 0, slashExtraDecoding: false }
                    });
                }
            } else {
                this.updatePortStrategy(port, newMode);
                
                let swState = this.serviceWorkerStates.get(port);
                if (!swState?.registered) {
                    await this.registerPortServiceWorker(port);
                    swState = this.serviceWorkerStates.get(port);
                }
                
                if (swState?.registration?.active) {
                    this.sendSwConfig(swState.registration.active, newMode);
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

    // ==================== 刷新与渲染 ====================

    async refreshPorts() {
        try {
            await this.syncServiceWorkers();
            
            const portList = [...this.ports];
            if (portList.length === 0) {
                this.displayPorts([]);
                return;
            }

            // 批量查询后端
            const response = await fetch(`${this.basePath}/api/ports/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ports: portList })
            });
            
            const portInfos = await response.json();
            this.displayPorts(portInfos);
        } catch (error) {
            console.error('Refresh ports failed:', error);
        }
    }

    displayPorts(ports) {
        const tbody = document.getElementById('portTableBody');
        const emptyState = document.getElementById('emptyState');
        const allPorts = this.mergePortData(ports);

        if (allPorts.length === 0) {
            tbody.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';

        // 检查用户是否正在交互
        const activeElement = document.activeElement;
        const isInteracting = activeElement && tbody.contains(activeElement) &&
            ['SELECT', 'BUTTON', 'INPUT'].includes(activeElement.tagName);

        if (isInteracting) return;

        this.updatePortsIncremental(tbody, allPorts);
    }

    mergePortData(ports) {
        const portMap = new Map(ports.map(p => [p.port, p]));
        
        // 确保所有持久化的端口都显示
        for (const port of this.ports) {
            if (!portMap.has(port)) {
                portMap.set(port, {
                    port: port,
                    is_listening: false,
                    process_name: null,
                    process_pid: null,
                    process_cmdline: null,
                    proxy_url: this.generateProxyUrlForPort(port)
                });
            }
        }

        return Array.from(portMap.values())
            .map(p => ({
                ...p,
                has_service_worker: this.serviceWorkerStates.has(p.port),
                sw_state: this.serviceWorkerStates.get(p.port)?.state
            }))
            .sort((a, b) => a.port - b.port);
    }

    updatePortsIncremental(tbody, allPorts) {
        const existingRows = new Map();
        tbody.querySelectorAll('tr[data-port]').forEach(row => {
            existingRows.set(parseInt(row.dataset.port), row);
        });

        const newPortsMap = new Map(allPorts.map(p => [p.port, p]));

        // 删除不存在的
        existingRows.forEach((row, port) => {
            if (!newPortsMap.has(port)) row.remove();
        });

        // 添加或更新
        allPorts.forEach((portData, index) => {
            const existingRow = existingRows.get(portData.port);

            if (!existingRow) {
                const newRow = this.createPortRowElement(portData);
                if (index === 0) {
                    tbody.prepend(newRow);
                } else {
                    const prevPort = allPorts[index - 1];
                    const prevRow = tbody.querySelector(`tr[data-port="${prevPort.port}"]`);
                    prevRow ? prevRow.after(newRow) : tbody.appendChild(newRow);
                }
            } else {
                this.updatePortRowIfNeeded(existingRow, portData);
            }
        });
    }

    createPortRowElement(portData) {
        const tr = document.createElement('tr');
        tr.dataset.port = portData.port;
        tr.innerHTML = this.renderPortRowContent(portData);
        return tr;
    }

    renderPortRowContent(port) {
        const isListening = port.is_listening;
        const processInfo = this.formatProcessInfo(port);
        const proxyUrl = this.hasProxySupport && port.proxy_url ? port.proxy_url : '';
        const absoluteUrl = proxyUrl ? this.getAbsoluteUrl(proxyUrl) : '#';
        const swModeSelect = this.hasProxySupport ? this.renderProxyModeSelect(port) : '<span class="process-info">N/A</span>';

        return `
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
                <option value="hybrid" ${currentMode === 'hybrid' ? 'selected' : ''}>Hybrid</option>
            </select>
        `;
    }

    updatePortRowIfNeeded(row, newData) {
        // 更新状态点
        const statusDot = row.querySelector('.status-dot');
        if (statusDot) {
            statusDot.classList.toggle('active', newData.is_listening);
        }

        // 更新代理 URL
        const addressCell = row.querySelector('.col-address');
        if (addressCell) {
            const proxyUrl = this.hasProxySupport && newData.proxy_url ? newData.proxy_url : '';
            const absoluteUrl = proxyUrl ? this.getAbsoluteUrl(proxyUrl) : '#';
            const newHtml = proxyUrl ? `<a href="${absoluteUrl}" target="_blank" class="address-link">${proxyUrl}</a>` : '';
            if (addressCell.innerHTML.trim() !== newHtml) {
                addressCell.innerHTML = newHtml;
            }
        }

        // 更新 Proxy Mode（避免打断交互）
        const proxyModeCell = row.querySelector('.col-proxy-mode');
        const proxyModeSelect = proxyModeCell?.querySelector('select');
        if (proxyModeCell && document.activeElement !== proxyModeSelect) {
            const newModeHtml = this.hasProxySupport ? this.renderProxyModeSelect(newData) : '<span class="process-info">N/A</span>';
            if (proxyModeCell.innerHTML.trim() !== newModeHtml.trim()) {
                proxyModeCell.innerHTML = newModeHtml;
            }
        }

        // 更新进程信息
        const processCell = row.querySelector('.col-process .process-info');
        if (processCell) {
            const newProcessInfo = this.formatProcessInfo(newData);
            if (processCell.textContent !== newProcessInfo) {
                processCell.textContent = newProcessInfo;
            }
        }
    }

    formatProcessInfo(port) {
        if (!port.is_listening) return '';
        const pid = port.process_pid || '';
        const cmd = port.process_cmdline || port.process_name || 'Unknown';
        return pid ? `(${pid}) ${cmd}` : cmd;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize
const app = new PortApp();
window.app = app;
