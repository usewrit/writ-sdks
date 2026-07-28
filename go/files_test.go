package writ

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The multipart upload sends a well-formed body the server can parse: a
// "file" part with filename + content type + bytes, plus the "source" field.
func TestFilesUploadMultipart(t *testing.T) {
	content := []byte("col_a,col_b\n1,2\n")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/files" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatalf("multipart parse: %v", err)
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("no file part: %v", err)
		}
		defer file.Close()
		if header.Filename != "report.csv" {
			t.Errorf("filename = %q", header.Filename)
		}
		if ct := header.Header.Get("Content-Type"); ct != "text/csv" {
			t.Errorf("part content type = %q", ct)
		}
		got, _ := io.ReadAll(file)
		if !bytes.Equal(got, content) {
			t.Errorf("content = %q", got)
		}
		if src := r.FormValue("source"); src != "api" {
			t.Errorf("source = %q", src)
		}
		_, _ = w.Write([]byte(`{"id":"file_ab12","object":"file","filename":"report.csv","content_type":"text/csv","bytes":16,"created_at":1752364800,"status":"processed","source":"api","purpose":"user_data"}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	f, err := c.Files.Upload(ctxT(t), "report.csv", content, &UploadOptions{ContentType: "text/csv", Source: "api"})
	if err != nil {
		t.Fatal(err)
	}
	if f.ID != "file_ab12" || f.Bytes != 16 || f.CreatedAt != 1752364800 || f.Source != "api" {
		t.Errorf("stored file = %+v", f)
	}
}

// Files.Content returns the exact raw bytes (binary-safe).
func TestFilesContentBytes(t *testing.T) {
	blob := []byte{0x00, 0x01, 0xFF, 0x7F, 'w', 'r', 'i', 't', 0x0A, 0x00}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/files/file_ab12/content" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(blob)
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	got, err := c.Files.Content(ctxT(t), "file_ab12")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, blob) {
		t.Errorf("content = %v", got)
	}
}

// Files.List uses the {data,count} envelope like the other stores.
func TestFilesList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"file_1","object":"file","filename":"a.bin","content_type":"application/octet-stream","bytes":3,"created_at":1,"status":"processed","source":"upload","purpose":"user_data"}],"count":1}`))
	}))
	defer srv.Close()

	c := testClient(srv.URL)
	page, err := c.Files.List(ctxT(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if page.Count != 1 || page.Data[0].Filename != "a.bin" {
		t.Errorf("page = %+v", page)
	}
}
