//! Minimal in-crate Server-Sent-Events parser (DESIGN.md §8).
//!
//! The daemon streams named SSE frames (`event: <name>` + `data: <json>`), with
//! keep-alive comment lines (`:` prefix) every 15 s. The JSON payload carries the
//! same discriminant in its `"event"` field, so parsing the `data` payload alone is
//! sufficient — this parser therefore only accumulates `data:` lines per frame
//! (multi-`data:` lines join with `\n` per the SSE spec) and ignores comments and
//! `event:`/`id:`/`retry:` fields. No reconnect logic in v1.

/// Incremental SSE frame parser. Feed raw response chunks; complete `data` payloads
/// come out. Byte-buffered so a UTF-8 code point split across chunks is safe.
#[derive(Debug, Default)]
pub(crate) struct SseParser {
    /// Unconsumed bytes (no complete line yet).
    buf: Vec<u8>,
    /// `data:` lines accumulated for the frame currently being read.
    data: Vec<String>,
}

impl SseParser {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Feed one chunk; push every completed frame's joined `data` payload to `out`.
    pub(crate) fn feed(&mut self, chunk: &[u8], out: &mut Vec<String>) {
        self.buf.extend_from_slice(chunk);
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // trailing '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(&String::from_utf8_lossy(&line), out);
        }
    }

    /// Process one complete line per the SSE grammar.
    fn line(&mut self, line: &str, out: &mut Vec<String>) {
        if line.is_empty() {
            // Blank line = frame boundary: dispatch accumulated data (if any).
            if !self.data.is_empty() {
                out.push(self.data.join("\n"));
                self.data.clear();
            }
            return;
        }
        if line.starts_with(':') {
            return; // comment / keep-alive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        if field == "data" {
            self.data.push(value.to_string());
        }
        // `event:` (the JSON discriminant repeats it), `id:`, `retry:`, and any
        // unknown field are ignored.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(chunks: &[&str]) -> Vec<String> {
        let mut parser = SseParser::new();
        let mut out = Vec::new();
        for c in chunks {
            parser.feed(c.as_bytes(), &mut out);
        }
        out
    }

    #[test]
    fn named_event_frame_yields_data_payload() {
        let out = collect(&[
            "event: started\ndata: {\"event\":\"started\",\"run_id\":1,\"total_steps\":2}\n\n",
        ]);
        assert_eq!(
            out,
            vec![r#"{"event":"started","run_id":1,"total_steps":2}"#]
        );
    }

    #[test]
    fn keepalive_comments_and_id_retry_are_ignored() {
        let out = collect(&[
            ": keep-alive\n",
            "id: 42\nretry: 1000\n",
            "event: finished\ndata: {\"event\":\"finished\",\"run_id\":1,\"status\":\"success\"}\n\n",
            ": trailing comment\n\n",
        ]);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("finished"));
    }

    #[test]
    fn multi_data_lines_accumulate_with_newline() {
        let out = collect(&[
            "data: {\"event\":\"progress\",\ndata: \"run_id\":1,\"completed\":1,\"total\":3}\n\n",
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0],
            "{\"event\":\"progress\",\n\"run_id\":1,\"completed\":1,\"total\":3}"
        );
        // ... and the joined payload is still valid JSON.
        let v: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(v["completed"], 1);
    }

    #[test]
    fn frames_split_across_chunks_reassemble() {
        let out = collect(&[
            "event: st",
            "ep\ndata: {\"event\":\"step\",\"run_id\":1,",
            "\"index\":0,\"step_type\":\"click\",\"status\":\"running\"}",
            "\n",
            "\n",
        ]);
        assert_eq!(out.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(v["step_type"], "click");
    }

    #[test]
    fn crlf_line_endings_are_handled() {
        let out = collect(&[
            "data: {\"event\":\"progress\",\"run_id\":1,\"completed\":2,\"total\":3}\r\n\r\n",
        ]);
        assert_eq!(out.len(), 1);
        assert!(out[0].ends_with('}'));
    }
}
