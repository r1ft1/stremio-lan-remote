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

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct DownloadEntry {
    pub filename: String,
    pub path: String,
    pub source_url: String,
    pub bytes: u64,
    pub total: u64,
    pub status: String,
    #[serde(default)]
    pub meta_id: String,
}

pub type SharedDownloads = Arc<Mutex<Vec<DownloadEntry>>>;

const PERSIST_FILE: &str = ".downloads.json";

pub fn load_persisted(dir: &std::path::Path) -> Vec<DownloadEntry> {
    let p = dir.join(PERSIST_FILE);
    let raw = match std::fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mut list: Vec<DownloadEntry> = serde_json::from_str(&raw).unwrap_or_default();
    for e in list.iter_mut() {
        if e.status == "downloading" {
            e.status = "interrupted".into();
        }
    }
    list
}

fn persist(dir: &std::path::Path, list: &[DownloadEntry]) {
    let p = dir.join(PERSIST_FILE);
    if let Ok(data) = serde_json::to_string(list) {
        let _ = std::fs::write(p, data);
    }
}

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
    #[serde(default)]
    meta_id: String,
}

#[derive(Deserialize)]
struct DownloadByName {
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
        .route("/cancel_download", post(cancel_download))
        .route("/delete_download", post(delete_download))
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
    let mut list = state.downloads.lock().map(|d| d.clone()).unwrap_or_default();
    if let Ok(read_dir) = std::fs::read_dir(&state.download_dir) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let filename = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if filename.starts_with('.') {
                continue;
            }
            if list.iter().any(|e| e.filename == filename) {
                continue;
            }
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            list.push(DownloadEntry {
                filename: filename.clone(),
                path: path.to_string_lossy().to_string(),
                source_url: String::new(),
                bytes: size,
                total: 0,
                status: "unknown".into(),
                meta_id: String::new(),
            });
        }
    }
    Json(list)
}

pub fn spawn_download_task(
    url: String,
    filename: String,
    meta_id: String,
    downloads: SharedDownloads,
    dir: std::path::PathBuf,
) -> bool {
    let dest = dir.join(&filename);
    let _ = std::fs::create_dir_all(&dir);

    let resume_from: u64 = {
        let mut d = match downloads.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if d.iter().any(|e| e.filename == filename && e.status == "downloading") {
            return false;
        }
        let existing_meta_id = d
            .iter()
            .find(|e| e.filename == filename)
            .map(|e| e.meta_id.clone())
            .unwrap_or_default();
        let final_meta_id = if !meta_id.is_empty() { meta_id.clone() } else { existing_meta_id };
        let on_disk = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        d.retain(|e| e.filename != filename);
        d.push(DownloadEntry {
            filename: filename.clone(),
            path: dest.to_string_lossy().to_string(),
            source_url: url.clone(),
            bytes: on_disk,
            total: 0,
            status: "downloading".into(),
            meta_id: final_meta_id,
        });
        persist(&dir, &d);
        on_disk
    };

    let downloads_for_task = downloads.clone();
    let dir_for_task = dir.clone();
    let filename_for_task = filename.clone();
    let url_for_task = url.clone();
    tokio::spawn(async move {
        info!(target: "lan_remote", "download start url={url_for_task} dest={dest:?} resume_from={resume_from}");
        let result = download_to_file(&url_for_task, &dest, &filename_for_task, downloads_for_task.clone(), resume_from).await;
        let mut d = downloads_for_task.lock().unwrap();
        if let Some(entry) = d.iter_mut().find(|e| e.filename == filename_for_task) {
            entry.status = match &result {
                Ok(_) => "done".into(),
                Err(e) => {
                    let msg = e.to_string();
                    if msg == "cancelled" {
                        "cancelled".into()
                    } else {
                        error!(target: "lan_remote", "download {filename_for_task} failed: {msg}");
                        format!("error: {msg}")
                    }
                }
            };
        }
        persist(&dir_for_task, &d);
    });
    true
}

async fn start_download(State(state): State<AppState>, Json(body): Json<DownloadBody>) -> StatusCode {
    let filename = sanitize_filename(&body.filename);
    if filename.is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    if spawn_download_task(body.url, filename, body.meta_id, state.downloads, state.download_dir) {
        StatusCode::ACCEPTED
    } else {
        StatusCode::CONFLICT
    }
}

async fn download_to_file(
    url: &str,
    dest: &std::path::Path,
    filename: &str,
    downloads: SharedDownloads,
    resume_from: u64,
) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let mut req = client.get(url);
    if resume_from > 0 {
        req = req.header("Range", format!("bytes={}-", resume_from));
    }
    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("HTTP {}", status);
    }
    let resumed = status.as_u16() == 206;
    let body_len = resp.content_length().unwrap_or(0);
    let total = if resumed { resume_from + body_len } else { body_len };
    {
        let mut d = downloads.lock().unwrap();
        if let Some(e) = d.iter_mut().find(|e| e.filename == filename) {
            e.total = total;
            if !resumed {
                e.bytes = 0;
            }
        }
    }
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut file = if resumed {
        tokio::fs::OpenOptions::new().append(true).open(dest).await?
    } else {
        tokio::fs::File::create(dest).await?
    };
    let mut bytes: u64 = if resumed { resume_from } else { 0 };
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        bytes += chunk.len() as u64;
        let cancelled = {
            let mut d = downloads.lock().unwrap();
            if let Some(e) = d.iter_mut().find(|e| e.filename == filename) {
                e.bytes = bytes;
                e.status == "cancelled"
            } else {
                false
            }
        };
        if cancelled {
            anyhow::bail!("cancelled");
        }
    }
    file.flush().await?;
    Ok(())
}

async fn cancel_download(State(state): State<AppState>, Json(body): Json<DownloadByName>) -> StatusCode {
    let filename = sanitize_filename(&body.filename);
    let path = state.download_dir.join(&filename);
    let still_downloading = {
        let mut d = state.downloads.lock().unwrap();
        match d.iter_mut().find(|e| e.filename == filename) {
            Some(e) if e.status == "downloading" => {
                e.status = "cancelled".into();
                true
            }
            _ => false,
        }
    };
    if !still_downloading {
        return StatusCode::NOT_FOUND;
    }
    let downloads = state.downloads.clone();
    let filename_clone = filename.clone();
    let dir = state.download_dir.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let _ = tokio::fs::remove_file(&path).await;
        let mut d = downloads.lock().unwrap();
        d.retain(|e| e.filename != filename_clone);
        persist(&dir, &d);
        info!(target: "lan_remote", "cancelled and removed {filename_clone}");
    });
    StatusCode::ACCEPTED
}

async fn delete_download(State(state): State<AppState>, Json(body): Json<DownloadByName>) -> StatusCode {
    let filename = sanitize_filename(&body.filename);
    let path = state.download_dir.join(&filename);
    let allowed = {
        let d = state.downloads.lock().unwrap();
        d.iter().any(|e| {
            e.filename == filename
                && matches!(e.status.as_str(), "done" | "unknown" | "interrupted")
        })
    };
    if !allowed {
        return StatusCode::NOT_FOUND;
    }
    match tokio::fs::remove_file(&path).await {
        Ok(_) => {
            let mut d = state.downloads.lock().unwrap();
            d.retain(|e| e.filename != filename);
            persist(&state.download_dir, &d);
            info!(target: "lan_remote", "deleted {filename}");
            StatusCode::OK
        }
        Err(e) => {
            error!(target: "lan_remote", "delete_download remove_file failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
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
