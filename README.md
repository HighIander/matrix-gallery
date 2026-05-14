# Matrix Gallery v0.31.0

This extension changes the way images are uploaded and displayed by Matrix, in order to mimick the feeling of Mattermost and other chat tools that allow upload of multiple images at once. 

You can drag/drop, paste or select images from disc and even optionally give individual image captions. The extension injects a "+" button at the lower right in matrix messenger in the webbrowser to open the image upload dialog. Uploaded images are rendered in the messege view as gallery in one line instead of individual messages underneath. Clicking on an image allows browsing through this gallery and displays the optional image captions. 

Use the option to install as web app from the browser adress bar instead of using a desktop app in order to use the functionality even in an app-like look and feel.

Licence: None (use as you like). No liability is taken by the author!

## Installation

0. Download into a directory on your computer, e.g. to [downloads/matrix-gallery]

### Chrome / Edge installation
1. Open:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Enable Developer Mode.
3. Click "Load unpacked".
4. Select the extracted extension folder, e.g. [downloads/matrix-gallery]

### Firefox installation [not tested!]
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from the extracted folder, e.g. [downloads/matrix-gallery/manifest.json]

## Compatibility

* If the extension is not present/not installed/unistalled (e.g. for your chat partners not using the extension, or on mobile devices), then the images are just displayed one after the other as is default in matrix. The image captions are accessible in the image view: raw view.
