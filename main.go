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

// Config holds relay server configuration.
type Config struct {
	RelayURL string `json:"relay_url"`
	AgentID  string `json:"agent_id"`
}

// RelayMessage is the message format used by the relay server.
type RelayMessage struct {
	ID      string `json:"id,omitempty"`
	FromID  string `json:"from_id"`
	ToID    string `json:"to_id"`
	Channel string `json:"channel,omitempty"`
	Content string `json:"content"`
	MsgType string `json:"msg_type"`
}

// SSEEvent represents a message received via SSE.
type SSEEvent struct {
	Type     string `json:"type"`
	ID       string `json:"id,omitempty"`
	FromID   string `json:"from_id,omitempty"`
	ToID     string `json:"to_id,omitempty"`
	Channel  string `json:"channel,omitempty"`
	Content  string `json:"content,omitempty"`
	MsgType  string `json:"msg_type,omitempty"`
	Timestamp int64 `json:"timestamp,omitempty"`
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	config := loadConfig()
	if config.RelayURL == "" {
		config.RelayURL = "https://agent-relay-production-560a.up.railway.app"
	}
	if config.AgentID == "" {
		config.AgentID = "hermes"
	}

	log.Printf("Agent ID: %s", config.AgentID)
	log.Printf("Relay URL: %s", config.RelayURL)

	// Start SSE listener
	sseClient := NewSSEClient(config.RelayURL, config.AgentID)
	
	// Message handler
	sseClient.OnMessage(func(event *SSEEvent) {
		if event.Type != "message" {
			return
		}
		log.Printf("Received from %s: %s", event.FromID, event.Content[:min(100, len(event.Content))])
		
		// Auto-reply logic
		handleMessage(event, config)
	})

	// Start listening
	sseClient.Start()
	defer sseClient.Stop()

	// Wait for interrupt
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("Shutting down...")
}

func handleMessage(event *SSEEvent, config *Config) {
	// Don't reply to ourselves
	if event.FromID == config.AgentID {
		return
	}

	content := event.Content
	fromID := event.FromID

	// Simple auto-reply patterns
	reply := ""
	lower := strings.ToLower(content)

	if strings.Contains(lower, "hello") || strings.Contains(lower, "你好") {
		reply = fmt.Sprintf("Hello from %s! Thanks for the message.", config.AgentID)
	} else if strings.Contains(lower, "status") || strings.Contains(lower, "状态") {
		reply = fmt.Sprintf("Agent %s is running. Uptime: %d minutes.", 
			config.AgentID, time.Since(startTime).Minutes())
	} else if strings.Contains(lower, "help") || strings.Contains(lower, "帮助") {
		reply = "Available commands: status, help, ping"
	} else if strings.Contains(lower, "ping") {
		reply = "pong"
	} else {
		// Default: echo back with agent ID
		reply = fmt.Sprintf("[Auto-reply from %s] Received: %s", config.AgentID, content)
	}

	// Send reply
	sendReply(config.RelayURL, config.AgentID, fromID, reply)
}

var startTime = time.Now()

func sendReply(relayURL, fromID, toID, content string) {
	msg := RelayMessage{
		FromID:  fromID,
		ToID:    toID,
		Content: content,
		MsgType: "text",
	}

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal message: %v", err)
		return
	}

	resp, err := http.Post(
		fmt.Sprintf("%s/api/messages", relayURL),
		"application/json",
		bytes.NewBuffer(data),
	)
	if err != nil {
		log.Printf("Failed to send reply: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		log.Printf("Reply sent to %s", toID)
	} else {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("Failed to send reply: %d - %s", resp.StatusCode, string(body))
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// SSEClient manages SSE connection to the relay server.
type SSEClient struct {
	relayURL string
	agentID  string
	client   *http.Client
	stopCh   chan struct{}
	handlers []func(*SSEEvent)
	seenIDs  map[string]bool
}

func NewSSEClient(relayURL, agentID string) *SSEClient {
	return &SSEClient{
		relayURL: relayURL,
		agentID:  agentID,
		client:   &http.Client{},
		stopCh:   make(chan struct{}),
		handlers: make([]func(*SSEEvent), 0),
		seenIDs:  make(map[string]bool),
	}
}

func (c *SSEClient) OnMessage(handler func(*SSEEvent)) {
	c.handlers = append(c.handlers, handler)
}

func (c *SSEClient) Start() {
	go c.listenLoop()
}

func (c *SSEClient) Stop() {
	close(c.stopCh)
}

func (c *SSEClient) listenLoop() {
	for {
		select {
		case <-c.stopCh:
			return
		default:
		}

		url := fmt.Sprintf("%s/api/stream?agent_id=%s", c.relayURL, c.agentID)
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			log.Printf("Failed to create request: %v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		req.Header.Set("Accept", "text/event-stream")

		resp, err := c.client.Do(req)
		if err != nil {
			log.Printf("SSE connection failed: %v, retrying in 3s...", err)
			time.Sleep(3 * time.Second)
			continue
		}

		log.Println("SSE connected")
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			if err != nil {
				select {
				case <-c.stopCh:
					resp.Body.Close()
					return
				default:
				}
				log.Printf("SSE disconnected: %v, reconnecting in 3s...", err)
				time.Sleep(3 * time.Second)
				break
			}

			data := string(buf[:n])
			lines := strings.Split(data, "\n")
			for _, line := range lines {
				if strings.HasPrefix(line, "data: ") {
					eventData := strings.TrimPrefix(line, "data: ")
					var event SSEEvent
					if err := json.Unmarshal([]byte(eventData), &event); err != nil {
						continue
					}
					if event.Type == "connected" {
						continue
					}
					if event.ID != "" && !c.seenIDs[event.ID] {
						c.seenIDs[event.ID] = true
						// Keep only last 1000 IDs
						if len(c.seenIDs) > 1000 {
							keys := make([]string, 0, len(c.seenIDs))
							for k := range c.seenIDs {
								keys = append(keys, k)
							}
							for _, k := range keys[:len(keys)-500] {
								delete(c.seenIDs, k)
							}
						}
						for _, h := range c.handlers {
							h(&event)
						}
					}
				}
			}
		}
		resp.Body.Close()
	}
}

func loadConfig() *Config {
	cfg := &Config{}
	
	// Try config file
	if data, err := os.ReadFile("/tmp/agent-client-config.json"); err == nil {
		json.Unmarshal(data, cfg)
	}
	
	// Override with env vars
	if v := os.Getenv("RELAY_URL"); v != "" {
		cfg.RelayURL = v
	}
	if v := os.Getenv("AGENT_ID"); v != "" {
		cfg.AgentID = v
	}
	
	return cfg
}
