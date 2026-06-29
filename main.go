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
	RelayURL  string
	AgentID   string
	APIKey    string
	BaseURL   string
	Model     string
	MaxTokens int
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

type ChatRequest struct {
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
	MaxTokens int          `json:"max_tokens,omitempty"`
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

var conversationHistory = make(map[string][]ChatMessage)
const maxHistory = 20

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	config := loadConfig()

	log.Printf("[启动] Agent: %s", config.AgentID)
	log.Printf("[Relay] %s", config.RelayURL)
	log.Printf("[模型] %s @ %s", config.Model, config.BaseURL)

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
	fromID := event.FromID
	content := event.Content

	if _, ok := conversationHistory[fromID]; !ok {
		conversationHistory[fromID] = []ChatMessage{
			{Role: "system", Content: fmt.Sprintf("你是 %s，一个 AI 智能体。你正在通过 Agent Relay 与其他智能体对话。回复要简洁、有帮助。", config.AgentID)},
		}
	}
	conversationHistory[fromID] = append(conversationHistory[fromID], ChatMessage{Role: "user", Content: content})

	if len(conversationHistory[fromID]) > maxHistory {
		conversationHistory[fromID] = append(
			conversationHistory[fromID][:1],
			conversationHistory[fromID][len(conversationHistory[fromID])-maxHistory+1:]...,
		)
	}

	reply := callLLM(config, conversationHistory[fromID])
	if reply == "" {
		reply = "[无响应]"
	}

	conversationHistory[fromID] = append(conversationHistory[fromID], ChatMessage{Role: "assistant", Content: reply})
	sendReply(config, fromID, reply)
	log.Printf("[回复] → %s: %s", fromID, truncate(reply, 80))
}

func callLLM(config *Config, messages []ChatMessage) string {
	reqBody := ChatRequest{Model: config.Model, Messages: messages, MaxTokens: config.MaxTokens}
	data, _ := json.Marshal(reqBody)

	url := strings.TrimRight(config.BaseURL, "/") + "/chat/completions"
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+config.APIKey)

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[LLM 错误] %v", err)
		return ""
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		log.Printf("[LLM 错误] %d: %s", resp.StatusCode, truncate(string(body), 200))
		return ""
	}

	var chatResp ChatResponse
	json.Unmarshal(body, &chatResp)
	if len(chatResp.Choices) > 0 {
		return chatResp.Choices[0].Message.Content
	}
	return ""
}

func sendReply(config *Config, toID, content string) {
	msg := RelayMessage{FromID: config.AgentID, ToID: toID, Content: content, MsgType: "text"}
	data, _ := json.Marshal(msg)
	http.Post(config.RelayURL+"/api/messages", "application/json", bytes.NewBuffer(data))
}

func register(config *Config) {
	data, _ := json.Marshal(map[string]string{"agent_id": config.AgentID, "name": config.AgentID, "framework": "go-sse-client"})
	http.Post(config.RelayURL+"/api/agents/register", "application/json", bytes.NewBuffer(data))
	log.Println("[注册] 成功")
}

func loadConfig() *Config {
	cfg := &Config{
		RelayURL:  "https://agent-relay-production-560a.up.railway.app",
		AgentID:   "hermes",
		BaseURL:   "https://apihub.agnes-ai.com/v1",
		Model:     "agnes-2.0-flash",
		MaxTokens: 500,
	}
	if v := os.Getenv("RELAY_URL"); v != "" { cfg.RelayURL = v }
	if v := os.Getenv("AGENT_ID"); v != "" { cfg.AgentID = v }
	if v := os.Getenv("API_KEY"); v != "" { cfg.APIKey = v }
	if v := os.Getenv("BASE_URL"); v != "" { cfg.BaseURL = v }
	if v := os.Getenv("MODEL"); v != "" { cfg.Model = v }
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
