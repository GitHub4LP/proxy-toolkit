package main

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:assets
var assetsFS embed.FS

// 预解出 static 子目录
var staticFS, _ = fs.Sub(assetsFS, "assets/static")

// serveAsset 读取 embed 文件并写入响应
func serveAsset(w http.ResponseWriter, r *http.Request, name string, contentType string, extraHeaders map[string]string) {
	data, err := assetsFS.ReadFile("assets/" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	for k, v := range extraHeaders {
		w.Header().Set(k, v)
	}
	w.Write(data)
}

// --- 以下为 http.HandlerFunc 工厂 ---

func handleIndex(w http.ResponseWriter, r *http.Request) {
	serveAsset(w, r, "static/index.html", "text/html; charset=utf-8", nil)
}

func handleSWScript(w http.ResponseWriter, r *http.Request) {
	serveAsset(w, r, "unified_service_worker.js", "application/javascript", map[string]string{
		"Service-Worker-Allowed": "/",
		"Cache-Control":          "no-store",
	})
}

func handleNavInterceptor(w http.ResponseWriter, r *http.Request) {
	serveAsset(w, r, "navigation_interceptor.js", "application/javascript", map[string]string{
		"Cache-Control":             "no-cache",
		"Access-Control-Allow-Origin": "*",
	})
}

func handleSwClient(w http.ResponseWriter, r *http.Request) {
	serveAsset(w, r, "sw_client.js", "application/javascript", map[string]string{
		"Cache-Control":             "no-cache",
		"Access-Control-Allow-Origin": "*",
	})
}
