package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"

	"github.com/gorilla/websocket"
)

// WSSession 管理一个到目标的 WebSocket 连接
type WSSession struct {
	conn    *websocket.Conn
	sseChan chan sseEvent // 下行消息队列
	done    chan struct{}
	once    sync.Once
}

func (s *WSSession) signalDone() {
	s.once.Do(func() { close(s.done) })
}

type sseEvent struct {
	Type    string `json:"type"`    // open, message, close, error
	Data    string `json:"data"`    // base64 编码（message 时）
	Code    int    `json:"code"`    // close code
	MsgType int    `json:"msgType,omitempty"` // 1=text, 2=binary
}

var (
	wsSessions   = make(map[string]*WSSession)
	wsSessionsMu sync.RWMutex
)

func getWSSession(sid string) *WSSession {
	wsSessionsMu.RLock()
	defer wsSessionsMu.RUnlock()
	return wsSessions[sid]
}

func putWSSession(sid string, s *WSSession) {
	wsSessionsMu.Lock()
	wsSessions[sid] = s
	wsSessionsMu.Unlock()
}

func delWSSession(sid string) {
	wsSessionsMu.Lock()
	delete(wsSessions, sid)
	wsSessionsMu.Unlock()
}

// handleWsConnect: 建立 WS 连接，SSE 下行推送
func handleWsConnect(w http.ResponseWriter, r *http.Request, port int, wsPath string, sid string) {
	// 检查是否已有同 sid 的 session
	if existing := getWSSession(sid); existing != nil {
		http.Error(w, "session exists", http.StatusConflict)
		return
	}

	portStr := strconv.Itoa(port)
	targetURL := fmt.Sprintf("ws://localhost:%s%s", portStr, wsPath)

	// 提取 subprotocols（通过 query 传递）
	var subprotocols []string
	if sp := r.URL.Query().Get("subprotocols"); sp != "" {
		if err := json.Unmarshal([]byte(sp), &subprotocols); err == nil {
			// ignore error
		}
	}

	dialer := websocket.Dialer{
		Subprotocols: subprotocols,
	}
	conn, _, err := dialer.Dial(targetURL, nil)
	if err != nil {
		log.Printf("[WS Bridge] Dial failed: %v", err)
		http.Error(w, fmt.Sprintf("ws dial failed: %v", err), http.StatusBadGateway)
		return
	}

	session := &WSSession{
		conn:    conn,
		sseChan: make(chan sseEvent, 64),
		done:    make(chan struct{}),
	}
	putWSSession(sid, session)

	// 下行通道：SSE（默认）或 Fetch Streaming（?stream=1）
	useStream := r.URL.Query().Get("stream") == "1"
	if useStream {
		w.Header().Set("Content-Type", "application/octet-stream")
	} else {
		w.Header().Set("Content-Type", "text/event-stream")
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	// 发送 open 事件
	fmt.Fprintf(w, "data: {\"type\":\"open\"}\n\n")
	if flusher != nil {
		flusher.Flush()
	}

	// goroutine: 读目标 WS → 推送 SSE
	go func() {
		for {
			msgType, data, err := conn.ReadMessage()
			if err != nil {
				code := 1006
				if websocket.IsCloseError(err, websocket.CloseNormalClosure) {
					code = 1000
				}
				select {
				case session.sseChan <- sseEvent{Type: "close", Code: code}:
				case <-session.done:
				}
				return
			}
			select {
				case session.sseChan <- sseEvent{
					Type:    "message",
					Data:    base64.StdEncoding.EncodeToString(data),
					MsgType: msgType,
				}:
				case <-session.done:
					return
			}
		}
	}()

	// 主循环：从 sseChan 读取 → SSE 写入
	// 同时检查客户端断开
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			// 客户端断开 SSE
			session.signalDone()
			conn.Close()
			delWSSession(sid)
			return
		case ev := <-session.sseChan:
			evJSON, _ := json.Marshal(ev)
			fmt.Fprintf(w, "data: %s\n\n", evJSON)
			if flusher != nil {
				flusher.Flush()
			}
			if ev.Type == "close" {
				conn.Close()
				delWSSession(sid)
				return
			}
		}
	}
}

// handleWsSend: POST 上行消息
func handleWsSend(w http.ResponseWriter, r *http.Request, sid string) {
	session := getWSSession(sid)
	if session == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	// 检查会话是否已关闭
	select {
	case <-session.done:
		http.Error(w, "session closed", http.StatusGone)
		return
	default:
	}

	action := r.URL.Query().Get("action")
	if action == "close" {
		// 关闭连接
		session.conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(1000, ""))
		session.conn.Close()
		delWSSession(sid)
		w.WriteHeader(http.StatusOK)
		return
	}

	// 读取 body 作为消息发送
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body failed", http.StatusBadRequest)
		return
	}

	// 检查是否是 base64 编码的二进制
	msgType := websocket.TextMessage
	if r.Header.Get("Content-Type") == "application/octet-stream" {
		msgType = websocket.BinaryMessage
	}

	if err := session.conn.WriteMessage(msgType, body); err != nil {
		log.Printf("[WS Bridge] Write failed: %v", err)
		http.Error(w, "write failed", http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusOK)
}
