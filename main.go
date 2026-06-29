package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	RelayURL     string
	AgentID      string
	ForwardURL   string // 转发到本地框架的地址
	ForwardPath  string // 转发路径
}

type RelayMessage struct {
	FromID  string `json:"from_id"`
	ToID    string `json:"to_id"`
	Content string `json:"content"`
	MsgType string `json:"msg_type"`
}

type SSEEvent struct {
	Type      string `json:"type"`
	ID        string `json:"id,omitempty"`
	FromID    string `json:"from_id,omitempty"`
	Content   string `json:"content,omitempty"`
	MsgType   string `json:"msg_type,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
}

type ForwardRequest struct {
	From    string `json:"from"`
	Content string `json:"content"`
}

type ForwardResponse struct {
	Reply string `json:"reply"`
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	config := loadConfig()

	log.Printf("[启动] Agent: %s", config.AgentID)
	log.Printf("[Relay] %s", config.RelayURL)
	log.Printf("[转发] %s%s", config.ForwardURL, config.ForwardPath)

	register(config)

	sse := NewSSEClient(config.RelayURL, config.AgentID)
	sse.OnMessage(func(event *SSEEvent) {
		if event.Type != "message" || event.FromID == config.AgentID {
			return
		}
		log.Printf("[收到] %s: %s", event.FromID, truncate(event.Content, 80))
		go handleMessage(event, config)
	})
	sse.Start()
	defer sse.Stop()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("[退出]")
}

func handleMessage(event *SSEEvent, config *Config) {
	// 转发到本地框架
	reply := forwardToFramework(config, event.FromID, event.Content)
	if reply == "" {
		reply = "[框架无响应]"
	}

	// 通过 Relay 回复
	sendReply(config, event.FromID, reply)
	log.Printf("[回复] → %s: %s", event.FromID, truncate(reply, 80))
}

func forwardToFramework(config *Config, fromID, content string) string {
	reqBody := ForwardRequest{From: fromID, Content: content}
	data, _ := json.Marshal(reqBody)

	url := config.ForwardURL + config.ForwardPath
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(data))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[转发错误] %v", err)
		return ""
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		log.Printf("[转发错误] %d: %s", resp.StatusCode, truncate(string(body), 200))
		return ""
	}

	var fwdResp ForwardResponse
	if err := json.Unmarshal(body, &fwdResp); err != nil {
		// 如果不是 JSON，直接返回原始响应
		return string(body)
	}
	return fwdResp.Reply
}

func sendReply(config *Config, toID, content string) {
	msg := RelayMessage{FromID: config.AgentID, ToID: toID, Content: content, MsgType: "text"}
	data, _ := json.Marshal(msg)
	http.Post(config.RelayURL+"/api/messages", "application/json", bytes.NewBuffer(data))
}

func register(config *Config) {
	data, _ := json.Marshal(map[string]string{
		"agent_id":  config.AgentID,
		"name":      config.AgentID,
		"framework": "relay-bridge",
	})
	http.Post(config.RelayURL+"/api/agents/register", "application/json", bytes.NewBuffer(data))
	log.Println("[注册] 成功")
}

func loadConfig() *Config {
	cfg := &Config{
		RelayURL:    "https://agent-relay-production-560a.up.railway.app",
		AgentID:     "hermes",
		ForwardURL:  "http://localhost:3000",
		ForwardPath: "/chat",
	}
	if v := os.Getenv("RELAY_URL"); v != "" { cfg.RelayURL = v }
	if v := os.Getenv("AGENT_ID"); v != "" { cfg.AgentID = v }
	if v := os.Getenv("FORWARD_URL"); v != "" { cfg.ForwardURL = v }
	if v := os.Getenv("FORWARD_PATH"); v != "" { cfg.ForwardPath = v }
	return cfg
}

func truncate(s string, n int) string {
	if len(s) <= n { return s }
	return s[:n] + "..."
}

type SSEClient struct {
	relayURL, agentID string
	stopCh chan struct{}
	handlers []func(*SSEEvent)
	seenIDs map[string]bool
}

func NewSSEClient(relayURL, agentID string) *SSEClient {
	return &SSEClient{relayURL: relayURL, agentID: agentID, stopCh: make(chan struct{}), handlers: make([]func(*SSEEvent), 0), seenIDs: make(map[string]bool)}
}

func (c *SSEClient) OnMessage(h func(*SSEEvent)) { c.handlers = append(c.handlers, h) }
func (c *SSEClient) Start() { go c.listenLoop() }
func (c *SSEClient) Stop()  { close(c.stopCh) }

func (c *SSEClient) listenLoop() {
	client := &http.Client{}
	for {
		select { case <-c.stopCh: return; default: }
		url := fmt.Sprintf("%s/api/stream?agent_id=%s", c.relayURL, c.agentID)
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("Accept", "text/event-stream")
		resp, err := client.Do(req)
		if err != nil { time.Sleep(3*time.Second); continue }
		log.Println("[SSE] 已连接")
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			if err != nil {
				select { case <-c.stopCh: resp.Body.Close(); return; default: }
				log.Println("[SSE] 断开，3秒后重连")
				time.Sleep(3*time.Second)
				break
			}
			for _, line := range strings.Split(string(buf[:n]), "\n") {
				if !strings.HasPrefix(line, "data: ") { continue }
				var event SSEEvent
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) != nil { continue }
				if event.Type == "connected" || (event.ID != "" && c.seenIDs[event.ID]) { continue }
				if event.ID != "" {
					c.seenIDs[event.ID] = true
					if len(c.seenIDs) > 1000 { for k := range c.seenIDs { delete(c.seenIDs, k); if len(c.seenIDs) <= 500 { break } } }
				}
				for _, h := range c.handlers { h(&event) }
			}
		}
		resp.Body.Close()
	}
}
