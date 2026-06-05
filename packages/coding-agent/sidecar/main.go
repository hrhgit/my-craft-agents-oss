package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
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

const (
	sidecarOwnerHeader          = "x-pi-transport-owner"
	sidecarRequestIDHeader      = "x-pi-request-id"
	sidecarTraceIDHeader        = "x-pi-trace-id"
	sidecarResponseStatusHeader = "x-pi-response-status"
	sidecarAttemptCountHeader   = "x-pi-attempt-count"
	sidecarRetryCountHeader     = "x-pi-retry-count"
	sidecarStreamingHeader      = "x-pi-streaming"
	sidecarStreamingRespHeader  = "x-pi-streaming-response"
	sidecarStreamStartedHeader  = "x-pi-stream-started"
	sidecarFinalStatusHeader    = "x-pi-final-status"
	sidecarFailureStageHeader   = "x-pi-failure-stage"
	sidecarTimeoutKindHeader    = "x-pi-timeout-kind"
	sidecarErrorHeader          = "x-pi-sidecar-error"
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
	URL                     string            `json:"url"`
	Method                  string            `json:"method"`
	Headers                 map[string]string `json:"headers,omitempty"`
	BodyBase64              string            `json:"bodyBase64,omitempty"`
	TotalTimeoutMs          int               `json:"totalTimeoutMs,omitempty"`
	ConnectTimeoutMs        int               `json:"connectTimeoutMs,omitempty"`
	TLSTimeoutMs            int               `json:"tlsTimeoutMs,omitempty"`
	ResponseHeaderTimeoutMs int               `json:"responseHeaderTimeoutMs,omitempty"`
	IdleStreamTimeoutMs     int               `json:"idleStreamTimeoutMs,omitempty"`
	MaxAttempts             int               `json:"maxAttempts,omitempty"`
	RetryBaseDelayMs        int               `json:"retryBaseDelayMs,omitempty"`
	RetryMaxDelayMs         int               `json:"retryMaxDelayMs,omitempty"`
	ProxyMode               string            `json:"proxyMode,omitempty"`
	ProxyEnabled            bool              `json:"proxyEnabled,omitempty"`
	ProxyCandidates         []string          `json:"proxyCandidates,omitempty"`
	ProxyProbeTimeoutMs     int               `json:"proxyProbeTimeoutMs,omitempty"`
	ProxyStatusCacheMs      int               `json:"proxyStatusCacheMs,omitempty"`
	BypassHosts             []string          `json:"bypassHosts,omitempty"`
	BypassCidrs             []string          `json:"bypassCidrs,omitempty"`
}

type transportOutcome struct {
	Owner             string `json:"owner"`
	RequestID         string `json:"requestId,omitempty"`
	TraceID           string `json:"traceId,omitempty"`
	ResponseStatus    int    `json:"responseStatus,omitempty"`
	AttemptCount      int    `json:"attemptCount"`
	RetryCount        int    `json:"retryCount"`
	StreamingResponse bool   `json:"streamingResponse"`
	StreamStarted     bool   `json:"streamStarted"`
	FinalStatus       string `json:"finalStatus"`
	FailureStage      string `json:"failureStage,omitempty"`
	TimeoutKind       string `json:"timeoutKind,omitempty"`
	ErrorMessage      string `json:"errorMessage,omitempty"`
}

type sidecarErrorResponse struct {
	Error   string           `json:"error"`
	Outcome transportOutcome `json:"outcome"`
}

type cancelOnCloseReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

type proxyReachabilityCacheEntry struct {
	reachable bool
	expiresAt time.Time
}

type proxyReachabilityCache struct {
	mu      sync.Mutex
	entries map[string]proxyReachabilityCacheEntry
}

var proxyStatusCache = &proxyReachabilityCache{entries: map[string]proxyReachabilityCacheEntry{}}

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

func createRequestClient(baseClient *http.Client, payload fetchRequest) *http.Client {
	clientCopy := *baseClient
	clientCopy.Timeout = durationOrDefault(payload.TotalTimeoutMs, defaultTotalTimeout)
	if baseTransport, ok := baseClient.Transport.(*http.Transport); ok {
		transportCopy := baseTransport.Clone()
		transportCopy.Proxy = proxyFuncForPayload(payload)
		transportCopy.DialContext = (&net.Dialer{
			Timeout:   durationOrDefault(payload.ConnectTimeoutMs, defaultConnectTimeout),
			KeepAlive: 30 * time.Second,
		}).DialContext
		transportCopy.TLSHandshakeTimeout = durationOrDefault(payload.TLSTimeoutMs, defaultConnectTimeout)
		transportCopy.ResponseHeaderTimeout = durationOrDefault(payload.ResponseHeaderTimeoutMs, defaultResponseHeaderTimeout)
		clientCopy.Transport = transportCopy
	}
	return &clientCopy
}

func proxyFuncForPayload(payload fetchRequest) func(*http.Request) (*url.URL, error) {
	if payload.ProxyMode == "" {
		return http.ProxyFromEnvironment
	}
	if !payload.ProxyEnabled {
		if payload.ProxyMode == "required" {
			return func(*http.Request) (*url.URL, error) {
				return nil, errors.New("required proxy route has proxy disabled")
			}
		}
		return http.ProxyFromEnvironment
	}
	return func(req *http.Request) (*url.URL, error) {
		if payload.ProxyMode != "required" && shouldBypassProxy(req.URL.Hostname(), payload) {
			return nil, nil
		}
		proxyURL, configured := reachableProxyCandidate(payload)
		if proxyURL != nil {
			return proxyURL, nil
		}
		if payload.ProxyMode == "required" {
			if configured {
				return nil, errors.New("required proxy route has no reachable proxy candidates")
			}
			return nil, errors.New("required proxy route has no configured proxy candidates")
		}
		return nil, nil
	}
}

func reachableProxyCandidate(payload fetchRequest) (*url.URL, bool) {
	configured := false
	for _, candidate := range payload.ProxyCandidates {
		parsed, address, ok := parseProxyCandidate(candidate)
		if !ok {
			continue
		}
		configured = true
		if proxyStatusCache.isReachable(address, payload) {
			return parsed, true
		}
	}
	return nil, configured
}

func parseProxyCandidate(candidate string) (*url.URL, string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(candidate))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, "", false
	}
	host := parsed.Hostname()
	if host == "" {
		return nil, "", false
	}
	port := parsed.Port()
	if port == "" {
		port = defaultProxyPort(parsed.Scheme)
	}
	if port == "" {
		return nil, "", false
	}
	return parsed, net.JoinHostPort(host, port), true
}

func defaultProxyPort(scheme string) string {
	switch strings.ToLower(scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	case "socks5", "socks5h":
		return "1080"
	default:
		return ""
	}
}

func (c *proxyReachabilityCache) isReachable(address string, payload fetchRequest) bool {
	cacheTTL := time.Duration(payload.ProxyStatusCacheMs) * time.Millisecond
	if cacheTTL > 0 {
		if reachable, ok := c.cached(address); ok {
			return reachable
		}
	}
	reachable := probeTCP(address, durationOrDefault(payload.ProxyProbeTimeoutMs, 500*time.Millisecond))
	if cacheTTL > 0 {
		c.store(address, reachable, cacheTTL)
	}
	return reachable
}

func (c *proxyReachabilityCache) cached(address string) (bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[address]
	if !ok {
		return false, false
	}
	if time.Now().After(entry.expiresAt) {
		delete(c.entries, address)
		return false, false
	}
	return entry.reachable, true
}

func (c *proxyReachabilityCache) store(address string, reachable bool, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[address] = proxyReachabilityCacheEntry{reachable: reachable, expiresAt: time.Now().Add(ttl)}
}

func probeTCP(address string, timeout time.Duration) bool {
	conn, err := net.DialTimeout("tcp", address, timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
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

	outcome := newTransportOutcome(payload)
	response, attemptCount, err := executeFetch(r.Context(), client, state, payload)
	outcome.AttemptCount = attemptCount
	if outcome.AttemptCount > 0 {
		outcome.RetryCount = outcome.AttemptCount - 1
	}
	if err != nil {
		outcome.FinalStatus = "transport_error"
		outcome.FailureStage = classifyFailureStage(err)
		outcome.TimeoutKind = classifyTimeoutKind(err)
		outcome.ErrorMessage = err.Error()
		state.recordFailure(outcome.FailureStage, requestTarget(payload.URL), outcome.ErrorMessage)
		setOutcomeHeaders(w.Header(), outcome)
		w.Header().Set(sidecarErrorHeader, "true")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(599)
		_ = json.NewEncoder(w).Encode(sidecarErrorResponse{Error: outcome.ErrorMessage, Outcome: outcome})
		return
	}
	defer response.Body.Close()

	state.recordSuccess()
	outcome.ResponseStatus = response.StatusCode
	outcome.StreamingResponse = isStreamingResponse(response.Header)
	outcome.FinalStatus = "success"
	copyResponseHeaders(w.Header(), response.Header)
	setOutcomeHeaders(w.Header(), outcome)
	if outcome.StreamingResponse {
		w.Header().Set(sidecarStreamingHeader, "true")
	}
	w.WriteHeader(response.StatusCode)
	idleStreamTimeout := durationOrDefault(payload.IdleStreamTimeoutMs, defaultIdleConnTimeout)
	if outcome.StreamingResponse {
		if err := copyStreamingResponse(w, response.Body, &outcome, idleStreamTimeout); err != nil {
			outcome.FinalStatus = "stream_error"
			outcome.FailureStage = "stream"
			outcome.TimeoutKind = classifyTimeoutKind(err)
			outcome.ErrorMessage = err.Error()
			state.recordFailure("stream", requestTarget(payload.URL), err.Error())
			abortStreamingResponse(w)
		}
		return
	}
	written, err := copyResponseBody(w, response.Body, idleStreamTimeout)
	if written > 0 {
		outcome.StreamStarted = true
	}
	if err != nil {
		outcome.FinalStatus = "stream_error"
		outcome.FailureStage = "stream"
		outcome.TimeoutKind = classifyTimeoutKind(err)
		outcome.ErrorMessage = err.Error()
		state.recordFailure("stream", requestTarget(payload.URL), err.Error())
	}
}

func executeFetch(ctx context.Context, client *http.Client, state *sidecarState, payload fetchRequest) (*http.Response, int, error) {
	method := strings.ToUpper(strings.TrimSpace(payload.Method))
	if method == "" {
		method = http.MethodGet
	}
	body, err := decodeRequestBody(payload.BodyBase64)
	if err != nil {
		return nil, 0, err
	}

	maxAttempts := payload.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = defaultMaxAttempts
	}
	requestClient := createRequestClient(client, payload)
	requestTotalTimeout := durationOrDefault(payload.TotalTimeoutMs, defaultTotalTimeout)

	var lastErr error
	attemptCount := 0
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		attemptCount = attempt
		reqCtx := ctx
		cancel := func() {}
		if requestTotalTimeout > 0 {
			var cancelFn context.CancelFunc
			reqCtx, cancelFn = context.WithTimeout(ctx, requestTotalTimeout)
			cancel = cancelFn
		}
		req, err := http.NewRequestWithContext(reqCtx, method, payload.URL, bytes.NewReader(body))
		if err != nil {
			cancel()
			return nil, attemptCount, err
		}
		copyHeaders(req.Header, payload.Headers)
		req.Header.Del("accept-encoding")

		response, err := requestClient.Do(req)
		if err != nil {
			cancel()
			lastErr = err
			if attempt < maxAttempts && isRetryableError(err) {
				state.recordFailure(classifyFailureStage(err), req.URL.Host, err.Error())
				sleepBeforeRetry(ctx, attempt, payload)
				continue
			}
			return nil, attemptCount, err
		}

		if attempt < maxAttempts && isRetryableResponse(response.StatusCode) {
			lastErr = errors.New(response.Status)
			_ = response.Body.Close()
			cancel()
			state.recordFailure("upstream", req.URL.Host, response.Status)
			sleepBeforeRetry(ctx, attempt, payload)
			continue
		}

		response.Body = &cancelOnCloseReadCloser{
			ReadCloser: response.Body,
			cancel:     cancel,
		}
		return response, attemptCount, nil
	}

	if lastErr != nil {
		return nil, attemptCount, lastErr
	}
	return nil, attemptCount, errors.New("request failed without response")
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

func shouldBypassProxy(host string, payload fetchRequest) bool {
	normalizedHost := strings.ToLower(strings.TrimSpace(host))
	if normalizedHost == "" {
		return false
	}
	for _, entry := range payload.BypassHosts {
		if matchesHostRule(normalizedHost, entry) {
			return true
		}
	}
	ip := net.ParseIP(normalizedHost)
	if ip == nil {
		return false
	}
	for _, cidr := range payload.BypassCidrs {
		if matchesCidr(ip, cidr) {
			return true
		}
	}
	return false
}

func matchesHostRule(host string, rule string) bool {
	normalizedRule := strings.ToLower(strings.TrimSpace(rule))
	if normalizedRule == "" {
		return false
	}
	if strings.HasPrefix(normalizedRule, "*.") {
		return strings.HasSuffix(host, normalizedRule[1:])
	}
	return host == normalizedRule
}

func matchesCidr(ip net.IP, cidr string) bool {
	_, network, err := net.ParseCIDR(strings.TrimSpace(cidr))
	if err != nil {
		return false
	}
	return network.Contains(ip)
}

func isStreamingResponse(headers http.Header) bool {
	contentType := strings.ToLower(headers.Get("Content-Type"))
	return strings.Contains(contentType, "text/event-stream")
}

func copyStreamingResponse(w http.ResponseWriter, body io.ReadCloser, outcome *transportOutcome, idleTimeout time.Duration) error {
	flusher, ok := w.(http.Flusher)
	if !ok {
		written, err := copyResponseBody(w, body, idleTimeout)
		if written > 0 {
			outcome.StreamStarted = true
		}
		return err
	}

	buffer := make([]byte, 8*1024)
	for {
		n, err := readWithIdleTimeout(body, buffer, idleTimeout)
		if n > 0 {
			outcome.StreamStarted = true
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return writeErr
			}
			flusher.Flush()
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func abortStreamingResponse(w http.ResponseWriter) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return
	}
	conn, _, err := hijacker.Hijack()
	if err != nil {
		return
	}
	_ = conn.Close()
}

func copyResponseBody(w io.Writer, body io.ReadCloser, idleTimeout time.Duration) (int64, error) {
	buffer := make([]byte, 8*1024)
	var totalWritten int64
	for {
		n, err := readWithIdleTimeout(body, buffer, idleTimeout)
		if n > 0 {
			written, writeErr := w.Write(buffer[:n])
			totalWritten += int64(written)
			if writeErr != nil {
				return totalWritten, writeErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return totalWritten, nil
			}
			return totalWritten, err
		}
	}
}

func readWithIdleTimeout(body io.ReadCloser, buffer []byte, idleTimeout time.Duration) (int, error) {
	if idleTimeout <= 0 {
		return body.Read(buffer)
	}
	type readResult struct {
		n   int
		err error
	}
	resultCh := make(chan readResult, 1)
	go func() {
		n, err := body.Read(buffer)
		resultCh <- readResult{n: n, err: err}
	}()
	timer := time.NewTimer(idleTimeout)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		return result.n, result.err
	case <-timer.C:
		_ = body.Close()
		return 0, fmt.Errorf("idle timeout after %dms", idleTimeout.Milliseconds())
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

func sleepBeforeRetry(ctx context.Context, attempt int, payload fetchRequest) {
	baseDelay := durationOrDefault(payload.RetryBaseDelayMs, defaultBaseRetryDelay)
	maxDelay := durationOrDefault(payload.RetryMaxDelayMs, defaultMaxRetryDelay)
	delay := baseDelay * time.Duration(1<<(attempt-1))
	if delay > maxDelay {
		delay = maxDelay
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func durationOrDefault(valueMs int, fallback time.Duration) time.Duration {
	if valueMs <= 0 {
		return fallback
	}
	return time.Duration(valueMs) * time.Millisecond
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

func classifyTimeoutKind(err error) string {
	if err == nil {
		return ""
	}
	message := strings.ToLower(err.Error())
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		var opErr *net.OpError
		if errors.As(err, &opErr) && opErr.Op == "dial" {
			return "connect"
		}
	}
	switch {
	case strings.Contains(message, "idle timeout"):
		return "idle_stream"
	case strings.Contains(message, "tls handshake timeout"):
		return "tls"
	case strings.Contains(message, "timeout awaiting response headers") || strings.Contains(message, "headers timed out"):
		return "response_headers"
	case strings.Contains(message, "context deadline exceeded") || strings.Contains(message, "client.timeout exceeded"):
		return "total"
	case strings.Contains(message, "timeout") || strings.Contains(message, "timed out"):
		return "unknown"
	default:
		return ""
	}
}

func newTransportOutcome(payload fetchRequest) transportOutcome {
	return transportOutcome{
		Owner:       "sidecar",
		RequestID:   headerValue(payload.Headers, sidecarRequestIDHeader),
		TraceID:     headerValue(payload.Headers, sidecarTraceIDHeader),
		FinalStatus: "transport_error",
	}
}

func setOutcomeHeaders(headers http.Header, outcome transportOutcome) {
	headers.Set(sidecarOwnerHeader, outcome.Owner)
	if outcome.RequestID != "" {
		headers.Set(sidecarRequestIDHeader, outcome.RequestID)
	}
	if outcome.TraceID != "" {
		headers.Set(sidecarTraceIDHeader, outcome.TraceID)
	}
	if outcome.ResponseStatus > 0 {
		headers.Set(sidecarResponseStatusHeader, strconv.Itoa(outcome.ResponseStatus))
	}
	headers.Set(sidecarAttemptCountHeader, strconv.Itoa(outcome.AttemptCount))
	headers.Set(sidecarRetryCountHeader, strconv.Itoa(outcome.RetryCount))
	headers.Set(sidecarStreamingRespHeader, strconv.FormatBool(outcome.StreamingResponse))
	headers.Set(sidecarStreamStartedHeader, strconv.FormatBool(outcome.StreamStarted))
	if outcome.FinalStatus != "" {
		headers.Set(sidecarFinalStatusHeader, outcome.FinalStatus)
	}
	if outcome.FailureStage != "" {
		headers.Set(sidecarFailureStageHeader, outcome.FailureStage)
	}
	if outcome.TimeoutKind != "" {
		headers.Set(sidecarTimeoutKindHeader, outcome.TimeoutKind)
	}
}

func headerValue(headers map[string]string, key string) string {
	for headerKey, value := range headers {
		if strings.EqualFold(headerKey, key) {
			return value
		}
	}
	return ""
}

func formatSidecarHeaderValue(value string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), "\n", " ")
}

func (o transportOutcome) String() string {
	return fmt.Sprintf("owner=%s requestId=%s traceId=%s attemptCount=%d finalStatus=%s", o.Owner, o.RequestID, o.TraceID, o.AttemptCount, o.FinalStatus)
}
