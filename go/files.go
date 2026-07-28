package writ

import (
	"bytes"
	"context"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
)

// FilesService wraps /v1/files (api/v1/files.rs) — OpenAI-style encrypted
// file handles (TEXT ids like "file_<hex>").
type FilesService struct {
	c *Client
}

// UploadOptions tunes Upload. Zero values are fine.
type UploadOptions struct {
	// ContentType of the file part (default "application/octet-stream").
	ContentType string
	// Source overrides the handle's source: "upload" (default), "api", or
	// "workflow_output".
	Source string
}

// List is GET /v1/files (?limit, ?source=upload|api|workflow_output).
func (s *FilesService) List(ctx context.Context, params url.Values) (Page[StoredFile], error) {
	return getPage[StoredFile](ctx, s.c, "/v1/files", params)
}

// Upload is POST /v1/files — a multipart upload of one file part (the daemon
// encrypts it at rest and returns the new handle). opts may be nil.
func (s *FilesService) Upload(ctx context.Context, filename string, content []byte, opts *UploadOptions) (*StoredFile, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)

	contentType := "application/octet-stream"
	source := ""
	if opts != nil {
		if opts.ContentType != "" {
			contentType = opts.ContentType
		}
		source = opts.Source
	}

	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, escapeQuotes(filename)))
	header.Set("Content-Type", contentType)
	part, err := w.CreatePart(header)
	if err != nil {
		return nil, fmt.Errorf("writ: build multipart body: %w", err)
	}
	if _, err := part.Write(content); err != nil {
		return nil, fmt.Errorf("writ: build multipart body: %w", err)
	}
	if source != "" {
		if err := w.WriteField("source", source); err != nil {
			return nil, fmt.Errorf("writ: build multipart body: %w", err)
		}
	}
	if err := w.Close(); err != nil {
		return nil, fmt.Errorf("writ: build multipart body: %w", err)
	}

	body := rawBody{data: buf.Bytes(), contentType: w.FormDataContentType()}
	_, data, err := s.c.call(ctx, http.MethodPost, "/v1/files", nil, body, nil)
	if err != nil {
		return nil, err
	}
	var out StoredFile
	if err := unmarshalResponse(data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FromData is POST /v1/files/from-data — exports a workflow's extracted data
// into a new stored file. Body: {workflow_id, format?: "csv"|"json",
// filters?}.
func (s *FilesService) FromData(ctx context.Context, body any) (*StoredFile, error) {
	var out StoredFile
	if err := s.c.callJSON(ctx, http.MethodPost, "/v1/files/from-data", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get is GET /v1/files/:id — one live handle's metadata.
func (s *FilesService) Get(ctx context.Context, id string) (*StoredFile, error) {
	var out StoredFile
	if err := s.c.callJSON(ctx, http.MethodGet, "/v1/files/"+url.PathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete is DELETE /v1/files/:id (soft delete; bytes reclaimed by GC).
func (s *FilesService) Delete(ctx context.Context, id string) error {
	return s.c.callJSON(ctx, http.MethodDelete, "/v1/files/"+url.PathEscape(id), nil, nil, nil)
}

// Content is GET /v1/files/:id/content — the decrypted raw bytes.
func (s *FilesService) Content(ctx context.Context, id string) ([]byte, error) {
	_, data, err := s.c.call(ctx, http.MethodGet, "/v1/files/"+url.PathEscape(id)+"/content", nil, nil, nil)
	if err != nil {
		return nil, err
	}
	return data, nil
}

var quoteEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`)

func escapeQuotes(s string) string { return quoteEscaper.Replace(s) }
