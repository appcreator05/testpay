import BUNDLED_CATALOG from './data/userCatalog8468988.json';
import CURATED_CLOUD_CATALOG from './data/curatedCloudCatalog.json';
import {
    subscriptionDb,
    sanitizeSubscriptionId,
    checkAndHandleSubscriptionExpiry,
    getCachedIsSubscribed,
    SUBSCRIPTION_PLANS,
    loginOrRegisterSubscriptionUser,
    paySubscriptionFromWallet,
    logoutSubscriptionUser,
    listenToActiveSession
} from './services/subscriptionService';
import { ref, get } from 'firebase/database';
import { checkForAppUpdate, CURRENT_APP_VERSION, triggerApkInstall, getInstalledAppVersion } from './services/updateService';

// ==========================================
// VIP SUBSCRIPTION & 100% AD-FREE ENGINE
// ==========================================
// Block external YouTube app launches or popups
if (typeof window !== 'undefined') {
    const originalWindowOpen = window.open;
    window.open = function(url, target, features) {
        if (typeof url === 'string' && (url.includes('youtube.com') || url.includes('youtu.be') || url.startsWith('vnd.youtube'))) {
            return null;
        }
        return originalWindowOpen ? originalWindowOpen.apply(this, arguments) : null;
    };
}

let isInSubscriptionView = false;
let homeCachedHTML = "";
let adRefreshTimer = null;
let isSmartlinkInterstitialActive = false;
let isPopunderActive = false;
window.__isVipSubscribed = getCachedIsSubscribed();

let activeSessionUnsub = null;
let currentListeningSafeId = null;

function setupSessionListener(safeId) {
    if (!safeId) return;
    if (activeSessionUnsub && currentListeningSafeId === safeId) return;
    teardownSessionListener();
    currentListeningSafeId = safeId;
    try {
        activeSessionUnsub = listenToActiveSession(safeId, (reason) => {
            window.__isVipSubscribed = false;
            teardownSessionListener();
            updateVipAdSuppression();
            if (typeof window.showSessionKickedModal === 'function') {
                window.showSessionKickedModal(reason);
            }
            if (isInSubscriptionView && typeof renderSubscriptionPage === 'function') {
                renderSubscriptionPage();
            }
        });
    } catch (e) {
        console.warn('Could not setup session listener:', e);
    }
}

function teardownSessionListener() {
    if (typeof activeSessionUnsub === 'function') {
        try { activeSessionUnsub(); } catch (e) {}
    }
    activeSessionUnsub = null;
    currentListeningSafeId = null;
}

async function refreshSubscriptionState() {
    const safeId = localStorage.getItem('sub_wallet_safe_id');
    if (safeId) {
        try {
            setupSessionListener(safeId);
            const res = await checkAndHandleSubscriptionExpiry(safeId);
            if (res.deviceMismatched || res.sessionMismatched) {
                window.__isVipSubscribed = false;
                teardownSessionListener();
                updateVipAdSuppression();
                if (typeof window.showSessionKickedModal === 'function') {
                    window.showSessionKickedModal(res.message);
                }
                if (isInSubscriptionView && typeof renderSubscriptionPage === 'function') {
                    renderSubscriptionPage();
                }
                return;
            }
            window.__isVipSubscribed = res.isSubscribed;
        } catch (e) {
            window.__isVipSubscribed = getCachedIsSubscribed();
        }
    } else {
        teardownSessionListener();
        window.__isVipSubscribed = getCachedIsSubscribed();
    }
    updateVipAdSuppression();
}
setInterval(refreshSubscriptionState, 15000);
setTimeout(refreshSubscriptionState, 500);
window.addEventListener('DOMContentLoaded', updateVipAdSuppression);
updateVipAdSuppression();

// ==========================================
// CENTRAL SUBSCRIPTION GATE & CONTROLLER
// Bina subscription kore kichui play hobe na
// ==========================================
window.isUserSubscribed = function() {
    // 1. Android native SharedPreferences check
    if (window.Android && typeof window.Android.isUserSubscribed === 'function') {
        try {
            if (window.Android.isUserSubscribed()) {
                window.__isVipSubscribed = true;
                return true;
            }
        } catch (e) {}
    }

    // 2. LocalStorage subscription check
    try {
        const isSub = localStorage.getItem('vdosky_subscribed');
        const expiry = parseInt(localStorage.getItem('vdosky_sub_expiry') || '0', 10);
        if (isSub === 'true' && expiry > Date.now()) {
            window.__isVipSubscribed = true;
            return true;
        } else if (isSub === 'true' && expiry <= Date.now()) {
            localStorage.removeItem('vdosky_subscribed');
            localStorage.removeItem('vdosky_sub_expiry');
            localStorage.removeItem('vdosky_sub_plan');
            window.__isVipSubscribed = false;
        }
    } catch (e) {}

    // 3. Firebase cache or variable
    if (window.__isVipSubscribed || getCachedIsSubscribed()) {
        window.__isVipSubscribed = true;
        return true;
    }

    return false;
};

window.showSubscriptionRequiredPopup = function(type = 'movie', name = '') {
    const modal = document.getElementById('customSubGateModal');
    if (!modal) return;

    let typeText = 'movie';
    if (type === 'youtube') typeText = 'YouTube video';
    else if (type === 'game') typeText = 'game';
    else if (type === 'music') typeText = 'music';

    const subEl = document.getElementById('customGateModalSubtitle');
    if (subEl) {
        subEl.innerHTML = `Bina subscription kore ${typeText} play kora jabe na${name ? ` (<b>${name}</b>)` : ''}. Nicher plan theke select korun:`;
    }

    modal.classList.add('active');
};

window.closeSubscriptionRequiredPopup = function() {
    const modal = document.getElementById('customSubGateModal');
    if (modal) modal.classList.remove('active');
};

window.selectSubscriptionPlan = function(planName, price, url, days) {
    try {
        localStorage.setItem('vdosky_pending_plan', planName);
        localStorage.setItem('vdosky_pending_days', String(days || 30));
        localStorage.setItem('vdosky_payment_started_at', String(Date.now()));
    } catch (e) {}

    if (window.Android && typeof window.Android.openExternalUrl === 'function') {
        try {
            window.Android.openExternalUrl(url);
        } catch (e) {
            window.open(url, '_blank');
        }
    } else if (window.Android && typeof window.Android.openUrl === 'function') {
        try {
            window.Android.openUrl(url);
        } catch (e) {
            window.open(url, '_blank');
        }
    } else {
        window.open(url, '_blank');
    }

    if (typeof showToast === 'function') {
        showToast(`Opening ${planName} payment (₹${price})...`);
    }
};

// Automatic subscription activation when user returns to app after payment
window.handleAppResumeFromPayment = function() {
    try {
        const startedAt = parseInt(localStorage.getItem('vdosky_payment_started_at') || '0', 10);
        if (!startedAt) return;

        const timeDiff = Date.now() - startedAt;
        // If payment was clicked within the last 15 minutes, auto-activate on return
        if (timeDiff > 3000 && timeDiff < 15 * 60 * 1000) {
            const pendingPlan = localStorage.getItem('vdosky_pending_plan') || 'Basic Plan';
            const pendingDays = parseInt(localStorage.getItem('vdosky_pending_days') || '30', 10);
            const durationDays = pendingDays > 0 ? pendingDays : 30;
            const expiryTime = Date.now() + (durationDays * 24 * 60 * 60 * 1000);
            const autoPayId = 'pay_auto_' + Math.random().toString(36).substring(2, 10);

            localStorage.removeItem('vdosky_payment_started_at');
            localStorage.setItem('vdosky_subscribed', 'true');
            localStorage.setItem('vdosky_sub_plan', pendingPlan);
            localStorage.setItem('vdosky_sub_expiry', String(expiryTime));
            localStorage.setItem('vdosky_sub_payment_id', autoPayId);
            window.__isVipSubscribed = true;

            if (window.Android && typeof window.Android.saveSubscription === 'function') {
                try {
                    window.Android.saveSubscription(pendingPlan, durationDays, autoPayId);
                } catch (e) {}
            }

            updateVipAdSuppression();
            window.closeSubscriptionRequiredPopup();

            window.showCustomAlert(
                'Subscription Activated!',
                `Welcome! Your ${pendingPlan} is now automatically activated for ${durationDays} days. All movies, YouTube videos, games, and music are now unlocked!`,
                true
            );

            if (typeof window.renderSubscriptionPage === 'function' && isInSubscriptionView) {
                window.renderSubscriptionPage();
            }
        }
    } catch (e) {
        console.warn('handleAppResumeFromPayment error:', e);
    }
};

// Web browser visibility change support
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        window.handleAppResumeFromPayment();
    }
});
window.addEventListener('focus', () => {
    window.handleAppResumeFromPayment();
});

window.handlePlanLinkClick = function(event, url, planName, days) {
    if (event) event.preventDefault();
    window.selectSubscriptionPlan(planName, '', url, days);
};

window.handleAutoVerifySubmit = function(source = 'gate') {
    const inputId = source === 'page' ? 'pageAutoVerifyInput' : 'gateAutoVerifyInput';
    const input = document.getElementById(inputId);
    const val = input ? input.value.trim() : '';

    if (!val || val.length < 4) {
        if (typeof showToast === 'function') {
            showToast('Please enter a valid Razorpay Payment ID or UPI UTR number');
        }
        if (input) input.focus();
        return;
    }

    const pendingPlan = localStorage.getItem('vdosky_pending_plan') || 'Basic Plan';
    const pendingDays = parseInt(localStorage.getItem('vdosky_pending_days') || '30', 10);
    const durationDays = pendingDays > 0 ? pendingDays : 30;
    const expiryTime = Date.now() + (durationDays * 24 * 60 * 60 * 1000);

    // Save locally
    try {
        localStorage.setItem('vdosky_subscribed', 'true');
        localStorage.setItem('vdosky_sub_plan', pendingPlan);
        localStorage.setItem('vdosky_sub_expiry', String(expiryTime));
        localStorage.setItem('vdosky_sub_payment_id', val);
    } catch (e) {}
    window.__isVipSubscribed = true;

    // Save to Android native SharedPreferences
    if (window.Android && typeof window.Android.saveSubscription === 'function') {
        try {
            window.Android.saveSubscription(pendingPlan, durationDays, val);
        } catch (e) {}
    }

    window.closeSubscriptionRequiredPopup();

    window.showCustomAlert(
        'Subscription Activated!',
        `Your ${pendingPlan} is now active for ${durationDays} days. All movies, YouTube videos, games, and music are now unlocked!`,
        true
    );

    updateVipAdSuppression();

    if (typeof window.renderSubscriptionPage === 'function' && isInSubscriptionView) {
        window.renderSubscriptionPage();
    }
};

window.showCustomAlert = function(title, message, isSuccess = false) {
    const overlay = document.getElementById('customAlertOverlay');
    const titleEl = document.getElementById('customAlertTitle');
    const msgEl = document.getElementById('customAlertMessage');
    const iconEl = document.getElementById('customAlertIcon');
    if (!overlay) return;

    if (titleEl) titleEl.innerText = title || 'Subscribe now & Watch Play Continue';
    if (msgEl) msgEl.innerHTML = message || 'Recommended UPI Payment<br/>Safe And Secure';
    if (iconEl) {
        iconEl.innerHTML = isSuccess 
            ? '<i class="fa-solid fa-circle-check" style="color: #04AA6D;"></i>' 
            : '<i class="fa-solid fa-lock" style="color: #e50914;"></i>';
    }
    overlay.classList.add('show');
};

window.closeCustomAlert = function() {
    const overlay = document.getElementById('customAlertOverlay');
    if (overlay) overlay.classList.remove('show');
};

window.launchGame = function(gameUrl, gameTitle) {
    if (!window.isUserSubscribed()) {
        window.showSubscriptionRequiredPopup('game', gameTitle || 'Game');
        return;
    }
    window.location.href = gameUrl;
};

window.handleMusicMenuClick = function(event) {
    if (event) event.preventDefault();
    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
    }

    if (!window.isUserSubscribed()) {
        window.showSubscriptionRequiredPopup('music', 'Online Music');
        return;
    }
    window.location.href = 'music.html';
};

function updateVipAdSuppression() {
    const isVip = !!window.__isVipSubscribed;

    if (isVip) {
        if (document.body) document.body.classList.add('vip-active');
        if (document.documentElement) document.documentElement.classList.add('vip-active');

        // Immediately remove and purge all ad elements from the DOM
        if (typeof document !== 'undefined') {
            const adElements = document.querySelectorAll('.ad-slot-300x250, .ad-label, #fixedFooterAdContainer, #playerUnderAdSlot, .interstitial-modal, #smartlinkInterstitialModal, #popunderInterstitialModal');
            adElements.forEach(el => {
                try {
                    if (el.id === 'fixedFooterAdContainer') {
                        el.style.display = 'none';
                        const inner = document.getElementById('fixedFooterAdInner');
                        if (inner) inner.innerHTML = '';
                    } else if (el.id === 'playerUnderAdSlot') {
                        el.innerHTML = '';
                        const parent = el.closest('.ad-slot-300x250');
                        if (parent) parent.remove();
                    } else {
                        el.remove();
                    }
                } catch (e) {
                    el.style.display = 'none';
                }
            });
        }

        // Invalidate cached home HTML so non-VIP cached ads can never be re-injected
        homeCachedHTML = "";

        // Cancel ad refresh timer
        if (adRefreshTimer) {
            clearTimeout(adRefreshTimer);
            adRefreshTimer = null;
        }

        // Close any active interstitial
        if (typeof closeSmartlinkInterstitial === 'function' && isSmartlinkInterstitialActive) {
            closeSmartlinkInterstitial();
        }
        if (typeof closePopunderInterstitial === 'function' && isPopunderActive) {
            closePopunderInterstitial();
        }
    } else {
        if (document.body) document.body.classList.remove('vip-active');
        if (document.documentElement) document.documentElement.classList.remove('vip-active');
        const footerAd = document.getElementById('fixedFooterAdContainer');
        if (footerAd) {
            footerAd.style.display = 'flex';
        }
    }

    // Update VIP menu item in dropdown
    const vipItem = document.getElementById('vipMenuItem');
    const vipText = document.getElementById('vipMenuText');
    const vipBadge = document.getElementById('vipMenuBadge');
    if (vipItem && vipText && vipBadge) {
        if (isVip) {
            vipItem.classList.add('active');
            vipText.innerHTML = '<i class="fa-solid fa-shield-halved" style="color: #34d399; margin-right: 8px;"></i> VIP Subscription Active';
            vipBadge.textContent = 'ACTIVE';
            vipBadge.className = 'vip-badge-pill active';
        } else {
            vipItem.classList.remove('active');
            vipText.innerHTML = '<i class="fa-solid fa-crown" style="color: #FFD700; margin-right: 8px;"></i> VIP Subscription (No Ads)';
            vipBadge.textContent = 'VIP';
            vipBadge.className = 'vip-badge-pill';
        }
    }
}
window.updateVipAdSuppression = updateVipAdSuppression;

// ==========================================
// CHROME APP OPENER (SMARTLINK & ADS)
// ==========================================
window.openInChrome = function(url) {
    if (!url) return;

    // 1. Android APK Native Bridge (directly opens Chrome app via Android Intent)
    if (window.Android) {
        if (typeof window.Android.openChromeDirectly === 'function') {
            try { window.Android.openChromeDirectly(url); return true; } catch (e) {}
        }
        if (typeof window.Android.openInChrome === 'function') {
            try { window.Android.openInChrome(url); return true; } catch (e) {}
        }
        if (typeof window.Android.openExternalUrl === 'function') {
            try { window.Android.openExternalUrl(url); return true; } catch (e) {}
        }
        if (typeof window.Android.openUrl === 'function') {
            try { window.Android.openUrl(url); return true; } catch (e) {}
        }
    }

    const isAndroid = /Android/i.test(navigator.userAgent);
    const isChrome = /Chrome/i.test(navigator.userAgent) && !/Edge|OPR|Samsung/i.test(navigator.userAgent);

    // 2. If in another Android browser, try Chrome app intent
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

    // 3. Fallback: standard browser navigation / new tab
    try {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            try { document.body.removeChild(a); } catch (e) {}
        }, 300);
        return true;
    } catch (e) {
        try {
            window.open(url, '_blank', 'noopener,noreferrer');
            return true;
        } catch (err) {
            try {
                window.location.assign(url);
            } catch (err2) {}
        }
    }
    return false;
};

// ==========================================
// KEEP SCREEN ALWAYS ON & TRUE FULLSCREEN (WAKE LOCK + STATUS BAR HIDE)
// ==========================================
let appWakeLockSentinel = null;

async function requestContinuousWakeLock() {
    // 1. Android APK Native Bridge (Keep screen awake & Hide System Navigation Bars)
    if (window.Android) {
        try {
            if (typeof window.Android.keepScreenOn === 'function') {
                window.Android.keepScreenOn(true);
            }
            if (typeof window.Android.hideSystemBars === 'function') {
                window.Android.hideSystemBars();
            }
        } catch (e) {}
    }

    // 2. Hide Capacitor Status Bar & Navigation Bar dynamically on app load/visibility (Native mobile only)
    const isNativePlatform = Boolean(
        (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) ||
        window.Android ||
        window.AndroidInterface
    );

    if (isNativePlatform) {
        try {
            const { StatusBar } = await import('@capacitor/status-bar');
            if (StatusBar) {
                await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
                await StatusBar.hide().catch(() => {});
            }
        } catch (e) {}

        try {
            const { NavigationBar } = await import('@capawesome/capacitor-navigation-bar');
            if (NavigationBar) {
                await NavigationBar.hide().catch(() => {});
            }
        } catch (e) {}

        try {
            const { Fullscreen } = await import('@boengli/capacitor-fullscreen');
            if (Fullscreen) {
                await Fullscreen.activateImmersiveMode().catch(() => {});
            }
        } catch (e) {}
    }

    // 3. Web Screen Wake Lock API
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && typeof navigator.wakeLock.request === 'function') {
        try {
            if (!appWakeLockSentinel || appWakeLockSentinel.released) {
                appWakeLockSentinel = await navigator.wakeLock.request('screen');
                appWakeLockSentinel.addEventListener('release', () => {
                    appWakeLockSentinel = null;
                });
            }
        } catch (err) {
            // Tab is inactive or battery policy restricted
        }
    }
}

// Ensure screen stays awake while app is open
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            requestContinuousWakeLock();
        }
    });
    window.addEventListener('DOMContentLoaded', requestContinuousWakeLock);
    window.addEventListener('load', requestContinuousWakeLock);
    document.addEventListener('click', requestContinuousWakeLock, { passive: true });
    document.addEventListener('touchstart', requestContinuousWakeLock, { passive: true });
    // Initial triggers
    requestContinuousWakeLock();
    setTimeout(requestContinuousWakeLock, 800);
}

let dbCache;
const DB_NAME = "MoviePosterDB";
const DB_VERSION = 2;

const openDB = () => {
    return new Promise((resolve) => {
        if (dbCache) return resolve(dbCache);
        if (typeof window === 'undefined' || !window.indexedDB) {
            return resolve(null);
        }
        try {
            const request = window.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                try {
                    let db = e.target.result;
                    if (!db.objectStoreNames.contains("images")) {
                        db.createObjectStore("images");
                    }
                    if (!db.objectStoreNames.contains("catalog")) {
                        db.createObjectStore("catalog");
                    }
                } catch (err) {}
            };
            request.onsuccess = (e) => {
                dbCache = e.target.result;
                resolve(dbCache);
            };
            request.onerror = () => {
                dbCache = null;
                resolve(null);
            };
            request.onblocked = () => {
                dbCache = null;
                resolve(null);
            };
        } catch (err) {
            dbCache = null;
            resolve(null);
        }
    });
};

async function getCachedMoviesFromDB() {
    // 1. Check openDB IndexedDB catalog store
    const dbMovies = await new Promise((resolve) => {
        if (!dbCache) return resolve(null);
        try {
            if (!dbCache.objectStoreNames.contains("catalog")) return resolve(null);
            const tx = dbCache.transaction("catalog", "readonly");
            const store = tx.objectStore("catalog");
            const req = store.get("cached_movies_list");
            req.onsuccess = () => {
                if (Array.isArray(req.result) && req.result.length > 0) {
                    resolve(req.result);
                } else {
                    resolve(null);
                }
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });

    if (dbMovies && dbMovies.length > 0) return dbMovies;

    // 2. Fallback to localStorage
    try {
        const stored = localStorage.getItem("vdosky_offline_catalog");
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) {}

    return null;
}

async function saveMoviesToDB(movies) {
    if (!Array.isArray(movies) || movies.length === 0) return;
    try {
        localStorage.setItem("vdosky_offline_catalog", JSON.stringify(movies.slice(0, 1500)));
    } catch (e) {}

    if (!dbCache) return;
    try {
        if (!dbCache.objectStoreNames.contains("catalog")) return;
        const tx = dbCache.transaction("catalog", "readwrite");
        const store = tx.objectStore("catalog");
        store.put(movies, "cached_movies_list");
    } catch (err) {
        console.warn("Could not save movies to openDB:", err);
    }
}

async function getCachedImage(url) {
    return new Promise((resolve) => {
        if (!dbCache) return resolve(null);
        try {
            const tx = dbCache.transaction("images", "readonly");
            const store = tx.objectStore("images");
            const req = store.get(url);
            req.onsuccess = () => {
                if (req.result) {
                    resolve(URL.createObjectURL(req.result));
                } else {
                    resolve(null);
                }
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

async function saveImage(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const tx = dbCache.transaction("images", "readwrite");
        const store = tx.objectStore("images");
        store.put(blob, url);
        return URL.createObjectURL(blob);
    } catch {
        return url;
    }
}

async function getImage(url) {
    const cached = await getCachedImage(url);
    if (cached) return cached;
    return await saveImage(url);
}

let allMovies = [];
let isInCategoryView = false;
let isPlayerView = false;
let isInCloudStreamView = false;
let isInCommentView = false;
let isInGameView = false;
let currentPlayingMovie = null;
let currentCategoryName = "all";
let savedScrollPosition = 0;

// Show Toast Notification
function showToast(msg) {
    const toast = document.getElementById('toastNotice');
    if (!toast) return;
    toast.innerText = msg;
    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 2500);
}
window.showToast = showToast;

const GITHUB_LIVE_MOVIES_URL = "https://raw.githubusercontent.com/appcreator05/post/refs/heads/main/8468988.json";

// Live sync from user's GitHub repository
async function fetchJsonFromEndpoint(url) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
        try { abortController.abort(); } catch (e) {}
    }, 6000);

    try {
        // Simple CORS request: No custom headers like Cache-Control/Pragma to avoid 403 Forbidden on raw.githubusercontent.com
        const response = await fetch(url, {
            signal: abortController.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) return null;

        // If GitHub API contents endpoint is used, decode base64
        if (url.includes("api.github.com")) {
            const apiRes = await response.json();
            if (apiRes && apiRes.content) {
                const decoded = atob(apiRes.content.replace(/\s/g, ''));
                const parsed = JSON.parse(decoded);
                return Array.isArray(parsed) ? parsed : null;
            }
            return null;
        }

        const data = await response.json();
        return Array.isArray(data) ? data : null;
    } catch (e) {
        clearTimeout(timeoutId);
        return null;
    }
}

async function syncMoviesFromGitHub(isManual = false) {
    const cacheBuster = `_t=${Date.now()}`;
    const REMOTE_ENDPOINTS = [
        `https://raw.githubusercontent.com/appcreator05/post/refs/heads/main/8468988.json?${cacheBuster}`,
        `https://raw.githubusercontent.com/appcreator05/post/main/8468988.json?${cacheBuster}`,
        `https://api.github.com/repos/appcreator05/post/contents/8468988.json?${cacheBuster}`
    ];

    for (const endpoint of REMOTE_ENDPOINTS) {
        try {
            const freshMovies = await fetchJsonFromEndpoint(endpoint);
            if (freshMovies && Array.isArray(freshMovies) && freshMovies.length > 0) {
                const countDiff = freshMovies.length - (allMovies ? allMovies.length : 0);
                const isFirstDiff = allMovies && allMovies.length > 0 && (
                    freshMovies[0]?.title !== allMovies[0]?.title ||
                    freshMovies[0]?.video !== allMovies[0]?.video ||
                    freshMovies[0]?.yt !== allMovies[0]?.yt
                );
                const isLastDiff = allMovies && allMovies.length > 0 && (
                    freshMovies[freshMovies.length - 1]?.title !== allMovies[allMovies.length - 1]?.title
                );
                const hasChanged = (countDiff !== 0) || isFirstDiff || isLastDiff || isManual;

                allMovies = freshMovies;
                saveMoviesToDB(freshMovies);

                if (hasChanged) {
                    if (!isPlayerView) {
                        if (isInCategoryView) {
                            renderCategoryView(currentCategoryName);
                        } else {
                            await renderContent(allMovies);
                        }
                    }
                    if (countDiff > 0) {
                        showToast(`Updated: ${countDiff} new movie${countDiff > 1 ? 's' : ''} synced!`);
                    } else if (isManual) {
                        showToast(`Synced ${freshMovies.length} movies live from GitHub!`);
                    }
                }
                return true;
            }
        } catch (endpointErr) {
            console.warn(`Fetch error for ${endpoint}:`, endpointErr);
        }
    }
    return false;
}

window.syncMoviesFromGitHub = syncMoviesFromGitHub;
window.refreshMoviesFromGitHub = function(showFeedback = true) {
    if (showFeedback) showToast("Checking GitHub for new posts...");
    return syncMoviesFromGitHub(true);
};

async function fetchMovies() {
    let hasLoadedAndRendered = false;

    try {
        await openDB();

        // 1. Instant Initial Load: Compare cached DB with bundled catalog
        const cachedFromDB = await getCachedMoviesFromDB();
        let initialMovies = BUNDLED_CATALOG;

        // If cached DB has strictly more movies than bundled catalog, use it
        if (cachedFromDB && Array.isArray(cachedFromDB) && cachedFromDB.length > (BUNDLED_CATALOG ? BUNDLED_CATALOG.length : 0)) {
            initialMovies = cachedFromDB;
        } else if (BUNDLED_CATALOG && Array.isArray(BUNDLED_CATALOG) && BUNDLED_CATALOG.length > 0) {
            // Bundled catalog is fresh and has all latest movies (including Robin Hood 2018)
            initialMovies = BUNDLED_CATALOG;
            saveMoviesToDB(BUNDLED_CATALOG);
        }

        if (initialMovies && Array.isArray(initialMovies) && initialMovies.length > 0) {
            allMovies = initialMovies;
            hasLoadedAndRendered = true;
            if (!checkInitialRoute()) {
                await renderContent(allMovies);
            }
            const spinner = document.getElementById('globalSpinner');
            if (spinner) spinner.style.display = 'none';
        }

        // 2. Direct Live Fetch from User GitHub JSON (with cache buster and multi-mirror fallback)
        await syncMoviesFromGitHub(false);

    } catch (err) {
        console.warn("Error in fetchMovies:", err);
        if (!hasLoadedAndRendered && BUNDLED_CATALOG && BUNDLED_CATALOG.length > 0) {
            allMovies = BUNDLED_CATALOG;
            if (!checkInitialRoute()) {
                await renderContent(allMovies);
            }
        }
    } finally {
        const spinner = document.getElementById('globalSpinner');
        if (spinner) spinner.style.display = 'none';
    }
}

let currentPlyrInstance = null;
let currentActiveServerIndex = 0;
let currentYtPlayerInstance = null;
let autoNextTimer = null;
let isAutoNextEnabled = true;
let isAutoNextTransitioning = false;
let wasFullscreenBeforeNext = false;
try {
    const savedAutoNext = localStorage.getItem('vdosky_auto_next');
    if (savedAutoNext !== null) {
        isAutoNextEnabled = (savedAutoNext !== 'false');
    }
} catch (e) {}

let currentCloudFilteredList = [];

// PostMessage listener for YouTube iframe video ended event
window.addEventListener('message', (event) => {
    if (!event || !event.data) return;
    try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data) {
            if ((data.event === 'onStateChange' || data.type === 'onStateChange') && (data.info === 0 || data.data === 0 || data.info === '0' || data.data === '0')) {
                handleVideoEnded();
            }
        }
    } catch (e) {}
});

function destroyCurrentPlyr(preserveFullscreen = false) {
    if (typeof stopYtTimelineSync === 'function') {
        stopYtTimelineSync();
    }
    if (!preserveFullscreen && !isAutoNextTransitioning) {
        unlockScreenOrientation();
    }
    if (autoNextTimer) {
        clearInterval(autoNextTimer);
        autoNextTimer = null;
    }
    const overlay = document.getElementById('playerEndedOverlay');
    if (overlay) overlay.remove();

    const menu = document.getElementById('ytSettingsMenu');
    if (menu) menu.style.display = 'none';
    const exitDirectBtn = document.getElementById('ytExitDirectTouch');
    if (exitDirectBtn) exitDirectBtn.style.display = 'none';

    if (currentYtPlayerInstance) {
        try {
            if (typeof currentYtPlayerInstance.destroy === 'function') {
                currentYtPlayerInstance.destroy();
            }
        } catch (e) {}
        currentYtPlayerInstance = null;
    }
    if (currentPlyrInstance) {
        try {
            currentPlyrInstance.destroy();
        } catch (e) {
            console.warn("Error destroying Plyr instance:", e);
        }
        currentPlyrInstance = null;
    }
}

function getNextPlayableItem() {
    if (!currentPlayingMovie) return null;

    if (isInCloudStreamView) {
        const list = (currentCloudFilteredList && currentCloudFilteredList.length > 0) 
            ? currentCloudFilteredList 
            : (typeof CURATED_CLOUD_CATALOG !== 'undefined' ? CURATED_CLOUD_CATALOG : []);
        if (list.length === 0) return null;
        
        const currentIdx = list.findIndex(item => (item.yt && item.yt === currentPlayingMovie.yt) || item.title === currentPlayingMovie.title);
        if (currentIdx !== -1) {
            return list[(currentIdx + 1) % list.length];
        }
        return list[0];
    } else {
        const sameCat = allMovies.filter(m => m.category === currentPlayingMovie.category && m.title !== currentPlayingMovie.title);
        if (sameCat.length > 0) {
            return sameCat[0];
        }
        const globalIdx = allMovies.findIndex(m => m.title === currentPlayingMovie.title);
        if (globalIdx !== -1 && allMovies.length > 1) {
            return allMovies[(globalIdx + 1) % allMovies.length];
        }
        return allMovies[0] || null;
    }
}

function handleVideoEnded() {
    if (autoNextTimer) {
        clearInterval(autoNextTimer);
        autoNextTimer = null;
    }
    
    const box = document.getElementById('activePlayerBox');
    if (!box) return;

    const nextItem = getNextPlayableItem();
    if (!nextItem) return;

    const existingOverlay = document.getElementById('playerEndedOverlay');
    if (existingOverlay) existingOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'playerEndedOverlay';
    overlay.className = 'player-ended-overlay';

    const nextTitle = nextItem.title || nextItem.name || 'Next Video';

    if (isAutoNextEnabled) {
        let countdown = 2;
        overlay.innerHTML = `
            <div class="player-ended-card">
                <div class="player-ended-badge"><i class="fa-solid fa-forward-step"></i> Auto Next</div>
                <div class="player-ended-next-title">${nextTitle}</div>
                <div class="player-ended-timer-ring">Playing next in <span id="autoNextCount" class="player-ended-timer-count">${countdown}</span>s...</div>
                <div class="player-ended-buttons">
                    <button class="ended-btn-primary" onclick="playNextVideo(true)">
                        <i class="fa-solid fa-play"></i> Play Now
                    </button>
                    <button class="ended-btn-secondary" onclick="cancelAutoNext()">
                        <i class="fa-solid fa-xmark"></i> Cancel
                    </button>
                </div>
            </div>
        `;
        box.appendChild(overlay);

        const countEl = document.getElementById('autoNextCount');
        const interval = setInterval(() => {
            countdown--;
            if (countEl) countEl.innerText = countdown;
            if (countdown <= 0) {
                clearInterval(interval);
                autoNextTimer = null;
                playNextVideo(true);
            }
        }, 1000);

        autoNextTimer = interval;
    } else {
        overlay.innerHTML = `
            <div class="player-ended-card">
                <div class="player-ended-badge"><i class="fa-solid fa-circle-check"></i> Stream Finished</div>
                <div class="player-ended-next-title">${nextTitle}</div>
                <div class="player-ended-buttons">
                    <button class="ended-btn-primary" onclick="playNextVideo(true)">
                        <i class="fa-solid fa-forward-step"></i> Play Next
                    </button>
                    <button class="ended-btn-secondary" onclick="replayCurrentVideo()">
                        <i class="fa-solid fa-rotate-left"></i> Replay
                    </button>
                </div>
            </div>
        `;
        box.appendChild(overlay);
    }
}

window.playNextVideo = function(immediate = false) {
    if (autoNextTimer) {
        clearInterval(autoNextTimer);
        autoNextTimer = null;
    }
    const overlay = document.getElementById('playerEndedOverlay');
    if (overlay) overlay.remove();

    const nextItem = getNextPlayableItem();
    if (!nextItem) {
        showToast("No next video in queue");
        return;
    }

    const activeBox = document.getElementById('activePlayerBox');
    const wasFs = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement ||
        (activeBox && (activeBox.classList.contains('is-fullscreen') || activeBox.classList.contains('plyr-force-landscape'))) ||
        (currentPlyrInstance && currentPlyrInstance.fullscreen && currentPlyrInstance.fullscreen.active)
    );

    if (wasFs) {
        isAutoNextTransitioning = true;
        wasFullscreenBeforeNext = true;
    }

    // Seamless in-place transition for YouTube videos:
    // Retains fullscreen, landscape lock, and prevents exiting to portrait mode
    const currentYtIframe = document.getElementById('vdoSkyYouTube');
    const sourceInfo = detectMovieVideoSource(nextItem);
    const isNextYt = (sourceInfo.type === 'yt') || (nextItem.yt && nextItem.yt.length > 0);

    if (activeBox && currentYtIframe && isNextYt) {
        currentPlayingMovie = nextItem;
        const titleText = nextItem.title || nextItem.name || 'Cloud Stream';

        // Update titles in top shield and below player
        const shieldTitle = document.querySelector('.yt-shield-top-title');
        if (shieldTitle) shieldTitle.innerText = titleText;
        const movieTitle = document.querySelector('.player-movie-title');
        if (movieTitle) movieTitle.innerText = titleText;

        // Update rating & category badges
        const ratingBadge = document.querySelector('.badge-rating');
        if (ratingBadge) ratingBadge.innerText = `★ ${nextItem.rating || '4.8'}`;
        const catBadge = document.querySelector('.badge-category');
        if (catBadge) catBadge.innerText = nextItem.category || 'General';

        // Update active server info
        const servers = getMovieServers(nextItem);
        const activeServer = servers[0];
        currentActiveServerIndex = 0;

        // Load new video into YouTube player without breaking fullscreen or DOM
        if (currentYtPlayerInstance && typeof currentYtPlayerInstance.loadVideoById === 'function') {
            try {
                currentYtPlayerInstance.loadVideoById({
                    videoId: sourceInfo.id,
                    startSeconds: 0
                });
            } catch (e) {
                currentYtIframe.src = activeServer.url;
            }
        } else {
            currentYtIframe.src = activeServer.url;
        }

        // Update stream server selector buttons
        const serverSelector = document.querySelector('.server-selector');
        if (serverSelector) {
            const serverPills = servers.map((s, idx) => `
                <button class="server-pill ${idx === 0 ? 'active' : ''}" onclick="switchServer(${idx})">
                    <i class="fa-solid ${s.type === 'yt' ? 'fa-play' : 'fa-server'}"></i> ${s.name}
                </button>
            `).join('');
            serverSelector.innerHTML = `
                <span class="server-label"><i class="fa-solid fa-bolt"></i> Stream Server:</span>
                ${serverPills}
                <div class="auto-next-server-wrap">
                    <button type="button" class="auto-next-pill-btn ${isAutoNextEnabled ? 'active' : ''}" onclick="toggleAutoNext()" title="Toggle Auto Next">
                        <i class="fa-solid ${isAutoNextEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                        <span>Auto Next: <strong>${isAutoNextEnabled ? 'ON' : 'OFF'}</strong></span>
                    </button>
                    <button type="button" class="quick-next-btn" onclick="playNextVideo(true)" title="Play Next Stream">
                        <i class="fa-solid fa-forward-step"></i> Next
                    </button>
                </div>
            `;
        }

        // Maintain and lock Fullscreen & Landscape Orientation
        if (wasFs) {
            activeBox.classList.add('is-fullscreen');
            if (window.innerHeight > window.innerWidth) {
                activeBox.classList.add('plyr-force-landscape');
            }
            lockLandscapeOrientation();
            updateFullscreenButtonState(true);
        }

        setTimeout(() => {
            isAutoNextTransitioning = false;
            wasFullscreenBeforeNext = false;
        }, 1200);

        try {
            window.history.replaceState({ view: 'player', title: titleText }, '');
        } catch (e) {}
        showToast("Playing next: " + titleText);
        return;
    }

    if (isInCloudStreamView) {
        playCloudStreamVideo(nextItem, wasFs);
    } else {
        window.openPlayer(nextItem, wasFs);
    }
    showToast("Playing next: " + (nextItem.title || nextItem.name || 'Stream'));
};

window.cancelAutoNext = function() {
    if (autoNextTimer) {
        clearInterval(autoNextTimer);
        autoNextTimer = null;
    }
    const overlay = document.getElementById('playerEndedOverlay');
    if (overlay) {
        const nextItem = getNextPlayableItem();
        const nextTitle = nextItem ? (nextItem.title || nextItem.name) : 'Next Stream';
        overlay.innerHTML = `
            <div class="player-ended-card">
                <div class="player-ended-badge"><i class="fa-solid fa-circle-check"></i> Stream Finished</div>
                <div class="player-ended-next-title">${nextTitle}</div>
                <div class="player-ended-buttons">
                    <button class="ended-btn-primary" onclick="playNextVideo(true)">
                        <i class="fa-solid fa-forward-step"></i> Play Next
                    </button>
                    <button class="ended-btn-secondary" onclick="replayCurrentVideo()">
                        <i class="fa-solid fa-rotate-left"></i> Replay
                    </button>
                </div>
            </div>
        `;
    }
};

window.replayCurrentVideo = function() {
    const overlay = document.getElementById('playerEndedOverlay');
    if (overlay) overlay.remove();

    if (currentYtPlayerInstance && typeof currentYtPlayerInstance.seekTo === 'function') {
        try {
            currentYtPlayerInstance.seekTo(0, true);
            currentYtPlayerInstance.playVideo();
            return;
        } catch (e) {}
    }
    if (currentPlyrInstance) {
        try {
            currentPlyrInstance.currentTime = 0;
            currentPlyrInstance.play();
            return;
        } catch (e) {}
    }
    if (currentPlayingMovie) {
        renderPlayerSection(currentPlayingMovie, currentActiveServerIndex);
    }
};

window.toggleAutoNext = function(forceVal) {
    if (typeof forceVal === 'boolean') {
        isAutoNextEnabled = forceVal;
    } else {
        isAutoNextEnabled = !isAutoNextEnabled;
    }
    try {
        localStorage.setItem('vdosky_auto_next', isAutoNextEnabled ? 'true' : 'false');
    } catch (e) {}

    updateAutoNextUI();
    showToast(isAutoNextEnabled ? "Auto Next: Enabled" : "Auto Next: Disabled");
};

function updateAutoNextUI() {
    document.querySelectorAll('.auto-next-pill-btn').forEach(btn => {
        btn.classList.toggle('active', isAutoNextEnabled);
        const textSpan = btn.querySelector('strong');
        if (textSpan) textSpan.innerText = isAutoNextEnabled ? 'ON' : 'OFF';
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = `fa-solid ${isAutoNextEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}`;
        }
    });
}

let ytTimelineSyncInterval = null;
let isUserDraggingTimeline = false;
let ytControlsTimer = null;
let isYtControlsVisible = false;

window.showYtShieldControls = function(resetTimer = true) {
    const shield = document.getElementById('ytBottomShield');
    const topShield = document.getElementById('ytTopShield');
    const box = document.getElementById('activePlayerBox');
    if (!shield && !box) return;

    isYtControlsVisible = true;
    if (shield) shield.classList.add('yt-shield-visible');
    if (topShield) topShield.classList.add('yt-shield-visible');
    if (box) box.classList.add('show-yt-controls');

    if (resetTimer) {
        window.resetYtControlsTimeout(5000);
    }
};

window.hideYtShieldControls = function() {
    if (isUserDraggingTimeline) return;
    const menu = document.getElementById('ytSettingsMenu');
    if (menu && menu.style.display !== 'none') return; // Keep visible while settings menu is open

    isYtControlsVisible = false;
    const shield = document.getElementById('ytBottomShield');
    const topShield = document.getElementById('ytTopShield');
    const box = document.getElementById('activePlayerBox');

    if (shield) shield.classList.remove('yt-shield-visible');
    if (topShield) topShield.classList.remove('yt-shield-visible');
    if (box) box.classList.remove('show-yt-controls');

    if (ytControlsTimer) {
        clearTimeout(ytControlsTimer);
        ytControlsTimer = null;
    }
};

let currentYtSelectedQuality = 'auto';
try {
    currentYtSelectedQuality = localStorage.getItem('vdosky_yt_quality') || 'auto';
} catch (e) {}

let currentYtSelectedSpeed = 1;
try {
    currentYtSelectedSpeed = parseFloat(localStorage.getItem('vdosky_yt_speed')) || 1;
} catch (e) {}

window.syncYtQualityUI = function() {
    const list = document.getElementById('ytQualityList');
    if (list) {
        list.querySelectorAll('.yt-quality-item').forEach(item => {
            const q = item.dataset.quality;
            const check = item.querySelector('.yt-q-check');
            if (q === currentYtSelectedQuality) {
                item.classList.add('active');
                if (check) check.style.display = 'inline-block';
            } else {
                item.classList.remove('active');
                if (check) check.style.display = 'none';
            }
        });
    }

    document.querySelectorAll('.yt-speed-btn').forEach(btn => {
        const s = parseFloat(btn.dataset.speed);
        if (s === currentYtSelectedSpeed) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
};

window.toggleYtQualitySettings = function(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const menu = document.getElementById('ytSettingsMenu');
    if (!menu) return;
    const isShowing = menu.style.display !== 'none';
    if (isShowing) {
        window.closeYtSettingsMenu();
    } else {
        menu.style.display = 'flex';
        window.showYtShieldControls(false); // keep controls visible without hiding
        window.syncYtQualityUI();
    }
};

window.closeYtSettingsMenu = function(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const menu = document.getElementById('ytSettingsMenu');
    if (menu) menu.style.display = 'none';
    window.resetYtControlsTimeout(4000);
};

window.setYtVideoQuality = function(qualityLevel, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    currentYtSelectedQuality = qualityLevel;
    try {
        localStorage.setItem('vdosky_yt_quality', qualityLevel);
    } catch (e) {}

    if (currentYtPlayerInstance) {
        try {
            if (typeof currentYtPlayerInstance.setPlaybackQualityRange === 'function') {
                currentYtPlayerInstance.setPlaybackQualityRange(qualityLevel, qualityLevel);
            }
            if (typeof currentYtPlayerInstance.setPlaybackQuality === 'function') {
                currentYtPlayerInstance.setPlaybackQuality(qualityLevel);
            }
        } catch (e) {
            console.warn('Could not set YouTube quality level:', e);
        }
    }

    window.syncYtQualityUI();

    const labelMap = {
        'auto': 'Auto (Best)',
        'hd1080': '1080p Full HD',
        'hd720': '720p HD',
        'large': '480p SD',
        'medium': '360p Standard',
        'small': '240p Data Saver'
    };
    showToast(`Quality: ${labelMap[qualityLevel] || qualityLevel}`);
    setTimeout(() => {
        window.closeYtSettingsMenu();
    }, 300);
};

window.setYtPlaybackSpeed = function(speed, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    currentYtSelectedSpeed = speed;
    try {
        localStorage.setItem('vdosky_yt_speed', String(speed));
    } catch (e) {}

    if (currentYtPlayerInstance && typeof currentYtPlayerInstance.setPlaybackRate === 'function') {
        try {
            currentYtPlayerInstance.setPlaybackRate(speed);
        } catch (e) {
            console.warn('Could not set YouTube playback rate:', e);
        }
    }

    window.syncYtQualityUI();
    showToast(`Playback Speed: ${speed}x`);
};

window.enableDirectYtTouch = function(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    window.closeYtSettingsMenu();
    const touchSurface = document.getElementById('ytTouchSurface');
    if (touchSurface) {
        touchSurface.style.pointerEvents = 'none';
    }
    const bottomShield = document.getElementById('ytBottomShield');
    if (bottomShield) {
        bottomShield.classList.remove('yt-shield-visible');
    }
    const exitBanner = document.getElementById('ytExitDirectTouch');
    if (exitBanner) {
        exitBanner.style.display = 'flex';
    }
    showToast('YouTube Touch Enabled. Tap "Restore Controls" anytime.');
};

window.disableDirectYtTouch = function(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const touchSurface = document.getElementById('ytTouchSurface');
    if (touchSurface) {
        touchSurface.style.pointerEvents = 'auto';
    }
    const exitBanner = document.getElementById('ytExitDirectTouch');
    if (exitBanner) {
        exitBanner.style.display = 'none';
    }
    window.showYtShieldControls(true);
    showToast('App player controls restored');
};

function applyStoredYtPreferences() {
    if (!currentYtPlayerInstance) return;
    try {
        if (currentYtSelectedQuality && currentYtSelectedQuality !== 'auto') {
            if (typeof currentYtPlayerInstance.setPlaybackQualityRange === 'function') {
                currentYtPlayerInstance.setPlaybackQualityRange(currentYtSelectedQuality, currentYtSelectedQuality);
            }
            if (typeof currentYtPlayerInstance.setPlaybackQuality === 'function') {
                currentYtPlayerInstance.setPlaybackQuality(currentYtSelectedQuality);
            }
        }
        if (currentYtSelectedSpeed && currentYtSelectedSpeed !== 1) {
            if (typeof currentYtPlayerInstance.setPlaybackRate === 'function') {
                currentYtPlayerInstance.setPlaybackRate(currentYtSelectedSpeed);
            }
        }
    } catch (e) {}
}

window.toggleYtShieldControls = function() {
    if (isYtControlsVisible) {
        window.hideYtShieldControls();
    } else {
        window.showYtShieldControls(true);
    }
};

window.resetYtControlsTimeout = function(delay = 5000) {
    if (ytControlsTimer) {
        clearTimeout(ytControlsTimer);
    }
    ytControlsTimer = setTimeout(() => {
        window.hideYtShieldControls();
    }, delay);
};

function formatTimelineTime(sec) {
    if (!sec || isNaN(sec) || sec < 0) return '00:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
        return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

function startYtTimelineSync() {
    stopYtTimelineSync();
    ytTimelineSyncInterval = setInterval(updateYtTimelineProgress, 300);
}

function stopYtTimelineSync() {
    if (ytTimelineSyncInterval) {
        clearInterval(ytTimelineSyncInterval);
        ytTimelineSyncInterval = null;
    }
    if (ytControlsTimer) {
        clearTimeout(ytControlsTimer);
        ytControlsTimer = null;
    }
}

function updateYtTimelineProgress() {
    if (isUserDraggingTimeline) return;
    let current = 0;
    let duration = 0;
    let loadedFraction = 0;
    let isPlaying = false;

    if (currentYtPlayerInstance && typeof currentYtPlayerInstance.getCurrentTime === 'function') {
        try {
            current = currentYtPlayerInstance.getCurrentTime() || 0;
            duration = currentYtPlayerInstance.getDuration() || 0;
            if (typeof currentYtPlayerInstance.getVideoLoadedFraction === 'function') {
                loadedFraction = currentYtPlayerInstance.getVideoLoadedFraction() || 0;
            }
            if (typeof currentYtPlayerInstance.getPlayerState === 'function') {
                const st = currentYtPlayerInstance.getPlayerState();
                isPlaying = (st === 1);
            }
        } catch (e) {}
    } else if (currentPlyrInstance) {
        try {
            current = currentPlyrInstance.currentTime || 0;
            duration = currentPlyrInstance.duration || 0;
            loadedFraction = currentPlyrInstance.buffered || 0;
            isPlaying = currentPlyrInstance.playing;
        } catch (e) {}
    }

    const progressEl = document.getElementById('ytTimelineProgress');
    const bufferEl = document.getElementById('ytTimelineBuffer');
    const currentText = document.getElementById('ytCurrentTime');
    const durationText = document.getElementById('ytDuration');
    const playIcon = document.getElementById('ytPlayPauseIcon');

    if (progressEl && duration > 0) {
        const percent = Math.min(100, Math.max(0, (current / duration) * 100));
        progressEl.style.width = percent + '%';
    }
    if (bufferEl && loadedFraction > 0) {
        bufferEl.style.width = Math.min(100, Math.max(0, loadedFraction * 100)) + '%';
    }
    if (currentText) currentText.textContent = formatTimelineTime(current);
    if (durationText && duration > 0) durationText.textContent = formatTimelineTime(duration);
    if (playIcon) {
        playIcon.className = isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play';
    }
}

window.skipVideoSeconds = function(deltaSeconds) {
    if (typeof window.showYtShieldControls === 'function') {
        window.showYtShieldControls(true);
    }
    if (currentYtPlayerInstance && typeof currentYtPlayerInstance.getCurrentTime === 'function') {
        try {
            const cur = currentYtPlayerInstance.getCurrentTime() || 0;
            const dur = currentYtPlayerInstance.getDuration() || 0;
            const target = Math.max(0, Math.min(dur || 999999, cur + deltaSeconds));
            currentYtPlayerInstance.seekTo(target, true);
            updateYtTimelineProgress();
            window.showTimelineFeedback(`${deltaSeconds > 0 ? '+' : ''}${deltaSeconds}s`);
        } catch (e) {}
    } else if (currentPlyrInstance) {
        try {
            currentPlyrInstance.currentTime = Math.max(0, Math.min(currentPlyrInstance.duration || 999999, (currentPlyrInstance.currentTime || 0) + deltaSeconds));
            updateYtTimelineProgress();
            window.showTimelineFeedback(`${deltaSeconds > 0 ? '+' : ''}${deltaSeconds}s`);
        } catch (e) {}
    }
};

window.toggleYtPlayPause = function() {
    if (typeof window.showYtShieldControls === 'function') {
        window.showYtShieldControls(true);
    }
    if (currentYtPlayerInstance && typeof currentYtPlayerInstance.getPlayerState === 'function') {
        try {
            const state = currentYtPlayerInstance.getPlayerState();
            if (state === 1) {
                currentYtPlayerInstance.pauseVideo();
            } else {
                currentYtPlayerInstance.playVideo();
            }
        } catch (e) {}
    } else if (currentPlyrInstance) {
        try {
            currentPlyrInstance.togglePlay();
        } catch (e) {}
    }
};

window.showTimelineFeedback = function(text) {
    const isForward = text.includes('+');
    const animEl = document.getElementById(isForward ? 'ytSkipRightAnim' : 'ytSkipLeftAnim');
    if (animEl) {
        animEl.classList.remove('active');
        void animEl.offsetWidth;
        animEl.classList.add('active');
        setTimeout(() => animEl.classList.remove('active'), 650);
    }
};

window.handleTimelineClick = function(event) {
    if (typeof window.showYtShieldControls === 'function') {
        window.showYtShieldControls(true);
    }
    seekTimelineFromEvent(event);
};

function seekTimelineFromEvent(event) {
    const container = document.getElementById('ytTimelineContainer');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const clientX = event.clientX !== undefined ? event.clientX : (event.touches && event.touches[0] ? event.touches[0].clientX : 0);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

    if (currentYtPlayerInstance && typeof currentYtPlayerInstance.getDuration === 'function') {
        try {
            const dur = currentYtPlayerInstance.getDuration() || 0;
            if (dur > 0) {
                const target = ratio * dur;
                currentYtPlayerInstance.seekTo(target, true);
                const progressEl = document.getElementById('ytTimelineProgress');
                if (progressEl) progressEl.style.width = (ratio * 100) + '%';
                const currentText = document.getElementById('ytCurrentTime');
                if (currentText) currentText.textContent = formatTimelineTime(target);
            }
        } catch (e) {}
    } else if (currentPlyrInstance && currentPlyrInstance.duration) {
        try {
            currentPlyrInstance.currentTime = ratio * currentPlyrInstance.duration;
        } catch (e) {}
    }
}

window.handleTimelineHover = function(e) {
    const container = document.getElementById('ytTimelineContainer');
    const tooltip = document.getElementById('ytTimelineTooltip');
    if (!container || !tooltip) return;
    const rect = container.getBoundingClientRect();
    const clientX = e.clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

    let duration = 0;
    if (currentYtPlayerInstance && typeof currentYtPlayerInstance.getDuration === 'function') {
        duration = currentYtPlayerInstance.getDuration() || 0;
    } else if (currentPlyrInstance && currentPlyrInstance.duration) {
        duration = currentPlyrInstance.duration;
    }

    if (duration > 0) {
        const hoverTime = ratio * duration;
        tooltip.textContent = formatTimelineTime(hoverTime);
        tooltip.style.left = (ratio * 100) + '%';
        tooltip.style.opacity = '1';
    }
};

window.handleTimelineLeave = function() {
    const tooltip = document.getElementById('ytTimelineTooltip');
    if (tooltip) tooltip.style.opacity = '0';
};

function initTimelineDragEvents() {
    const container = document.getElementById('ytTimelineContainer');
    if (!container || container.__hasDragListeners) return;
    container.__hasDragListeners = true;

    const onPointerMove = (e) => {
        if (!isUserDraggingTimeline) return;
        if (typeof window.showYtShieldControls === 'function') {
            window.showYtShieldControls(false);
        }
        const rect = container.getBoundingClientRect();
        const clientX = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

        let duration = 0;
        if (currentYtPlayerInstance && typeof currentYtPlayerInstance.getDuration === 'function') {
            duration = currentYtPlayerInstance.getDuration() || 0;
        } else if (currentPlyrInstance && currentPlyrInstance.duration) {
            duration = currentPlyrInstance.duration;
        }

        if (duration > 0) {
            const target = ratio * duration;
            const progressEl = document.getElementById('ytTimelineProgress');
            const currentText = document.getElementById('ytCurrentTime');
            if (progressEl) progressEl.style.width = (ratio * 100) + '%';
            if (currentText) currentText.textContent = formatTimelineTime(target);
        }
    };

    const onPointerUp = (e) => {
        if (isUserDraggingTimeline) {
            isUserDraggingTimeline = false;
            seekTimelineFromEvent(e);
            if (typeof window.resetYtControlsTimeout === 'function') {
                window.resetYtControlsTimeout(5000);
            }
        }
        window.removeEventListener('mousemove', onPointerMove);
        window.removeEventListener('mouseup', onPointerUp);
        window.removeEventListener('touchmove', onPointerMove);
        window.removeEventListener('touchend', onPointerUp);
    };

    container.addEventListener('mousedown', (e) => {
        isUserDraggingTimeline = true;
        if (typeof window.showYtShieldControls === 'function') {
            window.showYtShieldControls(false);
        }
        seekTimelineFromEvent(e);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
    });

    container.addEventListener('touchstart', (e) => {
        isUserDraggingTimeline = true;
        if (typeof window.showYtShieldControls === 'function') {
            window.showYtShieldControls(false);
        }
        seekTimelineFromEvent(e);
        window.addEventListener('touchmove', onPointerMove, { passive: true });
        window.addEventListener('touchend', onPointerUp);
    }, { passive: true });
}

function initPlayerTouchControls() {
    const box = document.getElementById('activePlayerBox');
    const touchSurface = document.getElementById('ytTouchSurface') || box;
    const bottomShield = document.getElementById('ytBottomShield');
    const topShield = document.getElementById('ytTopShield');

    if (!touchSurface) return;

    // Show controls initially for 5 seconds, then slide down automatically
    window.showYtShieldControls(true);

    // Keep controls alive & reset 5-second timer when interacting with bottom shield
    if (bottomShield && !bottomShield.__hasTouchShieldListeners) {
        bottomShield.__hasTouchShieldListeners = true;
        const events = ['touchstart', 'touchmove', 'touchend', 'mousedown', 'mousemove', 'click'];
        events.forEach(evt => {
            bottomShield.addEventListener(evt, () => {
                if (!isUserDraggingTimeline) {
                    window.resetYtControlsTimeout(5000);
                }
            }, { passive: true });
        });
    }

    // Keep controls alive & reset 5-second timer when interacting with top shield
    if (topShield && !topShield.__hasTouchShieldListeners) {
        topShield.__hasTouchShieldListeners = true;
        const events = ['touchstart', 'click'];
        events.forEach(evt => {
            topShield.addEventListener(evt, () => {
                window.resetYtControlsTimeout(5000);
            }, { passive: true });
        });
    }

    if (touchSurface.__hasTouchControlsListeners) return;
    touchSurface.__hasTouchControlsListeners = true;

    let lastTapTime = 0;
    let lastTapX = 0;
    let singleTapTimeout = null;

    // Handle touch on the screen (Mobile)
    touchSurface.addEventListener('touchend', (e) => {
        const now = Date.now();
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch) return;
        const rect = touchSurface.getBoundingClientRect();
        const tapX = touch.clientX - rect.left;

        if (now - lastTapTime < 320 && Math.abs(tapX - lastTapX) < 90) {
            // Double tap detected: cancel single tap
            if (singleTapTimeout) {
                clearTimeout(singleTapTimeout);
                singleTapTimeout = null;
            }
            lastTapTime = 0;

            if (tapX < rect.width * 0.45) {
                window.skipVideoSeconds(-10);
            } else if (tapX > rect.width * 0.55) {
                window.skipVideoSeconds(10);
            } else {
                window.toggleYtPlayPause();
            }
            window.showYtShieldControls(true);
        } else {
            // Single tap: toggle / show bottom shield for 5 seconds
            lastTapTime = now;
            lastTapX = tapX;

            if (singleTapTimeout) clearTimeout(singleTapTimeout);
            singleTapTimeout = setTimeout(() => {
                singleTapTimeout = null;
                window.toggleYtShieldControls();
            }, 260);
        }
    }, { passive: false });

    // Desktop click handling
    touchSurface.addEventListener('click', (e) => {
        if (e.detail <= 1) {
            window.toggleYtShieldControls();
        }
    });

    touchSurface.addEventListener('mousemove', () => {
        window.showYtShieldControls(true);
    });

    if (box && !box.__hasMouseLeaveListener) {
        box.__hasMouseLeaveListener = true;
        box.addEventListener('mouseleave', () => {
            if (isYtControlsVisible && !isUserDraggingTimeline) {
                window.resetYtControlsTimeout(1800);
            }
        });
    }
}

function initPlayerDoubleTapSkip() {
    initPlayerTouchControls();
}

// Global keyboard shortcuts for video skip and play/pause
document.addEventListener('keydown', (e) => {
    const box = document.getElementById('activePlayerBox');
    if (!box) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        window.skipVideoSeconds(-10);
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        window.skipVideoSeconds(10);
    } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        window.toggleYtPlayPause();
    }
});

function setupYouTubePlayer(iframeId) {
    if (currentYtPlayerInstance) {
        try {
            if (typeof currentYtPlayerInstance.destroy === 'function') {
                currentYtPlayerInstance.destroy();
            }
        } catch (e) {}
        currentYtPlayerInstance = null;
    }

    const onPlayerStateChange = (event) => {
        updateYtTimelineProgress();
        if (event && (event.data === 0 || (window.YT && event.data === window.YT.PlayerState.ENDED))) {
            handleVideoEnded();
        }
    };

    function attachYt() {
        const el = document.getElementById(iframeId);
        if (!el) return;
        try {
            currentYtPlayerInstance = new window.YT.Player(iframeId, {
                events: {
                    'onReady': () => {
                        startYtTimelineSync();
                        updateYtTimelineProgress();
                        initTimelineDragEvents();
                        initPlayerDoubleTapSkip();
                        applyStoredYtPreferences();
                    },
                    'onStateChange': onPlayerStateChange
                }
            });
            startYtTimelineSync();
            initTimelineDragEvents();
            initPlayerDoubleTapSkip();
        } catch (e) {
            console.warn('YT Player attachment warning:', e);
            startYtTimelineSync();
            initTimelineDragEvents();
            initPlayerDoubleTapSkip();
        }
    }

    if (window.YT && window.YT.Player) {
        attachYt();
    } else {
        const prevReady = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = function() {
            if (typeof prevReady === 'function') prevReady();
            attachYt();
        };
    }
}

// Detect video source ("video", "yt", or "drc")
function detectMovieVideoSource(movie) {
    if (!movie) {
        return {
            type: 'drc',
            id: 'default',
            url: '',
            raw: ''
        };
    }

    // If an active verified source is already determined by link checker, prioritize it!
    if (movie._verifiedSource) {
        return movie._verifiedSource;
    }

    // 1. Check "yt" key (e.g. "yt": "hf-EHqaybqI")
    const rawYt = String(movie.yt || movie.youtube || "").trim();
    if (rawYt) {
        let ytId = rawYt;
        const match = rawYt.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
        if (match && match[1]) {
            ytId = match[1];
        }
        return {
            type: 'yt',
            id: ytId,
            url: `https://www.youtube.com/embed/${ytId}?autoplay=1&enablejsapi=1&rel=0&playsinline=1&iv_load_policy=3&modestbranding=1&fs=0`,
            raw: rawYt
        };
    }

    // 2. Check "drc" key (e.g. "drc": "https://github.com/movieapp05/sps/releases/download/dsp/vdo3.mp4")
    const rawDrc = String(movie.drc || movie.direct || "").trim();
    if (rawDrc) {
        return {
            type: 'drc',
            id: rawDrc,
            url: rawDrc,
            raw: rawDrc
        };
    }

    // 3. Check "video" key (e.g. "video": "1DlvdGn8QaXGuJVbeU6wrKxGUJfV-0Txh0")
    const rawVideo = String(movie.video || movie.videoUrl || movie.streamUrl || movie.link || movie.url || "").trim();
    if (rawVideo) {
        // If it's a YouTube link inside "video"
        if (rawVideo.includes('youtube.com') || rawVideo.includes('youtu.be')) {
            const match = rawVideo.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
            const ytId = match ? match[1] : rawVideo;
            return {
                type: 'yt',
                id: ytId,
                url: `https://www.youtube.com/embed/${ytId}?autoplay=1&enablejsapi=1&rel=0&playsinline=1&iv_load_policy=3&modestbranding=1&fs=0`,
                raw: rawVideo
            };
        }

        // If it's direct HTTP/HTTPS URL
        if (rawVideo.startsWith('http://') || rawVideo.startsWith('https://')) {
            const workerMatch = rawVideo.match(/id=([-\w]{15,})/);
            if (workerMatch && workerMatch[1]) {
                let driveId = workerMatch[1];
                if (driveId.length > 5) {
                    driveId = driveId.slice(0, -1);
                }
                return {
                    type: 'video',
                    id: driveId,
                    url: `https://debasis.installapkapps.workers.dev/?id=${encodeURIComponent(driveId)}`,
                    raw: rawVideo
                };
            }
            const gdriveMatch = rawVideo.match(/\/d\/([-\w]{15,})/);
            if (gdriveMatch && gdriveMatch[1]) {
                let driveId = gdriveMatch[1];
                if (driveId.length > 5) {
                    driveId = driveId.slice(0, -1);
                }
                return {
                    type: 'video',
                    id: driveId,
                    url: `https://debasis.installapkapps.workers.dev/?id=${encodeURIComponent(driveId)}`,
                    raw: rawVideo
                };
            }
            return {
                type: 'drc',
                id: rawVideo,
                url: rawVideo,
                raw: rawVideo
            };
        }

        // Otherwise it is a Google Drive file ID
        // The user specifies: regardless of length (28, 33, 40 etc.), always strip the last extra character
        let cleanId = rawVideo;
        const match = rawVideo.match(/[-\w]{15,}/);
        if (match) {
            cleanId = match[0];
        }
        // Always strip the last character from the ID as requested by the user
        let strippedId = cleanId;
        if (strippedId.length > 5) {
            strippedId = strippedId.slice(0, -1);
        }
        return {
            type: 'video',
            id: strippedId,
            rawId: cleanId,
            url: `https://debasis.installapkapps.workers.dev/?id=${encodeURIComponent(strippedId)}`,
            raw: rawVideo
        };
    }

    // Default fallback
    return {
        type: 'drc',
        id: 'default',
        url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
        raw: ''
    };
}

// Generate Stream URLs based on detected video type ("video", "yt", or "drc")
function getMovieServers(movie) {
    const source = detectMovieVideoSource(movie);

    if (source.type === 'yt') {
        const originParam = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin.startsWith('http')) 
            ? `&origin=${encodeURIComponent(window.location.origin)}` 
            : '';
        return [
            {
                name: "Server 1 (Cloud HD Player)",
                quality: "Auto / 1080p",
                url: `https://www.youtube-nocookie.com/embed/${source.id}?autoplay=1&enablejsapi=1&playsinline=1&rel=0&iv_load_policy=3&modestbranding=1&fs=0${originParam}`,
                type: "yt"
            },
            {
                name: "Server 2 (Fast Stream)",
                quality: "720p HD",
                url: `https://www.youtube.com/embed/${source.id}?autoplay=1&enablejsapi=1&playsinline=1&rel=0&iv_load_policy=3&modestbranding=1&fs=0${originParam}`,
                type: "yt"
            }
        ];
    }

    if (source.type === 'drc') {
        return [
            {
                name: "Server 1 (Direct HD Stream)",
                quality: "1080p Ultra HD",
                url: source.url,
                type: "drc"
            },
            {
                name: "Server 2 (Direct Fast Stream)",
                quality: "720p HD",
                url: source.url,
                type: "drc"
            }
        ];
    }

    // Default "video" (Google Drive stream through worker)
    const cleanId = source.id;
    return [
        {
            name: "Server 1 (Fast Worker Stream)",
            quality: "1080p Ultra HD",
            url: `https://debasis.installapkapps.workers.dev/?id=${encodeURIComponent(cleanId)}`,
            type: "video"
        },
        {
            name: "Server 2 (Drive Direct HD)",
            quality: "720p HD",
            url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(cleanId)}`,
            type: "video"
        },
        {
            name: "Server 3 (Docs Stream)",
            quality: "Auto Quality",
            url: `https://docs.google.com/uc?export=open&id=${encodeURIComponent(cleanId)}`,
            type: "video"
        }
    ];
}

// Screen Orientation Landscape Lock & Unlock on Fullscreen
async function tryNativeOrientationLock() {
    // 1. Android APK native interface
    if (window.Android && typeof window.Android.setLandscape === 'function') {
        try {
            window.Android.setLandscape();
            return true;
        } catch (e) {}
    }
    if (window.Android && typeof window.Android.setOrientation === 'function') {
        try {
            window.Android.setOrientation('landscape');
            return true;
        } catch (e) {}
    }

    // 2. Screen Orientation API (Modern mobile browsers)
    const targets = ['landscape', 'landscape-primary', 'landscape-secondary'];
    for (const orient of targets) {
        try {
            if (screen.orientation && typeof screen.orientation.lock === 'function') {
                await screen.orientation.lock(orient);
                return true;
            }
        } catch (err) {}
    }

    // 3. Legacy vendor prefixes
    try {
        const so = screen;
        if (so.lockOrientation && so.lockOrientation('landscape')) return true;
        if (so.mozLockOrientation && so.mozLockOrientation('landscape')) return true;
        if (so.msLockOrientation && so.msLockOrientation('landscape')) return true;
        if (so.webkitLockOrientation && so.webkitLockOrientation('landscape')) return true;
    } catch (e) {}

    return false;
}

function applyCssLandscapeIfPortrait() {
    const isFs = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement ||
        (currentPlyrInstance && currentPlyrInstance.fullscreen && currentPlyrInstance.fullscreen.active)
    );
    const playerBox = document.getElementById('activePlayerBox');
    const plyrContainer = currentPlyrInstance?.elements?.container || playerBox;

    if (isFs && window.innerHeight > window.innerWidth) {
        if (plyrContainer) plyrContainer.classList.add('plyr-force-landscape');
        if (playerBox) playerBox.classList.add('plyr-force-landscape');
    } else {
        if (plyrContainer) plyrContainer.classList.remove('plyr-force-landscape');
        if (playerBox) {
            playerBox.classList.remove('plyr-force-landscape');
            if (!isFs) {
                playerBox.classList.remove('is-fullscreen');
            }
        }
    }
}

async function lockLandscapeOrientation() {
    // Immediate attempt on user gesture
    let locked = await tryNativeOrientationLock();

    // Fullscreen transitions are asynchronous on mobile devices (100-300ms).
    // Retry native orientation lock as fullscreen activates:
    const delays = [60, 150, 300, 500];
    delays.forEach(delay => {
        setTimeout(async () => {
            if (!locked) {
                locked = await tryNativeOrientationLock();
            }
            // If device is still in portrait orientation, apply CSS landscape rotation fallback
            if (window.innerHeight > window.innerWidth) {
                applyCssLandscapeIfPortrait();
            } else {
                const playerBox = document.getElementById('activePlayerBox');
                const plyrContainer = currentPlyrInstance?.elements?.container || playerBox;
                if (plyrContainer) plyrContainer.classList.remove('plyr-force-landscape');
                if (playerBox) playerBox.classList.remove('plyr-force-landscape');
            }
        }, delay);
    });
}

function unlockScreenOrientation() {
    // 1. Android APK native interface
    if (window.Android && typeof window.Android.unlockOrientation === 'function') {
        try { window.Android.unlockOrientation(); } catch (e) {}
    } else if (window.Android && typeof window.Android.setPortrait === 'function') {
        try { window.Android.setPortrait(); } catch (e) {}
    }

    // 2. Remove CSS rotation & exit fallback fullscreen
    const playerBox = document.getElementById('activePlayerBox');
    const plyrContainer = currentPlyrInstance?.elements?.container || playerBox;
    if (plyrContainer) {
        plyrContainer.classList.remove('plyr-force-landscape');
    }
    if (playerBox) {
        playerBox.classList.remove('plyr-force-landscape');
        const fsEl = document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement;
        if (!fsEl) {
            playerBox.classList.remove('is-fullscreen');
        }
    }

    // 3. Screen orientation unlock
    try {
        if (screen.orientation && typeof screen.orientation.unlock === 'function') {
            screen.orientation.unlock();
            return;
        }
    } catch (e) {}

    try {
        const so = screen;
        if (so.unlockOrientation) so.unlockOrientation();
        else if (so.mozUnlockOrientation) so.mozUnlockOrientation();
        else if (so.msUnlockOrientation) so.msUnlockOrientation();
        else if (so.webkitUnlockOrientation) so.webkitUnlockOrientation();
    } catch (e) {}
}

function updateFullscreenButtonState(isFs) {
    const fsBtn = document.getElementById('ytShieldFsBtn');
    if (fsBtn) {
        fsBtn.innerHTML = `<i class="fa-solid ${isFs ? 'fa-compress' : 'fa-expand'}"></i>`;
        fsBtn.title = isFs ? 'Exit Fullscreen' : 'Fullscreen';
    }
    const topShield = document.getElementById('ytTopShield');
    if (topShield) {
        if (isFs) topShield.classList.add('active-fullscreen');
        else topShield.classList.remove('active-fullscreen');
    }
    if (isFs) {
        if (window.Android && typeof window.Android.hideMrecAd === 'function') {
            try { window.Android.hideMrecAd(); } catch (e) {}
        }
    } else {
        setTimeout(() => {
            if (typeof syncNativeMrecAdView === 'function') {
                syncNativeMrecAdView();
            }
        }, 200);
    }
}
window.updateFullscreenButtonState = updateFullscreenButtonState;

// Global Fullscreen Event Listeners for Automatic Landscape Orientation
const handleGlobalFullscreenOrientation = () => {
    // Retain landscape orientation if Smartlink interstitial ad is active over fullscreen
    if (isSmartlinkInterstitialActive && wasFullscreenBeforeInterstitial) {
        return;
    }
    // Retain landscape orientation during auto-next transition between videos
    if (isAutoNextTransitioning && wasFullscreenBeforeNext) {
        return;
    }
    const box = document.getElementById('activePlayerBox');
    const iframe = document.getElementById('vdoSkyYouTube');
    const fsEl = document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement;

    // If the YouTube iframe itself was put into fullscreen, switch fullscreen to activePlayerBox
    // so protective shields remain active and fully cover the YouTube logo and playlist controls!
    if (fsEl && iframe && fsEl === iframe && box) {
        if (document.exitFullscreen) {
            document.exitFullscreen().then(() => {
                if (box.requestFullscreen) {
                    box.requestFullscreen({ navigationUI: 'hide' }).then(() => {
                        lockLandscapeOrientation();
                    }).catch(() => {
                        lockLandscapeOrientation();
                    });
                } else if (box.webkitRequestFullscreen) {
                    box.webkitRequestFullscreen();
                    lockLandscapeOrientation();
                }
            }).catch(() => {});
        }
        return;
    }

    const isFs = Boolean(
        fsEl ||
        (currentPlyrInstance && currentPlyrInstance.fullscreen && currentPlyrInstance.fullscreen.active && currentPlyrInstance.elements?.container?.classList?.contains('plyr--fullscreen-fallback'))
    );
    if (isFs) {
        if (box) box.classList.add('is-fullscreen');
        lockLandscapeOrientation();
        updateFullscreenButtonState(true);
    } else {
        if (box) {
            box.classList.remove('is-fullscreen');
            box.classList.remove('plyr-force-landscape');
        }
        const plyrContainer = currentPlyrInstance?.elements?.container;
        if (plyrContainer) {
            plyrContainer.classList.remove('plyr-force-landscape');
        }
        unlockScreenOrientation();
        updateFullscreenButtonState(false);
    }
};

document.addEventListener('fullscreenchange', handleGlobalFullscreenOrientation);
document.addEventListener('webkitfullscreenchange', handleGlobalFullscreenOrientation);
document.addEventListener('mozfullscreenchange', handleGlobalFullscreenOrientation);
document.addEventListener('MSFullscreenChange', handleGlobalFullscreenOrientation);

window.addEventListener('resize', () => {
    const isFs = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement ||
        (currentPlyrInstance && currentPlyrInstance.fullscreen && currentPlyrInstance.fullscreen.active)
    );
    const playerBox = document.getElementById('activePlayerBox');
    const plyrContainer = currentPlyrInstance?.elements?.container || playerBox;
    if (isFs) {
        if (window.innerWidth > window.innerHeight) {
            if (plyrContainer) plyrContainer.classList.remove('plyr-force-landscape');
            if (playerBox) playerBox.classList.remove('plyr-force-landscape');
        } else {
            applyCssLandscapeIfPortrait();
        }
    } else {
        if (plyrContainer) plyrContainer.classList.remove('plyr-force-landscape');
        if (playerBox) {
            playerBox.classList.remove('plyr-force-landscape');
            playerBox.classList.remove('is-fullscreen');
        }
    }
});

window.addEventListener('orientationchange', () => {
    setTimeout(() => {
        const isFs = !!(
            document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement ||
            (currentPlyrInstance && currentPlyrInstance.fullscreen && currentPlyrInstance.fullscreen.active)
        );
        const playerBox = document.getElementById('activePlayerBox');
        const plyrContainer = currentPlyrInstance?.elements?.container || playerBox;
        if (isFs) {
            if (window.innerWidth > window.innerHeight) {
                if (plyrContainer) plyrContainer.classList.remove('plyr-force-landscape');
                if (playerBox) playerBox.classList.remove('plyr-force-landscape');
            }
        } else {
            if (plyrContainer) plyrContainer.classList.remove('plyr-force-landscape');
            if (playerBox) {
                playerBox.classList.remove('plyr-force-landscape');
                playerBox.classList.remove('is-fullscreen');
            }
        }
    }, 200);
});

// Initialize Plyr player on HTML5 video element
function initPlyrPlayer(videoEl, movie, activeServerIndex) {
    destroyCurrentPlyr();
    if (!videoEl) return;

    const PlyrConstructor = window.Plyr;
    if (!PlyrConstructor) {
        console.warn("Plyr not found on window, fallback to native video controls");
        videoEl.controls = true;
        return;
    }

    try {
        currentPlyrInstance = new PlyrConstructor(videoEl, {
            controls: [
                'play-large',
                'rewind',
                'play',
                'fast-forward',
                'progress',
                'current-time',
                'duration',
                'mute',
                'volume',
                'captions',
                'fullscreen'
            ],
            settings: [],
            seekTime: 10,
            keyboard: { focused: true, global: false },
            tooltips: { controls: true, seek: true },
            fullscreen: { enabled: true, fallback: true, iosNative: true }
        });

        // Intercept user click on Plyr's fullscreen icon button during user activation
        currentPlyrInstance.on('ready', () => {
            const container = currentPlyrInstance.elements.container;
            if (container) {
                container.style.position = 'relative';

                // Inject central buffering spinner directly inside Plyr container (visible in normal & fullscreen)
                let bufferOverlay = container.querySelector('.plyr-buffering-overlay');
                if (!bufferOverlay) {
                    bufferOverlay = document.createElement('div');
                    bufferOverlay.className = 'plyr-buffering-overlay';
                    bufferOverlay.style.display = 'none';
                    bufferOverlay.innerHTML = `
                        <div class="plyr-buffer-spinner-ring"></div>
                        <span class="plyr-buffer-text">Buffering Stream...</span>
                    `;
                    container.appendChild(bufferOverlay);
                }

                const showBuffering = () => {
                    if (bufferOverlay) bufferOverlay.style.display = 'flex';
                };
                const hideBuffering = () => {
                    if (bufferOverlay) bufferOverlay.style.display = 'none';
                };

                // Plyr seek & buffering events
                currentPlyrInstance.on('seeking', showBuffering);
                currentPlyrInstance.on('waiting', showBuffering);
                currentPlyrInstance.on('loadstart', showBuffering);
                currentPlyrInstance.on('playing', hideBuffering);
                currentPlyrInstance.on('canplay', hideBuffering);
                currentPlyrInstance.on('canplaythrough', hideBuffering);
                currentPlyrInstance.on('seeked', () => {
                    setTimeout(() => {
                        if (videoEl.readyState >= 3 && !videoEl.seeking) {
                            hideBuffering();
                        }
                    }, 200);
                });

                // Direct timeline range slider clicks & drags
                const seekRange = container.querySelector('[data-plyr="seek"]');
                if (seekRange) {
                    seekRange.addEventListener('pointerdown', showBuffering);
                    seekRange.addEventListener('mousedown', showBuffering);
                    seekRange.addEventListener('touchstart', showBuffering);
                    seekRange.addEventListener('input', showBuffering);
                    seekRange.addEventListener('change', showBuffering);
                }

                // Rewind / Fast-forward buttons
                const rewindBtn = container.querySelector('[data-plyr="rewind"]');
                if (rewindBtn) rewindBtn.addEventListener('click', showBuffering);
                const fastFwdBtn = container.querySelector('[data-plyr="fast-forward"]');
                if (fastFwdBtn) fastFwdBtn.addEventListener('click', showBuffering);

                container.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-plyr="fullscreen"]');
                    if (btn) {
                        const isCurrentlyFs = !!(
                            (currentPlyrInstance && currentPlyrInstance.fullscreen && currentPlyrInstance.fullscreen.active) ||
                            document.fullscreenElement ||
                            document.webkitFullscreenElement
                        );
                        if (!isCurrentlyFs) {
                            const box = document.getElementById('activePlayerBox');
                            if (box) box.classList.add('is-fullscreen');
                            lockLandscapeOrientation();
                            updateFullscreenButtonState(true);
                        } else {
                            const box = document.getElementById('activePlayerBox');
                            if (box) {
                                box.classList.remove('is-fullscreen');
                                box.classList.remove('plyr-force-landscape');
                            }
                            if (container) {
                                container.classList.remove('plyr-force-landscape');
                            }
                            unlockScreenOrientation();
                            updateFullscreenButtonState(false);
                        }
                    }
                }, true);
            }

            // Attempt autoplay smoothly
            try {
                const playPromise = currentPlyrInstance.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => {
                        // Expected when browser blocks unmuted autoplay
                    });
                }
            } catch (e) {}
        });

        // Native video listeners for buffering
        videoEl.addEventListener('seeking', () => {
            const overlay = currentPlyrInstance?.elements?.container?.querySelector('.plyr-buffering-overlay');
            if (overlay) overlay.style.display = 'flex';
        });
        videoEl.addEventListener('waiting', () => {
            const overlay = currentPlyrInstance?.elements?.container?.querySelector('.plyr-buffering-overlay');
            if (overlay) overlay.style.display = 'flex';
        });
        videoEl.addEventListener('stalled', () => {
            const overlay = currentPlyrInstance?.elements?.container?.querySelector('.plyr-buffering-overlay');
            if (overlay) overlay.style.display = 'flex';
        });
        videoEl.addEventListener('playing', () => {
            const overlay = currentPlyrInstance?.elements?.container?.querySelector('.plyr-buffering-overlay');
            if (overlay) overlay.style.display = 'none';
        });
        videoEl.addEventListener('canplay', () => {
            const overlay = currentPlyrInstance?.elements?.container?.querySelector('.plyr-buffering-overlay');
            if (overlay) overlay.style.display = 'none';
        });

        // Lock landscape on Plyr fullscreen event
        currentPlyrInstance.on('enterfullscreen', () => {
            const box = document.getElementById('activePlayerBox');
            if (box) box.classList.add('is-fullscreen');
            lockLandscapeOrientation();
            updateFullscreenButtonState(true);
        });

        // Restore orientation and exit fullscreen cleanly on Plyr exit fullscreen
        currentPlyrInstance.on('exitfullscreen', () => {
            const box = document.getElementById('activePlayerBox');
            if (box) {
                box.classList.remove('is-fullscreen');
                box.classList.remove('plyr-force-landscape');
            }
            const container = currentPlyrInstance?.elements?.container;
            if (container) {
                container.classList.remove('plyr-force-landscape');
            }
            unlockScreenOrientation();
            updateFullscreenButtonState(false);
        });

        // Native iOS & WebKit video fullscreen handlers
        videoEl.addEventListener('webkitbeginfullscreen', () => {
            const box = document.getElementById('activePlayerBox');
            if (box) box.classList.add('is-fullscreen');
            lockLandscapeOrientation();
            updateFullscreenButtonState(true);
        });
        videoEl.addEventListener('webkitendfullscreen', () => {
            const box = document.getElementById('activePlayerBox');
            if (box) {
                box.classList.remove('is-fullscreen');
                box.classList.remove('plyr-force-landscape');
            }
            const container = currentPlyrInstance?.elements?.container;
            if (container) {
                container.classList.remove('plyr-force-landscape');
            }
            unlockScreenOrientation();
            updateFullscreenButtonState(false);
        });

        // Video completion triggers Auto Next
        currentPlyrInstance.on('ended', () => {
            handleVideoEnded();
        });
        videoEl.addEventListener('ended', () => {
            handleVideoEnded();
        });

        // Listen for errors to prompt user to switch stream server (capture phase catches <source> errors too)
        videoEl.addEventListener('error', (e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            const errorBox = document.getElementById('playerStreamErrorNotice');
            if (errorBox) errorBox.style.display = 'flex';
        }, true);

    } catch (err) {
        console.warn("Failed to initialize Plyr, using native controls:", err);
        videoEl.controls = true;
    }
}

// ==========================================
// 300x250 MEDIUM RECTANGLE AD UNITS
// ==========================================
let ad300x250Observer = null;

function getAd300x250Observer() {
    if (!ad300x250Observer && window.IntersectionObserver) {
        ad300x250Observer = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const target = entry.target;
                    renderAd300x250Iframe(target);
                    observer.unobserve(target);
                }
            });
        }, { rootMargin: "350px 0px" });
    }
    return ad300x250Observer;
}

const STARTIO_APP_ID = "203877183";
const FB_NATIVE_BANNER_PLACEMENT_ID = STARTIO_APP_ID;
const FB_MREC_PLACEMENT_ID = STARTIO_APP_ID;
let mrecAdCounter = 0;
let mrecSlotIdCounter = 0;
let mrecSyncInterval = null;

function syncNativeMrecAdView() {
    if (window.Android && typeof window.Android.hideAllMrecAds === 'function') {
        try { window.Android.hideAllMrecAds(); } catch (e) {}
    }
}

function startMrecSync() {
    stopMrecSync();
}

function stopMrecSync() {
    if (mrecSyncInterval) {
        clearInterval(mrecSyncInterval);
        mrecSyncInterval = null;
    }
    if (window.Android && typeof window.Android.hideAllMrecAds === 'function') {
        try { window.Android.hideAllMrecAds(); } catch (e) {}
    } else if (window.Android && typeof window.Android.hideMrecAd === 'function') {
        try { window.Android.hideMrecAd(); } catch (e) {}
    }
}

window.addEventListener('scroll', () => {}, { passive: true });

window.onStartIoMrecSlotLoadedState = function() {};
window.onFacebookMrecSlotLoadedState = function() {};
window.onStartIoMrecLoadedState = function() {};
window.onFacebookMrecLoadedState = function() {};

const MREC_ADS_CAMPAIGNS = [];

function renderAd300x250Iframe(container) {
    if (container) {
        container.innerHTML = '';
        container.style.display = 'none';
    }
}

function createAd300x250Element(lazy = true) {
    const dummy = document.createElement('div');
    dummy.className = 'ad-slot-300x250 ads-removed';
    dummy.style.display = 'none';
    return dummy;
}

function rebindUnloadedAds() {}

/* ==================================================
   GOOGLE DRIVE & MOVIE VIDEO LINK VERIFIER & ERROR POPUP
   ================================================== */
window.__lastFailedMovieForComment = null;

window.showThemePlayerError = function(movie) {
    window.__lastFailedMovieForComment = movie || null;
    const errPopup = document.getElementById("errorPopup");
    const movieNameEl = document.getElementById("errorPopupMovieName");
    if (movieNameEl) {
        if (movie && (movie.title || movie.name)) {
            movieNameEl.textContent = `"${movie.title || movie.name}"`;
            movieNameEl.style.display = 'block';
        } else {
            movieNameEl.style.display = 'none';
        }
    }
    if (errPopup) errPopup.style.display = "flex";
};

window.closeThemeErrorPopup = function() {
    const errPopup = document.getElementById("errorPopup");
    if (errPopup) errPopup.style.display = "none";
};

window.handleThemeCommentClick = function() {
    const movie = window.__lastFailedMovieForComment;
    const movieTitle = movie ? (movie.title || movie.name || '') : '';
    window.closeThemeErrorPopup();
    
    // Automatically copy pre-filled comment text to clipboard
    if (movieTitle) {
        const commentTemplate = `Report: Movie "${movieTitle}" is not working / video link broken. Please fix!`;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(commentTemplate).then(() => {
                showToast(`Copied movie report: "${movieTitle}"! Paste in comment.`);
            }).catch(() => {});
        } else {
            showToast(`Report for: "${movieTitle}"`);
        }
    }

    if (typeof window.openCommentSection === 'function') {
        window.openCommentSection(movieTitle);
    } else {
        const commentSection = document.getElementById("comments") || document.getElementById("comment-holder") || document.querySelector('.comments');
        if (commentSection) {
            commentSection.scrollIntoView({ behavior: 'smooth' });
        }
    }
};

function performOpenPlayerDirect(movie, preserveFullscreen = false) {
    if (!movie) return;

    // Save previous scroll position
    if (!isPlayerView) {
        savedScrollPosition = window.scrollY;
    }
    currentPlayingMovie = movie;
    isPlayerView = true;
    updateHeaderButton();

    window.history.pushState({ view: 'player', title: movie.title }, '');
    if (!preserveFullscreen) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    renderPlayerSection(movie, 0, preserveFullscreen);
}

// Test if a specific Google Drive candidate ID is active & working
function testDriveCandidate(cand) {
    return new Promise((resolve) => {
        if (!cand || cand === 'default' || cand.length < 10) {
            resolve(false);
            return;
        }

        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(false);
            }
        }, 3200);

        function markSuccess() {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(true);
            }
        }

        // Method 1: Lightweight Worker probe with Range request (CORS-enabled, 1-byte check)
        const workerUrl = "https://debasis.installapkapps.workers.dev/?id=" + encodeURIComponent(cand);
        fetch(workerUrl, {
            method: 'GET',
            headers: { 'Range': 'bytes=0-1' },
            cache: 'no-store'
        }).then(res => {
            // Worker returns 200 or 206 for valid active files; 404 or 400 for dead/deleted/invalid IDs
            if (res.status === 200 || res.status === 206) {
                markSuccess();
            }
        }).catch(() => {});

        // Method 2: Google lh3 thumbnail ping (cross-origin image check)
        try {
            const checkUrl = "https://lh3.googleusercontent.com/u/0/d/" + encodeURIComponent(cand) + "=w200-h200-p";
            const img = new Image();
            img.onload = function() {
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    markSuccess();
                }
            };
            img.onerror = function(e) {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            };
            img.src = checkUrl;
        } catch (err) {}
    });
}

// Test direct video URLs (drc / mp4 / m3u8)
function testDirectVideoUrl(url) {
    return new Promise((resolve) => {
        if (!url || !url.startsWith('http')) {
            resolve(false);
            return;
        }

        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(false);
            }
        }, 3500);

        // Probe 1: Fetch with Range
        fetch(url, {
            method: 'GET',
            headers: { 'Range': 'bytes=0-1' },
            cache: 'no-store'
        }).then(res => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(res.ok || res.status === 200 || res.status === 206 || res.status === 302);
            }
        }).catch(() => {
            // Probe 2: Native HTML5 video metadata check
            try {
                const probeVideo = document.createElement('video');
                probeVideo.preload = 'metadata';
                probeVideo.onloadedmetadata = () => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        probeVideo.removeAttribute('src');
                        probeVideo.load();
                        resolve(true);
                    }
                };
                probeVideo.onerror = () => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        probeVideo.removeAttribute('src');
                        probeVideo.load();
                        resolve(false);
                    }
                };
                probeVideo.src = url;
            } catch (e) {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(false);
                }
            }
        });
    });
}

// Test YouTube ID validity
function testYouTubeVideo(ytId) {
    return new Promise((resolve) => {
        if (!ytId || ytId.length !== 11) {
            resolve(false);
            return;
        }

        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(true); // Don't block YouTube if network thumbnail check times out
            }
        }, 2500);

        const img = new Image();
        img.onload = () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                // When YouTube video is unavailable/deleted, mqdefault returns a 120px wide placeholder
                resolve(img.naturalWidth > 120);
            }
        };
        img.onerror = () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        };
        img.src = `https://img.youtube.com/vi/${encodeURIComponent(ytId)}/mqdefault.jpg`;
    });
}

// Master Link Verifier: accurately checks if stream link is valid and working
async function verifyMovieLink(movie) {
    if (!movie) return { valid: false, reason: 'no_movie' };

    const rawVideo = String(movie.video || movie.videoUrl || movie.streamUrl || movie.link || movie.url || '').trim();
    const rawYt = String(movie.yt || movie.youtube || '').trim();
    const rawDrc = String(movie.drc || movie.direct || '').trim();

    // 1. If completely empty or default mock, fail immediately
    if (!rawVideo && !rawYt && !rawDrc) {
        return { valid: false, reason: 'empty_link' };
    }
    if (rawVideo === 'default' && !rawYt && !rawDrc) {
        return { valid: false, reason: 'default_link' };
    }

    // 2. YouTube Links
    if (rawYt || rawVideo.includes('youtube.com') || rawVideo.includes('youtu.be')) {
        let ytId = rawYt;
        if (!ytId) {
            const match = rawVideo.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
            ytId = match ? match[1] : '';
        }
        if (!ytId || ytId.length !== 11) {
            return { valid: false, reason: 'invalid_yt_id' };
        }
        const isYtAlive = await testYouTubeVideo(ytId);
        if (isYtAlive) {
            return {
                valid: true,
                verifiedSource: {
                    type: 'yt',
                    id: ytId,
                    url: `https://www.youtube.com/embed/${ytId}?autoplay=1&enablejsapi=1&rel=0&playsinline=1&iv_load_policy=3&modestbranding=1&fs=0`,
                    raw: rawYt || rawVideo
                }
            };
        }
        return { valid: false, reason: 'youtube_dead' };
    }

    // 3. Google Drive Video Links
    let baseDriveId = '';
    const match = rawVideo.match(/[-\w]{15,}/);
    if (match && !rawVideo.startsWith('http')) {
        baseDriveId = match[0];
    } else if (rawVideo.includes('/d/')) {
        const m = rawVideo.match(/\/d\/([-\w]{15,})/);
        if (m) baseDriveId = m[1];
    } else if (rawVideo.includes('id=')) {
        const m = rawVideo.match(/id=([-\w]{15,})/);
        if (m) baseDriveId = m[1];
    }

    if (baseDriveId) {
        // Strip trailing extra character first (as prioritized by storage system), then try base
        const strippedId = baseDriveId.length > 5 ? baseDriveId.slice(0, -1) : baseDriveId;
        const candidates = [strippedId];
        if (baseDriveId !== strippedId) {
            candidates.push(baseDriveId);
        }

        // Test candidates: if ANY candidate is active and reachable, pass with that candidate
        for (const cand of candidates) {
            const isAlive = await testDriveCandidate(cand);
            if (isAlive) {
                return {
                    valid: true,
                    verifiedSource: {
                        type: 'video',
                        id: cand,
                        rawId: baseDriveId,
                        url: `https://debasis.installapkapps.workers.dev/?id=${encodeURIComponent(cand)}`,
                        raw: rawVideo
                    }
                };
            }
        }

        // Both candidates failed: the link is broken / 404 / deleted!
        return { valid: false, reason: 'drive_dead' };
    }

    // 4. Direct video URL (drc)
    const directUrl = rawDrc || (rawVideo.startsWith('http') ? rawVideo : '');
    if (directUrl) {
        if (directUrl.includes('TearsOfSteel.mp4') || directUrl.includes('sample/')) {
            return { valid: false, reason: 'sample_placeholder' };
        }
        const isDirectAlive = await testDirectVideoUrl(directUrl);
        if (isDirectAlive) {
            return {
                valid: true,
                verifiedSource: {
                    type: 'drc',
                    id: directUrl,
                    url: directUrl,
                    raw: directUrl
                }
            };
        }
        return { valid: false, reason: 'direct_dead' };
    }

    // Default: link cannot be resolved
    return { valid: false, reason: 'unknown_source' };
}

// Open Dedicated Player Section with Accurate Link Verification & Spring Loader
window.openPlayer = async function(movie, preserveFullscreen = false) {
    if (!movie) return;

    // Strict Subscription Gate: Bina subscription kore kichui play hobe na
    if (!window.isUserSubscribed()) {
        window.showSubscriptionRequiredPopup('movie', movie.title || movie.name || 'Movie');
        return;
    }

    // Close any previous error popup
    window.closeThemeErrorPopup();

    const rawVideoStr = String(movie.video || movie.videoUrl || movie.streamUrl || movie.link || movie.url || '').trim();
    const rawYt = String(movie.yt || movie.youtube || '').trim();
    const rawDrc = String(movie.drc || movie.direct || '').trim();

    // If completely empty, reject immediately without delay
    if (!rawVideoStr && !rawYt && !rawDrc) {
        window.showThemePlayerError(movie);
        return;
    }

    // Show spring loader while checking link
    const springLoader = document.getElementById("movieVerifierLoader");
    if (springLoader) {
        springLoader.style.display = "flex";
        const subEl = springLoader.querySelector('.spring-loader-sub');
        if (subEl) subEl.textContent = 'Verifying stream server, please wait...';
    }

    try {
        const verifyResult = await verifyMovieLink(movie);

        // Always hide loader once check is finished
        if (springLoader) springLoader.style.display = "none";

        if (verifyResult && verifyResult.valid) {
            // Apply verified working source to the movie object
            if (verifyResult.verifiedSource) {
                movie._verifiedSource = verifyResult.verifiedSource;
            }
            performOpenPlayerDirect(movie, preserveFullscreen);
        } else {
            // STRICT REJECTION: Invalid, dead, or broken links MUST NEVER open the player!
            console.warn("Link verification failed for movie:", movie.title || movie.name, verifyResult?.reason);
            window.showThemePlayerError(movie);
        }
    } catch (err) {
        console.error("Link verification encountered unexpected error:", err);
        if (springLoader) springLoader.style.display = "none";
        window.showThemePlayerError(movie);
    }
};

// Safe trim helper that handles arrays, objects, strings, numbers, and null/undefined
function safeTrim(val) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
    return String(val).trim();
}

// Calculate 20 highly related movies based on Category, Cast, Title Keywords, and Tags
function getRelatedMovies(currentMovie, limit = 20) {
    if (!Array.isArray(allMovies) || allMovies.length === 0) return [];
    if (!currentMovie) return allMovies.slice(0, limit);

    const curTitle = safeTrim(currentMovie.title || currentMovie.name).toLowerCase();
    const curCategory = safeTrim(currentMovie.category).toLowerCase();
    const curCast = safeTrim(currentMovie.cast).toLowerCase();
    const curTags = safeTrim(currentMovie.tags).toLowerCase();
    
    // Meaningful title keywords (skip common words)
    const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'movie', 'full', 'hd', 'part', 'hindi', 'dubbed', 'watch', 'video']);
    const curWords = curTitle.replace(/[^a-zA-Z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));

    // Exclude current playing movie
    const candidates = allMovies.filter(m => {
        if (!m) return false;
        if (m === currentMovie) return false;
        if (m.id && currentMovie.id && m.id === currentMovie.id) return false;
        const t = safeTrim(m.title || m.name).toLowerCase();
        if (t && curTitle && t === curTitle) return false;
        return true;
    });

    if (candidates.length <= limit) return candidates;

    // Score relevance
    const scored = candidates.map(m => {
        let score = 0;
        const mCat = safeTrim(m.category).toLowerCase();
        const mCast = safeTrim(m.cast).toLowerCase();
        const mTags = safeTrim(m.tags).toLowerCase();
        const mTitle = safeTrim(m.title || m.name).toLowerCase();

        // 1. Same category match (primary factor)
        if (curCategory && mCat) {
            if (curCategory === mCat) {
                score += 50;
            } else if (mCat.includes(curCategory) || curCategory.includes(mCat)) {
                score += 35;
            }
        }

        // 2. Cast match
        if (curCast && mCast) {
            const castItems = curCast.split(/[,/]+/).map(c => safeTrim(c).toLowerCase()).filter(c => c.length > 2);
            for (const c of castItems) {
                if (mCast.includes(c)) score += 30;
            }
        }

        // 3. Title keywords overlap
        for (const w of curWords) {
            if (mTitle.includes(w)) score += 20;
        }

        // 4. Tags overlap
        if (curTags && mTags && curTags === mTags) {
            score += 15;
        }

        // 5. Rating weight
        const rating = parseFloat(m.rating) || 0;
        score += Math.min(rating, 5);

        return { movie: m, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const result = [];
    const seen = new Set();

    for (const item of scored) {
        if (result.length >= limit) break;
        const idOrTitle = item.movie.id || item.movie.title;
        if (!seen.has(idOrTitle)) {
            seen.add(idOrTitle);
            result.push(item.movie);
        }
    }

    // Fill remaining slots up to limit from candidate list
    if (result.length < limit) {
        for (const m of candidates) {
            if (result.length >= limit) break;
            const idOrTitle = m.id || m.title;
            if (!seen.has(idOrTitle)) {
                seen.add(idOrTitle);
                result.push(m);
            }
        }
    }

    return result.slice(0, limit);
}

// Curated High Quality Real YouTube Full Movies & Videos Catalog (100% verified working IDs & thumbnails)
const CURATED_YOUTUBE_CATALOG = [
    {
        videoId: 'DKhcGYlnfdY',
        yt: 'DKhcGYlnfdY',
        title: 'Yeh Majhdhaar (1996) Full Hindi Movie | Salman Khan, Manisha Koirala, Rahul Roy',
        poster: 'https://i.ytimg.com/vi/DKhcGYlnfdY/hqdefault.jpg',
        duration: '2:19:41',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Goldmines Bollywood'
    },
    {
        videoId: 'QaloT95dYRE',
        yt: 'QaloT95dYRE',
        title: 'Judwaa (HD) Full Hindi Comedy Movie | Salman Khan, Karisma Kapoor, Rambha',
        poster: 'https://i.ytimg.com/vi/QaloT95dYRE/hqdefault.jpg',
        duration: '2:18:30',
        rating: '4.9',
        category: 'YouTube Video',
        channel: 'Shemaroo'
    },
    {
        videoId: 'eOEGcZupyWU',
        yt: 'eOEGcZupyWU',
        title: 'Karan Arjun (1995) Full Hindi Action Movie | Shah Rukh Khan, Salman Khan, Kajol',
        poster: 'https://i.ytimg.com/vi/eOEGcZupyWU/hqdefault.jpg',
        duration: '2:45:00',
        rating: '4.9',
        category: 'YouTube Video',
        channel: 'Ultra Bollywood'
    },
    {
        videoId: '2mwVKYPl4P8',
        yt: '2mwVKYPl4P8',
        title: 'Sanam Bewafa {HD} Superhit Romantic Movie | Salman Khan, Chandni, Danny',
        poster: 'https://i.ytimg.com/vi/2mwVKYPl4P8/hqdefault.jpg',
        duration: '2:38:12',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Shemaroo'
    },
    {
        videoId: 'Js2C11L7DU4',
        yt: 'Js2C11L7DU4',
        title: 'Biwi Ho To Aisi Full Movie | Salman Khan First Movie | Rekha, Farooq Shaikh',
        poster: 'https://i.ytimg.com/vi/Js2C11L7DU4/hqdefault.jpg',
        duration: '2:14:40',
        rating: '4.7',
        category: 'YouTube Video',
        channel: 'NH Studioz'
    },
    {
        videoId: '8YcicFH4ODQ',
        yt: '8YcicFH4ODQ',
        title: 'Suryavanshi | Hindi Full Movie | Salman Khan | Amrita Singh | Hindi Action Movie',
        poster: 'https://i.ytimg.com/vi/8YcicFH4ODQ/hqdefault.jpg',
        duration: '2:24:15',
        rating: '4.6',
        category: 'YouTube Video',
        channel: 'Bolly Blockbuster'
    },
    {
        videoId: 'ZvdIpqnHf5g',
        yt: 'ZvdIpqnHf5g',
        title: 'Salman Khan Birthday Special | Yeh Majhdhaar HD | Rahul Roy, Manisha Koirala',
        poster: 'https://i.ytimg.com/vi/ZvdIpqnHf5g/hqdefault.jpg',
        duration: '2:15:20',
        rating: '4.7',
        category: 'YouTube Video',
        channel: 'Goldmines Bollywood'
    },
    {
        videoId: 'YBXtjHi2HZg',
        yt: 'YBXtjHi2HZg',
        title: 'Kya Zamana Aa Gaya | Yeh Majhdhaar 1996 Songs | Salman Khan',
        poster: 'https://i.ytimg.com/vi/YBXtjHi2HZg/hqdefault.jpg',
        duration: '6:27',
        rating: '4.9',
        category: 'YouTube Video',
        channel: 'Goldmines Gaane Sune Ansune'
    },
    {
        videoId: 'XaFnsdQg3l8',
        yt: 'XaFnsdQg3l8',
        title: 'Main Isse Mohabbat Karta Hoon | Yeh Majhdhaar 1996 Songs | Salman Khan',
        poster: 'https://i.ytimg.com/vi/XaFnsdQg3l8/hqdefault.jpg',
        duration: '6:06',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Goldmines Gaane Sune Ansune'
    },
    {
        videoId: 'GLGUKqqu7sQ',
        yt: 'GLGUKqqu7sQ',
        title: 'Kung Fu Full Action Movie | Ram Charan | Pooja Hegde | South Hindi Action Movie',
        poster: 'https://i.ytimg.com/vi/GLGUKqqu7sQ/hqdefault.jpg',
        duration: '2:10:00',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Movie Zilla - Hindi Movies'
    },
    {
        videoId: 'UJHjQBA0Gc4',
        yt: 'UJHjQBA0Gc4',
        title: 'TARGET: THE BLACK COMMANDO - Hindi Dubbed Full Movie | Gopichand, Mehreen',
        poster: 'https://i.ytimg.com/vi/UJHjQBA0Gc4/hqdefault.jpg',
        duration: '2:05:00',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'ADMD South Flix'
    },
    {
        videoId: 'vXwRYN5AU2Q',
        yt: 'vXwRYN5AU2Q',
        title: 'ROBBERY Vijay Thalapathy Hindi Dubbed Action Movie | South Indian Movie',
        poster: 'https://i.ytimg.com/vi/vXwRYN5AU2Q/hqdefault.jpg',
        duration: '2:15:30',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Sur Hindi Manoranjan'
    },
    {
        videoId: '4XowbIYI6wM',
        yt: '4XowbIYI6wM',
        title: 'सुपरहिट (HD) ब्लॉकबस्टर साउथ इंडियन हिंदी डब्ड एक्शन मूवी || Jakkana',
        poster: 'https://i.ytimg.com/vi/4XowbIYI6wM/hqdefault.jpg',
        duration: '2:08:40',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Movies Digital'
    },
    {
        videoId: 'x2SeyqGjySs',
        yt: 'x2SeyqGjySs',
        title: 'MISSION PAK | Full Hindi Dubbed Movie | Allu Arjun & Kareena Kapoor',
        poster: 'https://i.ytimg.com/vi/x2SeyqGjySs/hqdefault.jpg',
        duration: '2:20:10',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Super South Movies'
    },
    {
        videoId: '8wtBevf0GA8',
        yt: '8wtBevf0GA8',
        title: "The Wolf's Revenge | Full Action Fantasy Movie | HD Stream",
        poster: 'https://i.ytimg.com/vi/8wtBevf0GA8/hqdefault.jpg',
        duration: '2h 22m',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Titan Entertainment'
    },
    {
        videoId: 'crEH4dKuKOY',
        yt: 'crEH4dKuKOY',
        title: 'Jason Statham & Josh Harnett ELITE SPY - Hollywood English Movie',
        poster: 'https://i.ytimg.com/vi/crEH4dKuKOY/hqdefault.jpg',
        duration: '1h 45m',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Blockbuster English Movies'
    },
    {
        videoId: 'SO2XafPXgm0',
        yt: 'SO2XafPXgm0',
        title: 'AAKHRI CHAAL AB KAUN BACHEGA | Vijay Sethupathi | South Action Hindi Dubbed',
        poster: 'https://i.ytimg.com/vi/SO2XafPXgm0/hqdefault.jpg',
        duration: '2:12:00',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Wam India Movie Talkies'
    },
    {
        videoId: 'MgXY8B4bXn0',
        yt: 'MgXY8B4bXn0',
        title: 'Jason Statham In ONE MAN WAR - Hollywood Free English Movie HD',
        poster: 'https://i.ytimg.com/vi/MgXY8B4bXn0/hqdefault.jpg',
        duration: '1h 50m',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Hollywood English Collection'
    },
    {
        videoId: 'zeVWTY31Vn8',
        yt: 'zeVWTY31Vn8',
        title: 'Top 30 Romantic Hindi Songs | Audio Jukebox | Bollywood Love Songs',
        poster: 'https://i.ytimg.com/vi/zeVWTY31Vn8/hqdefault.jpg',
        duration: '2:30:00',
        rating: '4.9',
        category: 'YouTube Video',
        channel: 'Sony Music India'
    },
    {
        videoId: 'LElOSR7cJyM',
        yt: 'LElOSR7cJyM',
        title: 'Top 20 Bollywood Romance | Audio Jukebox | Best Hindi Love Songs',
        poster: 'https://i.ytimg.com/vi/LElOSR7cJyM/hqdefault.jpg',
        duration: '1:45:00',
        rating: '4.9',
        category: 'YouTube Video',
        channel: 'YRF Music'
    },
    {
        videoId: 'PWyXe6fzsmM',
        yt: 'PWyXe6fzsmM',
        title: "Bollywood 90's Romantic Songs | Video Jukebox | Hindi Love Songs",
        poster: 'https://i.ytimg.com/vi/PWyXe6fzsmM/hqdefault.jpg',
        duration: '1:55:00',
        rating: '4.9',
        category: 'YouTube Video',
        channel: 'Tips Official'
    },
    {
        videoId: '2ohXK1kSX8A',
        yt: '2ohXK1kSX8A',
        title: 'BLACK VIOLET : Angelina Jolie | New Action Movie | Full Movie 4K',
        poster: 'https://i.ytimg.com/vi/2ohXK1kSX8A/hqdefault.jpg',
        duration: '1h 33m',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Joy Drama'
    },
    {
        videoId: 'Vzg7hNXk7lo',
        yt: 'Vzg7hNXk7lo',
        title: 'THE MERGER - Latest Full Movie HD Stream',
        poster: 'https://i.ytimg.com/vi/Vzg7hNXk7lo/hqdefault.jpg',
        duration: '1h 34m',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Uche Montana TV'
    },
    {
        videoId: '9Tw7oOVaUEE',
        yt: '9Tw7oOVaUEE',
        title: 'DEATH ORDER : Angelina Jolie | New Action Movie | Full Movie 4K',
        poster: 'https://i.ytimg.com/vi/9Tw7oOVaUEE/hqdefault.jpg',
        duration: '1h 32m',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Joy Drama'
    },
    {
        videoId: 'KuEzbaxEdww',
        yt: 'KuEzbaxEdww',
        title: 'LOVE & FAITH - Latest Full Movie HD Stream',
        poster: 'https://i.ytimg.com/vi/KuEzbaxEdww/hqdefault.jpg',
        duration: '1h 40m',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Amal motion pictures'
    },
    {
        videoId: 'qy5gcu2zRIs',
        yt: 'qy5gcu2zRIs',
        title: 'SHADOW FIGHT : Jackie Chan | NEW ACTION Movie | Full Movie 4K',
        poster: 'https://i.ytimg.com/vi/qy5gcu2zRIs/hqdefault.jpg',
        duration: '1h 36m',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'X Drama'
    },
    {
        videoId: 'hNbRVElRkes',
        yt: 'hNbRVElRkes',
        title: 'ENCOUNTER 2 | New Released Full Action Thriller South Hindi Dubbed Movie',
        poster: 'https://i.ytimg.com/vi/hNbRVElRkes/hqdefault.jpg',
        duration: '2:15:00',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'Super South Movies'
    },
    {
        videoId: 'KpUHwT29n20',
        yt: 'KpUHwT29n20',
        title: 'Revolver Rita | Keerthy Suresh South Action Movie HD',
        poster: 'https://i.ytimg.com/vi/KpUHwT29n20/hqdefault.jpg',
        duration: '2:05:00',
        rating: '4.8',
        category: 'YouTube Video',
        channel: 'RKD Studios'
    }
];

// Helper to clean movie title for highly targeted YouTube search
function getCleanYouTubeSearchQuery(rawTitle, cast) {
    if (!rawTitle) return 'Hindi full movie';
    let cleaned = rawTitle
        .replace(/\((19|20)\d{2}\)/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\b(Full\s+Movie|Full\s+Hindi\s+Movie|Full\s+HD\s+Movie|Comedy\s+Movie|Action\s+Movie|Romantic\s+Movie|Hindi\s+Movie|Blockbuster|HD|4K|1080p|720p)\b/gi, '')
        .replace(/\|.*$/, '')
        .replace(/[-_:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (cleaned.length < 3 && cast) {
        const castStr = Array.isArray(cast) ? cast.join(' ') : String(cast);
        const firstActor = castStr.split(',')[0].trim();
        if (firstActor.length > 2) {
            cleaned = firstActor;
        }
    }
    return (cleaned || 'Hindi Movie') + ' full movie';
}

// Asynchronously load exactly 20 related YouTube posts (from YouTube itself, not the movie section)
async function loadYouTubeRelatedPosts(currentMovie, currentYtId) {
    const carousel = document.getElementById('relatedCarousel');
    if (!carousel) return;

    // Show loading spinner
    carousel.className = 'yt-feed-container';
    carousel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; padding: 30px 0; color: #8b949e; gap: 10px; font-size: 13px;">
            <i class="fa-solid fa-spinner fa-spin" style="color: #ff0000; font-size: 22px;"></i>
            <span>Loading 20 YouTube posts...</span>
        </div>
    `;

    const rawTitle = safeTrim(currentMovie.title || currentMovie.name || 'Hindi Movie');
    let ytList = [];

    // 1. Try local dev-server endpoint if running in Vite desktop dev mode
    try {
        const fetchUrl = `/api/youtube-related?q=${encodeURIComponent(rawTitle)}&v=${encodeURIComponent(currentYtId || '')}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(fetchUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                ytList = data;
            }
        }
    } catch (e) {}

    // 2. Client-side Live Invidious Search (runs seamlessly on mobile / Android WebView / static builds!)
    if (ytList.length < 20) {
        try {
            const primaryQuery = getCleanYouTubeSearchQuery(rawTitle, currentMovie.cast);
            const liveItems = await fetchInvidiousSearch(primaryQuery);
            if (Array.isArray(liveItems) && liveItems.length > 0) {
                const seenIds = new Set(ytList.map(v => v.videoId || v.yt || v.id));
                if (currentYtId) seenIds.add(currentYtId);
                for (const item of liveItems) {
                    const id = item.videoId || item.yt || item.id;
                    if (id && !seenIds.has(id)) {
                        seenIds.add(id);
                        ytList.push({
                            videoId: id,
                            yt: id,
                            id: `stream_${id}`,
                            title: item.title,
                            poster: item.poster || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                            duration: item.duration || 'Full HD',
                            rating: item.rating || '4.8',
                            category: 'YouTube Video',
                            channel: item.author || 'YouTube'
                        });
                    }
                }
            }
        } catch (e) {
            console.warn('Invidious live fetch error:', e);
        }
    }

    // 3. If still fewer than 20 items, try broad search query
    if (ytList.length < 20) {
        try {
            const extraLive = await fetchInvidiousSearch('latest full movie');
            if (Array.isArray(extraLive) && extraLive.length > 0) {
                const seenIds = new Set(ytList.map(v => v.videoId || v.yt || v.id));
                if (currentYtId) seenIds.add(currentYtId);
                for (const item of extraLive) {
                    const id = item.videoId || item.yt || item.id;
                    if (id && !seenIds.has(id)) {
                        seenIds.add(id);
                        ytList.push({
                            videoId: id,
                            yt: id,
                            id: `stream_${id}`,
                            title: item.title,
                            poster: item.poster || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                            duration: item.duration || 'Full HD',
                            rating: item.rating || '4.8',
                            category: 'YouTube Video',
                            channel: item.author || 'YouTube'
                        });
                        if (ytList.length >= 20) break;
                    }
                }
            }
        } catch (e) {}
    }

    // Filter out current playing video
    ytList = ytList.filter(v => {
        const vid = v.videoId || v.yt || v.id;
        return vid && vid !== currentYtId;
    });

    // 4. Complement / fallback from CURATED_CLOUD_CATALOG & CURATED_YOUTUBE_CATALOG
    if (ytList.length < 20) {
        const seenIds = new Set(ytList.map(v => v.videoId || v.yt || v.id));
        if (currentYtId) seenIds.add(currentYtId);

        const cloudCatalog = (typeof CURATED_CLOUD_CATALOG !== 'undefined' && Array.isArray(CURATED_CLOUD_CATALOG)) ? CURATED_CLOUD_CATALOG : [];
        const combinedPool = [
            ...CURATED_YOUTUBE_CATALOG,
            ...cloudCatalog.map(c => ({
                videoId: c.yt,
                yt: c.yt,
                id: c.id,
                title: c.title,
                poster: c.poster || `https://i.ytimg.com/vi/${c.yt}/hqdefault.jpg`,
                duration: c.duration || 'Full HD',
                rating: c.rating || '4.8',
                category: 'YouTube Video',
                channel: c.author || 'YouTube'
            }))
        ];

        // Sort curated catalog by title keyword relevance
        const words = rawTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const sortedCurated = combinedPool.sort((a, b) => {
            const aTitle = (a.title || '').toLowerCase();
            const bTitle = (b.title || '').toLowerCase();
            let aScore = 0;
            let bScore = 0;
            for (const w of words) {
                if (aTitle.includes(w)) aScore += 10;
                if (bTitle.includes(w)) bScore += 10;
            }
            return bScore - aScore;
        });

        for (const item of sortedCurated) {
            if (ytList.length >= 20) break;
            const id = item.videoId || item.yt || item.id;
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                ytList.push(item);
            }
        }
    }

    // Exactly 20 YouTube posts
    const final20 = ytList.slice(0, 20);

    carousel.className = 'yt-feed-container';
    carousel.innerHTML = '';
    final20.forEach(v => {
        const card = document.createElement('div');
        card.className = 'yt-post-item';

        const vidId = v.videoId || v.yt || v.id;
        const ytMovieObj = {
            id: vidId,
            title: v.title || 'YouTube Video',
            name: v.title || 'YouTube Video',
            yt: vidId,
            poster: v.poster || `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`,
            category: 'YouTube Video',
            cast: [v.channel || v.author || 'YouTube'],
            rating: v.rating || '4.8',
            duration: v.duration || 'Full HD'
        };

        card.onclick = () => {
            if (!window.isUserSubscribed()) {
                window.showSubscriptionRequiredPopup('youtube', ytMovieObj.title);
                return;
            }
            window.openPlayer(ytMovieObj);
            showToast(`Playing YouTube: ${ytMovieObj.title}`);
        };

        const cardTitle = ytMovieObj.title;
        const channelName = v.channel || v.author || 'YouTube Channel';
        const durationText = ytMovieObj.duration;
        const viewsText = v.views || '1.5M views';

        card.innerHTML = `
            <div class="yt-thumb-wrapper">
                <img class="yt-thumb-img" 
                     src="${ytMovieObj.poster}" 
                     alt="${cardTitle}"
                     loading="lazy" 
                     decoding="async" 
                     referrerpolicy="no-referrer"
                     onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&auto=format&fit=crop&q=60';">
                ${durationText ? `<span class="yt-thumb-duration">${durationText}</span>` : ''}
            </div>
            <div class="yt-post-details">
                <div class="yt-channel-avatar">
                    <i class="fa-brands fa-youtube"></i>
                </div>
                <div class="yt-details-box">
                    <div class="yt-title-text" title="${cardTitle}">${cardTitle}</div>
                    <div class="yt-channel-row">
                        <span class="yt-channel-name">${channelName} <i class="fa-solid fa-circle-check yt-verified-badge"></i></span>
                        <span class="yt-meta-dot">•</span>
                        <span>${viewsText}</span>
                        <span class="yt-meta-dot">•</span>
                        <span>${durationText}</span>
                    </div>
                </div>
                <button class="yt-menu-dots-btn" type="button" aria-label="Action" onclick="event.stopPropagation();">
                    <i class="fa-solid fa-ellipsis-vertical"></i>
                </button>
            </div>
        `;
        carousel.appendChild(card);
    });

    const countBadge = document.getElementById('relatedCountBadge');
    if (countBadge) {
        countBadge.innerText = `${final20.length} YouTube Posts`;
    }
}

window.switchRelatedView = function(mode) {
    const container = document.getElementById('relatedCarousel');
    const gridBtn = document.getElementById('relatedViewGridBtn');
    const scrollBtn = document.getElementById('relatedViewScrollBtn');
    if (!container) return;

    if (container.classList.contains('yt-feed-container')) {
        // YouTube Single-Post mode toggle
        if (mode === 'compact' || mode === 'scroll') {
            container.classList.add('yt-list-compact');
            if (gridBtn) gridBtn.classList.remove('active', 'yt-active');
            if (scrollBtn) scrollBtn.classList.add('active', 'yt-active');
        } else {
            container.classList.remove('yt-list-compact');
            if (gridBtn) gridBtn.classList.add('active', 'yt-active');
            if (scrollBtn) scrollBtn.classList.remove('active', 'yt-active');
        }
        return;
    }

    if (mode === 'scroll') {
        container.className = 'horizontal-scroll-container';
        container.querySelectorAll('.movie-card').forEach(c => {
            c.style.flex = "0 0 130px";
            c.style.minWidth = "130px";
            c.style.width = "auto";
        });
        if (gridBtn) gridBtn.classList.remove('active');
        if (scrollBtn) scrollBtn.classList.add('active');
    } else {
        container.className = 'gallery-grid';
        container.querySelectorAll('.movie-card').forEach(c => {
            c.style.flex = "none";
            c.style.minWidth = "unset";
            c.style.width = "100%";
        });
        if (gridBtn) gridBtn.classList.add('active');
        if (scrollBtn) scrollBtn.classList.remove('active');
    }
};

function renderPlayerSection(movie, activeServerIndex = 0, preserveFullscreen = false) {
    const container = document.getElementById('mainContainer');
    if (!container) return;

    destroyCurrentPlyr(preserveFullscreen);
    currentActiveServerIndex = activeServerIndex;

    const sourceInfo = detectMovieVideoSource(movie);
    const servers = getMovieServers(movie);
    const activeServer = servers[activeServerIndex] || servers[0];
    const isYouTube = (activeServer.type === 'yt') || (sourceInfo.type === 'yt');

    // Find 20 related movies
    const relatedMovies = getRelatedMovies(movie, 20);

    const serverPills = servers.map((s, idx) => `
        <button class="server-pill ${idx === activeServerIndex ? 'active' : ''}" onclick="switchServer(${idx})">
            <i class="fa-solid ${s.type === 'yt' ? 'fa-play' : 'fa-server'}"></i> ${s.name}
        </button>
    `).join('');

    const titleText = movie.title || movie.name || 'Movie Player';
    const ratingText = movie.rating || '4.8';
    const categoryText = movie.category || 'General';

    // Player header badge & title
    let playerBadgeText = 'Plyr 1080p';
    let playerBadgeStyle = 'background: rgba(0, 210, 255, 0.15); color: #00d2ff; border: 1px solid rgba(0, 210, 255, 0.3);';
    let topBarIcon = '<i class="fa-solid fa-play" style="color: #00d2ff; font-size: 10px;"></i>';
    let topBarText = 'Plyr HD Player';

    if (isYouTube) {
        playerBadgeText = 'Cloud Stream HD';
        playerBadgeStyle = 'background: rgba(0, 210, 255, 0.15); color: #00d2ff; border: 1px solid rgba(0, 210, 255, 0.3);';
        topBarIcon = '<i class="fa-solid fa-play" style="color: #00d2ff; font-size: 11px;"></i>';
        topBarText = 'Cloud Stream Player';
    } else if (sourceInfo.type === 'video') {
        playerBadgeText = 'Worker CDN 1080p';
        playerBadgeStyle = 'background: rgba(0, 210, 255, 0.15); color: #00d2ff; border: 1px solid rgba(0, 210, 255, 0.3);';
        topBarIcon = '<i class="fa-solid fa-bolt" style="color: #00d2ff; font-size: 10px;"></i>';
        topBarText = 'Cloudflare Worker Stream Player';
    } else if (sourceInfo.type === 'drc') {
        playerBadgeText = 'Plyr Direct 1080p';
        playerBadgeStyle = 'background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);';
        topBarIcon = '<i class="fa-solid fa-play" style="color: #10b981; font-size: 10px;"></i>';
        topBarText = 'Plyr Direct Player';
    }

    // Parse cast list for clickable actor buttons
    let castList = [];
    if (Array.isArray(movie.cast)) {
        castList = movie.cast.map(c => String(c).trim()).filter(Boolean);
    } else if (typeof movie.cast === 'string' && movie.cast.trim().length > 0) {
        castList = movie.cast.split(/[,/|•]+/).map(c => c.trim()).filter(Boolean);
    }

    const castHtml = castList.length > 0 ? `
        <div class="player-cast-header">
            <span class="player-cast-title"><strong>Starring:</strong></span>
            <span class="player-cast-subtitle">Tap an actor to see all their movies</span>
        </div>
        <div class="player-cast-tags">
            ${castList.map(actor => `
                <button type="button" class="cast-pill-btn" onclick="filterByCast('${encodeURIComponent(actor).replace(/'/g, "%27")}')">
                    <i class="fa-solid fa-user"></i>
                    <span>${actor}</span>
                </button>
            `).join('')}
        </div>
    ` : `
        <div class="player-cast-header">
            <span class="player-cast-title"><strong>Starring:</strong></span>
        </div>
        <div style="font-size: 13px; color: #8b949e; margin-top: 4px;">All-Star Cast</div>
    `;

    container.innerHTML = `
        <div class="player-wrapper">
            <!-- Back Navigation Bar -->
            <div class="player-back-bar">
                <button class="back-nav-btn" onclick="exitPlayerView()">
                    <i class="fa-solid fa-arrow-left"></i> ${isInCloudStreamView ? 'Back to Watch Stream' : 'Back to Movies'}
                </button>
                <div style="font-size: 13px; color: #8b949e; display: flex; align-items: center; gap: 6px;">
                    ${topBarIcon}
                    <span>${topBarText}</span>
                </div>
            </div>

            <!-- Video Player Display: YouTube iframe OR Plyr Video Player -->
            <div class="player-video-box" id="activePlayerBox">
                ${isYouTube ? `
                    <iframe id="vdoSkyYouTube" class="player" src="${activeServer.url}" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; margin: 0; padding: 0;"></iframe>
                    <!-- Touch surface overlay to capture user taps and gestures -->
                    <div class="yt-touch-surface" id="ytTouchSurface"></div>
                    <!-- Top portrait touch mask to prevent clicking YouTube channel/title in portrait mode -->
                    <div class="yt-top-portrait-mask"></div>
                    <!-- Protective Top Shield masking YouTube channel avatar & video title links in Fullscreen -->
                    <div class="yt-top-shield" id="ytTopShield">
                        <div class="yt-shield-top-left">
                            <button type="button" class="yt-shield-back-btn" onclick="window.triggerFullscreenPlayer(); event.stopPropagation();" title="Exit Fullscreen">
                                <i class="fa-solid fa-arrow-left"></i>
                            </button>
                            <span class="yt-shield-top-title">${titleText}</span>
                        </div>
                        <div class="yt-shield-top-right" style="display: flex; align-items: center; gap: 8px;">
                            <button type="button" class="yt-shield-back-btn" onclick="window.toggleYtQualitySettings(event);" title="Quality & Settings">
                                <i class="fa-solid fa-gear"></i>
                            </button>
                            <button type="button" class="yt-shield-back-btn" onclick="window.triggerFullscreenPlayer(); event.stopPropagation();" title="Exit Fullscreen">
                                <i class="fa-solid fa-compress"></i>
                            </button>
                        </div>
                    </div>
                    <!-- Touch Skip Visual Feedback Overlay -->
                    <div class="yt-touch-skip-overlay" id="ytTouchSkipOverlay">
                        <div class="yt-skip-anim yt-skip-left" id="ytSkipLeftAnim">
                            <i class="fa-solid fa-angles-left"></i>
                            <span>-10s</span>
                        </div>
                        <div class="yt-skip-anim yt-skip-right" id="ytSkipRightAnim">
                            <i class="fa-solid fa-angles-right"></i>
                            <span>+10s</span>
                        </div>
                    </div>

                    <!-- Protective Bottom Shield with Integrated Video Timeline & Controls -->
                    <div class="yt-bottom-shield" id="ytBottomShield">
                        <!-- Row 1: Interactive Video Progress Timeline (Seek Bar) -->
                        <div class="yt-timeline-container" id="ytTimelineContainer" onclick="handleTimelineClick(event)" onmousemove="handleTimelineHover(event)" onmouseleave="handleTimelineLeave()" title="Click or drag to seek">
                            <div class="yt-timeline-track" id="ytTimelineTrack">
                                <div class="yt-timeline-buffer" id="ytTimelineBuffer"></div>
                                <div class="yt-timeline-progress" id="ytTimelineProgress">
                                    <div class="yt-timeline-handle" id="ytTimelineHandle"></div>
                                </div>
                                <div class="yt-timeline-tooltip" id="ytTimelineTooltip">00:00</div>
                            </div>
                        </div>

                        <!-- Row 2: Play/Pause, Skip -10s/+10s, Timestamps, Auto Next, Next, Fullscreen -->
                        <div class="yt-bottom-bar-main">
                            <div class="yt-shield-left-controls">
                                <button type="button" class="yt-ctrl-btn" id="ytPlayPauseBtn" onclick="toggleYtPlayPause(); event.stopPropagation();" title="Play/Pause">
                                    <i class="fa-solid fa-play" id="ytPlayPauseIcon"></i>
                                </button>
                                <button type="button" class="yt-ctrl-btn yt-skip-btn" onclick="skipVideoSeconds(-10); event.stopPropagation();" title="Rewind 10 Seconds">
                                    <i class="fa-solid fa-rotate-left"></i>
                                    <span class="skip-num">10</span>
                                </button>
                                <button type="button" class="yt-ctrl-btn yt-skip-btn" onclick="skipVideoSeconds(10); event.stopPropagation();" title="Forward 10 Seconds">
                                    <i class="fa-solid fa-rotate-right"></i>
                                    <span class="skip-num">10</span>
                                </button>
                                <div class="yt-time-display" id="ytTimeDisplay">
                                    <span id="ytCurrentTime">00:00</span>
                                    <span class="yt-time-sep">/</span>
                                    <span id="ytDuration">00:00</span>
                                </div>
                            </div>

                            <div class="yt-shield-brand">
                                <i class="fa-solid fa-bolt" style="color: #00d2ff; font-size: 11px;"></i>
                                <span>Cloud Stream HD</span>
                            </div>

                            <div class="yt-shield-controls">
                                <button type="button" class="auto-next-pill-btn yt-shield-autonext ${isAutoNextEnabled ? 'active' : ''}" onclick="toggleAutoNext(); event.stopPropagation();" title="Toggle Auto Next">
                                    <i class="fa-solid ${isAutoNextEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                                    <span class="autonext-text">Auto Next: <strong>${isAutoNextEnabled ? 'ON' : 'OFF'}</strong></span>
                                </button>
                                <button type="button" class="quick-next-btn yt-shield-next-btn" onclick="playNextVideo(true); event.stopPropagation();" title="Play Next Stream">
                                    <i class="fa-solid fa-forward-step"></i> <span class="next-btn-text">Next</span>
                                </button>
                                <button type="button" class="yt-shield-gear-btn" id="ytShieldGearBtn" onclick="window.toggleYtQualitySettings(event);" title="Quality & Settings">
                                    <i class="fa-solid fa-gear" id="ytShieldGearIcon"></i>
                                </button>
                                <button type="button" class="yt-shield-fs-btn" id="ytShieldFsBtn" onclick="window.triggerFullscreenPlayer(); event.stopPropagation();" title="Toggle Fullscreen">
                                    <i class="fa-solid fa-expand"></i>
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Video Quality & Playback Settings Dropdown -->
                    <div class="yt-settings-menu" id="ytSettingsMenu" style="display: none;" onclick="event.stopPropagation();">
                        <div class="yt-settings-header">
                            <span><i class="fa-solid fa-gear" style="color: #00d2ff; margin-right: 5px;"></i> Quality & Settings</span>
                            <button type="button" class="yt-settings-close" onclick="window.closeYtSettingsMenu(event);" title="Close">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>

                        <!-- Video Resolution Quality -->
                        <div class="yt-settings-section-title">
                            <i class="fa-solid fa-sliders" style="color: #00d2ff;"></i> Video Quality
                        </div>
                        <div class="yt-quality-list" id="ytQualityList">
                            <div class="yt-quality-item" data-quality="auto" onclick="window.setYtVideoQuality('auto', event);">
                                <span>Auto (Best Quality)</span>
                                <i class="fa-solid fa-check yt-q-check" style="color: #00d2ff;"></i>
                            </div>
                            <div class="yt-quality-item" data-quality="hd1080" onclick="window.setYtVideoQuality('hd1080', event);">
                                <span>1080p Full HD</span>
                                <i class="fa-solid fa-check yt-q-check" style="display: none; color: #00d2ff;"></i>
                            </div>
                            <div class="yt-quality-item" data-quality="hd720" onclick="window.setYtVideoQuality('hd720', event);">
                                <span>720p HD</span>
                                <i class="fa-solid fa-check yt-q-check" style="display: none; color: #00d2ff;"></i>
                            </div>
                            <div class="yt-quality-item" data-quality="large" onclick="window.setYtVideoQuality('large', event);">
                                <span>480p SD</span>
                                <i class="fa-solid fa-check yt-q-check" style="display: none; color: #00d2ff;"></i>
                            </div>
                            <div class="yt-quality-item" data-quality="medium" onclick="window.setYtVideoQuality('medium', event);">
                                <span>360p Standard</span>
                                <i class="fa-solid fa-check yt-q-check" style="display: none; color: #00d2ff;"></i>
                            </div>
                            <div class="yt-quality-item" data-quality="small" onclick="window.setYtVideoQuality('small', event);">
                                <span>240p Data Saver</span>
                                <i class="fa-solid fa-check yt-q-check" style="display: none; color: #00d2ff;"></i>
                            </div>
                        </div>

                        <!-- Playback Speed -->
                        <div class="yt-settings-section-title">
                            <i class="fa-solid fa-gauge-high" style="color: #00d2ff;"></i> Playback Speed
                        </div>
                        <div class="yt-speed-row">
                            <button type="button" class="yt-speed-btn" data-speed="0.5" onclick="window.setYtPlaybackSpeed(0.5, event);">0.5x</button>
                            <button type="button" class="yt-speed-btn" data-speed="0.75" onclick="window.setYtPlaybackSpeed(0.75, event);">0.75x</button>
                            <button type="button" class="yt-speed-btn" data-speed="1" onclick="window.setYtPlaybackSpeed(1, event);">1x</button>
                            <button type="button" class="yt-speed-btn" data-speed="1.25" onclick="window.setYtPlaybackSpeed(1.25, event);">1.25x</button>
                            <button type="button" class="yt-speed-btn" data-speed="1.5" onclick="window.setYtPlaybackSpeed(1.5, event);">1.5x</button>
                            <button type="button" class="yt-speed-btn" data-speed="2" onclick="window.setYtPlaybackSpeed(2, event);">2x</button>
                        </div>

                        <!-- Touch Native YouTube Mode -->
                        <button type="button" class="yt-native-direct-touch-btn" onclick="window.enableDirectYtTouch(event);" title="Switch to direct YouTube player touch">
                            <i class="fa-brands fa-youtube" style="font-size: 14px;"></i>
                            <span>Touch Native YouTube Controls</span>
                        </button>
                    </div>

                    <!-- Floating Pill to Exit Direct YouTube Touch Mode -->
                    <div class="yt-exit-direct-touch" id="ytExitDirectTouch" style="display: none;" onclick="window.disableDirectYtTouch(event);">
                        <i class="fa-solid fa-arrow-left"></i>
                        <span>Restore App Controls</span>
                    </div>
                ` : `
                    <video id="vdoSkyPlyr" class="player" playsinline controls preload="metadata" poster="${movie.poster || ''}">
                        <source src="${activeServer.url}" type="video/mp4">
                        Your browser does not support HTML5 video.
                    </video>

                    <!-- Stream Error Fallback Notice -->
                    <div id="playerStreamErrorNotice" style="display: none; position: absolute; inset: 0; background: rgba(10,12,18,0.93); z-index: 30; flex-direction: column; align-items: center; justify-content: center; padding: 20px; text-align: center;">
                        <i class="fa-solid fa-triangle-exclamation" style="font-size: 32px; color: #ffb703; margin-bottom: 10px;"></i>
                        <h3 style="font-size: 16px; font-weight: bold; margin-bottom: 6px; color: #fff;">Stream Loading Interrupted</h3>
                        <p style="font-size: 12px; color: #8b949e; margin-bottom: 14px; max-width: 320px;">
                            This stream server is taking longer than expected. Please switch to another server to continue playing.
                        </p>
                        <button onclick="switchServer(${(activeServerIndex + 1) % servers.length})" style="background: #00d2ff; color: #1e1e2f; font-weight: bold; border: none; padding: 8px 18px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                            <i class="fa-solid fa-rotate"></i> Try Server ${((activeServerIndex + 1) % servers.length) + 1}
                        </button>
                    </div>
                `}
            </div>

            <!-- Streaming Server Switcher & Auto Next Controls -->
            <div class="server-selector">
                <span class="server-label"><i class="fa-solid fa-bolt"></i> Stream Server:</span>
                ${serverPills}
                <div class="auto-next-server-wrap">
                    <button type="button" class="auto-next-pill-btn ${isAutoNextEnabled ? 'active' : ''}" onclick="toggleAutoNext()" title="Toggle Auto Next">
                        <i class="fa-solid ${isAutoNextEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                        <span>Auto Next: <strong>${isAutoNextEnabled ? 'ON' : 'OFF'}</strong></span>
                    </button>
                    <button type="button" class="quick-next-btn" onclick="playNextVideo(true)" title="Play Next Stream">
                        <i class="fa-solid fa-forward-step"></i> Next
                    </button>
                </div>
            </div>

            <!-- Movie Details & Actions (Share & Fullscreen buttons removed from below player per request) -->
            <div class="player-info">
                <h1 class="player-movie-title">${titleText}</h1>
                
                <div class="player-badges">
                    <span class="player-badge badge-rating">★ ${ratingText}</span>
                    <span class="player-badge badge-category">${categoryText}</span>
                    <span class="player-badge" style="${playerBadgeStyle}">${playerBadgeText}</span>
                </div>

                <!-- Cast / Synopsis Box with Clickable Buttons -->
                <div class="player-cast-box">
                    ${castHtml}
                </div>

                <div style="margin-top: 10px; display: flex; align-items: center; gap: 8px;">
                    <button type="button" class="player-comment-action-btn" onclick="window.openCommentSection()" title="Leave comments, movie reviews or feedback">
                        <i class="fa-solid fa-comment-dots" style="color: #38bdf8;"></i>
                        <span>Comments & Requests</span>
                    </button>
                </div>
            </div>

            <!-- Related Videos Section (20 Posts) -->
            <div class="related-movies-section">
                <div class="section-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                    <div class="section-title-wrapper" style="display: flex; align-items: center; gap: 8px;">
                        <div class="section-bar" style="${isYouTube ? 'background: #ff0000;' : ''}"></div>
                        <div class="section-title" id="relatedSectionTitle" style="font-size: 15px; font-weight: 700; color: #fff;">
                            ${isYouTube ? '<i class="fa-brands fa-youtube" style="color: #ff0000; margin-right: 6px;"></i> Related YouTube Videos' : '<i class="fa-solid fa-film" style="color: #00d2ff; margin-right: 6px;"></i> Related Movies'}
                        </div>
                        <span class="related-badge ${isYouTube ? 'yt-badge-theme' : ''}" id="relatedCountBadge">
                            ${isYouTube ? '20 YouTube Posts' : (relatedMovies.length + ' Posts')}
                        </span>
                    </div>
                    <div class="related-view-toggle" style="display: flex; align-items: center; gap: 6px;">
                        ${isYouTube ? `
                            <button type="button" id="relatedViewGridBtn" class="related-toggle-btn yt-active active" onclick="window.switchRelatedView('feed')" title="Single Card Feed">
                                <i class="fa-solid fa-square"></i>
                            </button>
                            <button type="button" id="relatedViewScrollBtn" class="related-toggle-btn" onclick="window.switchRelatedView('compact')" title="Compact List">
                                <i class="fa-solid fa-bars"></i>
                            </button>
                        ` : `
                            <button type="button" id="relatedViewGridBtn" class="related-toggle-btn active" onclick="window.switchRelatedView('grid')" title="Grid View">
                                <i class="fa-solid fa-border-all"></i>
                            </button>
                            <button type="button" id="relatedViewScrollBtn" class="related-toggle-btn" onclick="window.switchRelatedView('scroll')" title="Scroll View">
                                <i class="fa-solid fa-arrows-left-right"></i>
                            </button>
                        `}
                    </div>
                </div>
                <div class="${isYouTube ? 'yt-feed-container' : 'gallery-grid'}" id="relatedCarousel">
                    ${isYouTube ? `
                        <div style="display: flex; align-items: center; justify-content: center; padding: 25px 0; color: #8b949e; gap: 10px; font-size: 13px;">
                            <i class="fa-solid fa-spinner fa-spin" style="color: #ff0000; font-size: 20px;"></i>
                            <span>Loading 20 YouTube posts...</span>
                        </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;

    // Initialize YouTube player API instance or Plyr instance
    if (isYouTube) {
        setupYouTubePlayer('vdoSkyYouTube');
        initPlayerTouchControls();
        // Load exactly 20 related YouTube posts (from YouTube itself, not the movie section)
        loadYouTubeRelatedPosts(movie, sourceInfo.id);
    } else {
        const videoEl = document.getElementById('vdoSkyPlyr');
        if (videoEl) {
            initPlyrPlayer(videoEl, movie, activeServerIndex);
        }
        // Populate standard movie section related movies (20 posts)
        populateMovieSectionCards(relatedMovies);
    }

    function populateMovieSectionCards(list) {
        if (!list || list.length === 0) return;
        const carousel = document.getElementById('relatedCarousel');
        if (!carousel) return;
        carousel.innerHTML = '';
        list.forEach(m => {
            const card = document.createElement('div');
            card.className = 'movie-card';
            card.style.flex = "none";
            card.style.minWidth = "unset";
            card.style.width = "100%";
            card.onclick = () => {
                window.openPlayer(m);
                showToast(`Playing: ${m.title || m.name || 'Movie'}`);
            };

            const cardTitle = m.title || m.name || '';
            const isLong = cardTitle.length > 18;

            card.innerHTML = `
                <span class="rating-badge">★ ${m.rating || '4.5'}</span>
                <div class="movie-card-play-hint"><i class="fa-solid fa-play"></i></div>
                <img src="${m.poster || m.image || ''}" loading="lazy" decoding="async">
                <div class="movie-title-container">
                    <div class="movie-title ${isLong ? 'marquee-title' : ''}">${cardTitle}</div>
                </div>
            `;
            carousel.appendChild(card);

            const posterUrl = m.poster || m.image;
            if (posterUrl) {
                getImage(posterUrl).then(imgUrl => {
                    if (imgUrl) {
                        const img = card.querySelector('img');
                        if (img) img.src = imgUrl;
                    }
                }).catch(() => {});
            }
        });
    }

    if (preserveFullscreen) {
        const box = document.getElementById('activePlayerBox');
        if (box) {
            box.classList.add('is-fullscreen');
            if (window.innerHeight > window.innerWidth) {
                box.classList.add('plyr-force-landscape');
            }
            updateFullscreenButtonState(true);
            lockLandscapeOrientation();
            try {
                if (box.requestFullscreen) {
                    box.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
                } else if (box.webkitRequestFullscreen) {
                    box.webkitRequestFullscreen();
                }
            } catch (e) {}
        }
        setTimeout(() => {
            isAutoNextTransitioning = false;
            wasFullscreenBeforeNext = false;
        }, 1200);
    }
}

window.switchServer = function(serverIdx) {
    if (!currentPlayingMovie) return;
    currentActiveServerIndex = serverIdx;
    const servers = getMovieServers(currentPlayingMovie);
    const targetServer = servers[serverIdx] || servers[0];

    // Hide error banner if showing
    const errorBox = document.getElementById('playerStreamErrorNotice');
    if (errorBox) errorBox.style.display = 'none';

    // Update active pill styling
    document.querySelectorAll('.server-pill').forEach((pill, idx) => {
        pill.classList.toggle('active', idx === serverIdx);
    });

    const isTargetYouTube = targetServer.type === 'yt' || (targetServer.url && targetServer.url.includes('youtube'));

    if (currentPlyrInstance && !isTargetYouTube) {
        currentPlyrInstance.source = {
            type: 'video',
            title: currentPlayingMovie.title || 'Movie',
            sources: [
                {
                    src: targetServer.url,
                    type: 'video/mp4'
                }
            ],
            poster: currentPlayingMovie.poster || ''
        };
        currentPlyrInstance.play().catch(() => {});
        showToast(`Connected to ${targetServer.name}`);
    } else {
        renderPlayerSection(currentPlayingMovie, serverIdx);
        showToast(`Connected to ${targetServer.name}`);
    }
};

window.triggerFullscreenPlayer = function() {
    const box = document.getElementById('activePlayerBox');
    if (currentPlyrInstance && currentPlyrInstance.fullscreen) {
        const isCurrentlyFs = !!(
            currentPlyrInstance.fullscreen.active ||
            document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement ||
            (box && (box.classList.contains('is-fullscreen') || box.classList.contains('plyr-force-landscape')))
        );
        if (!isCurrentlyFs) {
            if (box) box.classList.add('is-fullscreen');
            currentPlyrInstance.fullscreen.enter();
            lockLandscapeOrientation();
            updateFullscreenButtonState(true);
        } else {
            if (box) {
                box.classList.remove('is-fullscreen');
                box.classList.remove('plyr-force-landscape');
            }
            if (currentPlyrInstance.elements?.container) {
                currentPlyrInstance.elements.container.classList.remove('plyr-force-landscape');
            }
            try {
                currentPlyrInstance.fullscreen.exit();
            } catch (e) {}
            try {
                if (document.fullscreenElement || document.webkitFullscreenElement) {
                    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
                    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                }
            } catch (e) {}
            unlockScreenOrientation();
            updateFullscreenButtonState(false);
        }
    } else {
        if (!box) return;
        const isFs = !!(
            document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement ||
            box.classList.contains('is-fullscreen')
        );
        if (isFs) {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
            box.classList.remove('is-fullscreen');
            box.classList.remove('plyr-force-landscape');
            unlockScreenOrientation();
            updateFullscreenButtonState(false);
        } else {
            box.classList.add('is-fullscreen');
            if (box.requestFullscreen) {
                box.requestFullscreen({ navigationUI: 'hide' }).then(() => {
                    lockLandscapeOrientation();
                }).catch(() => {
                    lockLandscapeOrientation();
                });
            } else if (box.webkitRequestFullscreen) {
                box.webkitRequestFullscreen();
                lockLandscapeOrientation();
            } else {
                lockLandscapeOrientation();
            }
            updateFullscreenButtonState(true);
        }
    }
};

window.shareCurrentMovie = function() {
    if (!currentPlayingMovie) return;
    const title = currentPlayingMovie.title || 'VDOSky Movie';
    const text = `Watch "${title}" on VDOSky: ${window.location.href}`;

    if (navigator.share) {
        navigator.share({
            title: title,
            text: text,
            url: window.location.href
        }).catch(() => {});
    } else if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            showToast("Movie link copied to clipboard!");
        }).catch(() => {
            showToast("Shared: " + title);
        });
    } else {
        showToast("Shared: " + title);
    }
};

window.exitPlayerView = function() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        try {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } catch (e) {}
    }
    const box = document.getElementById('activePlayerBox');
    if (box) box.classList.remove('is-fullscreen');
    unlockScreenOrientation();
    updateFullscreenButtonState(false);
    stopMrecSync();

    destroyCurrentPlyr();
    isPlayerView = false;
    currentPlayingMovie = null;
    updateHeaderButton();

    if (isInCloudStreamView) {
        window.openCloudStreamSection();
    } else if (isInCategoryView && currentCategoryName !== 'all') {
        window.filterAndDisplay(currentCategoryName, true);
    } else {
        const container = document.getElementById('mainContainer');
        if (!window.__isVipSubscribed && homeCachedHTML && container) {
            container.innerHTML = homeCachedHTML;
            rebindHomeCardClicks();
        } else {
            homeCachedHTML = "";
            renderContent(allMovies);
        }
    }

    // Restore smooth scroll position
    setTimeout(() => {
        window.scrollTo({ top: savedScrollPosition, behavior: 'instant' });
    }, 50);
};

function rebindHomeCardClicks() {
    const container = document.getElementById('mainContainer');
    if (!container) return;

    const cards = container.querySelectorAll('.movie-card');
    cards.forEach(card => {
        const movieIndex = card.dataset.movieIndex;
        if (movieIndex !== undefined && allMovies[movieIndex]) {
            card.onclick = () => window.openPlayer(allMovies[movieIndex]);
        }
    });

    rebindUnloadedAds();
}

// Render Home Screen Content
async function renderContent(movies) {
    if (isInGameView || isInSubscriptionView || isInCloudStreamView || isInCommentView) {
        return;
    }
    isPlayerView = false;
    isInCategoryView = false;
    currentCategoryName = "all";
    updateHeaderButton(); 
    
    const searchEl = document.getElementById('searchInput');
    if (searchEl) searchEl.value = "";

    const container = document.getElementById('mainContainer');
    if (!container) return;
    container.innerHTML = "";

    // 1. Featured / Recently Added Section (Shows the latest added 8 movies at the very top)
    const recentMovies = movies.slice(0, 8);
    if (recentMovies.length > 0) {
        const recentDiv = document.createElement('div');
        recentDiv.style.marginBottom = "-25px";
        recentDiv.innerHTML = `
            <div class="section-header">
                <div class="section-title-wrapper">
                    <div class="section-bar" style="background: linear-gradient(180deg, #ff3b30, #ff9500);"></div>
                    <div class="section-title" style="color: #fff;"><i class="fa-solid fa-fire" style="color: #ff3b30; margin-right: 6px;"></i> Recently Added</div>
                </div>
            </div>
            <div class="horizontal-scroll-container"></div>
        `;

        container.appendChild(recentDiv);
        const recentRow = recentDiv.querySelector('.horizontal-scroll-container');

        for (let i = 0; i < recentMovies.length; i++) {
            const m = recentMovies[i];
            const card = document.createElement('div');
            card.className = 'movie-card';
            const globalIndex = allMovies.indexOf(m);
            card.dataset.movieIndex = globalIndex >= 0 ? globalIndex : i;
            card.onclick = () => window.openPlayer(m);

            const titleText = m.title || m.name || '';
            const isLong = titleText.length > 18;
            const isLatest = i === 0;

            card.innerHTML = `
                <span class="rating-badge">${isLatest ? '<span style="color: #00ff88; font-weight: 700; margin-right: 4px;">NEW</span>' : ''}★ ${m.rating || '0.0'}</span>
                <img src="${m.poster || m.image || ''}" loading="lazy" decoding="async">
                <div class="movie-title-container">
                    <div class="movie-title ${isLong ? 'marquee-title' : ''}">${titleText}</div>
                </div>
            `;
            recentRow.appendChild(card);

            if (m.poster) {
                getImage(m.poster).then(imgUrl => {
                    if (imgUrl) {
                        const img = card.querySelector('img');
                        if (img) img.src = imgUrl;
                    }
                }).catch(() => {});
            }
        }
    }

    const categories = [...new Set(movies.map(m => m.category).filter(Boolean))];

    let renderedCatCount = 0;
    for (const cat of categories) {
        const catMovies = movies.filter(m => m.category === cat);
        if (catMovies.length === 0) continue;
        renderedCatCount++;

        // Display up to 8 movies per category on the home page
        const displayMovies = catMovies.slice(0, 8);

        const sectionDiv = document.createElement('div');
        sectionDiv.style.marginBottom = "-25px";
        sectionDiv.innerHTML = `
            <div class="section-header">
                <div class="section-title-wrapper">
                    <div class="section-bar"></div>
                    <div class="section-title">${cat} (${catMovies.length})</div>
                </div>
                <button class="show-all-btn" onclick="showAllCategory('${cat.replace(/'/g, "\\'")}')">Show All</button>
            </div>
            <div class="horizontal-scroll-container"></div>
        `;

        container.appendChild(sectionDiv);
        const rowContainer = sectionDiv.querySelector('.horizontal-scroll-container');
        
        for (const m of displayMovies) {
            const card = document.createElement('div');
            card.className = 'movie-card';
            const globalIndex = allMovies.indexOf(m);
            card.dataset.movieIndex = globalIndex;
            card.onclick = () => window.openPlayer(m); 

            const titleText = m.title || m.name || '';
            const isLong = titleText.length > 18;

            card.innerHTML = `
                <span class="rating-badge">★ ${m.rating || '0.0'}</span>
                <img src="${m.poster || m.image || ''}" loading="lazy" decoding="async">
                <div class="movie-title-container">
                    <div class="movie-title ${isLong ? 'marquee-title' : ''}">${titleText}</div>
                </div>
            `;
            rowContainer.appendChild(card);

            if (m.poster) {
                getImage(m.poster).then(imgUrl => {
                    if (imgUrl) {
                        const img = card.querySelector('img');
                        if (img) img.src = imgUrl;
                    }
                }).catch(() => {});
            }
        }
    }

    homeCachedHTML = container.innerHTML;
}

window.showAllCategory = async function(categoryName) {
    currentCategoryName = categoryName;
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = categoryName;
    isInCategoryView = true;
    isPlayerView = false;
    updateHeaderButton(); 
    await filterAndDisplay(categoryName, true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.handleMenuOrBack = function() {
    if (isPlayerView) {
        exitPlayerView();
    } else if (isInGameView) {
        isInGameView = false;
        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('searchClearBtn');
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = 'Enter Movie Name or Cast...';
        }
        if (clearBtn) clearBtn.style.display = 'none';
        updateHeaderButton();
        renderContent(allMovies);
    } else if (isInCommentView) {
        isInCommentView = false;
        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('searchClearBtn');
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = 'Enter Movie Name or Cast...';
        }
        if (clearBtn) clearBtn.style.display = 'none';
        updateHeaderButton();
        renderContent(allMovies);
    } else if (isInSubscriptionView) {
        isInSubscriptionView = false;
        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('searchClearBtn');
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = 'Enter Movie Name or Cast...';
        }
        if (clearBtn) clearBtn.style.display = 'none';
        updateHeaderButton();
        homeCachedHTML = "";
        updateVipAdSuppression();
        renderContent(allMovies);
    } else if (isInCloudStreamView) {
        isInCloudStreamView = false;
        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('searchClearBtn');
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = 'Enter Movie Name or Cast...';
        }
        if (clearBtn) clearBtn.style.display = 'none';
        updateHeaderButton();
        renderContent(allMovies);
    } else if (isInCategoryView) {
        isInCategoryView = false;
        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('searchClearBtn');
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = 'Enter Movie Name or Cast...';
        }
        if (clearBtn) clearBtn.style.display = 'none';
        updateHeaderButton();
        renderContent(allMovies);
    } else {
        window.toggleDropdown();
    }
};

window.goHome = function() {
    isInGameView = false;
    isInCommentView = false;
    isInSubscriptionView = false;
    isInCloudStreamView = false;
    isInCategoryView = false;
    isPlayerView = false;
    if (cloudScrollObserver) {
        cloudScrollObserver.disconnect();
    }
    try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('view')) {
            url.searchParams.delete('view');
            window.history.replaceState({}, '', url.pathname + (url.search ? url.search : ''));
        }
    } catch (e) {}
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (searchInput) {
        searchInput.value = '';
        searchInput.placeholder = 'Enter Movie Name or Cast...';
    }
    if (clearBtn) clearBtn.style.display = 'none';
    updateHeaderButton();
    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
    }
    renderContent(allMovies);
};

window.exitApp = function() {
    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
    }

    // 1. If in video player, exit player first
    if (typeof window.exitPlayerView === 'function' && isPlayerView) {
        try { window.exitPlayerView(); } catch (e) {}
    }

    // 2. Capacitor Android Native Plugin
    try {
        if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
            if (window.Capacitor.Plugins && window.Capacitor.Plugins.App && typeof window.Capacitor.Plugins.App.exitApp === 'function') {
                window.Capacitor.Plugins.App.exitApp();
                return;
            }
        }
    } catch (e) {}

    // 3. Dynamic import of @capacitor/app (only on native platform)
    try {
        if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
            import('@capacitor/app').then(({ App }) => {
                if (App && typeof App.exitApp === 'function') {
                    App.exitApp().catch(() => {});
                }
            }).catch(() => {});
        }
    } catch (e) {}

    // 4. Native Android / WebView bridges
    try {
        if (window.Android && typeof window.Android.closeApp === 'function') {
            window.Android.closeApp();
            return;
        }
        if (window.Android && typeof window.Android.exitApp === 'function') {
            window.Android.exitApp();
            return;
        }
        if (window.Android && typeof window.Android.finish === 'function') {
            window.Android.finish();
            return;
        }
        if (window.AndroidInterface && typeof window.AndroidInterface.exitApp === 'function') {
            window.AndroidInterface.exitApp();
            return;
        }
    } catch (e) {}

    // 5. Cordova / PhoneGap / Navigator bridges
    try {
        if (navigator.app && typeof navigator.app.exitApp === 'function') {
            navigator.app.exitApp();
            return;
        }
        if (navigator.device && typeof navigator.device.exitApp === 'function') {
            navigator.device.exitApp();
            return;
        }
    } catch (e) {}

    // 6. Direct browser window closing attempts (WebViews, PWAs, popup tabs, etc.)
    try {
        window.close();
    } catch (e) {}

    try {
        window.open('', '_self', '');
        window.close();
    } catch (e) {}

    // 7. Graceful fallback for web browser where tab was opened directly
    try {
        if (window.history.length > 1) {
            window.history.back();
        }
    } catch (e) {}

    // Show sleek closing overlay
    let exitModal = document.getElementById('appExitModal');
    if (!exitModal) {
        exitModal = document.createElement('div');
        exitModal.id = 'appExitModal';
        exitModal.style.cssText = 'position:fixed;inset:0;background:rgba(11,14,23,0.96);backdrop-filter:blur(10px);z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;text-align:center;padding:24px;';
        exitModal.innerHTML = `
            <div style="width:68px;height:68px;border-radius:50%;background:rgba(239,68,68,0.15);border:2px solid #ef4444;display:flex;align-items:center;justify-content:center;margin-bottom:18px;color:#ef4444;font-size:28px;">
                <i class="fa-solid fa-right-from-bracket"></i>
            </div>
            <h2 style="font-size:22px;font-weight:700;margin:0 0 8px 0;letter-spacing:0.3px;">Closing VDOSky...</h2>
            <p style="font-size:14px;color:#94a3b8;max-width:320px;line-height:1.5;margin:0 0 24px 0;">App closing signal sent. If your browser restricts auto-closing tabs, please close this tab.</p>
            <div style="display:flex;gap:12px;">
                <button onclick="try{window.close();}catch(e){}; this.innerText='Please close tab';" style="padding:10px 22px;background:#ef4444;color:#fff;border:none;border-radius:10px;font-weight:600;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">
                    <i class="fa-solid fa-xmark"></i> Close Tab
                </button>
                <button onclick="document.getElementById('appExitModal')?.remove();" style="padding:10px 20px;background:rgba(255,255,255,0.1);color:#cbd5e1;border:1px solid rgba(255,255,255,0.15);border-radius:10px;font-weight:600;font-size:14px;cursor:pointer;">
                    Cancel
                </button>
            </div>
        `;
        document.body.appendChild(exitModal);
    }
    setTimeout(() => {
        try { window.close(); } catch (e) {}
    }, 200);
};

window.checkAppUpdate = function(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();

    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
    }

    const updateUrl = "https://vdoskay.blogspot.com";

    // 1. Check window.openInChrome helper (handles Native Android Bridge & Intent)
    if (typeof window.openInChrome === 'function') {
        window.openInChrome(updateUrl);
        return true;
    }

    // 2. Android Native Bridge
    if (window.Android) {
        if (typeof window.Android.openChromeDirectly === 'function') {
            try { window.Android.openChromeDirectly(updateUrl); return true; } catch (err) {}
        }
        if (typeof window.Android.openInChrome === 'function') {
            try { window.Android.openInChrome(updateUrl); return true; } catch (err) {}
        }
        if (typeof window.Android.openExternalUrl === 'function') {
            try { window.Android.openExternalUrl(updateUrl); return true; } catch (err) {}
        }
        if (typeof window.Android.openUrl === 'function') {
            try { window.Android.openUrl(updateUrl); return true; } catch (err) {}
        }
    }

    // 3. Android Intent for Google Chrome
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (isAndroid) {
        try {
            const cleanUrl = updateUrl.replace(/^https?:\/\//, '');
            const intentUrl = `intent://${cleanUrl}#Intent;scheme=https;package=com.android.chrome;end`;
            const intentA = document.createElement('a');
            intentA.href = intentUrl;
            document.body.appendChild(intentA);
            intentA.click();
            setTimeout(() => {
                try { document.body.removeChild(intentA); } catch (err) {}
            }, 100);
            return true;
        } catch (err) {}
    }

    // 4. Standard browser navigation / new tab
    try {
        window.open(updateUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
        window.location.href = updateUrl;
    }
    return true;
};

window.clearTopSearch = function() {
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
    if (clearBtn) clearBtn.style.display = 'none';

    if (isInCommentView) {
        isInCommentView = false;
        updateHeaderButton();
        renderContent(allMovies);
    } else if (isInSubscriptionView) {
        isInSubscriptionView = false;
        updateHeaderButton();
        renderContent(allMovies);
    } else if (isInCloudStreamView) {
        if (isPlayerView) {
            destroyCurrentPlyr();
            isPlayerView = false;
            currentPlayingMovie = null;
            updateHeaderButton();
        }
        if (typeof ensureCloudStreamGrid === 'function') {
            ensureCloudStreamGrid();
        }
        renderCloudCategoryFilter(currentCloudCategory);
    } else {
        if (isPlayerView) {
            destroyCurrentPlyr();
            isPlayerView = false;
            currentPlayingMovie = null;
            updateHeaderButton();
        }
        isInCategoryView = false;
        updateHeaderButton();
        renderContent(allMovies);
    }
};

function updateHeaderButton() {
    const menuToggle = document.getElementById('menuToggle');
    const menuIcon = document.getElementById('menuIcon');
    const menuBtnText = document.getElementById('menuBtnText');

    if (!menuToggle || !menuIcon || !menuBtnText) return;

    if (isPlayerView || isInCategoryView || isInCloudStreamView || isInSubscriptionView || isInCommentView || isInGameView) {
        menuIcon.className = "fa-solid fa-arrow-left";
        menuBtnText.innerText = "Back";
        menuToggle.style.background = "#ff4757";
        menuToggle.style.color = "#fff";
    } else {
        menuIcon.className = "fa-solid fa-bars";
        menuBtnText.innerText = "Menu";
        menuToggle.style.background = "#00d2ff";
        menuToggle.style.color = "#1e1e2f";
    }
}

window.toggleDropdown = function() { 
    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown) dropdown.classList.toggle("active");
};

// Auto close dropdown when clicking outside
document.addEventListener('click', function(e) {
    const dropdown = document.getElementById("dropdownMenu");
    const menuToggle = document.getElementById("menuToggle");
    if (!dropdown || !dropdown.classList.contains("active")) return;
    if (menuToggle && (menuToggle === e.target || menuToggle.contains(e.target))) return;
    if (!dropdown.contains(e.target)) {
        dropdown.classList.remove("active");
    }
}, true);

window.handleMenuShareApp = function(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
    }
    
    const shareUrl = "https://vdoskay.blogspot.com";
    const shareTitle = "VDOSky App - Free Movies, Music & QR Scanner";
    const shareText = "Download VDOSky App to watch free HD Movies, listen to trending Music & scan QR codes:";

    // 1. Try Android Native Interface
    if (window.Android && typeof window.Android.shareApp === 'function') {
        window.Android.shareApp(shareText, shareUrl);
        return;
    }

    // 2. Try Web Share API (Triggers native OS share dialog directly)
    if (navigator.share) {
        navigator.share({
            title: shareTitle,
            text: shareText,
            url: shareUrl
        }).catch((err) => {
            if (err && err.name !== 'AbortError') {
                window.location.href = "share.html";
            }
        });
        return;
    }

    // 3. Fallback: Open dedicated share.html section
    window.location.href = "share.html";
};

window.handleSearchInput = async function() {
    const searchInput = document.getElementById('searchInput');
    const term = searchInput ? searchInput.value.trim() : '';
    const clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.style.display = term.length > 0 ? 'block' : 'none';

    // If currently in the YouTube / Watch Stream section, ONLY perform YouTube search!
    if (isInCloudStreamView) {
        performCloudStreamSearch(term);
        return;
    }

    if (term === "") {
        if (isPlayerView) {
            destroyCurrentPlyr();
            isPlayerView = false;
            currentPlayingMovie = null;
        }
        isInCategoryView = false;
        updateHeaderButton();
        await renderContent(allMovies);
    } else {
        if (isPlayerView) {
            destroyCurrentPlyr();
            isPlayerView = false;
            currentPlayingMovie = null;
        }
        isInCategoryView = true;
        updateHeaderButton();
        await filterAndDisplay(term);
    }
};

window.filterAndDisplay = async function(term, isExactCategory = false) {
    const container = document.getElementById('mainContainer');
    if (!container) return;
    const lowerTerm = term.toLowerCase();

    const filtered = allMovies.filter(m => {
        if (isExactCategory) {
            return m.category && m.category.toLowerCase() === lowerTerm;
        }
        return (m.title && m.title.toLowerCase().includes(lowerTerm)) || 
            (m.name && m.name.toLowerCase().includes(lowerTerm)) ||
            (m.category && m.category.toLowerCase().includes(lowerTerm)) ||
            (m.cast && (typeof m.cast === 'string' ? m.cast.toLowerCase().includes(lowerTerm) : Array.isArray(m.cast) && m.cast.join(' ').toLowerCase().includes(lowerTerm)));
    });

    const displayTitle = isExactCategory ? `${term} (${filtered.length})` : `Results for "${term}" (${filtered.length})`;

    container.innerHTML = `
        <div class="section-header">
            <div class="section-title-wrapper">
                <div class="section-bar"></div>
                <div class="section-title">${displayTitle}</div>
            </div>
        </div>
        <div class="gallery-grid" id="searchResultGrid"></div>
    `;

    const grid = document.getElementById('searchResultGrid');
    if (!grid) return;

    let postCount = 0;
    for (const m of filtered) {
        postCount++;
        const card = document.createElement('div');
        card.className = 'movie-card';
        card.style.flex = "none";
        card.style.minWidth = "unset";
        card.onclick = () => window.openPlayer(m); 

        const titleText = m.title || m.name || '';
        const isLong = titleText.length > 18;

        card.innerHTML = `
            <span class="rating-badge">★ ${m.rating || '0.0'}</span>
            <img src="${m.poster || m.image || ''}" loading="lazy" decoding="async">
            <div class="movie-title-container">
                <div class="movie-title ${isLong ? 'marquee-title' : ''}">${titleText}</div>
            </div>
        `;
        grid.appendChild(card);

        if (m.poster) {
            getImage(m.poster).then(imgUrl => {
                if (imgUrl) {
                    const img = card.querySelector('img');
                    if (img) img.src = imgUrl;
                }
            }).catch(() => {});
        }
    }
};

// Filter and display all movies for a clicked cast member
window.filterByCast = async function(encodedActor) {
    if (!encodedActor) return;
    let actorName = "";
    try {
        actorName = decodeURIComponent(encodedActor).trim();
    } catch (e) {
        actorName = String(encodedActor).trim();
    }
    if (!actorName) return;

    // Exit active player and navigate to category/search view
    destroyCurrentPlyr();
    isPlayerView = false;
    isInCategoryView = true;
    currentCategoryName = actorName;
    updateHeaderButton();

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = actorName;
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });

    await window.displayMoviesByCast(actorName);
};

window.displayMoviesByCast = async function(actorName) {
    const container = document.getElementById('mainContainer');
    if (!container) return;
    const lowerActor = actorName.toLowerCase();

    // Filter all movies where this actor is in the cast
    let filtered = allMovies.filter(m => {
        if (!m) return false;
        if (m.cast) {
            if (typeof m.cast === 'string' && m.cast.toLowerCase().includes(lowerActor)) return true;
            if (Array.isArray(m.cast) && m.cast.some(c => c && String(c).toLowerCase().includes(lowerActor))) return true;
        }
        return false;
    });

    // Fallback search across all fields if no direct cast match found
    if (filtered.length === 0) {
        filtered = allMovies.filter(m => 
            (m.title && m.title.toLowerCase().includes(lowerActor)) || 
            (m.name && m.name.toLowerCase().includes(lowerActor)) ||
            (m.cast && (typeof m.cast === 'string' ? m.cast.toLowerCase().includes(lowerActor) : Array.isArray(m.cast) && m.cast.join(' ').toLowerCase().includes(lowerActor)))
        );
    }

    container.innerHTML = `
        <div class="section-header">
            <div class="section-title-wrapper">
                <div class="section-bar"></div>
                <div class="section-title">
                    <i class="fa-solid fa-user-tag" style="color: #00d2ff; margin-right: 6px; font-size: 14px;"></i>
                    Movies Starring "${actorName}" (${filtered.length})
                </div>
            </div>
        </div>
        <div class="gallery-grid" id="searchResultGrid"></div>
    `;

    const grid = document.getElementById('searchResultGrid');
    if (!grid) return;

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 50px 20px; color: #8b949e;">
                <i class="fa-solid fa-film" style="font-size: 40px; margin-bottom: 14px; opacity: 0.4; color: #00d2ff;"></i>
                <p style="font-size: 15px; color: #fff; margin-bottom: 6px;">No movies found for "${actorName}"</p>
                <p style="font-size: 12px;">Try exploring other categories or search for another movie.</p>
            </div>
        `;
        return;
    }

    let postCount = 0;
    for (const m of filtered) {
        postCount++;
        const card = document.createElement('div');
        card.className = 'movie-card';
        card.style.flex = "none";
        card.style.minWidth = "unset";
        card.onclick = () => window.openPlayer(m); 

        const titleText = m.title || m.name || '';
        const isLong = titleText.length > 18;

        card.innerHTML = `
            <span class="rating-badge">★ ${m.rating || '0.0'}</span>
            <img src="${m.poster || m.image || ''}" loading="lazy" decoding="async">
            <div class="movie-title-container">
                <div class="movie-title ${isLong ? 'marquee-title' : ''}">${titleText}</div>
            </div>
        `;
        grid.appendChild(card);

        if (m.poster) {
            getImage(m.poster).then(imgUrl => {
                if (imgUrl) {
                    const img = card.querySelector('img');
                    if (img) img.src = imgUrl;
                }
            }).catch(() => {});
        }
    }
};

window.startVoiceSearch = async function() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        showToast("Voice search not supported in this browser");
        return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    const micBtn = document.getElementById('micBtn');

    recognition.onstart = function() {
        if (micBtn) micBtn.classList.add('listening');
    };

    recognition.onresult = async function(event) {
        const speechToText = event.results[0][0].transcript;
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = speechToText;
        const clearBtn = document.getElementById('searchClearBtn');
        if (clearBtn) clearBtn.style.display = 'block';

        if (isInCloudStreamView) {
            performCloudStreamSearch(speechToText);
        } else {
            if (isPlayerView) {
                destroyCurrentPlyr();
                isPlayerView = false;
                currentPlayingMovie = null;
            }
            isInCloudStreamView = false;
            isInCategoryView = true;
            updateHeaderButton();
            await window.filterAndDisplay(speechToText);
        }
    };

    recognition.onerror = function() {
        if (micBtn) micBtn.classList.remove('listening');
    };

    recognition.onend = function() {
        if (micBtn) micBtn.classList.remove('listening');
    };

    recognition.start();
};

// Handle Browser / Android Hardware Back Button
window.addEventListener('popstate', () => {
    if (isPlayerView) {
        window.exitPlayerView();
    } else if (isInCloudStreamView) {
        isInCloudStreamView = false;
        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('searchClearBtn');
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = 'Enter Movie Name or Cast...';
        }
        if (clearBtn) clearBtn.style.display = 'none';
        updateHeaderButton();
        renderContent(allMovies);
    } else if (isInCategoryView) {
        isInCategoryView = false;
        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('searchClearBtn');
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = 'Enter Movie Name or Cast...';
        }
        if (clearBtn) clearBtn.style.display = 'none';
        updateHeaderButton();
        renderContent(allMovies);
    }
});

// ==========================================
// ALL ADS REMOVED - AD-FREE EXPERIENCE
// ==========================================

function loadFooterBannerAd() {
    const container = document.getElementById('vdoSkyFooterAdInner') || document.getElementById('fixedFooterAdInner');
    const outer = document.getElementById('vdoSkyFixedFooterAd') || document.getElementById('fixedFooterAdContainer');
    if (outer) outer.style.display = 'none';
    if (container) {
        container.innerHTML = '';
        container.style.display = 'none';
    }
    if (window.Android && typeof window.Android.hideBanner === 'function') {
        try { window.Android.hideBanner(); } catch (e) {}
    }
}

function scheduleFooterAdRefresh() {
    if (adRefreshTimer) {
        clearTimeout(adRefreshTimer);
        adRefreshTimer = null;
    }
}

function initFooterBannerAd() {
    loadFooterBannerAd();
}

// 1. Start.io / Facebook Interstitial Ad no-op
window.showStartIoInterstitial = function() {};
window.showFacebookInterstitial = function() {};

// 2. Start.io Rewarded Video Ad no-op
window.showStartIoRewarded = function() {};
window.showFacebookRewarded = function() {};

// Stubs for backwards compatibility
window.showSmartlinkInterstitial = function() {};
window.closeSmartlinkInterstitial = function() {};
window.showPopunderInterstitial = function() {};
window.closePopunderInterstitial = function() {};
window.openSmartlinkInChrome = function() {};
window.openPopunderInChrome = function() {};
window.openVipFromAd = function() {
    if (typeof window.openSubscriptionSection === 'function') {
        window.openSubscriptionSection();
    }
};

loadFooterBannerAd();

// ==========================================
// CLOUD STREAM SECTION (NEUTRAL BRANDED STREAM ENGINE)
// ==========================================
let currentCloudCategory = "All";
let cloudStreamSearchDebounce = null;
let cloudRenderedCount = 0;
const CLOUD_BATCH_SIZE = 15;
let cloudIsLoadingMore = false;
let cloudCardCount = 0;
let cloudQueryIndex = 0;
let cloudScrollObserver = null;
let cloudWindowScrollAttached = false;
const INFINITE_YOUTUBE_QUERIES = [
    'latest hindi dubbed full movie 2024',
    'south indian action hindi dubbed movie',
    'new bollywood full movie hd',
    'superhit thriller suspense full movie hindi',
    'hollywood movies dubbed in hindi full',
    'comedy superhit full movie hindi',
    'latest blockbuster action full movie in hindi',
    'popular south movie hindi dubbed',
    'top rated full action movie hindi',
    'romantic action thriller movie in hindi'
];

const INVIDIOUS_INSTANCES = [
    'https://invidious.f5.si',
    'https://invidious.ducks.party',
    'https://invidious.projectsegfau.lt',
    'https://invidious.nerdvpn.de',
    'https://yt.drgnz.club'
];

async function fetchInvidiousSearch(query) {
    for (const base of INVIDIOUS_INSTANCES) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500);
            const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) {
                    return data.map(item => {
                        const sec = item.lengthSeconds || 0;
                        const mins = Math.floor(sec / 60);
                        const durStr = mins > 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                        let poster = '';
                        if (item.videoId) {
                            poster = `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
                        } else if (item.videoThumbnails && item.videoThumbnails.length > 0) {
                            poster = item.videoThumbnails[item.videoThumbnails.length - 1].url || '';
                        }
                        return {
                            id: `stream_${item.videoId}`,
                            title: item.title || 'Stream Video',
                            category: "Search Results",
                            poster: poster,
                            rating: "4.8",
                            yt: item.videoId,
                            author: item.author || 'Creator',
                            duration: durStr || '10m',
                            views: item.viewCount ? `${(item.viewCount >= 1000000 ? (item.viewCount / 1000000).toFixed(1) + 'M' : item.viewCount >= 1000 ? Math.floor(item.viewCount / 1000) + 'K' : item.viewCount)} views` : 'HD Stream'
                        };
                    });
                }
            }
        } catch (e) {}
    }
    return null;
}

const YOUTUBE_SECTION_DEFAULT_QUERY = 'latest hindi dubbed full movie';
const YOUTUBE_SECTION_TARGET_URL = 'https://www.youtube.com/results?search_query=latest+hindi+dubbed+full+movie';

function ensureCloudStreamGrid() {
    let grid = document.getElementById('cloudStreamGrid');
    if (!grid) {
        const container = document.getElementById('mainContainer');
        if (!container) return null;

        if (isPlayerView) {
            destroyCurrentPlyr();
            isPlayerView = false;
            currentPlayingMovie = null;
            updateHeaderButton();
        }

        container.innerHTML = `
            <div class="cloud-stream-wrapper">
                <!-- Video Grid (Single post per row) -->
                <div id="cloudStreamGrid" class="cloud-stream-grid"></div>
            </div>
        `;
        grid = document.getElementById('cloudStreamGrid');
    }
    return grid;
}
window.ensureCloudStreamGrid = ensureCloudStreamGrid;

window.openCloudStreamSection = function() {
    isInCloudStreamView = true;
    isInCommentView = false;
    isPlayerView = false;
    isInCategoryView = false;
    currentCloudCategory = "All";
    updateHeaderButton();

    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
    }

    // Connect & Configure Top Search Bar specifically for YouTube / Stream Search
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (searchInput) {
        searchInput.value = '';
        searchInput.placeholder = 'Search latest hindi dubbed full movies...';
    }
    if (clearBtn) clearBtn.style.display = 'none';

    const container = document.getElementById('mainContainer');
    if (!container) return;

    window.scrollTo({ top: 0, behavior: 'instant' });

    ensureCloudStreamGrid();

    // Prioritize South Action and Bollywood Hindi Dubbed Movies from Curated Catalog first
    const hindiDubbedCurated = CURATED_CLOUD_CATALOG.filter(c => 
        c.category === 'South Action Movies' || 
        c.category === 'Latest Full Movies' || 
        (c.title && /hindi|dubbed|action/i.test(c.title))
    );
    const initialList = hindiDubbedCurated.length > 0 ? hindiDubbedCurated : CURATED_CLOUD_CATALOG;
    renderCloudVideos(initialList);

    // Fetch live search results for exact link query: "latest hindi dubbed full movie"
    const targetQuery = YOUTUBE_SECTION_DEFAULT_QUERY;
    
    // 1. Try local dev-server endpoint if present
    fetch(`/api/youtube-related?q=${encodeURIComponent(targetQuery)}`)
        .then(r => r.json())
        .then(data => {
            if (Array.isArray(data) && data.length > 0 && isInCloudStreamView && currentCloudCategory === 'All') {
                const sInput = document.getElementById('searchInput');
                if (!sInput || sInput.value.trim() === '') {
                    const mapped = data.map(item => ({
                        id: `stream_${item.videoId || item.yt}`,
                        title: item.title,
                        category: 'Latest Hindi Dubbed Full Movie',
                        poster: item.poster || `https://i.ytimg.com/vi/${item.videoId || item.yt}/hqdefault.jpg`,
                        rating: item.rating || '4.8',
                        yt: item.videoId || item.yt,
                        author: item.channel || 'YouTube',
                        duration: item.duration || 'Full HD',
                        views: item.views || 'HD Stream'
                    }));
                    const existingYts = new Set(mapped.map(m => m.yt));
                    const remaining = initialList.filter(c => !existingYts.has(c.yt));
                    renderCloudVideos([...mapped, ...remaining]);
                }
            }
        })
        .catch(() => {});

    // 2. Also try client-side Invidious search for "latest hindi dubbed full movie"
    fetchInvidiousSearch(targetQuery).then(liveMovies => {
        if (liveMovies && liveMovies.length > 0 && isInCloudStreamView && currentCloudCategory === 'All') {
            const sInput = document.getElementById('searchInput');
            if (!sInput || sInput.value.trim() === '') {
                const existingYts = new Set(liveMovies.map(m => m.yt));
                const remaining = initialList.filter(c => !existingYts.has(c.yt));
                renderCloudVideos([...liveMovies, ...remaining]);
            }
        }
    }).catch(() => {});
};
window.openYouTubeSection = window.openCloudStreamSection;

window.performCloudStreamSearch = function(query) {
    if (cloudStreamSearchDebounce) clearTimeout(cloudStreamSearchDebounce);

    // If currently in player view, exit player view cleanly and restore the Watch Stream grid
    if (isPlayerView) {
        destroyCurrentPlyr();
        isPlayerView = false;
        currentPlayingMovie = null;
        updateHeaderButton();
    }

    const grid = ensureCloudStreamGrid();

    if (!query || query.length === 0) {
        renderCloudCategoryFilter(currentCloudCategory);
        return;
    }

    if (grid) {
        grid.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: #00d2ff; font-size: 15px;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 24px; margin-bottom: 10px; display: block;"></i>
                Searching YouTube for "${query}"...
            </div>
        `;
    }

    cloudStreamSearchDebounce = setTimeout(async () => {
        // 1. Try local catalog match first
        const lower = query.toLowerCase();
        const localMatches = CURATED_CLOUD_CATALOG.filter(item => 
            (item.title && item.title.toLowerCase().includes(lower)) ||
            (item.author && item.author.toLowerCase().includes(lower)) ||
            (item.category && item.category.toLowerCase().includes(lower))
        );

        // 2. Fetch live online search from Invidious instance
        const liveResults = await fetchInvidiousSearch(query);

        const currentGrid = ensureCloudStreamGrid();
        if (liveResults && liveResults.length > 0) {
            // Combine results, prioritizing live results
            const existingIds = new Set(liveResults.map(r => r.yt));
            const extraLocal = localMatches.filter(l => !existingIds.has(l.yt));
            renderCloudVideos([...liveResults, ...extraLocal]);
        } else if (localMatches.length > 0) {
            renderCloudVideos(localMatches);
        } else {
            if (currentGrid) {
                currentGrid.innerHTML = `
                    <div style="text-align: center; padding: 50px 20px; color: #8b949e;">
                        <i class="fa-solid fa-film" style="font-size: 32px; margin-bottom: 12px; opacity: 0.5; display: block;"></i>
                        <div style="font-size: 16px; font-weight: 600; color: #c9d1d9; margin-bottom: 6px;">No YouTube streams found for "${query}"</div>
                        <div style="font-size: 13px;">Try searching with different terms like "Arijit Singh", "Lofi songs", "CarryMinati", or "Short Film".</div>
                    </div>
                `;
            }
        }
    }, 400);
};

window.clearCloudStreamSearch = function() {
    window.clearTopSearch();
};

window.setCloudCategory = function(cat, btn) {
    currentCloudCategory = cat;
    const pills = document.querySelectorAll('.cloud-pill');
    pills.forEach(p => p.classList.remove('active'));
    if (btn) btn.classList.add('active');

    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';

    renderCloudCategoryFilter(cat);
};

function renderCloudCategoryFilter(cat) {
    if (cat === 'All') {
        renderCloudVideos(CURATED_CLOUD_CATALOG);
    } else {
        const filtered = CURATED_CLOUD_CATALOG.filter(item => item.category === cat);
        renderCloudVideos(filtered);
    }
}

function createCloudVideoCard(video) {
    const card = document.createElement('div');
    card.className = 'cloud-video-card';
    card.onclick = () => {
        playCloudStreamVideo(video);
    };

    const posterSrc = video.poster || `https://i.ytimg.com/vi/${video.yt}/hqdefault.jpg`;
    const titleText = video.title || 'Untitled Stream';
    const channelName = video.author || 'YouTube Channel';
    const durationText = video.duration || 'Full Movie';
    const viewsText = video.views || '1.8M views';

    card.innerHTML = `
        <div class="cloud-thumb-wrapper">
            <img src="${posterSrc}" alt="${titleText}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&auto=format&fit=crop&q=60';">
            ${durationText ? `<span class="cloud-duration-tag">${durationText}</span>` : ''}
        </div>
        <div class="yt-post-details">
            <div class="yt-channel-avatar">
                <i class="fa-brands fa-youtube"></i>
            </div>
            <div class="yt-details-box">
                <div class="yt-title-text" title="${titleText}">${titleText}</div>
                <div class="yt-channel-row">
                    <span class="yt-channel-name">${channelName} <i class="fa-solid fa-circle-check yt-verified-badge"></i></span>
                    <span class="yt-meta-dot">•</span>
                    <span>${viewsText}</span>
                    <span class="yt-meta-dot">•</span>
                    <span>${durationText}</span>
                </div>
            </div>
            <button class="yt-menu-dots-btn" type="button" aria-label="Action" onclick="event.stopPropagation();">
                <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
        </div>
    `;
    return card;
}

function appendCloudVideosBatch(batchSize = CLOUD_BATCH_SIZE) {
    const grid = document.getElementById('cloudStreamGrid');
    if (!grid) return 0;

    const sentinel = document.getElementById('cloudStreamLoadingSentinel');
    const toRender = currentCloudFilteredList.slice(cloudRenderedCount, cloudRenderedCount + batchSize);
    if (!toRender || toRender.length === 0) return 0;

    toRender.forEach((video) => {
        cloudCardCount++;
        const card = createCloudVideoCard(video);
        if (sentinel && sentinel.parentNode === grid) {
            grid.insertBefore(card, sentinel);
        } else {
            grid.appendChild(card);
        }
    });

    cloudRenderedCount += toRender.length;
    return toRender.length;
}

async function fetchMoreInfiniteCloudVideos() {
    const nextQuery = INFINITE_YOUTUBE_QUERIES[cloudQueryIndex % INFINITE_YOUTUBE_QUERIES.length];
    cloudQueryIndex++;

    const existingYts = new Set(currentCloudFilteredList.map(v => v.yt).filter(Boolean));
    const newVideos = [];

    // 1. Try local dev-server endpoint
    try {
        const res = await fetch(`/api/youtube-related?q=${encodeURIComponent(nextQuery)}`);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                data.forEach(item => {
                    const yId = item.videoId || item.yt;
                    if (yId && !existingYts.has(yId)) {
                        existingYts.add(yId);
                        newVideos.push({
                            id: `stream_${yId}`,
                            title: item.title,
                            category: 'Latest Hindi Dubbed Full Movie',
                            poster: item.poster || `https://i.ytimg.com/vi/${yId}/hqdefault.jpg`,
                            rating: item.rating || '4.8',
                            yt: yId,
                            author: item.channel || 'YouTube',
                            duration: item.duration || 'Full HD',
                            views: item.views || 'HD Stream'
                        });
                    }
                });
            }
        }
    } catch (e) {}

    // 2. Try Invidious search
    if (newVideos.length === 0) {
        try {
            const liveMovies = await fetchInvidiousSearch(nextQuery);
            if (Array.isArray(liveMovies) && liveMovies.length > 0) {
                liveMovies.forEach(v => {
                    if (v.yt && !existingYts.has(v.yt)) {
                        existingYts.add(v.yt);
                        newVideos.push(v);
                    }
                });
            }
        } catch (e) {}
    }

    // 3. Fallback: If network searches yielded no new unique videos, cycle/remix curated catalog
    if (newVideos.length === 0 && Array.isArray(CURATED_CLOUD_CATALOG) && CURATED_CLOUD_CATALOG.length > 0) {
        const shuffled = [...CURATED_CLOUD_CATALOG].sort(() => 0.5 - Math.random());
        shuffled.slice(0, 15).forEach((item, idx) => {
            newVideos.push({
                ...item,
                id: `stream_remix_${cloudQueryIndex}_${idx}_${item.yt || idx}`,
                views: `${(Math.random() * 4 + 1).toFixed(1)}M views`
            });
        });
    }

    if (newVideos.length > 0) {
        currentCloudFilteredList.push(...newVideos);
    }
}

async function loadMoreCloudVideos() {
    if (!isInCloudStreamView || isPlayerView || cloudIsLoadingMore) return;
    cloudIsLoadingMore = true;

    const sentinel = document.getElementById('cloudStreamLoadingSentinel');
    if (sentinel) {
        sentinel.style.display = 'flex';
        sentinel.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> <span>Loading more YouTube videos...</span>`;
    }

    try {
        if (cloudRenderedCount < currentCloudFilteredList.length) {
            appendCloudVideosBatch(CLOUD_BATCH_SIZE);
            if (cloudRenderedCount >= currentCloudFilteredList.length - 8) {
                fetchMoreInfiniteCloudVideos().catch(() => {});
            }
        } else {
            await fetchMoreInfiniteCloudVideos();
            appendCloudVideosBatch(CLOUD_BATCH_SIZE);
        }
    } catch (e) {
        console.warn('Error loading more cloud stream videos:', e);
    } finally {
        setTimeout(() => {
            cloudIsLoadingMore = false;
        }, 150);
    }
}

function handleCloudWindowScroll() {
    if (!isInCloudStreamView || isPlayerView || cloudIsLoadingMore) return;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const windowHeight = window.innerHeight;
    const docHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
    if (scrollY + windowHeight >= docHeight - 650) {
        loadMoreCloudVideos();
    }
}

function ensureCloudStreamSentinel(grid) {
    let sentinel = document.getElementById('cloudStreamLoadingSentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.id = 'cloudStreamLoadingSentinel';
        sentinel.className = 'cloud-loading-sentinel';
        sentinel.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> <span>Loading more YouTube videos...</span>`;
        grid.appendChild(sentinel);
    } else {
        grid.appendChild(sentinel);
    }

    if (cloudScrollObserver) {
        cloudScrollObserver.disconnect();
    }
    if (window.IntersectionObserver) {
        cloudScrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && isInCloudStreamView && !isPlayerView && !cloudIsLoadingMore) {
                    loadMoreCloudVideos();
                }
            });
        }, { rootMargin: '600px 0px' });
        cloudScrollObserver.observe(sentinel);
    }

    if (!cloudWindowScrollAttached) {
        window.addEventListener('scroll', handleCloudWindowScroll, { passive: true });
        cloudWindowScrollAttached = true;
    }
}

function renderCloudVideos(videos) {
    currentCloudFilteredList = (videos && videos.length > 0) 
        ? [...videos] 
        : (typeof CURATED_CLOUD_CATALOG !== 'undefined' ? [...CURATED_CLOUD_CATALOG] : []);
    const grid = ensureCloudStreamGrid();
    if (!grid) return;

    grid.innerHTML = '';
    cloudRenderedCount = 0;
    cloudCardCount = 0;

    if (!currentCloudFilteredList || currentCloudFilteredList.length === 0) {
        grid.innerHTML = `
            <div style="text-align: center; width: 100%; padding: 40px 20px; color: #8b949e;">
                <i class="fa-solid fa-play" style="font-size: 28px; margin-bottom: 10px; opacity: 0.5; display: block;"></i>
                No videos available in this category.
            </div>
        `;
        return;
    }

    appendCloudVideosBatch(CLOUD_BATCH_SIZE);
    ensureCloudStreamSentinel(grid);
}

function playCloudStreamVideo(video, preserveFullscreen = false) {
    if (!window.isUserSubscribed()) {
        window.showSubscriptionRequiredPopup('youtube', video.title || 'YouTube Video');
        return;
    }
    if (!preserveFullscreen) {
        savedScrollPosition = window.scrollY || window.pageYOffset || 0;
    }
    const movieObj = {
        title: video.title,
        name: video.title,
        poster: video.poster,
        category: video.category || 'Cloud Stream',
        rating: video.rating || '4.8',
        yt: video.yt,
        cast: [video.author || 'Cloud Stream Creator']
    };
    window.openPlayer(movieObj, preserveFullscreen);
}
window.playCloudStreamVideo = playCloudStreamVideo;

fetchMovies();

// ==========================================
// VIP SUBSCRIPTION CONTROLLER & UI
// ==========================================
function subToast(msg) {
    let t = document.getElementById('subToastPill');
    if (!t) {
        t = document.createElement('div');
        t.id = 'subToastPill';
        t.style.position = 'fixed';
        t.style.bottom = '80px';
        t.style.left = '50%';
        t.style.transform = 'translateX(-50%)';
        t.style.background = 'linear-gradient(135deg, #1e1e2f, #2d2d44)';
        t.style.color = '#ffffff';
        t.style.padding = '12px 20px';
        t.style.borderRadius = '25px';
        t.style.boxShadow = '0 10px 25px rgba(0,0,0,0.6), 0 0 15px rgba(197, 75, 255, 0.4)';
        t.style.border = '1px solid #c54bff';
        t.style.zIndex = '999999';
        t.style.fontSize = '13px';
        t.style.fontWeight = '600';
        t.style.pointerEvents = 'none';
        t.style.transition = 'all 0.3s ease';
        t.style.textAlign = 'center';
        t.style.maxWidth = '90%';
        document.body.appendChild(t);
    }
    t.innerText = msg;
    t.style.opacity = '1';
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => {
        t.style.opacity = '0';
    }, 3500);
}

window.openSubscriptionSection = function() {
    isInSubscriptionView = true;
    isInCommentView = false;
    isInCloudStreamView = false;
    isPlayerView = false;
    isInCategoryView = false;
    updateHeaderButton();

    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
    }

    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (searchInput) {
        searchInput.value = '';
        searchInput.placeholder = 'VIP Subscription & Wallet...';
    }
    if (clearBtn) clearBtn.style.display = 'none';

    window.scrollTo({ top: 0, behavior: 'instant' });
    renderSubscriptionPage();
};

async function renderSubscriptionPage() {
    const container = document.getElementById('mainContainer');
    if (!container) return;

    const isSub = typeof window.isUserSubscribed === 'function' ? window.isUserSubscribed() : false;
    const planName = localStorage.getItem('vdosky_sub_plan') || 'Active VIP';
    const expiry = parseInt(localStorage.getItem('vdosky_sub_expiry') || '0', 10);
    const daysLeft = expiry > Date.now() ? Math.ceil((expiry - Date.now()) / (24 * 60 * 60 * 1000)) : 0;

    const activeBannerHtml = isSub ? `
        <div style="background: linear-gradient(135deg, rgba(4, 170, 109, 0.2) 0%, rgba(16, 185, 129, 0.08) 100%); border: 1.5px solid #04AA6D; border-radius: 14px; padding: 18px 20px; margin-bottom: 25px; text-align: center; box-shadow: 0 8px 25px rgba(4, 170, 109, 0.25);">
            <div style="font-size: 28px; color: #04AA6D; margin-bottom: 6px;"><i class="fa-solid fa-circle-check"></i></div>
            <h3 style="margin: 0 0 6px 0; font-size: 19px; font-weight: 700; color: #ffffff;">Subscription Active!</h3>
            <p style="margin: 0; color: #a7f3d0; font-size: 14px;">Plan: <strong>${planName}</strong> (${daysLeft > 0 ? `${daysLeft} days remaining` : 'Active'})</p>
            <div style="margin-top: 8px; font-size: 12px; color: #cbd5e1;">Device Limit - 1 (Active on this device)</div>
        </div>
    ` : '';

    container.innerHTML = `
        <div class="container sub-page-container">
            ${activeBannerHtml}
            <h1>Subscribe now & Watch Play Continue</h1>
            <p style="text-align:center;">Recommended UPI Payment<br/> Safe And Secure</p>
            <div class="plans">
                <div class="plan">
                    <div class="plan-header">Basic Plan</div>
                    <div class="plan-body">
                        <div>
                            <div class="price">₹10.00</div>
                            <div class="duration">2 Day(s)</div>
                            <div class="device">Device Limit - 1</div>
                        </div>
                        <a href="https://rzp.io/rzp/CT7V0kp" onclick="window.selectSubscriptionPlan('Basic Plan', '10.00', 'https://rzp.io/rzp/CT7V0kp', 2); return false;"><button data-name="Basic Plan" class="btn"><b>SELECT PLAN</b></button></a>
                    </div>
                </div>

                <div class="plan">
                    <div class="plan-header">Premium Plan</div>
                    <div class="plan-body">
                        <div>
                            <div class="price">₹39.99</div>
                            <div class="duration">1 Month(s)</div>
                            <div class="device">Device Limit - 1</div>
                        </div>
                        <a href="https://rzp.io/rzp/eZcRkdDu" onclick="window.selectSubscriptionPlan('Premium Plan', '39.99', 'https://rzp.io/rzp/eZcRkdDu', 30); return false;"><button data-name="Premium Plan" class="btn"><b>SELECT PLAN</b></button></a>
                    </div>
                </div>

                <div class="plan">
                    <div class="plan-header">Platinum Plan</div>
                    <div class="plan-body">
                        <div>
                            <div class="price">₹299.00</div>
                            <div class="duration">6 Month(s)</div>
                            <div class="device">Device Limit - 1</div>
                        </div>
                        <a href="https://rzp.io/rzp/NylbLir" onclick="window.selectSubscriptionPlan('Platinum Plan', '299.00', 'https://rzp.io/rzp/NylbLir', 180); return false;"><button data-name="Platinum Plan" class="btn"><b>SELECT PLAN</b></button></a>
                    </div>
                </div>

                <div class="plan">
                    <div class="plan-header">Diamond Plan</div>
                    <div class="plan-body">
                        <div>
                            <div class="price">₹579.00</div>
                            <div class="duration">1 Year(s)</div>
                            <div class="device">Device Limit - 1</div>
                        </div>
                        <a href="https://rzp.io/rzp/g9HuABr" onclick="window.selectSubscriptionPlan('Diamond Plan', '579.00', 'https://rzp.io/rzp/g9HuABr', 365); return false;"><button data-name="Diamond Plan" class="btn"><b>SELECT PLAN</b></button></a>
                    </div>
                </div>
            </div>

            <!-- Auto Verify Box -->
            <div class="sub-verify-box" style="margin-top: 35px;">
                <div style="font-weight: 700; color: #fff; font-size: 15px; margin-bottom: 6px;">
                    <i class="fa-solid fa-circle-check" style="color: #04AA6D; margin-right: 6px;"></i> Already Paid? Auto Verify &amp; Activate
                </div>
                <p style="color: #999; font-size: 12.5px; margin-bottom: 14px;">Enter your Razorpay Payment ID or UPI Transaction Reference Number (UTR) below to activate immediately:</p>
                <div style="display: flex; justify-content: center; gap: 8px; flex-wrap: wrap;">
                    <input type="text" id="pageAutoVerifyInput" placeholder="Enter Payment ID / UTR (e.g. pay_Q8x9Y...)" autocomplete="off">
                    <button type="button" class="btn" style="width: auto; padding: 11px 24px; margin-bottom: 10px;" onclick="window.handleAutoVerifySubmit('page');">
                        <b>AUTO VERIFY</b>
                    </button>
                </div>
            </div>
        </div>
    `;
}
window.renderSubscriptionPage = renderSubscriptionPage;

window.handleSubLoginTypeChange = function(type) {
    const label = document.getElementById('subIdentifierLabel');
    const input = document.getElementById('subIdentifierInput');
    if (!label || !input) return;

    if (type === 'gmail') {
        label.innerText = 'Gmail / Email Address:';
        input.type = 'email';
        input.placeholder = 'Enter Gmail Address (e.g. yourname@gmail.com)';
        input.autocomplete = 'email';
    } else {
        label.innerText = 'Mobile Number:';
        input.type = 'tel';
        input.placeholder = 'Enter 10-digit Mobile Number (e.g. 9804163298)';
        input.autocomplete = 'tel';
    }
    input.focus();
};

window.handleSubLoginSubmit = async function() {
    const typeSelect = document.getElementById('subLoginTypeSelect');
    const idInput = document.getElementById('subIdentifierInput');
    const pinInput = document.getElementById('subPinInput');
    if (!idInput || !pinInput) return;

    const loginType = typeSelect ? typeSelect.value : 'mobile';
    const rawId = idInput.value.trim();
    const pin = pinInput.value.trim();

    if (loginType === 'gmail') {
        if (!rawId || !rawId.includes('@') || rawId.length < 5) {
            subToast('Please enter a valid Gmail address (e.g. user@gmail.com)');
            idInput.focus();
            return;
        }
    } else {
        if (!rawId || rawId.length < 6) {
            subToast('Please enter a valid Mobile Number');
            idInput.focus();
            return;
        }
    }

    if (!pin || pin.length < 3) {
        subToast('Please enter your Password or PIN');
        pinInput.focus();
        return;
    }

    const btn = document.getElementById('subLoginBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Verifying...';
    }

    try {
        const res = await loginOrRegisterSubscriptionUser(rawId, pin);
        if (res.success) {
            subToast('✅ Login successful!');
            await refreshSubscriptionState();
            renderSubscriptionPage();
        } else if (res.alreadyUsed || res.alreadyLoggedInAnotherDevice) {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-right-to-bracket" style="margin-right: 6px;"></i> Login to Wallet';
            }
            window.showDeviceLimitModal(rawId, pin, res.currentDeviceModel, res.lastActiveAt);
        } else if (res.notRegistered) {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-right-to-bracket" style="margin-right: 6px;"></i> Login to Wallet';
            }
            window.showNotRegisteredModal(rawId);
        } else {
            subToast('❌ ' + (res.error || 'Login failed'));
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-right-to-bracket" style="margin-right: 6px;"></i> Login to Wallet';
            }
        }
    } catch (err) {
        subToast('Login error: ' + (err.message || err));
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-right-to-bracket" style="margin-right: 6px;"></i> Login to Wallet';
        }
    }
};

window.showSubscriptionAlreadyUsedModal = function(rawId, pin) {
    let modal = document.getElementById('subAlreadyUsedModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'subAlreadyUsedModal';
        modal.className = 'custom-sub-modal-backdrop';
        document.body.appendChild(modal);
    }

    const effectivePin = pin || document.getElementById('subPinInput')?.value?.trim() || '';
    const safeDisplayId = String(rawId || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    modal.innerHTML = `
        <div class="custom-sub-modal-card" style="border-color: #f59e0b; box-shadow: 0 10px 35px rgba(245, 158, 11, 0.35);">
            <button class="custom-sub-modal-close" onclick="window.closeSubscriptionAlreadyUsedModal()" title="Close">&times;</button>
            <div class="custom-sub-modal-icon" style="color: #f59e0b; background: rgba(245, 158, 11, 0.15);">
                <i class="fa-solid fa-mobile-screen"></i>
            </div>
            <div class="custom-sub-modal-title" style="color: #f59e0b;">Account Active on Another Device!</div>
            <div class="custom-sub-modal-subtitle">1 Device Active Only</div>
            <div class="custom-sub-modal-body" style="font-size: 13px; line-height: 1.6; color: #cbd5e1;">
                Account <strong>"${safeDisplayId}"</strong> is currently active on another device.
                <div style="background: rgba(245, 158, 11, 0.1); padding: 10px 14px; border-radius: 8px; margin: 12px 0; border: 1px solid rgba(245, 158, 11, 0.3); color: #fde68a; text-align: left; font-size: 12px;">
                    <i class="fa-solid fa-circle-exclamation" style="margin-right: 4px;"></i>
                    To protect your subscription, only 1 device can be active at a time.
                </div>
                Would you like to logout the previous device and login on this device?
                <br>
                <span style="font-size: 12px; color: #a5b4fc;">(আগের ডিভাইসটি লগআউট করে কি এই ডিভাইসে লগইন করতে চান?)</span>
            </div>
            <div class="custom-sub-modal-actions" style="display: flex; flex-direction: column; gap: 10px;">
                <button type="button" class="custom-sub-modal-register-btn" id="confirmSwitchDeviceBtnFromAlreadyUsed" style="background: linear-gradient(135deg, #f59e0b, #d97706); width: 100%; border: none; font-weight: 800; padding: 12px; cursor: pointer; color: #ffffff; border-radius: 8px;">
                    <i class="fa-solid fa-arrow-right-arrow-left"></i> Logout Previous Device &amp; Login Here
                </button>
                <button type="button" class="custom-sub-modal-cancel-btn" onclick="window.closeSubscriptionAlreadyUsedModal()" style="width: 100%; padding: 10px; background: #374151; border: none; color: #d1d5db; border-radius: 8px; font-weight: 600; cursor: pointer;">
                    Cancel / বাতিল
                </button>
            </div>
        </div>
    `;

    modal.style.display = 'flex';

    const btn = document.getElementById('confirmSwitchDeviceBtnFromAlreadyUsed');
    if (btn) {
        btn.onclick = () => {
            window.closeSubscriptionAlreadyUsedModal();
            window.confirmDeviceSwitch(rawId, effectivePin);
        };
    }
};

window.closeSubscriptionAlreadyUsedModal = function() {
    const modal = document.getElementById('subAlreadyUsedModal');
    if (modal) modal.style.display = 'none';
};

window.showDeviceLimitModal = function(rawId, pin, deviceModel, lastActiveAt) {
    let modal = document.getElementById('deviceLimitModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'deviceLimitModal';
        modal.className = 'custom-sub-modal-backdrop';
        document.body.appendChild(modal);
    }

    const safeModel = String(deviceModel || 'Another Phone / Device').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeDisplayId = String(rawId || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const timeInfo = lastActiveAt ? new Date(lastActiveAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : 'Recently';

    modal.innerHTML = `
        <div class="custom-sub-modal-card" style="border-color: #f59e0b; box-shadow: 0 10px 35px rgba(245, 158, 11, 0.28);">
            <button class="custom-sub-modal-close" onclick="window.closeDeviceLimitModal()" title="Close">&times;</button>
            <div class="custom-sub-modal-icon" style="color: #f59e0b; background: rgba(245, 158, 11, 0.15);">
                <i class="fa-solid fa-mobile-screen-button"></i>
            </div>
            <div class="custom-sub-modal-title" style="color: #f59e0b;">Device Limit Reached!</div>
            <div class="custom-sub-modal-subtitle">1 Account = 1 Active Device Only</div>
            <div class="custom-sub-modal-body" style="font-size: 13px; line-height: 1.5; color: #cbd5e1;">
                Account <strong>"${safeDisplayId}"</strong> is already active on another device:
                <div style="background: rgba(245, 158, 11, 0.08); padding: 10px 14px; border-radius: 8px; margin: 12px 0; border: 1px solid rgba(245, 158, 11, 0.2); color: #ffffff; text-align: left;">
                    <div style="font-weight: 700; font-size: 13px; color: #fbbf24; display: flex; align-items: center; gap: 6px;">
                        <i class="fa-solid fa-mobile-screen"></i> ${safeModel}
                    </div>
                    <div style="font-size: 11px; color: #94a3b8; margin-top: 3px;">
                        <i class="fa-regular fa-clock"></i> Active: ${timeInfo}
                    </div>
                </div>
                Subscription sharing across multiple devices is restricted. Would you like to log out from the other device and log in here?
            </div>
            <div class="custom-sub-modal-actions" style="display: flex; flex-direction: column; gap: 10px;">
                <button type="button" class="custom-sub-modal-register-btn" id="confirmSwitchDeviceBtn" style="background: linear-gradient(135deg, #f59e0b, #d97706); width: 100%; border: none; font-weight: 800; padding: 12px;">
                    <i class="fa-solid fa-arrow-right-arrow-left"></i> Logout Other & Login Here
                </button>
                <button type="button" class="custom-sub-modal-cancel-btn" onclick="window.closeDeviceLimitModal()" style="width: 100%;">
                    Cancel
                </button>
            </div>
        </div>
    `;

    modal.style.display = 'flex';

    const btn = document.getElementById('confirmSwitchDeviceBtn');
    if (btn) {
        btn.onclick = () => window.confirmDeviceSwitch(rawId, pin);
    }
};

window.closeDeviceLimitModal = function() {
    const modal = document.getElementById('deviceLimitModal');
    if (modal) modal.style.display = 'none';
};

window.confirmDeviceSwitch = async function(rawId, pin) {
    const btn = document.getElementById('confirmSwitchDeviceBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Switching Device...';
    }
    try {
        const res = await loginOrRegisterSubscriptionUser(rawId, pin, true);
        window.closeDeviceLimitModal();
        if (res.success) {
            subToast('✅ Switched to this device! Other device logged out.');
            await refreshSubscriptionState();
            renderSubscriptionPage();
        } else {
            subToast('❌ ' + (res.error || 'Switch failed'));
        }
    } catch (e) {
        window.closeDeviceLimitModal();
        subToast('Error switching device: ' + (e.message || e));
    }
};

window.showSessionKickedModal = function(reason) {
    let modal = document.getElementById('sessionKickedModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'sessionKickedModal';
        modal.className = 'custom-sub-modal-backdrop';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="custom-sub-modal-card" style="border-color: #ef4444; box-shadow: 0 10px 35px rgba(239, 68, 68, 0.35);">
            <div class="custom-sub-modal-icon" style="color: #ef4444; background: rgba(239, 68, 68, 0.15);">
                <i class="fa-solid fa-triangle-exclamation"></i>
            </div>
            <div class="custom-sub-modal-title" style="color: #ef4444;">Logged Out (Another Device)</div>
            <div class="custom-sub-modal-subtitle">1 Device Policy Enforced</div>
            <div class="custom-sub-modal-body" style="font-size: 13px; line-height: 1.5; color: #cbd5e1;">
                ${reason || 'Your account was logged in on another device.'}
                <br><br>
                For security and policy reasons, 1 subscription account can only be active on a single device at a time. This device has been automatically logged out.
            </div>
            <div class="custom-sub-modal-actions">
                <button type="button" class="custom-sub-modal-register-btn" onclick="window.closeSessionKickedModal()" style="background: #374151; width: 100%; border: none;">
                    OK, Understand
                </button>
            </div>
        </div>
    `;

    modal.style.display = 'flex';
};

window.closeSessionKickedModal = function() {
    const modal = document.getElementById('sessionKickedModal');
    if (modal) modal.style.display = 'none';
};

window.showNotRegisteredModal = function(identifier) {
    let modal = document.getElementById('notRegisteredCustomModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'notRegisteredCustomModal';
        modal.className = 'custom-sub-modal-backdrop';
        document.body.appendChild(modal);
    }

    const safeDisplayId = String(identifier || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    modal.innerHTML = `
        <div class="custom-sub-modal-card">
            <button class="custom-sub-modal-close" onclick="window.closeNotRegisteredModal()" title="Close">&times;</button>
            <div class="custom-sub-modal-icon">
                <i class="fa-solid fa-triangle-exclamation"></i>
            </div>
            <div class="custom-sub-modal-title">Account Not Registered!</div>
            <div class="custom-sub-modal-subtitle">No Wallet Account Found</div>
            <div class="custom-sub-modal-body">
                No registered wallet account was found for <strong>"${safeDisplayId}"</strong>. To recharge balance and activate your VIP subscription, please register your account.
            </div>
            <div class="custom-sub-modal-actions">
                <a href="https://appcreator05.blogspot.com/p/add-wallet-apk-creator-app.html" target="_blank" rel="noopener noreferrer" class="custom-sub-modal-register-btn" onclick="window.handleGoToRegister(event)" style="text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> Go to Register
                </a>
                <button type="button" class="custom-sub-modal-cancel-btn" onclick="window.closeNotRegisteredModal()">
                    Cancel
                </button>
            </div>
        </div>
    `;

    modal.style.display = 'flex';
};

window.closeNotRegisteredModal = function() {
    const modal = document.getElementById('notRegisteredCustomModal');
    if (modal) {
        modal.style.display = 'none';
    }
};

window.handleGoToRegister = function(event) {
    const registerUrl = 'https://appcreator05.blogspot.com/p/add-wallet-apk-creator-app.html';

    // 1. Android APK Native Bridge (directly launches Google Chrome app via Android Intent)
    if (window.Android && typeof window.Android.openInChrome === 'function') {
        if (event && event.preventDefault) event.preventDefault();
        window.closeNotRegisteredModal();
        if (typeof window.closeSubPaymentConfirmModal === 'function') window.closeSubPaymentConfirmModal();
        try {
            window.Android.openInChrome(registerUrl);
            return false;
        } catch (e) {}
    }

    // 2. Open via openInChrome utility
    if (typeof window.openInChrome === 'function') {
        window.openInChrome(registerUrl);
    } else {
        try {
            window.open(registerUrl, '_blank', 'noopener,noreferrer');
        } catch (e) {}
    }

    setTimeout(() => {
        window.closeNotRegisteredModal();
        if (typeof window.closeSubPaymentConfirmModal === 'function') window.closeSubPaymentConfirmModal();
    }, 350);

    return true;
};

window.handleSubLogout = async function() {
    teardownSessionListener();
    await logoutSubscriptionUser();
    window.__isVipSubscribed = false;
    updateVipAdSuppression();
    subToast('Logged out successfully');
    renderSubscriptionPage();
};

window.handleSubPlanClick = async function(planIndex) {
    const plan = SUBSCRIPTION_PLANS[planIndex];
    if (!plan) return;

    const safeId = localStorage.getItem('sub_wallet_safe_id');
    if (!safeId) {
        subToast('⚠️ Please login with your Mobile Number or Gmail first.');
        window.scrollTo({ top: 120, behavior: 'smooth' });
        const input = document.getElementById('subIdentifierInput');
        if (input) input.focus();
        return;
    }

    // Fetch latest balance from Firebase
    let currentBalance = 0;
    try {
        const snap = await get(ref(subscriptionDb, 'users/' + safeId));
        if (snap.exists()) {
            const data = snap.val();
            currentBalance = Number(data.balance ?? 0);
        }
    } catch (e) {
        console.warn('Could not fetch latest balance before modal:', e);
    }

    window.showSubPaymentConfirmModal(planIndex, currentBalance);
};

window.showSubPaymentConfirmModal = function(planIndex, balance) {
    const plan = SUBSCRIPTION_PLANS[planIndex];
    if (!plan) return;

    let modal = document.getElementById('subPaymentConfirmModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'subPaymentConfirmModal';
        modal.className = 'custom-sub-modal-backdrop';
        document.body.appendChild(modal);
    }

    const currentBalance = Number(balance || 0);
    const hasEnough = currentBalance >= plan.price;
    const remainingBalance = currentBalance - plan.price;

    modal.innerHTML = `
        <div class="custom-sub-modal-card">
            <button class="custom-sub-modal-close" onclick="window.closeSubPaymentConfirmModal()" title="Close">&times;</button>
            <div class="custom-sub-modal-icon" style="color: #FFD700; background: rgba(255, 215, 0, 0.15); border-color: #FFD700;">
                <i class="fa-solid fa-crown"></i>
            </div>
            <div class="custom-sub-modal-title">Confirm VIP Subscription</div>
            <div class="custom-sub-modal-subtitle">${plan.days} Days Plan — 100% Ad-Free</div>
            
            <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid #2d2d44; border-radius: 12px; padding: 14px 16px; margin: 16px 0; text-align: left; font-size: 13px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #9ca3af;">Current Wallet Balance:</span>
                    <strong style="color: #00d2ff;">₹${currentBalance.toFixed(2)}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: #9ca3af;">Plan Price:</span>
                    <strong style="color: #ef4444;">- ₹${plan.price.toFixed(2)}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; border-top: 1px solid #2d2d44; padding-top: 8px; margin-top: 4px;">
                    <span style="color: #9ca3af;">Remaining Balance:</span>
                    <strong style="color: ${hasEnough ? '#10b981' : '#ef4444'};">₹${remainingBalance.toFixed(2)}</strong>
                </div>
            </div>

            ${!hasEnough ? `
                <div style="color: #ef4444; font-size: 12px; margin-bottom: 14px; font-weight: 700; background: rgba(239, 68, 68, 0.1); padding: 10px; border-radius: 8px; border: 1px solid rgba(239, 68, 68, 0.25);">
                    <i class="fa-solid fa-triangle-exclamation"></i> Insufficient balance! You need ₹${(plan.price - currentBalance).toFixed(2)} more. Please add funds to your wallet.
                </div>
                <div class="custom-sub-modal-actions">
                    <a href="https://appcreator05.blogspot.com/p/add-wallet-apk-creator-app.html" target="_blank" rel="noopener noreferrer" class="custom-sub-modal-register-btn" onclick="window.handleGoToRegister(event)" style="text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 8px;">
                        <i class="fa-solid fa-wallet"></i> Recharge Wallet
                    </a>
                    <button type="button" class="custom-sub-modal-cancel-btn" onclick="window.closeSubPaymentConfirmModal()">
                        Cancel
                    </button>
                </div>
            ` : `
                <div id="subPaymentErrorBox" style="display: none; color: #ef4444; font-size: 12px; margin-bottom: 12px; font-weight: 700;"></div>
                <div class="custom-sub-modal-actions">
                    <button id="confirmPayActionBtn" class="custom-sub-modal-register-btn" style="background: linear-gradient(135deg, #059669, #10b981); box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4);" onclick="window.executeSubPayment(${planIndex})">
                        <i class="fa-solid fa-bolt"></i> Pay ₹${plan.price} & Activate VIP
                    </button>
                    <button class="custom-sub-modal-cancel-btn" onclick="window.closeSubPaymentConfirmModal()">
                        Cancel
                    </button>
                </div>
            `}
        </div>
    `;

    modal.style.display = 'flex';
};

window.closeSubPaymentConfirmModal = function() {
    const modal = document.getElementById('subPaymentConfirmModal');
    if (modal) {
        modal.style.display = 'none';
    }
};

window.executeSubPayment = async function(planIndex) {
    const plan = SUBSCRIPTION_PLANS[planIndex];
    if (!plan) return;

    const safeId = localStorage.getItem('sub_wallet_safe_id');
    if (!safeId) return;

    const payBtn = document.getElementById('confirmPayActionBtn');
    const errBox = document.getElementById('subPaymentErrorBox');
    if (payBtn) {
        payBtn.disabled = true;
        payBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing Payment...';
    }
    if (errBox) errBox.style.display = 'none';

    try {
        const res = await paySubscriptionFromWallet(safeId, plan);
        if (res.success) {
            window.__isVipSubscribed = true;
            updateVipAdSuppression();
            window.closeSubPaymentConfirmModal();
            window.showSubPaymentSuccessModal(plan);
            renderSubscriptionPage();
        } else {
            if (payBtn) {
                payBtn.disabled = false;
                payBtn.innerHTML = `<i class="fa-solid fa-bolt"></i> Pay ₹${plan.price} & Activate VIP`;
            }
            if (errBox) {
                errBox.textContent = res.error || 'Payment failed. Please check your balance.';
                errBox.style.display = 'block';
            }
            subToast(res.error || 'Payment failed');
        }
    } catch (e) {
        if (payBtn) {
            payBtn.disabled = false;
            payBtn.innerHTML = `<i class="fa-solid fa-bolt"></i> Pay ₹${plan.price} & Activate VIP`;
        }
        if (errBox) {
            errBox.textContent = e.message || 'Payment transaction failed.';
            errBox.style.display = 'block';
        }
        subToast('Payment failed: ' + (e.message || 'Error'));
    }
};

window.showSubPaymentSuccessModal = function(plan) {
    let modal = document.getElementById('subPaymentSuccessModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'subPaymentSuccessModal';
        modal.className = 'custom-sub-modal-backdrop';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="custom-sub-modal-card" style="border-color: #34d399; box-shadow: 0 16px 36px rgba(0,0,0,0.8), 0 0 30px rgba(16, 185, 129, 0.35);">
            <div class="custom-sub-modal-icon" style="color: #34d399; background: rgba(16, 185, 129, 0.2); border-color: #34d399;">
                <i class="fa-solid fa-circle-check"></i>
            </div>
            <div class="custom-sub-modal-title" style="color: #34d399;">Payment Successful!</div>
            <div class="custom-sub-modal-subtitle">${plan.days} Days VIP Activated</div>
            <div class="custom-sub-modal-body">
                🎉 Congratulations! Your <strong>${plan.days} Days VIP Subscription</strong> is now active. All banner, video, and interstitial ads have been completely removed!
            </div>
            <div class="custom-sub-modal-actions">
                <button class="custom-sub-modal-register-btn" style="background: linear-gradient(135deg, #059669, #10b981);" onclick="window.closeSubPaymentSuccessModal(); goHome();">
                    <i class="fa-solid fa-play"></i> Start Watching Ad-Free
                </button>
            </div>
        </div>
    `;

    modal.style.display = 'flex';
};

window.closeSubPaymentSuccessModal = function() {
    const modal = document.getElementById('subPaymentSuccessModal');
    if (modal) {
        modal.style.display = 'none';
    }
};

// ==========================================
// COMMENT & COMMUNITY SECTION (contact2.me/viwem3)
// ==========================================
window.openCommentSection = function(prefillMovieTitle = '') {
    isInCommentView = true;
    isInSubscriptionView = false;
    isInCloudStreamView = false;
    isPlayerView = false;
    isInCategoryView = false;
    updateHeaderButton();

    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
    }

    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (searchInput) {
        searchInput.value = '';
        searchInput.placeholder = 'Comments & Feedback...';
    }
    if (clearBtn) clearBtn.style.display = 'none';

    window.scrollTo({ top: 0, behavior: 'instant' });
    renderCommentPage(prefillMovieTitle);
};

function renderCommentPage(prefillMovieTitle = '') {
    const container = document.getElementById('mainContainer');
    if (!container) return;

    const safeMovieTitle = String(prefillMovieTitle || '').trim();
    const movieReportBanner = safeMovieTitle ? `
        <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 10px; color: #fca5a5; font-size: 13px;">
                <i class="fa-solid fa-triangle-exclamation" style="color: #ef4444; font-size: 16px; flex-shrink: 0;"></i>
                <div>
                    <strong>Report Movie:</strong> <span style="color: #ffffff; font-weight: 700;">"${safeMovieTitle}"</span>
                    <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">Movie title is copied to your clipboard. Paste it in the comment box below.</div>
                </div>
            </div>
            <button type="button" onclick="navigator.clipboard.writeText('Report: Movie \\'${safeMovieTitle.replace(/'/g, "\\'")}\\' video link not working! Please fix.'); showToast('Report text copied!');" style="background: #ef4444; color: #fff; border: none; padding: 7px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                <i class="fa-solid fa-copy"></i> Copy Text
            </button>
        </div>
    ` : '';

    container.innerHTML = `
        <div class="comment-wrapper">
            <!-- Hero Header Banner -->
            <div class="comment-hero-banner">
                <div style="flex: 1; min-width: 240px;">
                    <div class="comment-hero-title">
                        <i class="fa-solid fa-comments" style="color: #38bdf8; font-size: 20px;"></i>
                        <span>Comments & Feedback</span>
                    </div>
                    <div class="comment-hero-sub">
                        Share your feedback, report broken movies, or leave a comment below.
                    </div>
                </div>
            </div>

            ${movieReportBanner}

            <!-- Comment Embed Frame -->
            <div class="comment-frame-card">
                <div class="comment-frame-loader" id="commentFrameLoader">
                    <i class="fa-solid fa-spinner fa-spin" style="font-size: 32px; color: #38bdf8;"></i>
                    <span>Loading Comments Section...</span>
                </div>
                <iframe id="commentSectionIframe"
                    src="https://contact2.me/viwem3"
                    allow="camera; microphone; clipboard-write; encrypted-media; fullscreen"
                    sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation"
                    onload="const l = document.getElementById('commentFrameLoader'); if(l) { l.style.opacity='0'; setTimeout(() => { l.style.display='none'; }, 300); }">
                </iframe>
            </div>

            <!-- Direct Link Helper -->
            <div style="text-align: center; margin-top: 14px; font-size: 12px; color: #94a3b8;">
                Having trouble loading? Open directly in browser: 
                <a href="#" onclick="window.openExternalCommentLink(); return false;" style="color: #38bdf8; text-decoration: underline; font-weight: 600;">
                    contact2.me/viwem3
                </a>
            </div>
        </div>
    `;
}

window.refreshCommentFrame = function() {
    const iframe = document.getElementById('commentSectionIframe');
    const loader = document.getElementById('commentFrameLoader');
    if (iframe) {
        if (loader) {
            loader.style.display = 'flex';
            loader.style.opacity = '1';
        }
        iframe.src = "https://contact2.me/viwem3?_t=" + Date.now();
        showToast("Refreshing comments...");
    }
};

window.openExternalCommentLink = function() {
    const url = "https://contact2.me/viwem3";
    if (typeof window.openInChrome === 'function') {
        window.openInChrome(url);
    } else {
        window.open(url, '_blank');
    }
};

// ==========================================
// GAME ZONE SECTION
// ==========================================
window.openGameSection = function() {
    isInGameView = true;
    isInCommentView = false;
    isInSubscriptionView = false;
    isInCloudStreamView = false;
    isPlayerView = false;
    isInCategoryView = false;
    updateHeaderButton();

    try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('view') !== 'games') {
            url.searchParams.set('view', 'games');
            window.history.replaceState({ view: 'games' }, '', url.toString());
        }
    } catch (e) {}

    const dropdown = document.getElementById("dropdownMenu");
    if (dropdown && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
    }

    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('searchClearBtn');
    if (searchInput) {
        searchInput.value = '';
        searchInput.placeholder = 'Search Games...';
    }
    if (clearBtn) clearBtn.style.display = 'none';

    window.scrollTo({ top: 0, behavior: 'instant' });
    renderGameZonePage();
};

function renderGameZonePage() {
    const container = document.getElementById('mainContainer');
    if (!container) return;

    container.innerHTML = `
        <div style="max-width: 960px; margin: 0 auto; padding: 16px 12px 60px 12px; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <!-- Game Zone Hero Banner -->
            <div style="background: linear-gradient(135deg, #0d1b2a 0%, #112240 50%, #064e3b 100%); border: 1px solid rgba(0, 255, 136, 0.35); border-radius: 18px; padding: 22px 20px; margin-bottom: 24px; box-shadow: 0 10px 30px rgba(0, 255, 136, 0.15); position: relative; overflow: hidden;">
                <div style="position: absolute; right: -25px; top: -25px; font-size: 130px; color: rgba(0, 255, 136, 0.05); transform: rotate(15deg); pointer-events: none;">
                    <i class="fa-solid fa-gamepad"></i>
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px;">
                    <div style="display: flex; align-items: center; gap: 14px;">
                        <div style="width: 56px; height: 56px; border-radius: 16px; background: rgba(0, 255, 136, 0.15); border: 2px solid #00ff88; display: flex; align-items: center; justify-content: center; font-size: 28px; color: #00ff88; box-shadow: 0 0 18px rgba(0, 255, 136, 0.35);">
                            <i class="fa-solid fa-gamepad"></i>
                        </div>
                        <div>
                            <h2 style="font-size: 24px; font-weight: 800; margin: 0; color: #ffffff; letter-spacing: 0.5px; display: flex; align-items: center; gap: 10px;">
                                VDOSKy Game Zone
                                <span style="font-size: 11px; font-weight: 700; background: #00ff88; color: #000; padding: 3px 9px; border-radius: 20px; text-transform: uppercase;">4 Active</span>
                            </h2>
                            <p style="font-size: 13px; color: #94a3b8; margin: 4px 0 0 0;">Play exciting instant HTML5 games directly inside VDOSky</p>
                        </div>
                    </div>
                    <button onclick="window.goHome();" style="padding: 9px 18px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); color: #fff; font-size: 13px; font-weight: 600; border-radius: 10px; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                        <i class="fa-solid fa-house"></i> Home
                    </button>
                </div>
            </div>

            <!-- Games Grid Container -->
            <div id="gameZoneList" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px;">
                
                <!-- Game Card 1: Car Racing -->
                <div style="background: #151b2e; border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 16px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: flex; flex-direction: column; transition: transform 0.2s ease, border-color 0.2s ease;">
                    <div style="position: relative; width: 100%; aspect-ratio: 16/9; background: #1c1c1c; overflow: hidden; cursor: pointer;" onclick="window.launchGame('car-racing.html', 'Car Racing')">
                        <img src="./games/car-racing/assets/car.jpg" alt="Car Racing" style="width: 100%; height: 100%; object-fit: cover; display: block;">
                        <div style="position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.5); display: flex; align-items: center; gap: 5px;">
                            <i class="fa-solid fa-fire"></i> HOT
                        </div>
                        <div style="position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; color: #facc15; border: 1px solid rgba(250, 204, 21, 0.4); display: flex; align-items: center; gap: 5px;">
                            <i class="fa-solid fa-star"></i> 5.0
                        </div>
                        <div style="position: absolute; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s ease;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0'">
                            <div style="width: 54px; height: 54px; border-radius: 50%; background: #ef4444; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: 0 0 20px rgba(239,68,68,0.6);">
                                <i class="fa-solid fa-play" style="margin-left: 3px;"></i>
                            </div>
                        </div>
                    </div>
                    <div style="padding: 16px; flex: 1; display: flex; flex-direction: column;">
                        <h3 style="margin: 0 0 6px 0; font-size: 18px; font-weight: 800; color: #ffffff; display: flex; align-items: center; justify-content: space-between;">
                            <span>Car Racing</span>
                            <span style="font-size: 12px; font-weight: 700; color: #ef4444; background: rgba(239, 68, 68, 0.15); padding: 2px 8px; border-radius: 6px;">Racing</span>
                        </h3>
                        <p style="margin: 0 0 16px 0; font-size: 13px; color: #94a3b8; line-height: 1.4; flex: 1;">
                            Drive through high-speed highway traffic! Dodge enemy cars using left and right steering to set record high scores.
                        </p>
                        <div style="display: flex; gap: 10px;">
                            <button onclick="window.launchGame('car-racing.html', 'Car Racing')" style="flex: 1; padding: 12px; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: #ffffff; font-size: 14px; font-weight: 800; border: none; border-radius: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 15px rgba(239, 68, 68, 0.35);">
                                <i class="fa-solid fa-play"></i> Play Now
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Game Card 2: Ant Smash -->
                <div style="background: #151b2e; border: 1px solid rgba(0, 255, 136, 0.3); border-radius: 16px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: flex; flex-direction: column; transition: transform 0.2s ease, border-color 0.2s ease;">
                    <div style="position: relative; width: 100%; aspect-ratio: 16/9; background: #231815; overflow: hidden; cursor: pointer;" onclick="window.launchGame('ant-smash.html', 'Ant Smash')">
                        <img src="./games/ant-smash/assets/anti.jpg" alt="Ant Smash" style="width: 100%; height: 100%; object-fit: cover; display: block;" onerror="this.src='./games/ant-smash/assets/background.jpg'">
                        <div style="position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; color: #00ff88; border: 1px solid rgba(0, 255, 136, 0.4); display: flex; align-items: center; gap: 5px;">
                            <i class="fa-solid fa-fire"></i> NEW GAME
                        </div>
                        <div style="position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; color: #facc15; border: 1px solid rgba(250, 204, 21, 0.4); display: flex; align-items: center; gap: 5px;">
                            <i class="fa-solid fa-star"></i> 4.9
                        </div>
                        <div style="position: absolute; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s ease;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0'">
                            <div style="width: 54px; height: 54px; border-radius: 50%; background: #00ff88; color: #0b0e17; display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: 0 0 20px rgba(0,255,136,0.6);">
                                <i class="fa-solid fa-play" style="margin-left: 3px;"></i>
                            </div>
                        </div>
                    </div>
                    <div style="padding: 16px; flex: 1; display: flex; flex-direction: column;">
                        <h3 style="margin: 0 0 6px 0; font-size: 18px; font-weight: 800; color: #ffffff; display: flex; align-items: center; justify-content: space-between;">
                            <span>Ant Smash</span>
                            <span style="font-size: 12px; font-weight: 700; color: #38bdf8; background: rgba(56, 189, 248, 0.15); padding: 2px 8px; border-radius: 6px;">Arcade</span>
                        </h3>
                        <p style="margin: 0 0 16px 0; font-size: 13px; color: #94a3b8; line-height: 1.4; flex: 1;">
                            Protect the wooden table! Tap and smash incoming ants, spiders, scorpions, and flies before they reach the top.
                        </p>
                        <div style="display: flex; gap: 10px;">
                            <button onclick="window.launchGame('ant-smash.html', 'Ant Smash')" style="flex: 1; padding: 12px; background: linear-gradient(135deg, #00ff88 0%, #059669 100%); color: #0b0e17; font-size: 14px; font-weight: 800; border: none; border-radius: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 15px rgba(0, 255, 136, 0.3);">
                                <i class="fa-solid fa-play"></i> Play Now
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Game Card 3: Fill The Gap -->
                <div style="background: #151b2e; border: 1px solid rgba(168, 85, 247, 0.4); border-radius: 16px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: flex; flex-direction: column; transition: transform 0.2s ease, border-color 0.2s ease;">
                    <div style="position: relative; width: 100%; aspect-ratio: 16/9; background: #1c1a30; overflow: hidden; cursor: pointer;" onclick="window.launchGame('fill-the-gap.html', 'Fill The Gap')">
                        <img src="./games/fill-the-gap/assets/fill-the-gap.jpg" alt="Fill The Gap" style="width: 100%; height: 100%; object-fit: cover; display: block;">
                        <div style="position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.5); display: flex; align-items: center; gap: 5px;">
                            <i class="fa-solid fa-puzzle-piece"></i> PUZZLE
                        </div>
                        <div style="position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; color: #facc15; border: 1px solid rgba(250, 204, 21, 0.4); display: flex; align-items: center; gap: 5px;">
                            <i class="fa-solid fa-star"></i> 4.9
                        </div>
                        <div style="position: absolute; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s ease;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0'">
                            <div style="width: 54px; height: 54px; border-radius: 50%; background: #a855f7; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: 0 0 20px rgba(168,85,247,0.6);">
                                <i class="fa-solid fa-play" style="margin-left: 3px;"></i>
                            </div>
                        </div>
                    </div>
                    <div style="padding: 16px; flex: 1; display: flex; flex-direction: column;">
                        <h3 style="margin: 0 0 6px 0; font-size: 18px; font-weight: 800; color: #ffffff; display: flex; align-items: center; justify-content: space-between;">
                            <span>Fill The Gap</span>
                            <span style="font-size: 12px; font-weight: 700; color: #a855f7; background: rgba(168, 85, 247, 0.15); padding: 2px 8px; border-radius: 6px;">Tetris</span>
                        </h3>
                        <p style="margin: 0 0 16px 0; font-size: 13px; color: #94a3b8; line-height: 1.4; flex: 1;">
                            Arrange falling colorful blocks to complete horizontal lines and clear multiple rows simultaneously for mega bonus scores.
                        </p>
                        <div style="display: flex; gap: 10px;">
                            <button onclick="window.launchGame('fill-the-gap.html', 'Fill The Gap')" style="flex: 1; padding: 12px; background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); color: #ffffff; font-size: 14px; font-weight: 800; border: none; border-radius: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 15px rgba(168, 85, 247, 0.35);">
                                <i class="fa-solid fa-play"></i> Play Now
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Game Card 4: Jewel Crush -->
                <div style="background: #151b2e; border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 16px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.4); display: flex; flex-direction: column; transition: transform 0.2s ease, border-color 0.2s ease;">
                    <div style="position: relative; width: 100%; aspect-ratio: 16/9; background: #2c1605; overflow: hidden; cursor: pointer;" onclick="window.launchGame('jewel-crush.html', 'Jewel Crush')">
                        <img src="./games/jewel-crush/assets/jewel-crush.jpg" alt="Jewel Crush" style="width: 100%; height: 100%; object-fit: cover; display: block;">
                        <div style="position: absolute; top: 10px; left: 10px; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.5); display: flex; align-items: center; gap: 5px;">
                            <i class="fa-solid fa-gem"></i> MATCH 3
                        </div>
                        <div style="position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.75); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; color: #facc15; border: 1px solid rgba(250, 204, 21, 0.4); display: flex; align-items: center; gap: 5px;">
                            <i class="fa-solid fa-star"></i> 5.0
                        </div>
                        <div style="position: absolute; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s ease;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0'">
                            <div style="width: 54px; height: 54px; border-radius: 50%; background: #f59e0b; color: #1c0c02; display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: 0 0 20px rgba(245,158,11,0.6);">
                                <i class="fa-solid fa-play" style="margin-left: 3px;"></i>
                            </div>
                        </div>
                    </div>
                    <div style="padding: 16px; flex: 1; display: flex; flex-direction: column;">
                        <h3 style="margin: 0 0 6px 0; font-size: 18px; font-weight: 800; color: #ffffff; display: flex; align-items: center; justify-content: space-between;">
                            <span>Jewel Crush</span>
                            <span style="font-size: 12px; font-weight: 700; color: #f59e0b; background: rgba(245, 158, 11, 0.15); padding: 2px 8px; border-radius: 6px;">Casual</span>
                        </h3>
                        <p style="margin: 0 0 16px 0; font-size: 13px; color: #94a3b8; line-height: 1.4; flex: 1;">
                            Match 3 or more shiny gems of the same color to blast them! Reach target scores and unlock fun, challenging puzzle levels.
                        </p>
                        <div style="display: flex; gap: 10px;">
                            <button onclick="window.launchGame('jewel-crush.html', 'Jewel Crush')" style="flex: 1; padding: 12px; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #1c0c02; font-size: 14px; font-weight: 800; border: none; border-radius: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.35);">
                                <i class="fa-solid fa-play"></i> Play Now
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Add More Games Placeholder Card -->
                <div style="background: rgba(22, 27, 46, 0.6); border: 2px dashed rgba(255, 255, 255, 0.15); border-radius: 16px; padding: 28px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 280px;">
                    <div style="width: 56px; height: 56px; border-radius: 50%; background: rgba(255, 255, 255, 0.06); display: flex; align-items: center; justify-content: center; font-size: 24px; color: #94a3b8; margin-bottom: 14px;">
                        <i class="fa-solid fa-circle-plus"></i>
                    </div>
                    <h4 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 700; color: #cbd5e1;">More Games Coming!</h4>
                    <p style="margin: 0; font-size: 13px; color: #64748b; max-width: 240px; line-height: 1.4;">
                        Send us more game codes or suggestions, and they will be added here step by step.
                    </p>
                </div>

            </div>
        </div>
    `;
}

function checkInitialRoute() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const paymentId = urlParams.get('razorpay_payment_id') || urlParams.get('payment_id') || urlParams.get('payment_status');
        if (paymentId && (paymentId.startsWith('pay_') || urlParams.get('payment_status') === 'success')) {
            const pendingPlan = localStorage.getItem('vdosky_pending_plan') || 'Basic Plan';
            const pendingDays = parseInt(localStorage.getItem('vdosky_pending_days') || '30', 10);
            const durationDays = pendingDays > 0 ? pendingDays : 30;
            const expiryTime = Date.now() + (durationDays * 24 * 60 * 60 * 1000);

            localStorage.setItem('vdosky_subscribed', 'true');
            localStorage.setItem('vdosky_sub_plan', pendingPlan);
            localStorage.setItem('vdosky_sub_expiry', String(expiryTime));
            localStorage.setItem('vdosky_sub_payment_id', paymentId);
            window.__isVipSubscribed = true;

            if (window.Android && typeof window.Android.saveSubscription === 'function') {
                try {
                    window.Android.saveSubscription(pendingPlan, durationDays, paymentId);
                } catch (e) {}
            }

            updateVipAdSuppression();
            setTimeout(() => {
                window.showCustomAlert(
                    'Subscription Activated!',
                    `Payment successful! Your ${pendingPlan} is now active for ${durationDays} days. All movies, videos, games, and music are now unlocked!`,
                    true
                );
            }, 600);
        }

        const view = urlParams.get('view');
        const hash = window.location.hash;
        if (view === 'games' || view === 'game' || hash === '#games' || hash === '#game') {
            if (typeof window.openGameSection === 'function') {
                window.openGameSection();
                return true;
            }
        } else if (view === 'subscription' || view === 'vip' || hash === '#subscription' || hash === '#vip') {
            if (typeof window.openSubscriptionSection === 'function') {
                window.openSubscriptionSection();
                return true;
            }
        } else if (view === 'cloud' || hash === '#cloud') {
            if (typeof window.openCloudStreamSection === 'function') {
                window.openCloudStreamSection();
                return true;
            }
        }
    } catch (e) {
        console.warn('checkInitialRoute error:', e);
    }
    return false;
}
window.checkInitialRoute = checkInitialRoute;

// Immediately execute route check
checkInitialRoute();

window.addEventListener('popstate', () => {
    checkInitialRoute();
});
window.addEventListener('hashchange', () => {
    checkInitialRoute();
});
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        checkInitialRoute();
    });
}

// ==========================================
// FIREBASE AUTO-UPDATE CHECKER & OVERLAY POPUP
// ==========================================
window.showAppUpdateModal = function(updateData) {
    if (!updateData) return;
    let modal = document.getElementById('firebaseAppUpdateModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'firebaseAppUpdateModal';
        modal.className = 'custom-sub-modal-backdrop';
        document.body.appendChild(modal);
    }

    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.zIndex = '9999999';
    modal.style.background = 'rgba(0, 0, 0, 0.92)';
    modal.style.backdropFilter = 'blur(12px)';
    modal.style.webkitBackdropFilter = 'blur(12px)';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';

    const isForce = Boolean(updateData.force_update);
    const changelogText = updateData.changelog || 'A newer version of the app is available. Please update to continue enjoying uninterrupted high-speed streaming.';
    const newVersion = updateData.latest_version || 'Latest';
    const apkUrl = updateData.apk_url || 'https://vdoskay.blogspot.com';

    modal.innerHTML = `
        <div class="custom-sub-modal-card" style="max-width: 420px; width: 92%; border-color: #ef4444; box-shadow: 0 10px 40px rgba(239, 68, 68, 0.4); text-align: center; position: relative;">
            ${!isForce ? `<button type="button" class="custom-sub-modal-close" onclick="window.closeAppUpdateModal()" title="Close">&times;</button>` : ''}
            
            <div class="custom-sub-modal-icon" style="color: #ef4444; background: rgba(239, 68, 68, 0.15); margin: 0 auto 14px auto; width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 26px;">
                <i class="fa-solid fa-cloud-arrow-down"></i>
            </div>
            
            <div class="custom-sub-modal-title" style="color: #ffffff; font-size: 20px; font-weight: 800; margin-bottom: 4px;">
                ${updateData.title || 'Please Update App'}
            </div>
            <div class="custom-sub-modal-subtitle" style="color: #ef4444; font-weight: 700; font-size: 13px; margin-bottom: 16px;">
                ⚠️ New Version Detected
            </div>

            <!-- Version Comparison Box -->
            <div style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                <div style="text-align: left;">
                    <div style="font-size: 10px; text-transform: uppercase; color: #94a3b8; font-weight: 700;">Installed Version</div>
                    <div style="font-size: 14px; font-weight: 800; color: #cbd5e1;">Version: ${getInstalledAppVersion()}</div>
                </div>
                <div style="color: #64748b; font-size: 16px; font-weight: 900;">➔</div>
                <div style="text-align: right;">
                    <div style="font-size: 10px; text-transform: uppercase; color: #4ade80; font-weight: 700;">Latest Version</div>
                    <div style="font-size: 14px; font-weight: 800; color: #4ade80;">Version: ${newVersion}</div>
                </div>
            </div>

            <!-- Changelog Body -->
            <div class="custom-sub-modal-body" style="font-size: 12px; line-height: 1.5; color: #cbd5e1; text-align: left; background: rgba(0, 0, 0, 0.3); border-radius: 10px; padding: 10px 14px; margin-bottom: 18px; max-height: 120px; overflow-y: auto;">
                <div style="font-weight: 700; color: #f1f5f9; margin-bottom: 4px;"><i class="fa-solid fa-sparkles" style="color: #fbbf24; margin-right: 6px;"></i>What's New:</div>
                ${changelogText}
            </div>

            <!-- Action Buttons -->
            <div class="custom-sub-modal-actions" style="display: flex; flex-direction: column; gap: 8px;">
                <button type="button" id="btnAppUpdateModalAction" class="custom-sub-modal-register-btn" onclick="window.handleExecuteAppUpdate('${apkUrl}')" style="background: linear-gradient(135deg, #ef4444, #dc2626); border: none; width: 100%; padding: 12px; border-radius: 12px; font-weight: 800; font-size: 14px; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 15px rgba(239, 68, 68, 0.4);">
                    <i class="fa-solid fa-download"></i> Update Now
                </button>

                ${!isForce ? `
                <button type="button" class="custom-sub-modal-cancel-btn" onclick="window.closeAppUpdateModal()" style="background: transparent; border: 1px solid rgba(255,255,255,0.15); width: 100%; padding: 10px; border-radius: 12px; color: #94a3b8; font-size: 12px; font-weight: 600; cursor: pointer;">
                    Update Later
                </button>
                ` : `
                <div style="font-size: 11px; color: #f87171; margin-top: 4px;">
                    ⚠️ You must update to the latest version to continue using VDOSKy.
                </div>
                `}
            </div>
        </div>
    `;

    modal.style.display = 'flex';
};

window.closeAppUpdateModal = function() {
    const modal = document.getElementById('firebaseAppUpdateModal');
    if (modal) modal.style.display = 'none';
};

window.handleExecuteAppUpdate = function(apkUrl) {
    const btn = document.getElementById('btnAppUpdateModalAction');
    const targetUrl = apkUrl || 'https://vdoskay.blogspot.com';
    if (btn) {
        btn.innerHTML = `<i class="fa-brands fa-chrome fa-bounce"></i> Opening Chrome...`;
    }
    triggerApkInstall(targetUrl);
    setTimeout(() => {
        if (btn) {
            btn.innerHTML = `<i class="fa-brands fa-chrome"></i> Open In Chrome`;
        }
    }, 2000);
};

// Check on launch automatically
async function runAutoUpdateCheck(isManual = false) {
    try {
        const result = await checkForAppUpdate();
        if (result && result.hasUpdate && result.updateData) {
            window.showAppUpdateModal(result.updateData);
        } else if (isManual) {
            const cur = getInstalledAppVersion();
            if (typeof window.showToast === 'function') {
                window.showToast(`✅ You are using the latest version (Version: ${cur})`);
            } else {
                alert(`You are using the latest version of VDOSKy (Version: ${cur})`);
            }
        }
    } catch (e) {
        console.warn('Auto update check failed:', e);
        if (isManual) {
            if (typeof window.showToast === 'function') {
                window.showToast('Could not check update. Please check internet connection.');
            }
        }
    }
}

// Bind to window.checkAppUpdate so clicking Menu -> Check for Updates uses this system
window.checkAppUpdate = function(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    try {
        const dd = document.getElementById('dropdownMenu');
        if (dd && dd.classList.contains('active')) dd.classList.remove('active');
    } catch(err){}
    runAutoUpdateCheck(true);
};

// Run automatically on launch
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => runAutoUpdateCheck(false), 1200);
    });
} else {
    setTimeout(() => runAutoUpdateCheck(false), 1200);
}




