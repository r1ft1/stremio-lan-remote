use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use axum::{Json, Router, extract::State, http::StatusCode, routing::{get, post}};
use flume::Sender;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tracing::{error, info};

pub enum LanMessage {
    EvalJs(String),
    PlayUrl(String),
    ShowUi(bool),
    Pause,
    Resume,
    TogglePause,
    Stop,
    SeekRelative(f64),
    SeekAbsolute(f64),
    VolumeDelta(f64),
    SetTrack(String, String),
    ToggleFullscreen,
}

#[derive(Default, Clone, Serialize)]
pub struct StateSnapshot {
    pub paused: bool,
    pub time_pos: f64,
    pub duration: f64,
    pub aid: Value,
    pub sid: Value,
    pub track_list: Value,
    pub direct_mode: bool,
    pub buffering: bool,
    pub buffer_pct: f64,
    pub volume: f64,
    pub fullscreen: bool,
}

#[derive(Default, Clone, Serialize)]
pub struct DownloadEntry {
    pub filename: String,
    pub path: String,
    pub source_url: String,
    pub bytes: u64,
    pub total: u64,
    pub status: String,
}

pub type SharedDownloads = Arc<Mutex<Vec<DownloadEntry>>>;

pub type SharedState = Arc<RwLock<StateSnapshot>>;

#[derive(Clone)]
pub struct AppState {
    pub tx: Sender<LanMessage>,
    pub state: SharedState,
    pub downloads: SharedDownloads,
    pub download_dir: PathBuf,
}

#[derive(Deserialize)]
struct PlayBody {
    url: String,
}

#[derive(Deserialize)]
struct SeekBody {
    seconds: f64,
}

#[derive(Deserialize)]
struct VolumeBody {
    delta: f64,
}

#[derive(Deserialize)]
struct TrackBody {
    kind: String,
    id: String,
}

#[derive(Deserialize)]
struct DownloadBody {
    url: String,
    filename: String,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/dispatch", post(dispatch))
        .route("/play_url", post(play_url))
        .route("/show_ui", post(show_ui))
        .route("/hide_ui", post(hide_ui))
        .route("/pause", post(pause))
        .route("/resume", post(resume))
        .route("/toggle", post(toggle))
        .route("/stop", post(stop))
        .route("/seek", post(seek))
        .route("/seek_abs", post(seek_abs))
        .route("/volume", post(volume))
        .route("/set_track", post(set_track))
        .route("/fullscreen", post(toggle_fullscreen))
        .route("/download", post(start_download))
        .route("/downloads", get(get_downloads))
        .route("/state", get(get_state))
        .with_state(state)
}

async fn dispatch(State(state): State<AppState>, Json(body): Json<Value>) -> StatusCode {
    match state.tx.send_async(LanMessage::EvalJs(body.to_string())).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(e) => {
            error!("lan_remote dispatch channel send failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

async fn play_url(State(state): State<AppState>, Json(body): Json<PlayBody>) -> StatusCode {
    let _ = state.tx.send_async(LanMessage::ShowUi(false)).await;
    match state.tx.send_async(LanMessage::PlayUrl(body.url)).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(e) => {
            error!("lan_remote play_url channel send failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

async fn show_ui(State(state): State<AppState>) -> StatusCode {
    match state.tx.send_async(LanMessage::ShowUi(true)).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn hide_ui(State(state): State<AppState>) -> StatusCode {
    match state.tx.send_async(LanMessage::ShowUi(false)).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn pause(State(state): State<AppState>) -> StatusCode {
    match state.tx.send_async(LanMessage::Pause).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn resume(State(state): State<AppState>) -> StatusCode {
    match state.tx.send_async(LanMessage::Resume).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn toggle(State(state): State<AppState>) -> StatusCode {
    match state.tx.send_async(LanMessage::TogglePause).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn stop(State(state): State<AppState>) -> StatusCode {
    match state.tx.send_async(LanMessage::Stop).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn seek(State(state): State<AppState>, Json(body): Json<SeekBody>) -> StatusCode {
    match state.tx.send_async(LanMessage::SeekRelative(body.seconds)).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn seek_abs(State(state): State<AppState>, Json(body): Json<SeekBody>) -> StatusCode {
    match state.tx.send_async(LanMessage::SeekAbsolute(body.seconds)).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn volume(State(state): State<AppState>, Json(body): Json<VolumeBody>) -> StatusCode {
    match state.tx.send_async(LanMessage::VolumeDelta(body.delta)).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn set_track(State(state): State<AppState>, Json(body): Json<TrackBody>) -> StatusCode {
    match state.tx.send_async(LanMessage::SetTrack(body.kind, body.id)).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn toggle_fullscreen(State(state): State<AppState>) -> StatusCode {
    match state.tx.send_async(LanMessage::ToggleFullscreen).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn get_downloads(State(state): State<AppState>) -> Json<Vec<DownloadEntry>> {
    let list = state.downloads.lock().map(|d| d.clone()).unwrap_or_default();
    Json(list)
}

async fn start_download(State(state): State<AppState>, Json(body): Json<DownloadBody>) -> StatusCode {
    let filename = sanitize_filename(&body.filename);
    if filename.is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let url = body.url;
    let dest = state.download_dir.join(&filename);
    let downloads = state.downloads.clone();

    if let Err(e) = std::fs::create_dir_all(&state.download_dir) {
        error!("create download dir failed: {e}");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }

    {
        let mut d = downloads.lock().unwrap();
        if d.iter().any(|e| e.filename == filename && e.status == "downloading") {
            return StatusCode::CONFLICT;
        }
        d.retain(|e| e.filename != filename);
        d.push(DownloadEntry {
            filename: filename.clone(),
            path: dest.to_string_lossy().to_string(),
            source_url: url.clone(),
            bytes: 0,
            total: 0,
            status: "downloading".into(),
        });
    }

    tokio::spawn(async move {
        info!(target: "lan_remote", "download start url={url} dest={dest:?}");
        let result = download_to_file(&url, &dest, &filename, downloads.clone()).await;
        let mut d = downloads.lock().unwrap();
        if let Some(entry) = d.iter_mut().find(|e| e.filename == filename) {
            entry.status = match result {
                Ok(_) => "done".into(),
                Err(e) => {
                    error!(target: "lan_remote", "download {filename} failed: {e}");
                    format!("error: {e}")
                }
            };
        }
    });

    StatusCode::ACCEPTED
}

async fn download_to_file(
    url: &str,
    dest: &std::path::Path,
    filename: &str,
    downloads: SharedDownloads,
) -> anyhow::Result<()> {
    let resp = reqwest::get(url).await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status());
    }
    let total = resp.content_length().unwrap_or(0);
    {
        let mut d = downloads.lock().unwrap();
        if let Some(e) = d.iter_mut().find(|e| e.filename == filename) {
            e.total = total;
        }
    }
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut file = tokio::fs::File::create(dest).await?;
    let mut bytes: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        bytes += chunk.len() as u64;
        if let Ok(mut d) = downloads.lock() {
            if let Some(e) = d.iter_mut().find(|e| e.filename == filename) {
                e.bytes = bytes;
            }
        }
    }
    file.flush().await?;
    Ok(())
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.len() > 200 {
        cleaned.chars().take(200).collect()
    } else {
        cleaned
    }
}

async fn get_state(State(state): State<AppState>) -> Json<StateSnapshot> {
    let snap = state.state.read().map(|s| s.clone()).unwrap_or_default();
    Json(snap)
}

pub async fn serve(
    addr: SocketAddr,
    tx: Sender<LanMessage>,
    state: SharedState,
    downloads: SharedDownloads,
    download_dir: PathBuf,
) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(AppState { tx, state, downloads, download_dir })).await?;
    Ok(())
}
