package writ

import (
	"context"
	"iter"
	"time"
)

// WatchOptions tunes a change watcher. The zero value is a sane production
// default: poll every 30s, 100 rows a page, and start from the current head of
// the feed (history already recorded is NOT replayed).
type WatchOptions struct {
	// Interval is the poll cadence. Default 30s. A watcher never polls faster
	// than this even when a page comes back full — it drains the backlog first
	// (see the loop below), then resumes the cadence.
	Interval time.Duration

	// PageSize is rows per request. Default 100.
	PageSize int

	// Since / SinceID resume a previous watcher exactly where it stopped. Persist
	// the last delivered change's LastDetectedAt and ID, hand them back here, and
	// no change detected during the downtime is missed.
	Since   string
	SinceID int64

	// ReplayHistory starts from the beginning of the feed instead of its head.
	// Ignored when Since is set. Off by default: a fresh watcher on an account
	// with months of history should not open by re-delivering all of it.
	ReplayHistory bool

	// OnError decides what a watcher does with a polling error. Return true to
	// keep polling (with backoff), false to stop and surface it. Nil means keep
	// polling: one bad response should not silently kill a change feed that a
	// production system depends on.
	OnError func(error) bool
}

func (o *WatchOptions) normalized() WatchOptions {
	out := WatchOptions{}
	if o != nil {
		out = *o
	}
	if out.Interval <= 0 {
		out.Interval = 30 * time.Second
	}
	if out.PageSize <= 0 {
		out.PageSize = 100
	}
	return out
}

// changeFetcher pulls one page. An empty since means "no cursor".
type changeFetcher func(ctx context.Context, since string, sinceID int64, limit int) ([]RecentChange, error)

// cursorFloor replays a feed from the beginning.
//
// It is NOT the same as omitting the cursor: omitting it selects the server's
// newest-first BROWSING view, whose order runs backwards against a forward
// walk. A floor cursor keeps the request in keyset mode — oldest-first,
// strictly advancing — which is the only ordering a watcher can consume.
const cursorFloor = "1970-01-01T00:00:00+00:00"

// Watch delivers detected changes across ALL cloud monitors as a continuous
// stream, in detection order, without gaps or repeats.
//
//	for change, err := range client.Cloud.Monitors.Watch(ctx, nil) {
//	    if err != nil { log.Print(err); continue }
//	    fmt.Println(change.TargetURL, *change.DiffSnippet)
//	}
//
// Stop by cancelling ctx or breaking out of the range.
//
// This exists because polling the feed correctly by hand is harder than it
// looks: the newest-first view drops changes when more than a page of them lands
// between polls, and a change row is UPDATED (not re-inserted) when the same
// difference recurs, so an id you already processed can resurface. Watch drives
// the server's keyset cursor instead, which makes "everything after this point"
// exact — and a resurfaced id arrives as what it actually is, a fresh detection.
//
// To resume across process restarts, persist the last delivered change's
// LastDetectedAt + ID and pass them as WatchOptions.Since / SinceID.
func (s *CloudMonitorsService) Watch(ctx context.Context, opts *WatchOptions) iter.Seq2[RecentChange, error] {
	fetch := func(ctx context.Context, since string, sinceID int64, limit int) ([]RecentChange, error) {
		return s.RecentChanges(ctx, &CloudChangeListOptions{
			Limit:   &limit,
			Since:   since,
			SinceID: &sinceID,
		})
	}
	return watchChanges(ctx, opts, fetch)
}

// Watch delivers detected changes across ALL monitors on the LOCAL daemon as a
// continuous stream. Identical semantics to the cloud watcher above — same
// cursor, same options, same delivery guarantees — so a program can move between
// venues by changing which service it watches.
func (s *MonitorsService) Watch(ctx context.Context, opts *WatchOptions) iter.Seq2[RecentChange, error] {
	fetch := func(ctx context.Context, since string, sinceID int64, limit int) ([]RecentChange, error) {
		page, err := s.RecentChanges(ctx, &ChangeListOptions{
			Limit:   &limit,
			Since:   since,
			SinceID: &sinceID,
		})
		if err != nil {
			return nil, err
		}
		return page.Data, nil
	}
	return watchChanges(ctx, opts, fetch)
}

// watchChanges is the shared cursor loop behind both Watch methods.
func watchChanges(ctx context.Context, opts *WatchOptions, fetch changeFetcher) iter.Seq2[RecentChange, error] {
	cfg := opts.normalized()

	return func(yield func(RecentChange, error) bool) {
		since, sinceID := cfg.Since, cfg.SinceID

		// Establish the starting cursor.
		if since == "" {
			if cfg.ReplayHistory {
				// Replay from the floor, NOT from "no cursor" — see cursorFloor.
				since, sinceID = cursorFloor, 0
			} else {
				// Read the single newest row (the no-cursor view IS newest-first)
				// and start AFTER it, so the watcher opens on "what happens from
				// now on" rather than the whole archive.
				head, err := fetch(ctx, "", 0, 1)
				if err != nil {
					if !yield(RecentChange{}, err) || !keepGoing(cfg, err) {
						return
					}
					since, sinceID = cursorFloor, 0
				} else if len(head) > 0 {
					since, sinceID = head[0].LastDetectedAt, head[0].ID
				} else {
					since, sinceID = cursorFloor, 0
				}
			}
		}

		failures := 0
		for {
			batch, err := fetch(ctx, since, sinceID, cfg.PageSize)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				if !yield(RecentChange{}, err) || !keepGoing(cfg, err) {
					return
				}
				failures++
				// Back off on repeated failure so a persistently broken feed does
				// not hammer the API at the full poll rate.
				if sleepCtx(ctx, errorBackoff(cfg.Interval, failures)) != nil {
					return
				}
				continue
			}
			failures = 0

			for _, change := range batch {
				// Guard against a server that echoes the cursor row back: strictly
				// advancing here means a malformed page can never loop forever.
				if change.LastDetectedAt < since ||
					(change.LastDetectedAt == since && change.ID <= sinceID) {
					continue
				}
				if !yield(change, nil) {
					return
				}
				since, sinceID = change.LastDetectedAt, change.ID
			}

			// A full page means there is very likely more waiting: drain the
			// backlog immediately instead of sleeping a whole interval per page.
			if len(batch) == cfg.PageSize {
				if ctx.Err() != nil {
					return
				}
				continue
			}
			if sleepCtx(ctx, cfg.Interval) != nil {
				return
			}
		}
	}
}

// keepGoing consults OnError (default: keep polling).
func keepGoing(cfg WatchOptions, err error) bool {
	if cfg.OnError == nil {
		return true
	}
	return cfg.OnError(err)
}

// errorBackoff grows the wait after consecutive failures, capped at 10 intervals.
func errorBackoff(interval time.Duration, failures int) time.Duration {
	if failures < 1 {
		return interval
	}
	d := interval << min(failures-1, 10)
	if capped := interval * 10; d > capped || d <= 0 {
		d = capped
	}
	return d
}
