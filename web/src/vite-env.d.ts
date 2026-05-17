/// <reference types="vite/client" />

interface BridgeDesktopPreferences {
  available: boolean;
  platform: string;
  version?: string;
  launchAtLogin: boolean;
  closeToTray: boolean;
  hideDockIcon: boolean;
  daemonPort: string;
  daemonUrl?: string;
}

interface BridgeDesktopDaemonStatus {
  running: boolean;
  stoppedByUser: boolean;
  port: string;
  url: string;
}

interface BridgeDesktopAppInfo {
  version: string;
  repo: string;
  releaseUrl: string;
}

interface BridgeDesktopUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  error?: string;
  message?: string;
}

interface Window {
  bridgeDesktop?: {
    platform: string;
    getPreferences: () => Promise<BridgeDesktopPreferences>;
    setPreferences: (patch: Partial<BridgeDesktopPreferences>) => Promise<BridgeDesktopPreferences>;
    getDaemonStatus: () => Promise<BridgeDesktopDaemonStatus>;
    startDaemon: () => Promise<BridgeDesktopDaemonStatus>;
    stopDaemon: () => Promise<BridgeDesktopDaemonStatus>;
    restartDaemon: () => Promise<BridgeDesktopDaemonStatus>;
    getAppInfo: () => Promise<BridgeDesktopAppInfo>;
    checkUpdates: () => Promise<BridgeDesktopUpdateInfo>;
    openUpdatePage: (url?: string) => Promise<void>;
    openPrivacySettings: () => Promise<{ opened: boolean; target: string }>;
    chooseProjectFolder: () => Promise<{ path: string } | null>;
    resizeWindow: (height: number) => Promise<boolean>;
  };
}
