// Utility to communicate directly with Android APK Start.io Native SDK
// Supports WebView, Website 2 APK Builder, Capacitor, Cordova, and Custom Android Interfaces

export const START_IO_APP_ID = '203877183';

declare global {
  interface Window {
    Android?: {
      showInterstitial?: () => void;
      showBanner?: () => void;
      showRewardedVideo?: () => void;
      trackImpression?: (adId: string) => void;
      trackClick?: (adId: string) => void;
      [key: string]: any;
    };
    StartApp?: {
      showInterstitial?: () => void;
      showBanner?: () => void;
      showRewardedVideo?: () => void;
      [key: string]: any;
    };
    startApp?: any;
    Website2APK?: {
      showInterstitial?: () => void;
      showBanner?: () => void;
      [key: string]: any;
    };
    showInterstitial?: () => void;
    showBanner?: () => void;
    showRewardedVideo?: () => void;
    onAndroidRewardedVideoCompleted?: () => void;
  }
}

/**
 * Check if the application is currently running inside the native Android APK environment
 */
export function isNativeAndroidApk(): boolean {
  return typeof window !== 'undefined' && Boolean(
    (window.Android && typeof window.Android.showRewardedVideo === 'function') ||
    (window.StartApp && typeof window.StartApp.showRewardedVideo === 'function') ||
    (window.Website2APK && typeof window.Website2APK.showRewardedVideo === 'function') ||
    typeof window.showRewardedVideo === 'function'
  );
}

/**
 * Trigger Android Native Start.io Rewarded Video Ad
 */
export function triggerNativeStartIoRewardedVideo(onRewardGranted?: () => void): boolean {
  try {
    if (typeof window !== 'undefined') {
      const win = window as any;
      if (win.Android && typeof win.Android.showRewardedVideoAd === 'function') {
        win.Android.showRewardedVideoAd();
        if (onRewardGranted) onRewardGranted();
        return true;
      }
      if (win.Android && typeof win.Android.showRewardedVideo === 'function') {
        win.Android.showRewardedVideo();
        if (onRewardGranted) onRewardGranted();
        return true;
      }
      if (win.StartApp && typeof win.StartApp.showRewardedVideo === 'function') {
        win.StartApp.showRewardedVideo();
        if (onRewardGranted) onRewardGranted();
        return true;
      }
    }
  } catch (e) {
    console.warn('[Start.io] Rewarded video bridge error:', e);
  }
  if (onRewardGranted) {
    onRewardGranted();
  }
  return false;
}

/**
 * Trigger Android Native Start.io Interstitial Ad
 */
export function triggerNativeStartIoInterstitial(): boolean {
  try {
    if (typeof window !== 'undefined') {
      const win = window as any;
      if (win.Android && typeof win.Android.showInterstitialAd === 'function') {
        win.Android.showInterstitialAd();
        return true;
      }
      if (win.Android && typeof win.Android.showInterstitial === 'function') {
        win.Android.showInterstitial();
        return true;
      }
      if (win.StartApp && typeof win.StartApp.showInterstitial === 'function') {
        win.StartApp.showInterstitial();
        return true;
      }
    }
  } catch (e) {
    console.warn('[Start.io] Interstitial bridge error:', e);
  }
  return false;
}

/**
 * Trigger Android Native Start.io Banner Ad
 */
export function triggerNativeStartIoBanner(): boolean {
  try {
    if (typeof window !== 'undefined') {
      const win = window as any;
      if (win.Android && typeof win.Android.showBanner === 'function') {
        win.Android.showBanner();
        return true;
      }
      if (win.StartApp && typeof win.StartApp.showBanner === 'function') {
        win.StartApp.showBanner();
        return true;
      }
    }
  } catch (e) {
    console.warn('[Start.io] Banner bridge error:', e);
  }
  return false;
}

/**
 * Signal Native Android Click/Impression Tracking to Native Start.io SDK
 */
export function reportStartIoInteraction(type: 'impression' | 'click', adId: string = 'general') {
  try {
    if (window.Android) {
      if (type === 'impression' && typeof window.Android.trackImpression === 'function') {
        window.Android.trackImpression(adId);
      } else if (type === 'click' && typeof window.Android.trackClick === 'function') {
        window.Android.trackClick(adId);
      }
    }
  } catch (e) {
    // Ignore bridge errors in non-Android environments
  }
}

/**
 * Open external URL directly in Google Chrome App
 */
export function openUrlInChrome(url: string) {
  if (!url) return;
  if (typeof window !== 'undefined') {
    const win = window as any;
    if (win.Android && typeof win.Android.openInChrome === 'function') {
      try {
        win.Android.openInChrome(url);
        return;
      } catch (e) {}
    }
    if (typeof win.openInChrome === 'function') {
      win.openInChrome(url);
      return;
    }
  }
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  const isChrome = typeof navigator !== 'undefined' && /Chrome/i.test(navigator.userAgent) && !/Edge|OPR|Samsung/i.test(navigator.userAgent);
  if (isAndroid && !isChrome) {
    try {
      const cleanUrl = url.replace(/^https?:\/\//, '');
      const intentUrl = `intent://${cleanUrl}#Intent;scheme=https;package=com.android.chrome;end`;
      const intentA = document.createElement('a');
      intentA.href = intentUrl;
      document.body.appendChild(intentA);
      intentA.click();
      setTimeout(() => {
        try { document.body.removeChild(intentA); } catch (e) {}
      }, 100);
    } catch (e) {}
  }
  try {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch (e) {}
    }, 200);
  } catch (e) {
    try {
      window.open(url, '_blank');
    } catch (err) {}
  }
}
