//! Rate limits (BRIEF 4.5).
//!
//! Three limits, because three endpoints are abusable in ways the rest are not:
//!
//! - **Auth, 10/min per IP.** `/v1/auth/login` verifies with Argon2id at 19 MiB
//!   *on the server* (`auth::password`). Unlimited, it is simultaneously a
//!   password-guessing oracle and a memory-exhaustion lever against one small
//!   machine -- an attacker does not need to guess anything to hurt it.
//!   `/v1/auth/salt` is unauthenticated by construction, so IP is the only key
//!   available for the whole router.
//! - **KeyPackage claims, 60/min per account.** Every claim *consumes* a
//!   KeyPackage. A loop exhausts someone's supply, after which nobody can start
//!   a conversation with them -- and the victim is shown no error, because
//!   nothing they do fails. This is the limit that prevents a silent denial of
//!   service against a third party.
//! - **Sends, 30/s per account.** Ordinary flood protection, generous enough
//!   that a person typing never meets it.
//!
//! # Why this is written here rather than pulled in
//!
//! It is counting, not cryptography, and rule 1 governs the latter. A fixed
//! window in eighty auditable lines costs no supply chain, no licence review,
//! and no `cargo deny` exception, and a reviewer can read all of it. That trade
//! would be wrong for anything with a cryptographic claim; it is right for
//! three counters.
//!
//! # What a fixed window does and does not promise
//!
//! A fixed window permits up to `2 * max` requests across a window boundary --
//! `max` at the end of one and `max` at the start of the next. A GCRA or
//! sliding window would not. That is accepted deliberately: these limits exist
//! to stop sustained abuse, and doubling the burst for one instant does not
//! change what any of them protect. It is written down rather than left for
//! someone to discover.
//!
//! Memory is bounded by pruning, which matters more than the burst: an
//! unbounded map keyed by attacker-chosen values would be the same
//! exhaustion bug this module exists to prevent.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How many keys may accumulate before expired ones are swept.
///
/// Pruning on every call would be wasted work at rest; pruning never would let
/// an attacker with many source addresses grow the map without bound.
const PRUNE_ABOVE: usize = 4096;

/// A fixed-window counter, keyed by whatever the caller can identify.
pub struct RateLimit {
    max: u32,
    window: Duration,
    windows: Mutex<HashMap<String, Window>>,
}

struct Window {
    started: Instant,
    count: u32,
}

impl RateLimit {
    pub fn new(max: u32, window: Duration) -> Self {
        Self {
            max,
            window,
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Records a request and says whether it is allowed.
    ///
    /// A poisoned lock allows the request. The alternative -- refusing every
    /// request for the life of the process because one thread panicked while
    /// holding a counter -- turns a bug into an outage, and this is not a
    /// security boundary whose failure should be closed.
    pub fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let Ok(mut windows) = self.windows.lock() else {
            return true;
        };

        if windows.len() > PRUNE_ABOVE {
            windows.retain(|_, w| now.duration_since(w.started) < self.window);
        }

        match windows.get_mut(key) {
            Some(w) if now.duration_since(w.started) < self.window => {
                w.count += 1;
                w.count <= self.max
            }
            // Absent, or the window has rolled over.
            slot => {
                let fresh = Window {
                    started: now,
                    count: 1,
                };
                match slot {
                    Some(w) => *w = fresh,
                    None => {
                        windows.insert(key.to_string(), fresh);
                    }
                }
                true
            }
        }
    }
}

/// The limits, held in `AppState`.
///
/// Grouped by what the work costs rather than by endpoint, so a new route
/// joins an existing bucket instead of arriving unlimited. Writing a post and
/// leaving a comment are the same kind of act at different rates; asking for an
/// upload URL and asking for a download URL both end in somebody paying for
/// object storage.
pub struct Limits {
    pub auth: RateLimit,
    pub key_packages: RateLimit,
    pub send: RateLimit,
    /// Creating a post.
    pub posts: RateLimit,
    /// Leaving a comment. Looser than posting: replies come in bursts.
    pub comments: RateLimit,
    /// Minting a presigned upload or download URL.
    ///
    /// The one limit here with a bill attached. Every grant is a write or a
    /// read somebody pays Hetzner for, and unlike a post there is no row to
    /// delete afterwards to undo the cost.
    pub media: RateLimit,
    /// Reacting, voting, pinning.
    ///
    /// Generous, because these are single clicks and a person changing their
    /// mind three times is not abuse -- but bounded, because they are one
    /// scripted loop away from being the cheapest way to fill a table.
    pub reactions: RateLimit,
    /// Editing a profile, changing visibility, blocking.
    pub profile: RateLimit,
    /// Adding or removing conversation members, and a team's roles.
    pub membership: RateLimit,
    /// Starting a team.
    ///
    /// Per hour rather than per minute: nobody starts ten teams in an hour by
    /// hand, and every one is a conversation row and an owner row that stays.
    pub teams: RateLimit,
    /// Minting, listing and revoking invitations.
    pub invites: RateLimit,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            auth: RateLimit::new(10, Duration::from_secs(60)),
            key_packages: RateLimit::new(60, Duration::from_secs(60)),
            send: RateLimit::new(30, Duration::from_secs(1)),
            posts: RateLimit::new(20, Duration::from_secs(60)),
            comments: RateLimit::new(40, Duration::from_secs(60)),
            media: RateLimit::new(60, Duration::from_secs(60)),
            reactions: RateLimit::new(120, Duration::from_secs(60)),
            profile: RateLimit::new(30, Duration::from_secs(60)),
            membership: RateLimit::new(30, Duration::from_secs(60)),
            teams: RateLimit::new(10, Duration::from_secs(60 * 60)),
            invites: RateLimit::new(60, Duration::from_secs(60)),
        }
    }
}

impl Limits {
    /// Limits high enough that nothing meets them.
    ///
    /// For tests whose subject is something else. A test that shares the real
    /// counters with its neighbours fails on whichever one happens to run
    /// eleventh, which is the kind of flake that gets a limit deleted rather
    /// than fixed. The test that proves a limit *fires* builds its own.
    pub fn permissive() -> Self {
        let forever = Duration::from_secs(1);
        Self {
            auth: RateLimit::new(u32::MAX, forever),
            key_packages: RateLimit::new(u32::MAX, forever),
            send: RateLimit::new(u32::MAX, forever),
            posts: RateLimit::new(u32::MAX, forever),
            comments: RateLimit::new(u32::MAX, forever),
            media: RateLimit::new(u32::MAX, forever),
            reactions: RateLimit::new(u32::MAX, forever),
            profile: RateLimit::new(u32::MAX, forever),
            membership: RateLimit::new(u32::MAX, forever),
            teams: RateLimit::new(u32::MAX, forever),
            invites: RateLimit::new(u32::MAX, forever),
        }
    }
}

/// The client's address, as far as this server can honestly tell.
///
/// The process binds `127.0.0.1` (`main.rs`) and Caddy reverse-proxies to it
/// (`docs/OPS.md`), so the peer address is always loopback and would rate-limit
/// the entire internet as one client. `X-Forwarded-For` is what Caddy sets, and
/// it is trustworthy **only because** nothing but Caddy can reach the port: an
/// outside client cannot forge a header on a connection it cannot open.
///
/// If `NEXO_BIND` is ever changed to a public address, this becomes
/// attacker-controlled and the limit becomes bypassable by sending a different
/// header each time. That is the one change that breaks this.
pub fn client_key(headers: &axum::http::HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        // The left-most entry is the original client; the rest are proxies.
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        // No header means nothing is in front of us -- a direct connection in
        // development. One bucket is the honest answer there.
        .unwrap_or_else(|| "direct".to_string())
}

/// Refuses an auth request that is over the per-address limit.
///
/// Applied as a layer over the whole auth router in `lib::router`, where the
/// state exists -- `auth::router()` is built before `.with_state`, so it cannot
/// carry the counters itself.
///
/// A bare `429`: telling a caller how much budget is left, or which limit they
/// met, is telling an attacker how to pace themselves.
pub async fn limit_auth(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse as _;

    let key = client_key(request.headers());
    if !state.limits.auth.check(&key) {
        // Logged because a real one means somebody is trying, and the operator
        // should be able to see it without instrumenting anything first.
        tracing::warn!(%key, "auth rate limit reached");
        return (
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "Too many attempts. Wait a minute.",
        )
            .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every bucket must actually bound something.
    ///
    /// The failure this catches is not a wrong number, it is a forgotten one:
    /// a bucket added to `Limits` and wired to a handler, but left effectively
    /// infinite, reads as rate limited everywhere except where it counts. The
    /// endpoint looks protected in the router, in the handler, and in review.
    #[test]
    fn every_default_limit_is_finite_and_refuses_eventually() {
        let limits = Limits::default();
        for (name, limit) in [
            ("auth", &limits.auth),
            ("key_packages", &limits.key_packages),
            ("send", &limits.send),
            ("posts", &limits.posts),
            ("comments", &limits.comments),
            ("media", &limits.media),
            ("reactions", &limits.reactions),
            ("profile", &limits.profile),
            ("membership", &limits.membership),
            ("teams", &limits.teams),
            ("invites", &limits.invites),
        ] {
            assert!(
                limit.max < u32::MAX,
                "{name} is unbounded, so nothing it guards is limited"
            );
            assert!(
                limit.max > 0,
                "{name} refuses everything, including the first"
            );

            // And it does refuse, rather than merely holding a number.
            let key = format!("{name}-probe");
            for _ in 0..limit.max {
                assert!(limit.check(&key), "{name} refused inside its own budget");
            }
            assert!(!limit.check(&key), "{name} never refuses");
        }
    }

    #[test]
    fn the_first_requests_up_to_the_limit_are_allowed() {
        let limit = RateLimit::new(3, Duration::from_secs(60));
        assert!(limit.check("a"));
        assert!(limit.check("a"));
        assert!(limit.check("a"));
        assert!(!limit.check("a"), "the fourth is over the limit");
    }

    #[test]
    fn keys_are_counted_separately() {
        let limit = RateLimit::new(1, Duration::from_secs(60));
        assert!(limit.check("a"));
        assert!(!limit.check("a"));
        assert!(limit.check("b"), "b has its own budget");
    }

    #[test]
    fn a_window_that_has_passed_starts_again() {
        let limit = RateLimit::new(1, Duration::from_millis(20));
        assert!(limit.check("a"));
        assert!(!limit.check("a"));
        std::thread::sleep(Duration::from_millis(30));
        assert!(limit.check("a"), "a new window is a new budget");
    }

    /// The property that stops this module becoming the bug it prevents.
    #[test]
    fn expired_keys_do_not_accumulate_without_bound() {
        let limit = RateLimit::new(1, Duration::from_millis(1));
        for i in 0..(PRUNE_ABOVE + 100) {
            limit.check(&format!("key-{i}"));
        }
        std::thread::sleep(Duration::from_millis(5));
        // One more call crosses the threshold and sweeps what expired.
        limit.check("trigger");
        let held = limit.windows.lock().unwrap().len();
        assert!(
            held <= PRUNE_ABOVE + 1,
            "expired windows should be swept, held {held}"
        );
    }

    #[test]
    fn the_forwarded_client_is_preferred_over_the_proxy() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_key(&headers), "203.0.113.7");
    }

    #[test]
    fn a_direct_connection_still_has_a_key() {
        assert_eq!(client_key(&axum::http::HeaderMap::new()), "direct");
    }
}
