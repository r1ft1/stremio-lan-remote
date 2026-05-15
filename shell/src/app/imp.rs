use std::cell::{Cell, RefCell};
use std::net::SocketAddr;
use std::rc::Rc;

use adw::{prelude::*, subclass::prelude::*};
use gtk::glib::{self, Properties, clone};
use tracing::error;

use crate::app::{
    config::URI_SCHEME,
    ipc::{
        self,
        event::{IpcEvent, IpcEventMpv},
    },
    tray::Tray,
    video::Video,
    webview::WebView,
    window::Window,
};
use crate::lan_remote;

const PRELOAD_SCRIPT: &str = include_str!("ipc/preload.js");
const LAN_REMOTE_SCRIPT: &str = include_str!("../injected.js");

#[derive(Properties, Default)]
#[properties(wrapper_type = super::Application)]
pub struct Application {
    #[property(get, set)]
    dev_mode: Cell<bool>,
    #[property(get, set)]
    startup_url: RefCell<String>,
    #[property(get, set)]
    decorations: Cell<bool>,
    tray: RefCell<Option<Tray>>,
    webview: RefCell<Option<WebView>>,
    deeplink: RefCell<Option<String>>,
}

#[glib::object_subclass]
impl ObjectSubclass for Application {
    const NAME: &'static str = "Application";
    type Type = super::Application;
    type ParentType = adw::Application;
}

#[glib::derived_properties]
impl ObjectImpl for Application {}

impl ApplicationImpl for Application {
    fn startup(&self) {
        self.parent_startup();

        let app = self.obj();
        app.setup_actions();
        app.setup_accels();
    }

    fn activate(&self) {
        self.parent_activate();

        let app = self.obj();

        if let Some(window) = app.active_window() {
            window.present();
            return;
        }

        let tray = Tray::default();
        let video = Video::default();

        let startup_url = self.startup_url.borrow();
        let dev_mode = self.dev_mode.get();

        let webview = WebView::default();
        webview.load_uri(&startup_url);
        webview.inject_script(PRELOAD_SCRIPT);
        webview.inject_script(LAN_REMOTE_SCRIPT);
        webview.connect_lan_remote_log();
        webview.dev_mode(dev_mode);

        let lan_direct_mode: Rc<Cell<bool>> = Rc::new(Cell::new(false));
        let lan_state: lan_remote::SharedState = std::sync::Arc::new(std::sync::RwLock::new(lan_remote::StateSnapshot::default()));
        let lan_downloads: lan_remote::SharedDownloads = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

        for prop in ["time-pos", "duration", "pause", "track-list", "aid", "sid", "paused-for-cache", "cache-buffering-state", "volume"] {
            video.observe_mpv_property(prop.to_string());
        }

        let download_dir = dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
            .join("stremio-downloads");

        let window = Window::new(&app);
        window.set_property("decorations", self.decorations.get());
        window.set_underlay(&video);
        window.set_overlay(&webview);

        let (lan_tx, lan_rx) = flume::bounded::<lan_remote::LanMessage>(64);
        let lan_addr: SocketAddr = "127.0.0.1:7001".parse().expect("invalid lan_remote addr");
        let lan_state_for_server = lan_state.clone();
        let lan_downloads_for_server = lan_downloads.clone();
        let download_dir_for_server = download_dir.clone();
        tokio::spawn(async move {
            if let Err(e) = lan_remote::serve(lan_addr, lan_tx, lan_state_for_server, lan_downloads_for_server, download_dir_for_server).await {
                error!("lan_remote server error: {e}");
            }
        });

        let webview_for_lan = webview.clone();
        let video_for_lan = video.clone();
        let direct_mode_for_lan = lan_direct_mode.clone();
        let lan_state_for_loop = lan_state.clone();
        let window_for_lan = window.clone();
        glib::MainContext::default().spawn_local(async move {
            while let Ok(msg) = lan_rx.recv_async().await {
                match msg {
                    lan_remote::LanMessage::EvalJs(json) => {
                        let escaped = json.replace('\\', "\\\\").replace('`', "\\`");
                        let script = format!("window.__lanRemote && window.__lanRemote.cmd(`{}`);", escaped);
                        webview_for_lan.exec_js(&script);
                    }
                    lan_remote::LanMessage::PlayUrl(url) => {
                        let was_direct = direct_mode_for_lan.get();
                        tracing::info!(target: "lan_remote", "PlayUrl was_direct={was_direct} url={url}");
                        direct_mode_for_lan.set(true);
                        if let Ok(mut s) = lan_state_for_loop.write() {
                            s.direct_mode = true;
                        }
                        if was_direct {
                            video_for_lan.send_mpv_command("stop".to_string(), vec![]);
                        }
                        video_for_lan.send_mpv_command("loadfile".to_string(), vec![url]);
                        video_for_lan.send_mpv_command("set".to_string(), vec!["pause".to_string(), "no".to_string()]);
                    }
                    lan_remote::LanMessage::ShowUi(visible) => {
                        webview_for_lan.set_opacity(if visible { 1.0 } else { 0.0 });
                    }
                    lan_remote::LanMessage::Pause => {
                        tracing::info!(target: "lan_remote", "LAN pause");
                        video_for_lan.send_mpv_command("set".to_string(), vec!["pause".to_string(), "yes".to_string()]);
                    }
                    lan_remote::LanMessage::Resume => {
                        tracing::info!(target: "lan_remote", "LAN resume");
                        video_for_lan.send_mpv_command("set".to_string(), vec!["pause".to_string(), "no".to_string()]);
                    }
                    lan_remote::LanMessage::TogglePause => {
                        tracing::info!(target: "lan_remote", "LAN toggle");
                        video_for_lan.send_mpv_command("cycle".to_string(), vec!["pause".to_string()]);
                    }
                    lan_remote::LanMessage::Stop => {
                        tracing::info!(target: "lan_remote", "Stop direct_mode=false");
                        direct_mode_for_lan.set(false);
                        if let Ok(mut s) = lan_state_for_loop.write() {
                            s.direct_mode = false;
                        }
                        video_for_lan.send_mpv_command("stop".to_string(), vec![]);
                        webview_for_lan.set_opacity(1.0);
                        webview_for_lan.exec_js("window.location.hash = '/';");
                    }
                    lan_remote::LanMessage::SeekRelative(seconds) => {
                        video_for_lan.send_mpv_command("seek".to_string(), vec![seconds.to_string(), "relative".to_string()]);
                    }
                    lan_remote::LanMessage::SeekAbsolute(seconds) => {
                        video_for_lan.send_mpv_command("seek".to_string(), vec![seconds.to_string(), "absolute".to_string()]);
                    }
                    lan_remote::LanMessage::VolumeDelta(delta) => {
                        video_for_lan.send_mpv_command("add".to_string(), vec!["volume".to_string(), delta.to_string()]);
                    }
                    lan_remote::LanMessage::SetTrack(kind, id) => {
                        tracing::info!(target: "lan_remote", "SetTrack {kind}={id}");
                        video_for_lan.send_mpv_command("set".to_string(), vec![kind, id]);
                    }
                    lan_remote::LanMessage::ToggleFullscreen => {
                        let is_fs = window_for_lan.is_fullscreen();
                        let next = !is_fs;
                        window_for_lan.set_fullscreen(next);
                        if let Ok(mut s) = lan_state_for_loop.write() {
                            s.fullscreen = next;
                        }
                        tracing::info!(target: "lan_remote", "ToggleFullscreen {is_fs} -> {next}");
                    }
                }
            }
        });

        let lan_state_for_fs = lan_state.clone();
        window.connect_fullscreened_notify(move |w| {
            if let Ok(mut s) = lan_state_for_fs.write() {
                s.fullscreen = w.is_fullscreen();
            }
        });

        window.connect_monitor_info(clone!(
            #[weak]
            video,
            move |scale_factor| {
                video.set_property("scale-factor", scale_factor);
            }
        ));

        video.connect_playback_started(clone!(
            #[weak]
            window,
            move || {
                window.disable_idling();
            }
        ));

        video.connect_playback_ended(clone!(
            #[weak]
            window,
            move || {
                window.enable_idling();
            }
        ));

        let direct_mode_for_prop = lan_direct_mode.clone();
        video.connect_mpv_property_change(clone!(
            #[weak]
            webview,
            #[strong]
            direct_mode_for_prop,
            move |name, value| {
                if direct_mode_for_prop.get()
                    && !matches!(name, "time-pos" | "duration" | "eof-reached")
                {
                    return;
                }
                let message = ipc::create_response(IpcEvent::Mpv(IpcEventMpv::Change((
                    name.to_string(),
                    value,
                ))));

                webview.send(&message);
            }
        ));

        let lan_state_for_prop = lan_state.clone();
        video.connect_mpv_property_change(move |name, value| {
            if let Ok(mut s) = lan_state_for_prop.write() {
                match name {
                    "time-pos" => { if let Some(v) = value.as_f64() { s.time_pos = v; } }
                    "duration" => { if let Some(v) = value.as_f64() { s.duration = v; } }
                    "pause" => { if let Some(v) = value.as_bool() { s.paused = v; } }
                    "track-list" => { s.track_list = value; }
                    "aid" => { s.aid = value; }
                    "sid" => { s.sid = value; }
                    "paused-for-cache" => { if let Some(v) = value.as_bool() { s.buffering = v; } }
                    "cache-buffering-state" => { if let Some(v) = value.as_f64() { s.buffer_pct = v; } }
                    "volume" => { if let Some(v) = value.as_f64() { s.volume = v; } }
                    _ => {}
                }
            }
        });

        let deeplink = self.deeplink.clone();
        let direct_mode_for_ipc = lan_direct_mode.clone();
        webview.connect_ipc(clone!(
            #[weak]
            app,
            #[weak]
            window,
            #[weak]
            video,
            #[strong]
            direct_mode_for_ipc,
            move |webview: WebView, message: &str| {
                if let Ok(event) = ipc::parse_request(message) {
                    match event {
                        IpcEvent::Init => {
                            let message = ipc::create_response(IpcEvent::Init);
                            webview.send(&message);
                        }
                        IpcEvent::Ready => {
                            if let Some(ref uri) = *deeplink.borrow() {
                                let message =
                                    ipc::create_response(IpcEvent::OpenMedia(uri.to_string()));
                                webview.send(&message);
                            }
                        }
                        IpcEvent::Fullscreen(state) => {
                            window.set_fullscreen(state);

                            let message = ipc::create_response(IpcEvent::Fullscreen(state));
                            webview.send(&message);
                        }
                        IpcEvent::Quit => {
                            app.quit();
                        }
                        IpcEvent::Mpv(event) => match event {
                            IpcEventMpv::Observe(name) => {
                                video.observe_mpv_property(name);
                            }
                            IpcEventMpv::Command((name, args)) => {
                                let in_direct = direct_mode_for_ipc.get();
                                let suppress = in_direct
                                    && matches!(name.as_str(), "stop" | "loadfile" | "playlist-clear" | "playlist-remove");
                                if in_direct {
                                    tracing::info!(target: "lan_remote", "stremio mpv cmd direct_mode={in_direct} suppress={suppress} {name} {args:?}");
                                }
                                if !suppress {
                                    video.send_mpv_command(name, args);
                                }
                            }
                            IpcEventMpv::Set((name, value)) => {
                                let in_direct = direct_mode_for_ipc.get();
                                let suppress = in_direct && (name == "pause" || name == "vid");
                                if in_direct {
                                    tracing::info!(target: "lan_remote", "stremio mpv set direct_mode={in_direct} suppress={suppress} {name}={value:?}");
                                }
                                if !suppress {
                                    video.set_mpv_property(name, value);
                                }
                            }
                            _ => {}
                        },
                        _ => {}
                    }
                }
            }
        ));

        webview.connect_fullscreen(clone!(
            #[weak]
            window,
            move |fullscreen: bool| {
                window.set_fullscreen(fullscreen);
            }
        ));

        webview.connect_open_external(clone!(
            #[weak]
            window,
            move |uri| {
                window.open_uri(uri);
            }
        ));

        window.connect_visibility(clone!(
            #[weak]
            webview,
            #[weak]
            tray,
            move |state| {
                let message = ipc::create_response(IpcEvent::Visibility(state));
                webview.send(&message);

                tray.update(state);
            }
        ));

        tray.connect_show(clone!(
            #[weak]
            window,
            move || {
                window.set_visible(true);
            }
        ));

        tray.connect_hide(clone!(
            #[weak]
            window,
            move || {
                window.set_visible(false);
            }
        ));

        tray.connect_quit(clone!(
            #[weak]
            app,
            move || {
                app.quit();
            }
        ));

        *self.tray.borrow_mut() = Some(tray);
        *self.webview.borrow_mut() = Some(webview);

        window.present();
    }

    fn open(&self, files: &[gtk::gio::File], hint: &str) {
        self.parent_open(files, hint);

        self.activate();

        if let Some(file) = files.first() {
            let uri = file.uri().to_string();
            if uri.starts_with(URI_SCHEME) {
                let mut deeplink = self.deeplink.borrow_mut();
                *deeplink = Some(uri.clone());

                if let Some(ref webview) = *self.webview.borrow() {
                    let message = ipc::create_response(IpcEvent::OpenMedia(uri));
                    webview.send(&message);
                }
            }
        }
    }
}

impl GtkApplicationImpl for Application {}
impl AdwApplicationImpl for Application {}
