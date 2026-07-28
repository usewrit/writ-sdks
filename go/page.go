package writ

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Page is the uniform list result every list method returns, regardless of
// the daemon's wire envelope ({data,count}, {data,count,total}, or a bare
// array). For bare arrays Count is synthesized as len(Data) and Total is nil;
// Total is non-nil only where the daemon reports it (runs).
type Page[T any] struct {
	Data  []T
	Count int
	Total *int
}

// decodePage normalizes the three daemon list envelopes into a Page.
func decodePage[T any](data []byte) (Page[T], error) {
	var page Page[T]
	trimmed := bytes.TrimLeft(data, " \t\r\n")
	if len(trimmed) > 0 && trimmed[0] == '[' {
		if err := json.Unmarshal(data, &page.Data); err != nil {
			return page, fmt.Errorf("writ: decode list response: %w", err)
		}
		page.Count = len(page.Data)
		return page, nil
	}
	var envelope struct {
		Data  []T  `json:"data"`
		Count *int `json:"count"`
		Total *int `json:"total"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return page, fmt.Errorf("writ: decode list envelope: %w", err)
	}
	page.Data = envelope.Data
	if envelope.Count != nil {
		page.Count = *envelope.Count
	} else {
		page.Count = len(envelope.Data)
	}
	page.Total = envelope.Total
	return page, nil
}
