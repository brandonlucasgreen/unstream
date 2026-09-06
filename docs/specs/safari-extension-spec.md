---
status: Idea
---
# Safari Extension Scoping Analysis

## Key Insight: Safari Extensions MUST Be Bundled with a Mac App

Unlike Chrome/Firefox, Safari extensions cannot be distributed standalone. They **require a container Mac app** to be distributed. This is enforced by Apple.

---

## Distribution Options

### Option A: Separate Safari Extension App (Simpler)

Create a standalone "Unstream for Safari" app that contains only the Safari extension.

**How it works:**
```bash
xcrun safari-web-extension-converter /path/to/chrome-extension \
  --project-location safari-extension \
  --app-name "Unstream for Safari" \
  --bundle-identifier com.brandonlucasgreen.unstream.safari \
  --swift
```

**Pros:**
- Simplest conversion path - Apple's converter handles most of it
- Your Chrome extension already uses Manifest V3 (Safari 15.4+ compatible)
- Independent release cycle from Mac menubar app
- Can distribute via Mac App Store OR notarized direct download

**Cons:**
- Users install two separate apps (menubar app + Safari extension app)
- Two separate codebases to maintain
- Potentially confusing user experience

---

### Option B: Bundle Safari Extension WITH Existing Mac App (Recommended)

Add the Safari extension as an extension target within your existing UnstreamMenubar Xcode project.

**How it works:**
1. Convert Chrome extension to generate Safari extension files
2. Add a "Safari Web Extension" target to UnstreamMenubar.xcodeproj
3. Share the extension resources between targets
4. Release single app that includes both menubar functionality AND Safari extension

**Pros:**
- **Single app install** - users get everything in one package
- Shared license validation (Yearly Pass works for both)
- Unified preferences/saved artists (via App Groups)
- Better user experience
- Single Mac App Store listing

**Cons:**
- More complex initial setup
- Mac App Store has stricter review (sandboxing requirements)
- Your current app uses features that may conflict with App Store sandboxing

---

### Option C: Mac App Store Bundle (Two Apps, One Purchase)

Create the Safari extension as a separate app, but sell both as an App Store "bundle."

**Pros:**
- Separate codebases but unified purchase
- Easier to manage release cycles independently

**Cons:**
- Still two separate installs
- Bundle pricing complexity

---

## Technical Compatibility Assessment

Your Chrome extension is **highly compatible** with Safari:

| Feature | Chrome Extension | Safari Support |
|---------|-----------------|----------------|
| Manifest V3 | ✅ Yes | ✅ Safari 15.4+ |
| Service Worker | ✅ Yes | ✅ Supported |
| Content Scripts | ✅ Yes | ✅ Supported |
| `chrome.storage` | ✅ Yes | ✅ (`browser.storage`) |
| `chrome.alarms` | ✅ Yes | ✅ Supported |
| `chrome.notifications` | ✅ Yes | ⚠️ Limited (use native) |
| Host permissions | ✅ Yes | ✅ Supported |

**Main code changes needed:**
1. Replace `chrome.*` APIs with `browser.*` (or use a polyfill)
2. Notifications may need native macOS integration instead of web notifications
3. Minor manifest adjustments for Safari-specific fields

---

## Mac App Store Considerations

If you bundle with the Mac app and release on Mac App Store:

**Sandboxing Requirements:**
- Your current app uses AppleScript to detect music (allowed with entitlement)
- Network access for API calls (allowed)
- User Notifications (allowed)
- iCloud for sync (allowed)

**Potential Issues:**
- App Sandbox is **required** for Mac App Store
- You'd need to audit current entitlements
- Some features may need adjustment

**Alternative: Notarized Direct Distribution**
- Keep distributing via GitHub/website (like now)
- Still requires the extension to be in a container app
- More flexibility, less App Store friction

---

## Recommended Approach

### Phase 1: Create Bundled App (Option B)

1. **Convert extension:**
   ```bash
   xcrun safari-web-extension-converter ./chrome-extension \
     --project-location ./safari-extension-temp \
     --app-name "Unstream Safari" \
     --bundle-identifier com.brandonlucasgreen.unstream.safari \
     --swift --copy-resources
   ```

2. **Extract extension target** from generated project and add to UnstreamMenubar.xcodeproj

3. **Share resources:**
   - License validation
   - Saved artists (via App Groups)
   - API client code

4. **Adapt for Safari:**
   - Use `browser.*` API namespace
   - Handle Safari-specific quirks

### Phase 2: Distribution Decision

- **Start with notarized direct distribution** (like current Mac app)
- **Later consider Mac App Store** if demand warrants the extra review friction

---

## Effort Estimate

| Task | Complexity |
|------|------------|
| Convert Chrome extension to Safari format | Low (automated) |
| Adapt code for `browser.*` API | Low (find/replace + testing) |
| Add extension target to existing Xcode project | Medium |
| Share data between app and extension (App Groups) | Medium |
| Test on Safari | Medium |
| Notarize bundled app | Low (existing process) |
| Mac App Store submission (if desired) | Medium-High (sandbox audit) |

**Total estimate:** 2-4 days of development work for a notarized direct distribution release.

---

## Questions to Decide

1. **Distribution method:** Mac App Store or notarized direct download?
2. **Data sharing:** Should Safari extension share saved artists/license with menubar app?
3. **Scope:** Full feature parity with Chrome, or start with core features only?

---

## References

- [Safari Extensions - Apple Developer](https://developer.apple.com/safari/extensions/)
- [Converting Chrome Extensions to Safari](https://gist.github.com/rxliuli/940584d75f55de3a4e9e2c5682bbcae8)
- [Packaging a web extension for Safari](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- [How to convert existing web extensions for Safari](https://developer.apple.com/news/?id=qiz0arxc)
