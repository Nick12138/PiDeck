use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl,
};

const MAX_BROWSER_SURFACES: usize = 8;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSurfaceBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BrowserSurfaceBounds {
    fn validate(self) -> Result<Self, String> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite()) {
            return Err("browser bounds must be finite".into());
        }
        if self.x < 0.0 || self.y < 0.0 || self.width < 1.0 || self.height < 1.0 {
            return Err("browser bounds must be positive and inside the window".into());
        }
        if values.iter().any(|value| *value > 100_000.0) {
            return Err("browser bounds are too large".into());
        }
        Ok(self)
    }

    fn rect(self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSurfaceSnapshot {
    pub surface_id: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSurfaceEvent {
    surface_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
}

fn validate_surface_id(surface_id: &str) -> Result<(), String> {
    let suffix = surface_id
        .strip_prefix("dock-browser-")
        .ok_or_else(|| "invalid browser surface id".to_string())?;
    if suffix.is_empty() || suffix.len() > 20 || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid browser surface id".into());
    }
    Ok(())
}

pub fn parse_browser_url(input: &str) -> Result<Url, String> {
    let value = input.trim();
    if value.is_empty() || value == "about:blank" {
        return Url::parse("about:blank").map_err(|error| error.to_string());
    }
    let url = Url::parse(value).map_err(|_| "Enter a valid http(s) URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only http(s) URLs are allowed".into());
    }
    Ok(url)
}

fn browser_navigation_allowed(url: &Url) -> bool {
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
        || url.as_str() == "about:blank"
}

pub struct BrowserSurfaceManager {
    surfaces: HashMap<String, Webview>,
}

impl BrowserSurfaceManager {
    pub fn new() -> Self {
        Self {
            surfaces: HashMap::new(),
        }
    }

    pub fn create(
        &mut self,
        app: &AppHandle,
        surface_id: &str,
        raw_url: &str,
        bounds: BrowserSurfaceBounds,
        visible: bool,
    ) -> Result<BrowserSurfaceSnapshot, String> {
        validate_surface_id(surface_id)?;
        let bounds = bounds.validate()?;
        let url = parse_browser_url(raw_url)?;
        if let Some(webview) = self.surfaces.get(surface_id) {
            webview
                .set_bounds(bounds.rect())
                .map_err(|error| error.to_string())?;
            if visible {
                webview.show()
            } else {
                webview.hide()
            }
            .map_err(|error| error.to_string())?;
            return Ok(BrowserSurfaceSnapshot {
                surface_id: surface_id.to_string(),
                url: webview
                    .url()
                    .map(|current| current.to_string())
                    .unwrap_or_else(|_| url.to_string()),
            });
        }
        if self.surfaces.len() >= MAX_BROWSER_SURFACES {
            return Err(format!(
                "At most {MAX_BROWSER_SURFACES} browser surfaces are allowed"
            ));
        }

        let window = app
            .get_window("main")
            .ok_or_else(|| "main window is unavailable".to_string())?;
        let event_app = app.clone();
        let load_surface_id = surface_id.to_string();
        let title_app = app.clone();
        let title_surface_id = surface_id.to_string();
        let profile_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("browser-profile");
        std::fs::create_dir_all(&profile_dir).map_err(|error| error.to_string())?;

        let builder = WebviewBuilder::new(surface_id, WebviewUrl::External(url.clone()))
            .data_directory(profile_dir)
            .incognito(false)
            .on_navigation(browser_navigation_allowed)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_page_load(move |_, payload| {
                let loading = matches!(payload.event(), PageLoadEvent::Started);
                let _ = event_app.emit_to(
                    "main",
                    "browser-surface-event",
                    BrowserSurfaceEvent {
                        surface_id: load_surface_id.clone(),
                        kind: "load",
                        url: Some(payload.url().to_string()),
                        title: None,
                        loading: Some(loading),
                    },
                );
            })
            .on_document_title_changed(move |_, title| {
                let _ = title_app.emit_to(
                    "main",
                    "browser-surface-event",
                    BrowserSurfaceEvent {
                        surface_id: title_surface_id.clone(),
                        kind: "title",
                        url: None,
                        title: Some(title),
                        loading: None,
                    },
                );
            });
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|error| error.to_string())?;
        if !visible {
            webview.hide().map_err(|error| error.to_string())?;
        }
        self.surfaces.insert(surface_id.to_string(), webview);
        Ok(BrowserSurfaceSnapshot {
            surface_id: surface_id.to_string(),
            url: url.to_string(),
        })
    }

    fn get(&self, surface_id: &str) -> Result<&Webview, String> {
        validate_surface_id(surface_id)?;
        self.surfaces
            .get(surface_id)
            .ok_or_else(|| "browser surface does not exist".to_string())
    }

    pub fn navigate(&self, surface_id: &str, raw_url: &str) -> Result<String, String> {
        let url = parse_browser_url(raw_url)?;
        self.get(surface_id)?
            .navigate(url.clone())
            .map_err(|error| error.to_string())?;
        Ok(url.to_string())
    }

    pub fn control(&self, surface_id: &str, action: &str) -> Result<(), String> {
        let webview = self.get(surface_id)?;
        match action {
            "back" => webview.eval("history.back()"),
            "forward" => webview.eval("history.forward()"),
            "reload" => webview.reload(),
            "stop" => webview.eval("window.stop()"),
            _ => return Err("unknown browser control".into()),
        }
        .map_err(|error| error.to_string())
    }

    pub fn set_bounds(&self, surface_id: &str, bounds: BrowserSurfaceBounds) -> Result<(), String> {
        self.get(surface_id)?
            .set_bounds(bounds.validate()?.rect())
            .map_err(|error| error.to_string())
    }

    pub fn set_visible(&self, surface_id: &str, visible: bool) -> Result<(), String> {
        let webview = self.get(surface_id)?;
        if visible {
            webview.show()
        } else {
            webview.hide()
        }
        .map_err(|error| error.to_string())
    }

    pub fn focus(&self, surface_id: &str) -> Result<(), String> {
        self.get(surface_id)?
            .set_focus()
            .map_err(|error| error.to_string())
    }

    pub fn close(&mut self, surface_id: &str) -> Result<bool, String> {
        validate_surface_id(surface_id)?;
        let Some(webview) = self.surfaces.remove(surface_id) else {
            return Ok(false);
        };
        webview.close().map_err(|error| error.to_string())?;
        Ok(true)
    }

    pub fn shutdown_all(&mut self) {
        for (_, webview) in self.surfaces.drain() {
            let _ = webview.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_browser_safe_urls() {
        assert_eq!(parse_browser_url("").unwrap().as_str(), "about:blank");
        assert_eq!(
            parse_browser_url("https://example.com/path")
                .unwrap()
                .scheme(),
            "https"
        );
        assert!(parse_browser_url("file:///etc/passwd").is_err());
        assert!(parse_browser_url("javascript:alert(1)").is_err());
        assert!(parse_browser_url("tauri://localhost").is_err());
    }

    #[test]
    fn validates_surface_ids_and_bounds() {
        assert!(validate_surface_id("dock-browser-1").is_ok());
        assert!(validate_surface_id("browser-1").is_err());
        assert!(BrowserSurfaceBounds {
            x: 1.0,
            y: 1.0,
            width: 500.0,
            height: 400.0,
        }
        .validate()
        .is_ok());
        assert!(BrowserSurfaceBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 100.0,
        }
        .validate()
        .is_err());
    }
}
