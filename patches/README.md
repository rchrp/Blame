# Electron Builder macOS signing

The temporary keychain password fix is included upstream in electron-builder 26.18.0, so the former `app-builder-lib@26.8.1` backport is no longer needed. `node --test scripts/macos-signing.test.mjs` still exercises the installed implementation with distinct certificate and keychain passwords.
