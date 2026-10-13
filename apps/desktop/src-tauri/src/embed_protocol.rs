//! `writer-embed://` serves the page that inline HTML embeds run in. The editor
//! frames it with an opaque-origin sandbox and posts the fence body to it, so
//! the CSP below, not the app's, governs what embed code can reach. See
//! `SPECs/embeds-spec.md`.

use std::borrow::Cow;
use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "writer-embed";

const FRAME_PATH: &str = "/frame";
const FRAME_HTML: &str = include_str!("embed-frame.html");

// Network only: `asset:`, `ipc:` and `tauri:` are left out so embed code
// cannot read local files or call native commands.
const FRAME_CSP: &str = "default-src https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; \
    connect-src https: http: ws: wss: data: blob:";

/// Appended to Co-writer's system prompt so the agent knows how to embed.
pub const EMBED_AUTHORING_GUIDE: &str = "To add an interactive diagram, visualization or prototype, \
write a fenced block whose info string is `html embed` containing one complete, self-contained HTML \
document; inline CSS and JS, and https CDN scripts are fine. It runs in a sandbox with no access to \
local files, the surrounding note or app APIs. Its height fits its content, so avoid 100vh and \
full-viewport layouts; use a transparent background and prefers-color-scheme for dark mode.";

pub fn respond(request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    if request.uri().path() != FRAME_PATH {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Cow::Borrowed(&[][..]))
            .expect("static response is valid");
    }
    Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, FRAME_CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Borrowed(FRAME_HTML.as_bytes()))
        .expect("static response is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(uri: &str) -> Response<Cow<'static, [u8]>> {
        respond(&Request::builder().uri(uri).body(Vec::new()).unwrap())
    }

    #[test]
    fn serves_the_frame_with_its_own_csp() {
        for uri in [
            "writer-embed://localhost/frame",
            "http://writer-embed.localhost/frame",
        ] {
            let response = get(uri);
            assert_eq!(response.status(), StatusCode::OK);
            let csp = response.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap();
            assert!(!csp.contains("asset:") && !csp.contains("ipc:") && !csp.contains("tauri:"));
            assert_eq!(response.body().as_ref(), FRAME_HTML.as_bytes());
        }
    }

    #[test]
    fn rejects_other_paths() {
        assert_eq!(
            get("writer-embed://localhost/etc/hosts").status(),
            StatusCode::NOT_FOUND
        );
    }
}
