package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func isPortListening(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// generateProxyURL 已移除：模板由前端从 location.pathname 自适应推导

type portInfo struct {
	Port          int    `json:"port"`
	IsListening   bool   `json:"is_listening"`
	ProcessName   *string `json:"process_name"`
	ProcessPid    *int    `json:"process_pid"`
	ProcessCmdline *string `json:"process_cmdline"`
	ProxyURL      string `json:"proxy_url"`
}

func newPortInfo(port int) portInfo {
	return portInfo{
		Port:           port,
		IsListening:    isPortListening(port),
		ProcessName:    nil,
		ProcessPid:     nil,
		ProcessCmdline: nil,
		ProxyURL:       "", // 由前端自适应推导
	}
}

// --- handlers ---

// handleUrlTemplate 已移除：模板由前端自适应推导

func handlePortInfo(w http.ResponseWriter, r *http.Request) {
	portStr := r.PathValue("port")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid port"})
		return
	}
	writeJSON(w, http.StatusOK, newPortInfo(port))
}

func handleBatchPorts(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Ports []int `json:"ports"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid body"})
		return
	}

	// 过滤无效端口
	validPorts := make([]int, 0, len(body.Ports))
	for _, port := range body.Ports {
		if port >= 1 && port <= 65535 {
			validPorts = append(validPorts, port)
		}
	}

	// 并发检测
	results := make([]portInfo, len(validPorts))
	var wg sync.WaitGroup
	for i, port := range validPorts {
		wg.Add(1)
		go func(idx, port int) {
			defer wg.Done()
			results[idx] = newPortInfo(port)
		}(i, port)
	}
	wg.Wait()
	writeJSON(w, http.StatusOK, results)
}

func handleTestEncoding(w http.ResponseWriter, r *http.Request) {
	rawPath := r.URL.EscapedPath()
	const prefix = "/api/test-encoding/"
	testPath := ""
	if strings.HasPrefix(rawPath, prefix) {
		testPath = rawPath[len(prefix):]
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": testPath})
}

// handleServiceInfo 返回本服务监听端口
func handleServiceInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"port": servicePort})
}

// handleWsProbe: WS 连通性探测，接受连接后立即关闭
func handleWsProbe(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.WriteMessage(websocket.TextMessage, []byte("ok"))
}
