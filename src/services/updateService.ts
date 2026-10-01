import { ref, get } from 'firebase/database';
import { firebaseDb, firebaseConfig } from './firebaseConfig';
import { subscriptionDb, subscriptionFirebaseConfig } from './subscriptionService';

export const CURRENT_APP_VERSION = '25';

export interface AppUpdateData {
  latest_version: string;
  apk_url: string;
  changelog?: string;
  force_update?: boolean;
  release_date?: string;
  title?: string;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  updateData: AppUpdateData | null;
}

/**
 * Get the current installed version dynamically from the DOM or fallback to CURRENT_APP_VERSION (25)
 */
export function getInstalledAppVersion(): string {
  if (typeof document !== 'undefined') {
    const el = document.querySelector('.menu-version-tag');
    if (el && el.textContent) {
      const m = el.textContent.match(/Version:\s*([^\s]+)/i);
      if (m && m[1]) return m[1].replace(/^v/i, '').trim();
    }
  }
  return CURRENT_APP_VERSION;
}

/**
 * Compare versions (supports integer build numbers like 25 vs 26 as well as semver like 25.1 vs 25)
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1: string | number, v2: string | number): number {
  const clean1 = String(v1 || '').replace(/^v/i, '').trim();
  const clean2 = String(v2 || '').replace(/^v/i, '').trim();

  // If both are pure integers (e.g. 26 vs 25)
  const int1 = parseInt(clean1, 10);
  const int2 = parseInt(clean2, 10);
  if (!isNaN(int1) && !isNaN(int2) && !clean1.includes('.') && !clean2.includes('.')) {
    if (int1 > int2) return 1;
    if (int1 < int2) return -1;
    return 0;
  }

  const parts1 = clean1.split('.').map(p => parseInt(p, 10) || 0);
  const parts2 = clean2.split('.').map(p => parseInt(p, 10) || 0);

  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * Check Firebase Realtime Database for app updates
 * Checks both Firebase JS SDK and direct REST endpoint fallback
 */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  let remoteData: any = null;

  // 1. First attempt: Direct Firebase RTDB REST API from all possible Firebase database instances
  const candidateUrls = [
    `${subscriptionFirebaseConfig.databaseURL}/app_update.json`,
    `${subscriptionFirebaseConfig.databaseURL}/update.json`,
    `${subscriptionFirebaseConfig.databaseURL}/.json`,
    `${firebaseConfig.databaseURL}/app_update.json`,
    `${firebaseConfig.databaseURL}/update.json`,
    `${firebaseConfig.databaseURL}/.json`
  ];

  for (const url of candidateUrls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        cache: 'no-store'
      });
      if (response.ok) {
        const json = await response.json();
        if (json) {
          if (json.version || json.latest_version || json.latestVersion) {
            remoteData = json;
            break;
          } else if (json.app_update) {
            remoteData = json.app_update;
            break;
          } else if (json.update) {
            remoteData = json.update;
            break;
          }
        }
      }
    } catch (err) {
      // Continue to next
    }
  }

  // 2. Second attempt: Firebase SDK get() on both databases
  if (!remoteData) {
    const dbs = [subscriptionDb, firebaseDb];
    for (const dbInstance of dbs) {
      try {
        const updateRef = ref(dbInstance, 'app_update');
        const snapshot = await get(updateRef);
        if (snapshot.exists()) {
          remoteData = snapshot.val();
          break;
        }
      } catch (err) {
        // continue
      }
    }
  }

  // 3. Evaluate if update exists
  if (remoteData) {
    const rawVersion = remoteData.latest_version || remoteData.version || remoteData.latestVersion || remoteData.app_version;
    const latestVersion = rawVersion ? String(rawVersion).trim() : null;
    const apkUrl = remoteData.apk_url || remoteData.apkUrl || remoteData.download_url || remoteData.url || "https://vdoskay.blogspot.com";
    const currentVer = getInstalledAppVersion();

    if (latestVersion) {
      const isNewer = compareVersions(latestVersion, currentVer) > 0 || (latestVersion !== currentVer && compareVersions(latestVersion, currentVer) >= 0);
      return {
        hasUpdate: isNewer,
        currentVersion: currentVer,
        updateData: {
          latest_version: latestVersion,
          apk_url: apkUrl,
          changelog: remoteData.changelog || remoteData.notes || remoteData.description || 'New version is available with performance improvements and bug fixes.',
          force_update: Boolean(remoteData.force_update ?? remoteData.forceUpdate ?? true),
          release_date: remoteData.release_date || remoteData.releaseDate,
          title: remoteData.title || 'Please Update App'
        }
      };
    }
  }

  return {
    hasUpdate: false,
    currentVersion: CURRENT_APP_VERSION,
    updateData: null
  };
}

/**
 * Open update link directly in Google Chrome app (or external browser)
 */
export function openUpdateInChrome(url?: string): boolean {
  const targetUrl = url || "https://vdoskay.blogspot.com";
  console.log('[UpdateService] Opening update link in Chrome:', targetUrl);

  // 1. Android Native JavascriptInterface (explicitly Chrome via intent or fallback)
  if ((window as any).Android) {
    const a = (window as any).Android;
    if (typeof a.openInChrome === 'function') {
      try { a.openInChrome(targetUrl); return true; } catch (e) { console.warn(e); }
    }
    if (typeof a.openChromeDirectly === 'function') {
      try { a.openChromeDirectly(targetUrl); return true; } catch (e) { console.warn(e); }
    }
    if (typeof a.openUrl === 'function') {
      try { a.openUrl(targetUrl); return true; } catch (e) { console.warn(e); }
    }
    if (typeof a.openExternalUrl === 'function') {
      try { a.openExternalUrl(targetUrl); return true; } catch (e) { console.warn(e); }
    }
  }

  // 2. Window-level helper if present
  if (typeof (window as any).openInChrome === 'function') {
    try {
      (window as any).openInChrome(targetUrl);
      return true;
    } catch (e) {
      console.warn(e);
    }
  }

  // 3. Android Intent for Google Chrome (com.android.chrome)
  const isAndroid = /Android/i.test(navigator.userAgent);
  if (isAndroid) {
    try {
      const clean = targetUrl.replace(/^https?:\/\//, '');
      window.location.href = `intent://${clean}#Intent;scheme=https;package=com.android.chrome;end`;
      return true;
    } catch (e) {
      console.warn(e);
    }
  }

  // 4. Standard new tab / window navigation fallback
  try {
    const win = window.open(targetUrl, '_blank', 'noopener,noreferrer');
    if (!win) {
      window.location.href = targetUrl;
    }
  } catch (e) {
    window.location.href = targetUrl;
  }

  return true;
}

/**
 * Backward compatibility alias for triggerApkInstall
 */
export function triggerApkInstall(apkUrl: string, fileName?: string): boolean {
  return openUpdateInChrome(apkUrl);
}
