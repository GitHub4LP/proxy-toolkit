package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

// 共用 transport：禁用自动压缩，保持透明转发
var proxyTransport = &http.Transport{
	DisableCompression: true,
}

// handleProxy 统一处理 /proxy/{port} 两种模式：
//   - subpath: /proxy/{port}/real/path   → port 后有 /，路径直接转发
//   - tunnel:  /proxy/{port}?u=/real/path → port 后无 /，路径从 u 参数读取
func handleProxy(w http.ResponseWriter, r *http.Request) {
	rawPath := r.URL.EscapedPath()
	rest := strings.TrimPrefix(rawPath, "/proxy/")

	// 提取 port：port 后有 / → subpath；无 / → tunnel
	slash := strings.IndexByte(rest, '/')

	var portStr string
	var isTunnel bool

	if slash == -1 {
		// tunnel 模式：/proxy/3000?u=/path
		portStr = rest
		isTunnel = true
	} else {
		// subpath 模式：/proxy/3000/path
		portStr = rest[:slash]
	}

	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		http.Error(w, "invalid port", http.StatusBadRequest)
		return
	}

	portStr = strconv.Itoa(port)
	targetOrigin := "http://localhost:" + portStr

	// 解析目标路径和 query
	var targetPath, targetRawPath, targetRawQuery string

	// tunnel 模式下的方法覆盖参数
	var methodOverride string

	if isTunnel {
		// WebSocket 桥接：?u=/ws&ws=1&sid=xxx
		if r.URL.Query().Get("ws") == "1" {
			sid := r.URL.Query().Get("sid")
			if sid == "" {
				http.Error(w, "missing sid", http.StatusBadRequest)
				return
			}
			// POST 只需 sid（发消息/关闭），不需要 u
			if r.Method == http.MethodPost {
				handleWsSend(w, r, sid)
				return
			}
			// GET 需要 u 参数（建立连接）
			u := r.URL.Query().Get("u")
			if u == "" || !strings.HasPrefix(u, "/") {
				http.Error(w, "missing or invalid u parameter", http.StatusBadRequest)
				return
			}
			parsed, err := url.Parse(u)
			if err != nil {
				http.Error(w, "invalid u parameter", http.StatusBadRequest)
				return
			}
			wsTarget := parsed.Path
			if parsed.RawQuery != "" {
				wsTarget += "?" + parsed.RawQuery
			}
			handleWsConnect(w, r, port, wsTarget, sid)
			return
		}

		u := r.URL.Query().Get("u")
		if u == "" || !strings.HasPrefix(u, "/") {
			http.Error(w, "missing or invalid u parameter", http.StatusBadRequest)
			return
		}
		// 用 url.Parse 正确分离 path / rawPath / query
		parsed, err := url.Parse(u)
		if err != nil {
			http.Error(w, "invalid u parameter", http.StatusBadRequest)
			return
		}
		targetPath = parsed.Path
		targetRawPath = parsed.RawPath
		targetRawQuery = parsed.RawQuery
		// 读取方法覆盖参数（非 GET/HEAD/POST 方法通过 POST + m 参数传递）
		methodOverride = r.URL.Query().Get("m")
	} else {
		// subpath：targetPath 是 port 后的剩余路径（含前导 /）
		remaining := rest[slash:]
		decoded, err := url.PathUnescape(remaining)
		if err != nil {
			http.Error(w, "invalid path encoding", http.StatusBadRequest)
			return
		}
		targetPath = decoded
		targetRawPath = remaining
		targetRawQuery = r.URL.RawQuery
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme = "http"
			r.Out.URL.Host = "localhost:" + portStr
			r.Out.URL.Path = targetPath
			r.Out.URL.RawPath = targetRawPath
			r.Out.URL.RawQuery = targetRawQuery
			r.Out.Host = "localhost:" + portStr

			// tunnel 模式：恢复原始方法
			if methodOverride != "" {
				r.Out.Method = methodOverride
			}

			// 重写 Origin/Referer 满足 CSRF/同源校验
			r.Out.Header.Set("Origin", targetOrigin)
			r.Out.Header.Set("Referer", targetOrigin+"/")

			// 过滤 X-Forwarded-* 和 X-Proxy-* headers
			for key := range r.Out.Header {
				lk := strings.ToLower(key)
				if strings.HasPrefix(lk, "x-forwarded-") || strings.HasPrefix(lk, "x-proxy-") {
					r.Out.Header.Del(key)
				}
			}
		},
		Transport:    proxyTransport,
		ErrorHandler: proxyErrorHandler,
	}
	proxy.ServeHTTP(w, r)
}

func proxyErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("[Proxy] %s %s -> %v", r.Method, r.URL.Path, err)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusBadGateway)
	fmt.Fprintf(w, "proxy error: %v", err)
}
