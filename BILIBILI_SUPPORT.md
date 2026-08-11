# Bilibili casting MVP

This patch adds a page-level `Cast Bilibili video...` command for public
`/video/BV...` pages. The extension resolves the current page CID, requests a
progressive stream, then asks the native bridge to expose that stream through a
Bilibili-CDN-only HTTP proxy with Range and HEAD support.

## Deliberate limits

- Regular BV video pages only; bangumi/course pages are not included.
- Uses Bilibili progressive output, not separated DASH audio/video.
- Does not bypass login, paid-content, DRM, or platform access controls.
- The extension and bridge must both be rebuilt and installed because the
  Native Messaging protocol gains `bridge:startRemoteMediaServer`.

## macOS build

Run the project's normal dependency installation and package commands on the
Mac that will install the bridge. The bridge contains a native DNS-SD module,
so it must be built for the target macOS architecture.
