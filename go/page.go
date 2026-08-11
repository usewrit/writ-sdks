package writ

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"net/url"
	"strconv"
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

// DefaultAutoPageSize is the page size AutoPage requests when the caller's
// params do not set one.
const DefaultAutoPageSize = 100

// AutoPage walks every page of a limit/offset list endpoint and yields the rows
// one at a time, fetching the next page only when the current one is exhausted.
//
//	for run, err := range writ.AutoPage(ctx, client.Runs.List, nil) {
//	    if err != nil { return err }
//	    fmt.Println(run.ID)
//	}
//
// Without this, "list everything" means hand-rolling an offset loop at every
// call site — and the usual mistake is stopping at the first page, silently
// processing 100 of 4,000 rows with no error to show for it.
//
// Iteration stops when a page comes back short (or empty), which is the honest
// end-of-data signal for an offset walk. Breaking out of the range stops the
// fetching too.
func AutoPage[T any](
	ctx context.Context,
	list func(context.Context, url.Values) (Page[T], error),
	params url.Values,
) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		// Copy: a caller's url.Values must not gain an offset it never set.
		q := url.Values{}
		for k, v := range params {
			q[k] = append([]string(nil), v...)
		}

		limit := DefaultAutoPageSize
		if raw := q.Get("limit"); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil && n > 0 {
				limit = n
			}
		}
		q.Set("limit", strconv.Itoa(limit))

		offset := 0
		if raw := q.Get("offset"); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil && n > 0 {
				offset = n
			}
		}

		var zero T
		for {
			q.Set("offset", strconv.Itoa(offset))
			page, err := list(ctx, q)
			if err != nil {
				yield(zero, err)
				return
			}
			for _, row := range page.Data {
				if !yield(row, nil) {
					return
				}
			}
			if len(page.Data) < limit {
				return
			}
			offset += len(page.Data)
		}
	}
}
