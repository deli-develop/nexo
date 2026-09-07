//! Who may open the microphone and the camera, and when.
//!
//! # Why this file exists at all
//!
//! WebView2 decides device permissions by raising `PermissionRequested`. wry
//! registers a handler for it, but only to allow clipboard reads — every other
//! kind is left at `COREWEBVIEW2_PERMISSION_STATE_DEFAULT`, which makes WebView2
//! draw its own prompt: *"http://tauri.localhost wants to · Use your cameras"*.
//!
//! That prompt is wrong in a native messenger twice over. It names an origin
//! nobody has heard of and cannot evaluate — `tauri.localhost` is an
//! implementation detail of how the app serves its own files — and it asks the
//! question a second time, after the person has already answered it by pressing
//! *call*. Rule 5 is about being honest and clear, and a browser chrome bubble
//! quoting a URL is neither.
//!
//! # What it does instead
//!
//! The gate is the call itself. `allow_call_media(true)` is set when a call
//! starts fetching its relay, cleared when it ends, and cleared again by the
//! lock screen. While it is set, the microphone and the camera are granted
//! without a prompt; while it is not, they are **refused**. So the page cannot
//! open a device outside a call, and pressing *call* is the consent — which is
//! a real decision about a real thing, unlike a dialog about an origin.
//!
//! Nothing here can grant more than Windows already allows. The OS keeps its
//! own camera and microphone privacy settings per application, and they still
//! apply: this decides only whether WebView2 asks, not whether Windows agrees.
//!
//! Every other permission kind is left untouched, deliberately. Setting a state
//! for them would override wry's clipboard handler, and denying by default
//! would break a feature this module has no business having an opinion about.
//!
//! # The `unsafe` in here
//!
//! This is the **second** `unsafe` in the workspace; the first is
//! `crates/platform/src/dpapi.rs`. It is confined to one function, and it is
//! only unsafe because the WebView2 API is COM: every call is an FFI call
//! through a vtable. No pointer is constructed here, nothing is transmuted, and
//! nothing outlives the closure — the risk is a wrong COM call, not memory
//! management.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    COREWEBVIEW2_PERMISSION_STATE_DENY, ICoreWebView2PermissionRequestedEventArgs3,
};
use webview2_com::PermissionRequestedEventHandler;
use windows::core::Interface as _;

/// Whether a call is currently entitled to the microphone and the camera.
///
/// A `static` rather than managed state because the handler below is a
/// `'static` COM callback: it outlives any borrow and cannot hold a `State`.
/// There is one window and one call at a time, so one flag says everything.
static CALL_MEDIA_ALLOWED: AtomicBool = AtomicBool::new(false);

/// Opens or closes the gate.
///
/// Set when a call asks for its relay — the first thing either side of a call
/// does — and cleared when the call ends. `commands::lock` clears it too: a
/// locked app has no business holding a microphone open, and the flag would
/// otherwise survive the lock the way the socket used to.
pub fn allow_call_media(allowed: bool) {
    CALL_MEDIA_ALLOWED.store(allowed, Ordering::SeqCst);
}

/// Whether the gate is open. For the log line, and for tests.
pub fn call_media_allowed() -> bool {
    CALL_MEDIA_ALLOWED.load(Ordering::SeqCst)
}

/// Answers WebView2's permission requests for this window.
///
/// Registered once, at startup. Failing is not fatal: without it WebView2 falls
/// back to its own prompt, which is what shipped before this existed, so a
/// refusal here costs a worse dialog rather than a broken call.
#[allow(unsafe_code)]
pub fn install<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(error) = window.with_webview(|webview| {
        // SAFETY: `controller()` hands back a live `ICoreWebView2Controller`
        // owned by the running webview, and every call below is an ordinary COM
        // method on it. The handler is boxed and handed to WebView2, which owns
        // it for the life of the webview; it captures nothing but a `'static`
        // atomic. `token` is written by `add_PermissionRequested` and dropped
        // unused because the handler is never removed -- it lives exactly as
        // long as the window it belongs to.
        unsafe {
            let controller = webview.controller();
            let core = match controller.CoreWebView2() {
                Ok(core) => core,
                Err(error) => {
                    tracing::warn!(%error, "no CoreWebView2; leaving permissions to WebView2");
                    return;
                }
            };

            let mut token = 0;
            let result = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };

                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;

                    // Never remember the answer.
                    //
                    // WebView2 saves a permission decision into the profile by
                    // default, and a saved decision means this event stops
                    // firing — the request is answered from the profile before
                    // anything here runs. That turns the gate below into a gate
                    // that is checked once and then propped open for ever,
                    // which was exactly the observed behaviour: a microphone
                    // granted long ago sailed straight past it while the camera
                    // was correctly refused.
                    //
                    // Asking not to save it means every request reaches this
                    // handler and is judged against the call that is actually
                    // happening. Best effort: `SetSavesInProfile` lives on the
                    // third revision of the args interface, so a WebView2 old
                    // enough not to have it keeps the previous behaviour rather
                    // than losing the handler entirely.
                    if let Ok(args2) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                        let _ = args2.SetSavesInProfile(false);
                    }

                    // Only the two a call needs. Everything else keeps whatever
                    // state it already had -- wry allows clipboard reads with a
                    // handler of its own, and overriding it here would break
                    // copy and paste for no reason.
                    if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                        || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                    {
                        args.SetState(if call_media_allowed() {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            // Refused rather than left to prompt. A page asking
                            // for a microphone outside a call is either a bug
                            // or something worse, and `getUserMedia` rejecting
                            // with `NotAllowedError` is an answer the call code
                            // already knows how to report.
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        })?;
                    }

                    Ok(())
                })),
                &mut token,
            );

            match result {
                Ok(()) => tracing::info!("permission handler installed"),
                Err(error) => {
                    tracing::warn!(%error, "could not install the permission handler")
                }
            }
        }
    }) {
        tracing::warn!(%error, "could not reach the platform webview");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_is_shut_until_a_call_opens_it() {
        // The default matters more than the toggle: a build that came up with
        // this set would hand any page a microphone.
        allow_call_media(false);
        assert!(!call_media_allowed());
        allow_call_media(true);
        assert!(call_media_allowed());
        allow_call_media(false);
        assert!(!call_media_allowed());
    }
}
