use std::{
    env,
    io::{BufRead, BufReader},
    net::TcpStream,
    path::PathBuf,
    process::{self, Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Ok, anyhow};
use tracing::{debug, error, info, warn};

const STREAMING_SERVER_PORT: u16 = 11470;

pub struct Server {
    child: Arc<Mutex<Option<Child>>>,
    file: Option<PathBuf>,
    dev: bool,
}

impl Server {
    pub fn new() -> Self {
        // SERVER_PATH is optional: when a shared streaming-server is managed
        // externally (e.g. the stremio-lan-remote-server.service systemd unit),
        // the shell reuses it and never needs to spawn — so a missing
        // SERVER_PATH must not panic at construction.
        let file = env::var("SERVER_PATH").ok().map(PathBuf::from);

        Self {
            child: Arc::new(Mutex::new(None)),
            file,
            dev: false,
        }
    }

    pub fn start(&mut self, dev: bool) -> anyhow::Result<()> {
        self.dev = dev;

        // If a shared streaming-server is already running (e.g. the
        // stremio-lan-remote-server.service systemd unit), reuse it instead of
        // spawning + supervising our own. Avoids a port conflict on 11470.
        if Self::check_streaming_server(std::time::Duration::from_secs(1)).is_ok() {
            info!(target: "server", "streaming-server already running on port {STREAMING_SERVER_PORT}, reusing it");
            return Ok(());
        }

        if port_in_use(STREAMING_SERVER_PORT) {
            warn!(target: "server", "port {STREAMING_SERVER_PORT} already in use before launch — likely a stale streaming-server. mpv playback will fail until it is freed.");
        }

        let file = match &self.file {
            Some(f) => f.clone(),
            None => {
                return Err(anyhow!(
                    "no streaming-server running on port {STREAMING_SERVER_PORT} and SERVER_PATH is unset; cannot spawn one"
                ));
            }
        };

        let child = spawn_node(&file, dev)?;
        *self.child.lock().unwrap() = Some(child);

        let child_handle = self.child.clone();
        thread::spawn(move || supervise(child_handle, file, dev));

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
        if let Some(mut process) = self.child.lock().unwrap().take() {
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

fn spawn_node(file: &PathBuf, dev: bool) -> anyhow::Result<Child> {
    let mut child = Command::new("node")
        .env("NO_CORS", (dev as i32).to_string())
        .arg(file.as_os_str())
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

    Ok(child)
}

fn supervise(child: Arc<Mutex<Option<Child>>>, file: PathBuf, dev: bool) {
    let mut down_since: Option<Instant> = None;

    loop {
        thread::sleep(Duration::from_secs(5));

        // Reap exited child + clear handle so port check is meaningful.
        {
            let mut guard = child.lock().unwrap();
            if let Some(c) = guard.as_mut() {
                match c.try_wait() {
                    Result::Ok(Some(status)) => {
                        warn!(target: "server", "streaming-server exited (status={status:?}), clearing handle");
                        *guard = None;
                    }
                    Result::Ok(None) => {}
                    Err(e) => {
                        warn!(target: "server", "streaming-server try_wait failed: {e}");
                    }
                }
            }
        }

        if port_in_use(STREAMING_SERVER_PORT) {
            if down_since.is_some() {
                info!(target: "server", "streaming-server recovered on port {STREAMING_SERVER_PORT}");
            }
            down_since = None;
            continue;
        }

        let now = Instant::now();
        let started = down_since.get_or_insert(now);
        if now.duration_since(*started) < Duration::from_secs(5) {
            continue;
        }

        warn!(target: "server", "streaming-server appears down ({:?}), respawning", now.duration_since(*started));
        down_since = None;

        // Best-effort kill any lingering handle, then respawn.
        {
            let mut guard = child.lock().unwrap();
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        match spawn_node(&file, dev) {
            Result::Ok(new_child) => {
                *child.lock().unwrap() = Some(new_child);
                info!(target: "server", "streaming-server respawned");
            }
            Err(e) => {
                error!(target: "server", "streaming-server respawn failed: {e}");
            }
        }
    }
}

fn port_in_use(port: u16) -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(200),
    )
    .is_ok()
}
