# Preview image notices

The images run these unmodified programs as separate processes:

| Program | License | Corresponding source |
| --- | --- | --- |
| TigerVNC | GPL-2.0 | https://github.com/TigerVNC/tigervnc |
| websockify | LGPL-3.0 | https://github.com/novnc/websockify |
| Openbox | GPL-2.0 | http://openbox.org/ |
| xdotool | BSD-3-Clause | https://github.com/jordansissel/xdotool |
| wmctrl | GPL-2.0 | https://salsa.debian.org/debian/wmctrl |
| ImageMagick | ImageMagick | https://imagemagick.org/script/license.php |

Each release must include the Debian copyright files under
`/usr/share/doc/*/copyright`, the installed package/version inventory and the
corresponding Debian source archives alongside the OCI image. The release workflow
exports those archives as a downloadable release artifact. Retain that artifact
for as long as the image is distributed; the source code offer is not satisfied
by a link to an upstream branch. Blame's helper is AGPL-3.0-only.

GUI Node adds Node.js (MIT) and distribution runtime libraries. GUI Tauri adds
Rust (MIT/Apache-2.0). The package inventory and source archive cover distribution
libraries as well. noVNC is MPL-2.0 and is distributed through the app's package
dependencies; its upstream license remains in the package.
