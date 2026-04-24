# Sentry Error Reporting Setup

## Overview

This document describes the Sentry SDK integration for the Unstream web app.

## Configuration

Sentry is configured via environment variables (not hardcoded):

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_SENTRY_DSN` | Sentry Data Source Name | `https://x@o000000.ingest.sentry.io/000000` |
| `VITE_SENTRY_ENV` | Environment name | `development`, `staging`, `production` |
| `VITE_APP_VERSION` | App version | `1.0.0` |

Optional (for source map upload during build):
| Variable | Description |
|----------|-------------|
| `SENTRY_ORG` | Sentry organization slug |
| `SENTRY_PROJECT` | Sentry project name (default: `unstream-web`) |
| `SENTRY_AUTH_TOKEN` | Sentry auth token for uploads |

## How It Works

1. **Initialization**: Sentry is initialized in `src/main.tsx` via `initSentry()`
2. **Environment-aware**: Configuration is read from `import.meta.env`
3. **Development-safe**: Errors in development mode are NOT sent to Sentry
4. **Automatic tracking**: Unhandled exceptions are captured automatically

## Usage

### Enable Sentry

1. Create a `.env.local` file in `apps/web/`:
   ```
   VITE_SENTRY_DSN=your-dsn-here
   VITE_SENTRY_ENV=production
   VITE_APP_VERSION=1.0.0
   SENTRY_ORG=your-org
   SENTRY_PROJECT=unstream-web
   SENTRY_AUTH_TOKEN=your-token
   ```

2. Rebuild the app - Sentry will be initialized and source maps uploaded automatically

### Testing

To verify Sentry is working in development:

```typescript
import { captureTestError } from './services/sentry'

// Trigger a test error (only in dev)
captureTestError()
```

## Non-goals (as per spec)

- Performance monitoring (tracing disabled by default)
- Session replay
- Alert routing
- Release health automation

## Future Enhancements

- Add performance monitoring (enable tracesSampleRate)
- Implement session replay
- Add custom user context (authenticated user info)
- Implement release health automation
