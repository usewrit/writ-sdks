//! Minimal in-crate HTTP/1.1 stub server for the SDK tests (DESIGN.md §9 asks for
//! an in-process mock; no wiremock). One request per connection
//! (`Connection: close`), raw responses written over a tokio `TcpListener` —
//! including hand-rolled SSE bodies with per-frame delays.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A canned response.
#[derive(Debug, Clone)]
pub enum Reply {
    /// A complete response with `Content-Length`.
    Full {
        status: u16,
        content_type: &'static str,
        body: Vec<u8>,
    },
    /// A streamed `text/event-stream` body: `(bytes, delay_ms)` frames written in
    /// order, then the connection closes (no terminal framing added — the test
    /// decides whether the stream ends cleanly or drops mid-run).
    Sse { frames: Vec<(Vec<u8>, u64)> },
}

impl Reply {
    pub fn full(status: u16, content_type: &'static str, body: Vec<u8>) -> Self {
        Reply::Full {
            status,
            content_type,
            body,
        }
    }

    pub fn sse(frames: Vec<(Vec<u8>, u64)>) -> Self {
        Reply::Sse { frames }
    }
}

/// One recorded inbound request.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    /// Header names lowercased.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<String> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.clone())
    }
}

#[derive(Debug)]
struct Route {
    method: String,
    path: String,
    /// Sequential replies; the last one sticks for further matches.
    queue: VecDeque<Reply>,
}

/// The stub server handle.
pub struct StubServer {
    addr: SocketAddr,
    routes: Arc<Mutex<Vec<Route>>>,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl StubServer {
    pub async fn start() -> StubServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind stub");
        let addr = listener.local_addr().unwrap();
        let routes: Arc<Mutex<Vec<Route>>> = Arc::new(Mutex::new(Vec::new()));
        let requests: Arc<Mutex<Vec<Recorded>>> = Arc::new(Mutex::new(Vec::new()));

        let accept_routes = Arc::clone(&routes);
        let accept_requests = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let routes = Arc::clone(&accept_routes);
                let requests = Arc::clone(&accept_requests);
                tokio::spawn(async move {
                    let _ = handle_connection(stream, routes, requests).await;
                });
            }
        });

        StubServer {
            addr,
            routes,
            requests,
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// Register a sticky reply for `method path` (path matched without query).
    pub fn route(&self, method: &str, path: &str, reply: Reply) {
        self.route_seq(method, path, vec![reply]);
    }

    /// Register a sequence of replies; the last one repeats.
    pub fn route_seq(&self, method: &str, path: &str, replies: Vec<Reply>) {
        let mut routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        routes.push(Route {
            method: method.to_string(),
            path: path.to_string(),
            queue: replies.into(),
        });
    }

    /// Snapshot of everything received so far.
    pub fn requests(&self) -> Vec<Recorded> {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    routes: Arc<Mutex<Vec<Route>>>,
    requests: Arc<Mutex<Vec<Recorded>>>,
) -> std::io::Result<()> {
    // Read the head (request line + headers).
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let head_end = loop {
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(()); // client went away
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 1 << 20 {
            return Ok(()); // absurd head; bail
        }
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), Some(q.to_string())),
        None => (target.clone(), None),
    };
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();

    // Read the body per Content-Length (the stub never sees chunked uploads).
    let content_length: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body: Vec<u8> = buf[head_end + 4..].to_vec();
    while body.len() < content_length {
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(Recorded {
            method: method.clone(),
            path: path.clone(),
            query,
            headers,
            body,
        });

    // Route lookup: pop from the sequence, keep the last reply sticky.
    let reply = {
        let mut routes = routes.lock().unwrap_or_else(|e| e.into_inner());
        routes
            .iter_mut()
            .find(|r| r.method == method && r.path == path)
            .map(|r| {
                if r.queue.len() > 1 {
                    r.queue.pop_front().unwrap()
                } else {
                    r.queue
                        .front()
                        .cloned()
                        .expect("route with empty reply queue")
                }
            })
    };

    match reply {
        Some(Reply::Full {
            status,
            content_type,
            body,
        }) => {
            let head = format!(
                "HTTP/1.1 {status} {}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                reason(status),
                body.len()
            );
            stream.write_all(head.as_bytes()).await?;
            stream.write_all(&body).await?;
        }
        Some(Reply::Sse { frames }) => {
            let head =
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nconnection: close\r\n\r\n";
            stream.write_all(head.as_bytes()).await?;
            stream.flush().await?;
            for (bytes, delay_ms) in frames {
                if delay_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                stream.write_all(&bytes).await?;
                stream.flush().await?;
            }
            // Dropping the stream closes the connection (EOF for the client).
        }
        None => {
            let body = format!(
                "{{\"error\":\"stub: no route for {method} {path}\",\"code\":\"not_found\"}}"
            );
            let head = format!(
                "HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).await?;
            stream.write_all(body.as_bytes()).await?;
        }
    }
    stream.shutdown().await.ok();
    Ok(())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        423 => "Locked",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Status",
    }
}

/// Serialize env-mutating tests (env vars are process-global).
pub fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// A fresh per-test temp directory (unique per process + call).
pub fn temp_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "writ-client-test-{}-{}-{}",
        std::process::id(),
        name,
        n
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}
