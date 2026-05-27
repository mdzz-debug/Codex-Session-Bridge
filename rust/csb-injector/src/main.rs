use serde_json::{json, Value};
use std::error::Error;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::{connect, Message};

#[derive(Debug)]
struct Options {
    debug_port: u16,
    app_path: Option<String>,
    script_path: PathBuf,
    timeout_ms: u64,
}

#[derive(Clone, Debug)]
struct CdpTarget {
    title: String,
    url: String,
    websocket_url: String,
}

fn main() {
    let result = run();
    match result {
        Ok(target) => {
            println!(
                "{}",
                json!({
                    "status": "ok",
                    "injected": true,
                    "message": "模型白名单解锁已注入",
                    "targetTitle": target.title,
                    "targetUrl": target.url,
                })
            );
        }
        Err(error) => {
            println!(
                "{}",
                json!({
                    "status": "failed",
                    "injected": false,
                    "message": "解锁注入失败",
                    "error": error.to_string(),
                })
            );
            std::process::exit(1);
        }
    }
}

fn run() -> Result<CdpTarget, Box<dyn Error>> {
    let opts = parse_options()?;
    let script = fs::read_to_string(&opts.script_path)?;
    if let Ok(target) = wait_for_target(opts.debug_port, Duration::from_millis(1500)) {
        inject_script(&target.websocket_url, &script)?;
        return Ok(target);
    }
    launch_codex(&opts)?;
    let target = wait_for_target(opts.debug_port, Duration::from_millis(opts.timeout_ms))?;
    inject_script(&target.websocket_url, &script)?;
    Ok(target)
}

fn parse_options() -> Result<Options, Box<dyn Error>> {
    let mut debug_port = 9229_u16;
    let mut app_path = None;
    let mut script_path = None;
    let mut timeout_ms = 45_000_u64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--debug-port" => {
                if let Some(value) = args.next() {
                    debug_port = value.parse()?;
                }
            }
            "--daemon-url" => {
                let _ = args.next();
            }
            "--app-path" => {
                if let Some(value) = args.next() {
                    if !value.trim().is_empty() {
                        app_path = Some(value);
                    }
                }
            }
            "--script-path" => {
                if let Some(value) = args.next() {
                    script_path = Some(PathBuf::from(value));
                }
            }
            "--timeout-ms" => {
                if let Some(value) = args.next() {
                    timeout_ms = value.parse()?;
                }
            }
            _ => {}
        }
    }

    let script_path = script_path.ok_or("--script-path is required")?;
    Ok(Options {
        debug_port,
        app_path,
        script_path,
        timeout_ms,
    })
}

fn launch_codex(opts: &Options) -> Result<(), Box<dyn Error>> {
    let debug_arg = format!("--remote-debugging-port={}", opts.debug_port);
    let origin_arg = format!("--remote-allow-origins=http://127.0.0.1:{}", opts.debug_port);

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("osascript")
            .args(["-e", "tell application \"Codex\" to quit"])
            .status();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            if !codex_running_macos() {
                break;
            }
            thread::sleep(Duration::from_millis(350));
        }

        let mut command = Command::new("open");
        if let Some(app_path) = opts.app_path.as_deref() {
            if app_path.ends_with(".app") {
                command.args(["-n", app_path, "--args"]);
            } else {
                command.args(["-n", "-a", app_path, "--args"]);
            }
        } else {
            command.args(["-n", "-a", "Codex", "--args"]);
        }
        command.args([debug_arg, origin_arg]);
        let status = command.status()?;
        if !status.success() {
            return Err("failed to launch Codex with remote debugging".into());
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                "Stop-Process -Name Codex -ErrorAction SilentlyContinue",
            ])
            .status();
        thread::sleep(Duration::from_millis(600));
        let app_path = opts
            .app_path
            .as_deref()
            .ok_or("Codex app path is required on Windows")?;
        Command::new(app_path)
            .args([debug_arg, origin_arg])
            .spawn()?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = opts;
        Err("unsupported platform for Codex desktop injection".into())
    }
}

#[cfg(target_os = "macos")]
fn codex_running_macos() -> bool {
    let output = Command::new("osascript")
        .args(["-e", "application \"Codex\" is running"])
        .output();
    output
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "true")
        .unwrap_or(false)
}

fn wait_for_target(port: u16, timeout: Duration) -> Result<CdpTarget, Box<dyn Error>> {
    let started = Instant::now();
    let mut last_error = String::new();
    while started.elapsed() < timeout {
        match list_targets(port).and_then(|targets| pick_target(&targets)) {
            Ok(target) => return Ok(target),
            Err(error) => last_error = error.to_string(),
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err(format!(
        "连接 Codex 调试端口 {} 超时{}",
        port,
        if last_error.is_empty() {
            String::new()
        } else {
            format!("：{last_error}")
        }
    )
    .into())
}

fn list_targets(port: u16) -> Result<Vec<Value>, Box<dyn Error>> {
    let body = http_get_loopback(port, "/json")?;
    let value: Value = serde_json::from_str(&body)?;
    Ok(value.as_array().cloned().unwrap_or_default())
}

fn pick_target(targets: &[Value]) -> Result<CdpTarget, Box<dyn Error>> {
    let mut first_page = None;
    for target in targets {
        let target_type = target.get("type").and_then(Value::as_str).unwrap_or_default();
        let websocket_url = target
            .get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if target_type != "page" || websocket_url.is_empty() {
            continue;
        }
        let title = target
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let url = target
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let candidate = CdpTarget {
            title,
            url,
            websocket_url: websocket_url.to_string(),
        };
        if first_page.is_none() {
            first_page = Some(candidate.clone());
        }
        let haystack = format!("{} {}", candidate.title, candidate.url).to_lowercase();
        if haystack.contains("codex") {
            return Ok(candidate);
        }
    }
    first_page.ok_or_else(|| "No injectable Codex page target found on CDP port".into())
}

fn http_get_loopback(port: u16, path: &str) -> Result<String, Box<dyn Error>> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_millis(500)))?;
    stream.write_all(
        format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: csb-injector\r\nAccept: */*\r\nConnection: close\r\n\r\n"
        )
        .as_bytes(),
    )?;
    let started = Instant::now();
    let mut response = Vec::new();
    loop {
        let mut chunk = [0_u8; 8192];
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                response.extend_from_slice(&chunk[..n]);
                if http_response_complete(&response) {
                    break;
                }
            }
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
                    && started.elapsed() < Duration::from_secs(3) =>
            {
                if http_response_complete(&response) {
                    break;
                }
                continue;
            }
            Err(error) => return Err(error.into()),
        }
    }
    http_response_body(&response)
}

fn http_header_end(response: &[u8]) -> Option<usize> {
    response.windows(4).position(|window| window == b"\r\n\r\n")
}

fn http_content_length(headers: &str) -> Option<usize> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.trim().eq_ignore_ascii_case("content-length") {
            return None;
        }
        value.trim().parse().ok()
    })
}

fn http_response_complete(response: &[u8]) -> bool {
    let Some(header_end) = http_header_end(response) else {
        return false;
    };
    let headers = String::from_utf8_lossy(&response[..header_end]);
    match http_content_length(&headers) {
        Some(length) => response.len() >= header_end + 4 + length,
        None => response.len() > header_end + 4,
    }
}

fn http_response_body(response: &[u8]) -> Result<String, Box<dyn Error>> {
    let header_end = http_header_end(response).ok_or("invalid HTTP response from CDP")?;
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let status = headers.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        return Err(format!("CDP returned {status}").into());
    }
    let body = &response[header_end + 4..];
    let body = match http_content_length(&headers) {
        Some(length) if body.len() >= length => &body[..length],
        _ => body,
    };
    Ok(String::from_utf8(body.to_vec())?)
}

fn inject_script(websocket_url: &str, script: &str) -> Result<(), Box<dyn Error>> {
    let (mut socket, _) = connect(websocket_url)?;
    send_cdp(&mut socket, 1, "Runtime.enable", json!({}))?;
    send_cdp(
        &mut socket,
        2,
        "Page.addScriptToEvaluateOnNewDocument",
        json!({ "source": script }),
    )?;
    send_cdp(
        &mut socket,
        3,
        "Runtime.evaluate",
        json!({
            "expression": script,
            "awaitPromise": false,
            "allowUnsafeEvalBlockedByCSP": true,
        }),
    )?;
    let _ = socket.close(None);
    Ok(())
}

fn send_cdp(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, Box<dyn Error>> {
    socket.send(Message::Text(
        json!({ "id": id, "method": method, "params": params }).to_string(),
    ))?;
    loop {
        let message = socket.read()?;
        let Message::Text(text) = message else {
            continue;
        };
        let value: Value = serde_json::from_str(&text)?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!("CDP {method} failed: {error}").into());
        }
        if let Some(details) = value.pointer("/result/exceptionDetails") {
            return Err(format!("CDP {method} exception: {details}").into());
        }
        return Ok(value);
    }
}
