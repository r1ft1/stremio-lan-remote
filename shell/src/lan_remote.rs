use std::net::SocketAddr;

use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use flume::Sender;
use serde_json::Value;
use tracing::error;

#[derive(Clone)]
pub struct AppState {
    pub tx: Sender<String>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/dispatch", post(dispatch))
        .with_state(state)
}

async fn dispatch(State(state): State<AppState>, Json(body): Json<Value>) -> StatusCode {
    match state.tx.send_async(body.to_string()).await {
        Ok(_) => StatusCode::ACCEPTED,
        Err(e) => {
            error!("lan_remote dispatch channel send failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

pub async fn serve(addr: SocketAddr, tx: Sender<String>) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(AppState { tx })).await?;
    Ok(())
}
