---
status: Done
---
# supabase-swift Compatibility Research (UNS-92)

**Date:** 2026-06-08
**Author:** Katy
**For:** UNS-61 (Cross-client auth), Phase 3

## TL;DR

Pin `supabase-swift` at **v2.44.1** (not the latest v2.46.0). The v2.44.0 release introduced Realtime protocol 2.0.0 (binary broadcast frames) that aligns with Supabase server 10.x, and v2.44.1 patched a critical connection-lifecycle race in that very code. Versions after 2.44.1 add only cosmetic features (custom JSON encoders, PostgREST null stripping) and don't carry anything we need yet. The SDK includes built-in Keychain storage for refresh tokens — no manual wiring required.

## Current Unstream Stack

- **Supabase server:** 10.x (per UNS-90 alignment; Supabase Cloud hosted, self-host config not in repo)
- **Supabase JS client:** `@supabase/supabase-js` ^2.99.1 (web app)
- **Sentry SDK:** `@sentry/react` ^10.56.0 / `@sentry/node` ^10.56.0 (web only)
- **Mac/iOS app:** `~/projects/unstream/apps/mac/Unstream.xcodeproj/project.pbxproj` — **no SPM dependencies currently** (no Sentry, no Supabase, no third-party packages at all)
- **Mac app auth pattern:** Custom `KeychainHelper` (Security framework, direct `SecItemAdd`/`SecItemCopyMatching`) for credential storage; `UnstreamAPI` actor with raw `URLSession` calls to `/api/` endpoints
- **Web AuthContext reference:** `~/projects/unstream/apps/web/src/contexts/AuthContext.tsx` — uses `supabase.auth.onAuthStateChange`, `signInWithOtp`, `signInWithPassword`, `getSession`, `signOut`

## supabase-swift Version Analysis

### Latest stable

| Version | Date | Key changes |
|---------|------|-------------|
| **v2.46.0** | 2026-04-29 | Custom JSON encoder/decoder for Functions |
| **v2.45.0** | 2026-04-27 | PostgREST `stripNulls` method |
| **v2.44.1** | 2026-04-23 | **Realtime: fix connection lifecycle races** (critical patch) |
| **v2.44.0** | 2026-04-22 | **Realtime: protocol 2.0.0 + binary broadcast frames** |
| **v2.43.1** | 2026-04-07 | Functions import fix |
| **v2.43.0** | 2026-03-24 | Storage improvements |
| **v2.42.0** | 2026-03-19 | Storage `setHeader` method |
| **v2.41.1** | 2026-02-06 | Bug fixes |
| **v2.41.0** | 2026-01-28 | Features + fixes |

The 2.x line has been the stable major since 2024. Breaking changes would come in a hypothetical 3.x. All 2.x versions are protocol-compatible with Supabase server 10.x (which speaks PostgREST v12+ / Realtime v2).

### Server protocol compatibility

**Compatible ✅.** `supabase-swift` 2.x targets the same REST/Realtime/WebSocket protocols as `supabase-js` 2.x. The Supabase server 10.x exposes a protocol-stable API surface — the Swift SDK communicates via HTTP (PostgREST, GoTrue, Storage, Functions) and WebSocket (Realtime), all of which are versioned server-side independently of the server release number.

Key detail: v2.44.0 added **Realtime protocol 2.0.0 support with binary broadcast frames**. Supabase server 10.x defaults to Realtime v2, so this is the version where Swift realtime became first-class compatible with our server. Prior versions (2.43.x and below) used the older Realtime v1 Phoenix channel protocol, which still works but won't get binary frame performance benefits.

### Sentry compatibility

**No conflicts ✅ — because Sentry isn't in the Mac/iOS app yet.**

The Unstream Mac/iOS project currently has **zero SPM dependencies**. The `project.pbxproj` has empty `packageProductDependencies` arrays and no `XCRemoteSwiftPackageReference` entries. There is no Sentry Swift SDK integrated.

On the web side, `@sentry/react` ^10.56.0 coexists fine with `@supabase/supabase-js` ^2.99.1 — the web `AuthContext.tsx` even calls `Sentry.captureMessage` / `Sentry.captureException` inside Supabase auth callbacks. No networking or telemetry conflicts.

When Daryl adds the Sentry Swift SDK to the Mac/iOS project, the same pattern will work: `supabase-swift` uses standard `URLSession` for HTTP calls and native WebSocket for Realtime. Sentry's Swift SDK hooks into `URLSession` via `URLSessionTaskDelegate` swizzling for automatic HTTP breadcrumbs, but this is non-invasive — it only observes/traces, doesn't modify requests. No known conflicts between Sentry Swift and supabase-swift.

**Recommendation:** Use Sentry's `beforeSend` callback to filter Supabase Realtime WebSocket noise (disconnect/reconnect events) to avoid flooding error quotas — same pattern the web app already uses.

### Realtime channel stability

**Stable at v2.44.1 ✅.**

The `supabase-swift` Realtime API provides:

```swift
let channel = client.realtimeV2.channel("saved-artists-changes")
let subscription = channel.onPostgresChange(
    .insert, schema: "public", table: "saved_artists"
) { payload in
    // handle new/changed artist
}
channel.subscribe()
```

Timeline:
- **v2.44.0** — Introduced Realtime protocol 2.0.0 with binary broadcast frames. This is the version that properly supports Supabase server 10.x's Realtime v2.
- **v2.44.1** — **Critical patch**: Extracted `ConnectionManager` as an actor and fixed connection lifecycle races. Without this patch, Realtime channels could deadlock or silently drop under poor network conditions.
- **v2.45.0, v2.46.0** — No Realtime changes. Only PostgREST and Functions improvements.

**This is why v2.44.1 is the sweet spot** — it has the stable Realtime v2 support with the critical lifecycle fix, and nothing since has touched Realtime.

For `saved_artists` table live sync, the `onPostgresChange` API supports `INSERT`, `UPDATE`, `DELETE` filters. We'd subscribe to all three on `saved_artists` filtered by `user_id` to sync a single user's saves across web + Mac + iOS clients.

### Keychain integration

**Built-in ✅ — no manual wiring required.**

The SDK ships `KeychainLocalStorage` in `Sources/Auth/Storage/KeychainLocalStorage.swift`:

```swift
public struct KeychainLocalStorage: AuthLocalStorage {
    public init(service: String? = "supabase.gotrue.swift", accessGroup: String? = nil)
    public func store(key: String, value: Data) throws
    public func retrieve(key: String) throws -> Data?
    public func remove(key: String) throws
}
```

**This is the default storage on iOS/macOS.** When you create a `SupabaseClient` without specifying custom options, it automatically uses `KeychainLocalStorage` for persisting refresh tokens and session data. The SDK handles:

- Storing session (access token + refresh token) on sign-in
- Auto-refreshing tokens using the stored refresh token
- Removing session on sign-out

**Important note for Unstream:** The existing `KeychainHelper` in the Mac app uses service name `lol.bgreen.Unstream`. The supabase-swift default is `supabase.gotrue.swift`. Daryl should configure the SDK with a custom service name for consistency, and plan a one-time migration of any existing auth tokens from `KeychainHelper` to the SDK's storage:

```swift
let client = SupabaseClient(
    supabaseURL: URL(string: supabaseURL)!,
    supabaseKey: anonKey,
    options: .init(
        auth: .init(
            storage: KeychainLocalStorage(service: "lol.bgreen.Unstream")
        )
    )
)
```

This way the SDK's auth session lives in the same keychain service the app already uses, and the existing `KeychainHelper` can be gradually deprecated for auth-related keys.

## Recommendation

**Pin `supabase-swift` at v2.44.1.**

| Version | Verdict | Reason |
|---------|---------|--------|
| v2.46.0 | ❌ Skip | No Realtime changes; only adds custom JSON encoder for Functions (we don't need) |
| v2.45.0 | ❌ Skip | Only PostgREST `stripNulls` (we don't need) |
| **v2.44.1** | **✅ Pin** | Stable Realtime v2 + critical lifecycle race fix |
| v2.44.0 | ❌ Avoid | Has Realtime v2 but buggy connection lifecycle |
| ≤ v2.43.x | ❌ Avoid | No Realtime protocol 2.0 support |

Once v2.44.1 proves stable in the wild for a few months and a subsequent patch release adds more Realtime hardening, we can bump. But for Phase 3 integration, v2.44.1 is the safest pin.

## Risks

1. **Realtime v2 is new (April 2026).** The binary broadcast frame support is only ~6 weeks old. While v2.44.1 fixed the known lifecycle race, there may be edge cases under spotty network conditions (e.g., iOS on cellular). **Mitigation:** Add exponential backoff + retry logic in the subscription layer; add Sentry breadcrumbs for Realtime disconnect/reconnect events.

2. **No Sentry in Mac/iOS yet.** Adding two major SPM dependencies (supabase-swift + sentry-cocoa) at once increases integration surface. **Mitigation:** Add supabase-swift first, verify auth + realtime work, then add Sentry as a separate commit.

3. **Keychain service name mismatch.** The existing `KeychainHelper` uses `lol.bgreen.Unstream`; the SDK defaults to `supabase.gotrue.swift`. If not configured, tokens end up in the wrong keychain service. **Mitigation:** Pass custom `KeychainLocalStorage(service: "lol.bgreen.Unstream")` on init.

4. **Share extension keychain access.** The UnstreamShareExtension (iOS) runs in a separate process. Keychain items stored by the main app won't be accessible unless an **access group** is configured. **Mitigation:** Use `KeychainLocalStorage(service: "lol.bgreen.Unstream", accessGroup: "group.bgreen.Unstream")` and enable keychain sharing in both targets' entitlements.

5. **supabase-js ^2.99.1 vs supabase-swift 2.44.1 protocol drift.** Unlikely but possible: if the JS SDK gets a minor protocol tweak that the Swift SDK hasn't adopted yet, auth session behavior could diverge. **Mitigation:** Pin both SDKs to known-compatible versions; test cross-client auth flows (sign in on web → session valid on Mac) before shipping.

## Integration effort for Daryl

**Estimated: ~150–200 lines of new code**, broken down as:

| Task | Lines | Notes |
|------|-------|-------|
| Add SPM dependency to Xcode project | ~5 | `.package(url: "https://github.com/supabase/supabase-swift.git", from: "2.44.1")` |
| `SupabaseClient` singleton / config | ~30 | URL + anon key from env/Info.plist, custom keychain service |
| Auth service wrapper | ~60 | Mirror web `AuthContext` API: `signInWithOtp`, `signInWithPassword`, `signOut`, `getSession`, `onAuthStateChange` |
| Saved artists realtime subscription | ~40 | Channel subscription for `saved_artists` Postgres changes, filtered by `user_id` |
| Keychain migration (existing tokens → SDK) | ~25 | One-time check in `KeychainHelper`, move any `supabase.auth.*` keys |
| Sentry integration (deferred) | ~20 | `beforeSend` filter for Realtime noise |

**Gotchas to expect:**

- The Xcode project currently has no SPM packages — adding the first one triggers Xcode's package resolution, which can be slow (supabase-swift pulls in ~6 transitive deps). Plan for a full build cycle after adding.
- `supabase-swift` uses Swift async/await throughout. The existing `UnstreamAPI` actor pattern is compatible, but Daryl will need to bridge between the SDK's `AuthClient` async methods and any SwiftUI `@Observable` / `@StateObject` patterns.
- Realtime subscriptions need to be torn down on sign-out. The SDK's `channel.unsubscribe()` is explicit — forgetting to call it leaves zombie WebSocket connections.
- The `saved_artists` table (migration-013/014) has RLS policies. Realtime broadcasts only respect RLS if the channel is created with the user's auth token. Daryl must create the channel **after** auth is confirmed, not at app launch.
---

## Verification notes (Wayne, post-research, 2026-06-08)

Spot-checked Katy's findings against the live repo and GitHub:

- **v2.44.1 / v2.45.0 / v2.46.0 release dates confirmed** via `api.github.com/repos/supabase/supabase-swift/releases`.
- **Mac app has zero actual SPM packages** — the pbxproj has empty `packageProductDependencies = ();` arrays for both `Unstream` and `UnstreamShareExtension` targets. Katy's "zero SPM deps" claim is correct; the "2 SPM references" earlier in the report was misleading wording on my part. Adding `supabase-swift` will be the first package — first SPM build is slow, plan accordingly.
- **Keychain access group already configured** on both targets as `group.lol.bgreen.unstream` (verified in `apps/mac/Unstream/Unstream-macOS.entitlements`, `apps/mac/Unstream/Unstream-iOS.entitlements`, and `apps/mac/UnstreamShareExtension/ShareExtension.entitlements`). The "blocker" Katy flagged is already handled — Daryl just needs to point `KeychainLocalStorage` at the existing group, not add new entitlements.
- **Existing `KeychainHelper` service name confirmed** as `lol.bgreen.Unstream` (in `apps/mac/Unstream/Services/KeychainHelper.swift`). Katy's config recommendation is correct.

**Net effect on Daryl's Phase 3 work:** slightly *easier* than the report implied — no new entitlements to add, just wire `KeychainLocalStorage(service: "lol.bgreen.Unstream", accessGroup: "group.lol.bgreen.unstream")` to match the existing setup.
