//! The Nexo desktop core.
//!
//! Everything security-relevant lives on this side of the IPC boundary: MLS
//! state, the identity keypair, the SQLCipher key, and every message plaintext.
//! The WebView receives already-decrypted strings and nothing else (rule 2).

#![forbid(unsafe_code)]

mod auth;
mod client;
mod commands;
mod conversations;
mod feed;
mod media;
mod meet;
mod preview;
mod stream;
mod windows;

/// Start the app.
pub fn run() {
    init_tracing();

    let builder = tauri::Builder::default();
    // Before the plugins, so the scheme exists by the time any window does.
    let builder = media::register(builder);
    builder
        // First, before anything else can take the port or the lock: a second
        // launch hands its arguments to the running instance and exits (§8).
        // Two instances would mean two SQLCipher connections to one file and
        // two MLS providers ratcheting the same group forward independently --
        // the second is the one that corrupts state.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            windows::show_main_window(app);
        }))
        // The session lives here, in the Rust process. Tokens never cross the
        // IPC boundary (rule 2).
        .manage(auth::SessionState::default())
        .manage(windows::WindowPrefs::default())
        .manage(client::ClientState::default())
        .manage(stream::StreamState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // HKCU, never HKLM (§8). A per-machine Run key needs admin, affects
        // every account on the computer, and is not this app's to write.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // §8: manifests signed with the minisign key whose public half is
        // pinned in tauri.conf.json. The plugin refuses anything the key did
        // not sign, so the update server is not trusted, only the key.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            windows::install_tray(app.handle())?;
            // Close-to-tray defaults off (see `WindowPrefs`). Someone who
            // closes a window and finds the app still running has been
            // surprised by their own computer; they can turn it on in
            // Settings once they know it exists, and the WebView pushes the
            // stored preference across at startup.
            windows::install_close_to_tray(app.handle());
            Ok(())
        })
        // Commands are added one at a time, and each one needs a matching
        // entry in capabilities/default.json. The capability set starts empty
        // and only ever grows deliberately (§4.5).
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::notify_message,
            commands::set_unread,
            commands::lock,
            commands::is_unlocked,
            commands::focus_window,
            commands::set_close_to_tray,
            commands::set_window_backdrop,
            commands::storage_info,
            commands::clear_media_cache,
            commands::preview_link,
            commands::get_autostart,
            commands::set_autostart,
            commands::check_update,
            commands::install_update,
            auth::register,
            auth::login,
            auth::restore_session,
            auth::change_password,
            auth::device_fingerprint,
            auth::pin_status,
            auth::set_pin,
            auth::clear_pin,
            auth::unlock_with_pin,
            auth::logout,
            auth::delete_account,
            conversations::list_conversations,
            conversations::delete_conversation,
            conversations::start_conversation,
            conversations::start_group,
            conversations::add_to_conversation,
            conversations::rename_conversation,
            conversations::mark_verified,
            conversations::search_messages,
            conversations::forward_message,
            conversations::open_self_conversation,
            conversations::acknowledge_key_change,
            conversations::set_conversation_avatar,
            conversations::conversation_avatar,
            conversations::attachment_data_url,
            conversations::conversation_attachments,
            conversations::send_message,
            conversations::sync_conversation,
            conversations::sync_all,
            conversations::call_ice_servers,
            conversations::call_offer,
            conversations::call_answer,
            conversations::call_hangup,
            conversations::conversation_messages,
            conversations::send_attachment,
            conversations::send_voice_message,
            conversations::send_reply,
            conversations::send_view_once,
            conversations::open_view_once,
            conversations::attachment_stream_info,
            conversations::send_sticker,
            stream::drain_stream,
            stream::typing,
            conversations::draft,
            conversations::set_draft,
            conversations::conversations_with_drafts,
            conversations::list_folders,
            conversations::create_folder,
            conversations::rename_folder,
            conversations::delete_folder,
            conversations::set_folder_member,
            conversations::save_attachment,
            conversations::flush_outbox,
            conversations::outbox_count,
            conversations::safety_number,
            conversations::react_to_message,
            conversations::revise_message,
            conversations::set_message_pinned,
            conversations::delete_message_for_me,
            meet::meet_pins,
            meet::meet_me,
            meet::meet_set_me,
            meet::meet_leave,
            meet::meet_consent,
            meet::meet_requests,
            meet::meet_send_request,
            meet::meet_accept_request,
            meet::meet_decline_request,
            meet::meet_report,
            meet::meet_search,
            meet::meet_create_invite,
            meet::meet_invites,
            meet::meet_revoke_invite,
            meet::story_post,
            meet::story_list,
            meet::story_open,
            feed::feed,
            feed::posts_by,
            feed::set_following,
            feed::follow_state,
            feed::create_post,
            feed::delete_post,
            feed::react,
            feed::pin_post,
            feed::unpin_post,
            feed::blocks,
            feed::block,
            feed::unblock,
            feed::profile,
            feed::my_profile,
            feed::update_profile,
            feed::update_visibility,
            feed::upload_image,
            feed::vote,
            feed::comments,
            feed::add_comment,
            feed::delete_comment,
            feed::image_url,
            feed::image_data_url,
            feed::read_image_for_crop,
            feed::upload_image_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nexo");
}

fn init_tracing() {
    // §4.5: nothing above `debug` may contain user content, and `debug` is
    // compiled out of release builds. `debug_assertions` is the switch, and
    // the release profile in the workspace manifest turns it off.
    //
    // `nexo_client` is named as well as this crate, and that is the point:
    // conversations, joins and the reasons a send was refused all happen in
    // that crate, and a filter that named only this one discarded every line
    // explaining them. What reached the console was the summary the user saw
    // anyway -- "You are not in that conversation." -- and nothing about why.
    let default = if cfg!(debug_assertions) {
        "nexo_desktop_lib=debug,nexo_client=debug"
    } else {
        "nexo_desktop_lib=info,nexo_client=info"
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| default.into()),
        )
        .init();
}
