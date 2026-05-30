package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	defaultConnectTimeout        = 15 * time.Second
	defaultResponseHeaderTimeout = 60 * time.Second
	defaultIdleConnTimeout       = 90 * time.Second
	defaultTotalTimeout          = 5 * time.Minute
	defaultMaxAttempts           = 2
	defaultBaseRetryDelay        = 500 * time.Millisecond
	defaultMaxRetryDelay         = 3 * time.Second
	maxRequestBodyBytes          = 256 * 1024 * 1024
)

type readyMessage struct {
	Type string `json:"type"`
	Port int    `json:"port"`
}

type healthResponse struct {
	Ready          bool           `json:"ready"`
	State          string         `json:"state"`
	ListenAddress  string         `json:"listenAddress,omitempty"`
	LastSuccessAt  int64          `json:"lastSuccessAt,omitempty"`
	LastFailureAt  int64          `json:"lastFailureAt,omitempty"`
	RecentFailures map[string]int `json:"recentFailures"`
	LastError      *failureRecord `json:"lastError,omitempty"`
}

type failureRecord struct {
	Stage         string `json:"stage"`
	Target        string `json:"target,omitempty"`
	Message       string `json:"message"`
	Count         int    `json:"count"`
	LastFailureAt int64  `json:"lastFailureAt,omitempty"`
}

type sidecarState struct {
	mu             sync.RWMutex
	listenAddress  string
	lastSuccessAt  int64
	lastFailureAt  int64
	recentFailures map[string]int
	lastError      *failureRecord
}

type fetchRequest struct {
	URL         string            `json:"url"`
	Method      string            `json:"method"`
	Headers     map[string]string `json:"headers,omitempty"`
	BodyBase64  string            `json:"bodyBase64,omitempty"`
	TimeoutMs   int               `json:"timeoutMs,omitempty"`
	MaxAttempts int               `json:"maxAttempts,omitempty"`
}

type cancelOnCloseReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (r *cancelOnCloseReadCloser) Close() error {
	err := r.ReadCloser.Close()
	r.cancel()
	return err
}

func (s *sidecarState) setListenAddress(address string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listenAddress = address
}

func (s *sidecarState) setLastError(err string) {
	s.recordFailure("unknown", "", err)
}

func (s *sidecarState) recordFailure(stage string, target string, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastFailureAt = time.Now().UnixMilli()
	if s.recentFailures == nil {
		s.recentFailures = map[string]int{}
	}
	s.recentFailures[stage]++
	s.lastError = &failureRecord{
		Stage:         stage,
		Target:        target,
		Message:       message,
		Count:         s.recentFailures[stage],
		LastFailureAt: s.lastFailureAt,
	}
}

func (s *sidecarState) recordSuccess() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSuccessAt = time.Now().UnixMilli()
}

func (s *sidecarState) snapshot() healthResponse {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state := "down"
	if s.listenAddress != "" {
		state = "ready"
	}
	if s.lastError != nil && s.lastFailureAt >= s.lastSuccessAt {
		state = "degraded"
	}
	return healthResponse{
		Ready:          s.listenAddress != "",
		State:          state,
		ListenAddress:  s.listenAddress,
		LastSuccessAt:  s.lastSuccessAt,
		LastFailureAt:  s.lastFailureAt,
		RecentFailures: cloneFailures(s.recentFailures),
		LastError:      cloneFailureRecord(s.lastError),
	}
}

func cloneFailures(input map[string]int) map[string]int {
	output := map[string]int{
		"dns":      0,
		"connect":  0,
		"tls":      0,
		"upstream": 0,
		"stream":   0,
		"unknown":  0,
	}
	for key, value := range input {
		output[key] = value
	}
	return output
}

func cloneFailureRecord(input *failureRecord) *failureRecord {
	if input == nil {
		return nil
	}
	copy := *input
	return &copy
}

func main() {
	log.SetOutput(io.Discard)

	state := &sidecarState{}
	client := createHTTPClient()
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(state.snapshot())
	})
	mux.HandleFunc("/v1/fetch", func(w http.ResponseWriter, r *http.Request) {
		handleFetch(state, client, w, r)
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}

	state.setListenAddress(listener.Addr().String())
	state.recordSuccess()
	port := listener.Addr().(*net.TCPAddr).Port
	_ = json.NewEncoder(os.Stdout).Encode(readyMessage{Type: "ready", Port: port})

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}

	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		state.setLastError(err.Error())
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
}

func createHTTPClient() *http.Client {
	return &http.Client{
		Timeout: defaultTotalTimeout,
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   defaultConnectTimeout,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          128,
			MaxIdleConnsPerHost:   32,
			IdleConnTimeout:       defaultIdleConnTimeout,
			ResponseHeaderTimeout: defaultResponseHeaderTimeout,
			TLSHandshakeTimeout:   defaultConnectTimeout,
		},
	}
}

func handleFetch(state *sidecarState, client *http.Client, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()

	var payload fetchRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxRequestBodyBytes))
	if err := decoder.Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	response, err := executeFetch(r.Context(), client, state, payload)
	if err != nil {
		stage := classifyFailureStage(err)
		state.recordFailure(stage, requestTarget(payload.URL), err.Error())
		w.Header().Set("x-pi-sidecar-error", "true")
		http.Error(w, err.Error(), 599)
		return
	}
	defer response.Body.Close()

	state.recordSuccess()
	copyResponseHeaders(w.Header(), response.Header)
	w.WriteHeader(response.StatusCode)
	if _, err := io.Copy(w, response.Body); err != nil {
		state.recordFailure("stream", requestTarget(payload.URL), err.Error())
	}
}

func executeFetch(ctx context.Context, client *http.Client, state *sidecarState, payload fetchRequest) (*http.Response, error) {
	method := strings.ToUpper(strings.TrimSpace(payload.Method))
	if method == "" {
		method = http.MethodGet
	}
	body, err := decodeRequestBody(payload.BodyBase64)
	if err != nil {
		return nil, err
	}

	maxAttempts := payload.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = defaultMaxAttempts
	}

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		reqCtx := ctx
		cancel := func() {}
		if payload.TimeoutMs > 0 {
			var cancelFn context.CancelFunc
			reqCtx, cancelFn = context.WithTimeout(ctx, time.Duration(payload.TimeoutMs)*time.Millisecond)
			cancel = cancelFn
		}
		req, err := http.NewRequestWithContext(reqCtx, method, payload.URL, bytes.NewReader(body))
		if err != nil {
			cancel()
			return nil, err
		}
		copyHeaders(req.Header, payload.Headers)
		req.Header.Del("accept-encoding")

		response, err := client.Do(req)
		if err != nil {
			cancel()
			lastErr = err
			if attempt < maxAttempts && isRetryableError(err) {
				state.recordFailure(classifyFailureStage(err), req.URL.Host, err.Error())
				sleepBeforeRetry(ctx, attempt)
				continue
			}
			return nil, err
		}

		if attempt < maxAttempts && isRetryableResponse(response.StatusCode) {
			lastErr = errors.New(response.Status)
			_ = response.Body.Close()
			cancel()
			state.recordFailure("upstream", req.URL.Host, response.Status)
			sleepBeforeRetry(ctx, attempt)
			continue
		}

		response.Body = &cancelOnCloseReadCloser{
			ReadCloser: response.Body,
			cancel:     cancel,
		}
		return response, nil
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("request failed without response")
}

func decodeRequestBody(bodyBase64 string) ([]byte, error) {
	if bodyBase64 == "" {
		return nil, nil
	}
	body, err := base64.StdEncoding.DecodeString(bodyBase64)
	if err != nil {
		return nil, err
	}
	if len(body) > maxRequestBodyBytes {
		return nil, errors.New("request body too large")
	}
	return body, nil
}

func copyHeaders(target http.Header, headers map[string]string) {
	for key, value := range headers {
		if key == "" {
			continue
		}
		target.Set(key, value)
	}
}

func copyResponseHeaders(target http.Header, source http.Header) {
	hopByHop := map[string]bool{
		"connection":          true,
		"keep-alive":          true,
		"proxy-authenticate":  true,
		"proxy-authorization": true,
		"te":                  true,
		"trailer":             true,
		"transfer-encoding":   true,
		"upgrade":             true,
	}
	for key, values := range source {
		if hopByHop[strings.ToLower(key)] {
			continue
		}
		for _, value := range values {
			target.Add(key, value)
		}
	}
}

func isRetryableResponse(status int) bool {
	return status == http.StatusRequestTimeout ||
		status == http.StatusTooManyRequests ||
		status == http.StatusInternalServerError ||
		status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable ||
		status == http.StatusGatewayTimeout
}

func isRetryableError(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	return true
}

func sleepBeforeRetry(ctx context.Context, attempt int) {
	delay := defaultBaseRetryDelay * time.Duration(1<<(attempt-1))
	if delay > defaultMaxRetryDelay {
		delay = defaultMaxRetryDelay
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func requestTarget(rawURL string) string {
	if rawURL == "" {
		return ""
	}
	if req, err := http.NewRequest(http.MethodGet, rawURL, nil); err == nil && req.URL != nil {
		return req.URL.Host
	}
	return rawURL
}

func classifyFailureStage(err error) string {
	if err == nil {
		return "unknown"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns"
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		if opErr.Op == "dial" {
			return "connect"
		}
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "tls") || strings.Contains(message, "handshake") {
		return "tls"
	}
	if strings.Contains(message, "unexpected eof") || strings.Contains(message, "stream") {
		return "stream"
	}
	return "upstream"
}
