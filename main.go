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
	RelayURL    string
	AgentID     string
	Protocol    string // openai, simple, relay
	ForwardURL  string
	APIKey      string
	Model       string
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

// ========== 协议适配器 ==========

type ProtocolAdapter interface {
	// 构造请求发给本地框架
	BuildRequest(fromID, content string, history []ChatMessage) (*http.Request, error)
	// 从响应中提取回复
	ParseResponse(body []byte) (string, error)
	// 获取对话历史的系统提示
	SystemPrompt(agentID string) string
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// --- OpenAI 兼容协议 ---
type OpenAIAdapter struct {
	URL     string
	APIKey  string
	Model   string
}

func (a *OpenAIAdapter) BuildRequest(fromID, content string, history []ChatMessage) (*http.Request, error) {
	msgs := append(history, ChatMessage{Role: "user", Content: content})
	body := map[string]interface{}{
		"model":    a.Model,
		"messages": msgs,
	}
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", a.URL+"/chat/completions", bytes.NewBuffer(data))
	req.Header.Set("Content-Type", "application/json")
	if a.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+a.APIKey)
	}
	return req, nil
}

func (a *OpenAIAdapter) ParseResponse(body []byte) (string, error) {
	var resp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	if len(resp.Choices) > 0 {
		return resp.Choices[0].Message.Content, nil
	}
	return "", nil
}

func (a *OpenAIAdapter) SystemPrompt(agentID string) string {
	return fmt.Sprintf("你是 %s，一个 AI 智能体，通过 Agent Relay 通信。回复简洁有帮助。", agentID)
}

// --- Simple 转发协议（直接 POST JSON，取 reply 字段）---
type SimpleAdapter struct {
	URL string
}

func (a *SimpleAdapter) BuildRequest(fromID, content string, _ []ChatMessage) (*http.Request, error) {
	body := map[string]string{"from": fromID, "content": content}
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", a.URL, bytes.NewBuffer(data))
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}

func (a *SimpleAdapter) ParseResponse(body []byte) (string, error) {
	// 尝试 JSON
	var resp map[string]interface{}
	if err := json.Unmarshal(body, &resp); err == nil {
		if reply, ok := resp["reply"].(string); ok {
			return reply, nil
		}
		if content, ok := resp["content"].(string); ok {
			return content, nil
		}
		if message, ok := resp["message"].(string); ok {
			return message, nil
		}
	}
	// 直接返回原始响应
	return string(body), nil
}

func (a *SimpleAdapter) SystemPrompt(_ string) string { return "" }

// --- Relay 协议（转发到另一个 Relay 实例）---
type RelayAdapter struct {
	URL    string
	ToID   string
}

func (a *RelayAdapter) BuildRequest(fromID, content string, _ []ChatMessage) (*http.Request, error) {
	body := RelayMessage{FromID: fromID, ToID: a.ToID, Content: content, MsgType: "text"}
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", a.URL+"/api/messages", bytes.NewBuffer(data))
	req.Header.Set("Content-Type", "application/json")
	return req, nil
}

func (a *RelayAdapter) ParseResponse(body []byte) (string, error) {
	var resp map[string]interface{}
	if err := json.Unmarshal(body, &resp); err == nil {
		if msg, ok := resp["message"].(map[string]interface{}); ok {
			if content, ok := msg["content"].(string); ok {
				return content, nil
			}
		}
	}
	return string(body), nil
}

func (a *RelayAdapter) SystemPrompt(_ string) string { return "" }

// ========== 对话历史管理 ==========

var conversationHistory = make(map[string][]ChatMessage)
const maxHistory = 20

func addToHistory(agentID, systemPrompt, role, content string) {
	if _, ok := conversationHistory[agentID]; !ok && systemPrompt != "" {
		conversationHistory[agentID] = []ChatMessage{{Role: "system", Content: systemPrompt}}
	}
	conversationHistory[agentID] = append(conversationHistory[agentID], ChatMessage{Role: role, Content: content})
	if len(conversationHistory[agentID]) > maxHistory {
		h := conversationHistory[agentID]
		conversationHistory[agentID] = append(h[:1], h[len(h)-maxHistory+1:]...)
	}
}

func getHistory(agentID string) []ChatMessage {
	return conversationHistory[agentID]
}

// ========== 主程序 ==========

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	config := loadConfig()
	adapter := createAdapter(config)

	log.Printf("[启动] Agent: %s", config.AgentID)
	log.Printf("[Relay] %s", config.RelayURL)
	log.Printf("[协议] %s → %s", config.Protocol, config.ForwardURL)

	register(config)

	sse := NewSSEClient(config.RelayURL, config.AgentID)
	sse.OnMessage(func(event *SSEEvent) {
		if event.Type != "message" || event.FromID == config.AgentID {
			return
		}
		log.Printf("[收到] %s: %s", event.FromID, truncate(event.Content, 80))
		go handleMessage(event, config, adapter)
	})
	sse.Start()
	defer sse.Stop()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("[退出]")
}

func handleMessage(event *SSEEvent, config *Config, adapter ProtocolAdapter) {
	fromID := event.FromID
	content := event.Content

	history := getHistory(fromID)
	req, err := adapter.BuildRequest(fromID, content, history)
	if err != nil {
		log.Printf("[构建请求错误] %v", err)
		return
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[转发错误] %v", err)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		log.Printf("[框架错误] %d: %s", resp.StatusCode, truncate(string(body), 200))
		return
	}

	reply, err := adapter.ParseResponse(body)
	if err != nil || reply == "" {
		reply = "[无响应]"
	}

	// 更新历史
	addToHistory(fromID, adapter.SystemPrompt(config.AgentID), "user", content)
	addToHistory(fromID, "", "assistant", reply)

	sendReply(config, fromID, reply)
	log.Printf("[回复] → %s: %s", fromID, truncate(reply, 80))
}

func createAdapter(config *Config) ProtocolAdapter {
	switch config.Protocol {
	case "openai":
		return &OpenAIAdapter{URL: config.ForwardURL, APIKey: config.APIKey, Model: config.Model}
	case "simple":
		return &SimpleAdapter{URL: config.ForwardURL}
	case "relay":
		return &RelayAdapter{URL: config.ForwardURL, ToID: config.AgentID}
	default:
		return &SimpleAdapter{URL: config.ForwardURL}
	}
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
		RelayURL:   "https://agent-relay-production-560a.up.railway.app",
		AgentID:    "hermes",
		Protocol:   "simple",
		ForwardURL: "http://localhost:8080",
		Model:      "default",
	}
	if v := os.Getenv("RELAY_URL"); v != "" { cfg.RelayURL = v }
	if v := os.Getenv("AGENT_ID"); v != "" { cfg.AgentID = v }
	if v := os.Getenv("PROTOCOL"); v != "" { cfg.Protocol = v }
	if v := os.Getenv("FORWARD_URL"); v != "" { cfg.ForwardURL = v }
	if v := os.Getenv("API_KEY"); v != "" { cfg.APIKey = v }
	if v := os.Getenv("MODEL"); v != "" { cfg.Model = v }
	return cfg
}

func truncate(s string, n int) string {
	if len(s) <= n { return s }
	return s[:n] + "..."
}

// ========== SSE 客户端 ==========

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
