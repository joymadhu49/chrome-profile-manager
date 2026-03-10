# Chrome Profile Manager

A desktop application built with Electron that lets you manage and launch multiple Google Chrome profiles simultaneously, tiled side-by-side on your screen.

## Download

**[Download the latest release](https://github.com/joymadhu49/chrome-profile-manager/releases/latest)**

| File | Description |
|------|-------------|
| **ChromeProfileManager.exe** | Portable — just download and run, no installation needed |
| **Chrome Profile Manager Setup 1.0.0.exe** | Windows installer with Start Menu shortcut |

> **Note:** Windows SmartScreen may show a warning on first launch since the app is not code-signed. Click **"More info"** then **"Run anyway"** to proceed.

## Features

- **Multi-profile launch** - Select any combination of Chrome profiles and launch them all at once
- **Auto-tiling** - Chrome windows are automatically arranged in a grid layout across your screen
- **Workspaces** - Save profile selections as named workspaces for quick re-use
- **URL broadcast** - Open the same URL across all selected profiles simultaneously
- **Quick links** - Save frequently used URLs for one-click access
- **Live status** - See which profiles are currently running in real time
- **Profile pictures** - Displays your Chrome profile photos and emails
- **Re-tile** - Rearrange running Chrome windows at any time
- **Shift-click** - Select a range of profiles quickly

## Requirements

- **Windows 10 or 11**
- **Google Chrome** installed in a standard location

## For Developers

If you want to modify the source code or build from source, you'll also need **Node.js 18+** and **npm 9+**.

### 1. Clone the repository

```bash
git clone https://github.com/joymadhu49/chrome-profile-manager.git
cd chrome-profile-manager
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run in development mode

```bash
npm start
```

This launches the Electron app. Your Chrome profiles are detected automatically from Chrome's `Local State` file.

## Building for Production

### Portable executable (single .exe, no installer)

```bash
npm run build
```

Output: `dist/ChromeProfileManager.exe`

### Windows installer (NSIS)

```bash
npm run build-installer
```

Output: `dist/Chrome Profile Manager Setup <version>.exe`

## Project Structure

```
chrome-profile-manager/
  main.js          # Electron main process
  preload.js       # Secure bridge between main and renderer
  index.html       # UI (single-page app, no framework)
  package.json     # Dependencies and build configuration
```

### Data Storage

All user data is stored in `%APPDATA%/chrome-profile-manager/`:

| File | Purpose |
|------|---------|
| `runtime-data/workspaces.json` | Saved workspaces |
| `runtime-data/custom-links.json` | Quick links |

No data is stored inside the project directory at runtime.

## Custom App Icon

To add your own app icon, place an `icon.png` file (minimum 256x256, recommended 512x512) in a `build/` folder at the project root:

```
chrome-profile-manager/
  build/
    icon.png
```

The build system will automatically pick it up.

## How It Works

1. The app reads Chrome's `Local State` file to discover all profiles
2. When you click **Launch**, it spawns Chrome with `--profile-directory` flags
3. Windows are positioned using the Windows DWM API via PowerShell for pixel-perfect tiling
4. A file watcher + polling detects when profiles are added/removed from Chrome

## License

ISC
