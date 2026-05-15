use std::{
    env,
    io::{BufRead, BufReader},
    net::TcpStream,
    path::PathBuf,
    process::{self, Child, Command},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Ok, anyhow};
use tracing::{debug, error, info, warn};

const STREAMING_SERVER_PORT: u16 = 11470;

pub struct Server {
    process: Option<Child>,
    file: PathBuf,
}

impl Server {
    pub fn new() -> Self {
        let server_path = env::var("SERVER_PATH").expect("Failed to read SERVER_PATH env");
        let file = PathBuf::from(&server_path);

        Self {
            process: None,
            file,
        }
    }

    pub fn start(&mut self, dev: bool) -> anyhow::Result<()> {
        if port_in_use(STREAMING_SERVER_PORT) {
            warn!(target: "server", "port {STREAMING_SERVER_PORT} already in use before launch — likely a stale streaming-server. mpv playback will fail until it is freed.");
        }

        let mut child = Command::new("node")
            .env("NO_CORS", (dev as i32).to_string())
            .arg(self.file.as_os_str())
            .stdout(process::Stdio::piped())
            .spawn()
            .context("Failed to start server")?;

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            thread::spawn(move || {
                while let Some(Result::Ok(line)) = lines.next() {
                    debug!(target: "server", "{}", line);
                }
            });
        }

        self.process = Some(child);

        thread::spawn(|| {
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                if port_in_use(STREAMING_SERVER_PORT) {
                    info!(target: "server", "streaming-server is listening on {STREAMING_SERVER_PORT}");
                    return;
                }
                thread::sleep(Duration::from_millis(500));
            }
            error!(target: "server", "streaming-server did NOT bind to port {STREAMING_SERVER_PORT} within 15s — playback will fail. Check for stale `node data/server.js` processes holding the port.");
        });

        Ok(())
    }

    pub fn check_streaming_server(timeout: Duration) -> anyhow::Result<()> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if port_in_use(STREAMING_SERVER_PORT) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }
        Err(anyhow!("streaming-server is not listening on port {STREAMING_SERVER_PORT}"))
    }

    pub fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(mut process) = self.process.take() {
            process.kill().context("Failed to kill server process")?;
        }

        Ok(())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop().expect("Failed to stop server");
    }
}

fn port_in_use(port: u16) -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(200),
    )
    .is_ok()
}
