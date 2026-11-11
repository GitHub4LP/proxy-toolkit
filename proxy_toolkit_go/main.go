package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
)

var servicePort int

func main() {
	flag.IntVar(&servicePort, "port", 8080, "监听端口")
	flag.Parse()

	mux := http.NewServeMux()

	// 统一反向代理（subpath + tunnel 共用 /proxy/{port}）
	mux.HandleFunc("/proxy/", handleProxy)

	// API
	mux.HandleFunc("GET /api/service-info", handleServiceInfo)
	mux.HandleFunc("GET /api/port/{port}", handlePortInfo)
	mux.HandleFunc("POST /api/ports/batch", handleBatchPorts)
	mux.HandleFunc("GET /api/test-encoding/", handleTestEncoding)
	mux.HandleFunc("/api/ws-probe", handleWsProbe)

	// SW JS 文件
	mux.HandleFunc("GET /unified_service_worker.js", handleSWScript)
	mux.HandleFunc("GET /navigation_interceptor.js", handleNavInterceptor)
	mux.HandleFunc("GET /sw_client.js", handleSwClient)

	// 静态文件
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

	// 首页（不用方法前缀，避免与 /proxy/ 冲突）
	mux.HandleFunc("/", handleIndex)

	listenAddr := fmt.Sprintf("0.0.0.0:%d", servicePort)
	log.Printf("[启动] 监听 %s", listenAddr)
	if err := http.ListenAndServe(listenAddr, mux); err != nil {
		log.Fatal(err)
	}
}
