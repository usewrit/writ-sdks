package writ

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// rawBody marks a pre-encoded request body (multipart uploads).
type rawBody struct {
	data        []byte
	contentType string
}

// newRequest builds a request with the standard headers.
func (c *Client) newRequest(ctx context.Context, method, path string, q url.Values, body io.Reader, contentType string) (*http.Request, error) {
	u := c.baseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return req, nil
}

// call performs a request, reading the whole response body. body may be nil,
// a rawBody, or any JSON-marshalable value. Statuses outside 2xx produce an
// *APIError unless allow(status) says otherwise (used for the cancel routes,
// where 409 not_running is a valid answer). Network failures produce a
// *ConnectionError; the per-request timeout is applied here.
func (c *Client) call(ctx context.Context, method, path string, q url.Values, body any, allow func(int) bool) (int, []byte, error) {
	if err := c.ready(ctx); err != nil {
		return 0, nil, err
	}
	var reader io.Reader
	contentType := ""
	if body != nil {
		if raw, ok := body.(rawBody); ok {
			reader = bytes.NewReader(raw.data)
			contentType = raw.contentType
		} else {
			b, err := json.Marshal(body)
			if err != nil {
				return 0, nil, fmt.Errorf("writ: encode request body: %w", err)
			}
			reader = bytes.NewReader(b)
			contentType = "application/json"
		}
	}
	if c.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.timeout)
		defer cancel()
	}
	req, err := c.newRequest(ctx, method, path, q, reader, contentType)
	if err != nil {
		return 0, nil, fmt.Errorf("writ: build request: %w", err)
	}
	resp, err := c.http().Do(req)
	if err != nil {
		return 0, nil, &ConnectionError{URL: req.URL.String(), Err: err}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, &ConnectionError{URL: req.URL.String(), Err: err}
	}
	if resp.StatusCode/100 == 2 || (allow != nil && allow(resp.StatusCode)) {
		return resp.StatusCode, data, nil
	}
	return resp.StatusCode, data, newAPIError(resp.StatusCode, data)
}

// callJSON performs a request and decodes the 2xx response into out
// (skipped when out is nil).
func (c *Client) callJSON(ctx context.Context, method, path string, q url.Values, body, out any) error {
	_, data, err := c.call(ctx, method, path, q, body, nil)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("writ: decode response: %w", err)
	}
	return nil
}

// unmarshalResponse decodes a 2xx body with a consistent error wrap.
func unmarshalResponse(data []byte, out any) error {
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("writ: decode response: %w", err)
	}
	return nil
}

// getPage GETs a list endpoint and normalizes whichever envelope the daemon
// used ({data,count}, {data,count,total}, or a bare array) into a Page.
func getPage[T any](ctx context.Context, c *Client, path string, q url.Values) (Page[T], error) {
	var zero Page[T]
	_, data, err := c.call(ctx, http.MethodGet, path, q, nil, nil)
	if err != nil {
		return zero, err
	}
	return decodePage[T](data)
}

// openStream issues a GET expecting a long-lived body (SSE). No per-request
// timeout is applied — cancellation rides on ctx. A non-2xx status is read,
// closed, and mapped to *APIError.
func (c *Client) openStream(ctx context.Context, path string) (*http.Response, error) {
	if err := c.ready(ctx); err != nil {
		return nil, err
	}
	req, err := c.newRequest(ctx, http.MethodGet, path, nil, nil, "")
	if err != nil {
		return nil, fmt.Errorf("writ: build request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := c.http().Do(req)
	if err != nil {
		return nil, &ConnectionError{URL: req.URL.String(), Err: err}
	}
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		return nil, newAPIError(resp.StatusCode, data)
	}
	return resp, nil
}
