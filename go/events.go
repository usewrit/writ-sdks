package writ

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"strings"
)

// sseFrames reads Server-Sent-Events frames from r and yields one RunEvent
// per frame. It follows the minimal parser contract from DESIGN §8:
//
//   - frames split on a blank line;
//   - multiple "data:" lines accumulate (joined with \n);
//   - ":" comment lines (keep-alives) and "id:"/"retry:" fields are ignored;
//   - the JSON payload carries the "event" discriminant (serde tag), so the
//     data alone is sufficient — the "event:" field name is used as a
//     fallback only;
//   - iteration stops after a terminal frame (finished/error).
//
// A read error (including context cancellation surfacing through the body)
// yields a single (zero RunEvent, error) pair and stops. A clean EOF without
// a terminal frame just ends the sequence.
func sseFrames(r io.Reader, streamURL string) iter.Seq2[RunEvent, error] {
	return func(yield func(RunEvent, error) bool) {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)

		eventName := ""
		var data []string
		for scanner.Scan() {
			line := strings.TrimSuffix(scanner.Text(), "\r")
			switch {
			case line == "":
				// Frame boundary: dispatch when the frame carried data.
				if len(data) == 0 {
					eventName = ""
					continue
				}
				payload := strings.Join(data, "\n")
				data = data[:0]
				var ev RunEvent
				if err := json.Unmarshal([]byte(payload), &ev); err != nil {
					yield(RunEvent{}, fmt.Errorf("writ: invalid SSE payload: %w", err))
					return
				}
				if ev.Event == "" {
					ev.Event = eventName
				}
				eventName = ""
				if !yield(ev, nil) {
					return
				}
				if ev.Terminal() {
					return
				}
			case strings.HasPrefix(line, ":"):
				// Keep-alive comment — ignore.
			case strings.HasPrefix(line, "event:"):
				eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			case strings.HasPrefix(line, "data:"):
				value := strings.TrimPrefix(line, "data:")
				value = strings.TrimPrefix(value, " ")
				data = append(data, value)
			default:
				// id:/retry:/unknown fields — ignore.
			}
		}
		if err := scanner.Err(); err != nil {
			yield(RunEvent{}, &ConnectionError{URL: streamURL, Err: err})
		}
	}
}
