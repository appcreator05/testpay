import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  runTransaction,
  onValue,
  push,
  query,
  orderByChild,
  equalTo,
  Unsubscribe
} from 'firebase/database';

// Dedicated Firebase Configuration for Wallet Balance Deduction & Subscription System
export const subscriptionFirebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_SUBSCRIPTION_API_KEY || "AIzaSyAPPdw4tLtXfkzaBAJk-DBC5KLyp8Jzu5w",
  authDomain: "update-2224e.firebaseapp.com",
  databaseURL: "https://update-2224e-default-rtdb.firebaseio.com",
  projectId: "update-2224e",
  storageBucket: "update-2224e.firebasestorage.app",
  messagingSenderId: "731168193501",
  appId: "1:731168193501:web:239c7be0fc864c7ca9d434"
};

// Named singleton app for subscription to prevent collision with any existing default Firebase app
export const subscriptionApp = getApps().some((a) => a.name === 'subscriptionApp')
  ? getApp('subscriptionApp')
  : initializeApp(subscriptionFirebaseConfig, 'subscriptionApp');

export const subscriptionDb = getDatabase(subscriptionApp);

export interface SubscriptionPlan {
  name: string;
  days: number;
  price: number;
  durationText: string;
  deviceLimit: number;
  link: string;
  text: string;
}

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    name: "Basic Plan",
    days: 2,
    price: 10.00,
    durationText: "2 Day(s)",
    deviceLimit: 1,
    link: "https://rzp.io/rzp/CT7V0kp",
    text: "Basic Plan — ₹10.00 (2 Days)"
  },
  {
    name: "Premium Plan",
    days: 30,
    price: 39.99,
    durationText: "1 Month(s)",
    deviceLimit: 1,
    link: "https://rzp.io/rzp/eZcRkdDu",
    text: "Premium Plan — ₹39.99 (1 Month)"
  },
  {
    name: "Platinum Plan",
    days: 180,
    price: 299.00,
    durationText: "6 Month(s)",
    deviceLimit: 1,
    link: "https://rzp.io/rzp/NylbLir",
    text: "Platinum Plan — ₹299.00 (6 Months)"
  },
  {
    name: "Diamond Plan",
    days: 365,
    price: 579.00,
    durationText: "1 Year(s)",
    deviceLimit: 1,
    link: "https://rzp.io/rzp/g9HuABr",
    text: "Diamond Plan — ₹579.00 (1 Year)"
  }
];

export interface UserSubscriptionData {
  type: 'email' | 'mobile';
  identifier: string; // e.g. "9804163298"
  pin: string;
  password?: string;
  balance: number;
  subscription_status?: 'active' | 'expired' | 'none';
  subscription?: string;
  plan_days?: number;
  purchased_at?: string;
  expires_at?: string;
  createdAt?: string;
  transactions?: Record<string, any>;
  // Clean single-device lock:
  is_used?: boolean;
  device_id?: string;
  // Legacy fields fallback compatibility:
  bound_device_id?: string;
  active_device_id?: string;
  already_used?: boolean;
  device_model?: string;
  last_active_at?: string;
  last_switched_at?: string;
  session_version?: number;
}

export interface SubscriptionStatusCheck {
  isSubscribed: boolean;
  userData: UserSubscriptionData | null;
  expiredJustNow: boolean;
  daysRemaining: number;
  expiryDate: Date | null;
  message?: string;
  deviceMismatched?: boolean;
  sessionMismatched?: boolean;
}

export function getOrCreateDeviceId(): string {
  try {
    let devId = localStorage.getItem('vdosky_device_id');
    if (!devId) {
      devId = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 12);
      localStorage.setItem('vdosky_device_id', devId);
    }
    return devId;
  } catch {
    return 'dev_fallback_' + Date.now().toString(36);
  }
}

export function getDeviceModelString(): string {
  if (typeof navigator === 'undefined') return 'Android App';
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) {
    const match = ua.match(/;\s*([^;)]+)\s*Build/i);
    return match ? match[1].trim() : 'Android Device';
  }
  if (/iPhone|iPad|iPod/i.test(ua)) return 'Apple iOS Device';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Macintosh/i.test(ua)) return 'Mac OS';
  if (/Linux/i.test(ua)) return 'Linux Device';
  return 'Mobile Browser / Web';
}

export function sanitizeSubscriptionId(rawId: string): string {
  return rawId.trim().toLowerCase().replace(/[^a-zA-Z0-9]/g, "_");
}

export function getStoredUserIdentifier(): string | null {
  return localStorage.getItem('sub_wallet_user');
}

export function getStoredSafeId(): string | null {
  return localStorage.getItem('sub_wallet_safe_id');
}

export function getCachedIsSubscribed(): boolean {
  try {
    const isSub = localStorage.getItem('vdosky_sub_active') === '1';
    const expiresAtStr = localStorage.getItem('vdosky_sub_expires_at');
    if (isSub && expiresAtStr) {
      const exp = new Date(expiresAtStr);
      if (new Date() < exp) {
        return true;
      } else {
        // Expired in cache
        localStorage.removeItem('vdosky_sub_active');
        localStorage.removeItem('vdosky_sub_expires_at');
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Checks subscription status against Firebase.
 * If expired:
 * 1. Automatically deletes the subscription subkey from Firebase (setting to null / removing expired subkeys).
 * 2. Clears local active flags.
 * 3. Immediately re-enables the ads system.
 */
export async function checkAndHandleSubscriptionExpiry(safeId: string): Promise<SubscriptionStatusCheck> {
  if (!safeId) {
    return {
      isSubscribed: false,
      userData: null,
      expiredJustNow: false,
      daysRemaining: 0,
      expiryDate: null
    };
  }

  try {
    const userRef = ref(subscriptionDb, `users/${safeId}`);
    const snapshot = await get(userRef);

    if (!snapshot.exists()) {
      localStorage.removeItem('vdosky_sub_active');
      localStorage.removeItem('vdosky_sub_expires_at');
      return {
        isSubscribed: false,
        userData: null,
        expiredJustNow: false,
        daysRemaining: 0,
        expiryDate: null
      };
    }

    const user = snapshot.val() as UserSubscriptionData;
    const currentDeviceId = getOrCreateDeviceId();
    const userDeviceId = user.device_id || user.bound_device_id || user.active_device_id;

    // 🔒 SINGLE DEVICE ENFORCEMENT:
    // If bound to another device, invalidate this device immediately
    if (userDeviceId && userDeviceId !== currentDeviceId) {
      console.warn(`[SingleDeviceLock] Account ${user.identifier || safeId} active on another device. Terminating local session.`);
      logoutSubscriptionUserLocalOnly();
      return {
        isSubscribed: false,
        userData: null,
        expiredJustNow: false,
        daysRemaining: 0,
        expiryDate: null,
        deviceMismatched: true,
        message: 'This subscription is already used on another device.'
      };
    }

    // Check expiry
    if (user.expires_at) {
      const expiryDate = new Date(user.expires_at);
      const now = new Date();

      if (now > expiryDate) {
        // 🔥 Expired! Delete subkeys from Firebase as requested:
        console.warn(`[Subscription] User ${user.identifier || safeId} expired on ${expiryDate.toISOString()}. Removing subkey from Firebase...`);

        try {
          await update(userRef, {
            expires_at: null,
            subscription_status: null,
            plan_days: null,
            purchased_at: null,
            subscription: null,
            transactions: null,
            createdAt: null
          });
        } catch (delErr) {
          console.error('[Subscription] Failed to remove subkeys from Firebase:', delErr);
        }

        // Clean local state
        localStorage.removeItem('vdosky_sub_active');
        localStorage.removeItem('vdosky_sub_expires_at');
        localStorage.setItem('vdosky_sub_expired_notice', '1');

        return {
          isSubscribed: false,
          userData: {
            ...user,
            subscription_status: 'expired',
            expires_at: undefined,
            plan_days: undefined
          },
          expiredJustNow: true,
          daysRemaining: 0,
          expiryDate,
          message: 'Subscription has expired. Subkey removed from Firebase and Ads are now active.'
        };
      } else {
        // Valid subscription!
        const diffMs = expiryDate.getTime() - now.getTime();
        const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

        localStorage.setItem('vdosky_sub_active', '1');
        localStorage.setItem('vdosky_sub_expires_at', user.expires_at);

        return {
          isSubscribed: true,
          userData: user,
          expiredJustNow: false,
          daysRemaining,
          expiryDate
        };
      }
    }

    // No active subscription keys
    localStorage.removeItem('vdosky_sub_active');
    localStorage.removeItem('vdosky_sub_expires_at');

    return {
      isSubscribed: false,
      userData: user,
      expiredJustNow: false,
      daysRemaining: 0,
      expiryDate: null
    };
  } catch (err: any) {
    console.error('[Subscription] Error checking subscription:', err);

    // Local fallback check
    const cachedActive = localStorage.getItem('vdosky_sub_active') === '1';
    const cachedExpiry = localStorage.getItem('vdosky_sub_expires_at');
    if (cachedActive && cachedExpiry) {
      const exp = new Date(cachedExpiry);
      if (new Date() < exp) {
        return {
          isSubscribed: true,
          userData: null,
          expiredJustNow: false,
          daysRemaining: Math.max(0, Math.ceil((exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24))),
          expiryDate: exp
        };
      } else {
        localStorage.removeItem('vdosky_sub_active');
        localStorage.removeItem('vdosky_sub_expires_at');
      }
    }

    return {
      isSubscribed: false,
      userData: null,
      expiredJustNow: false,
      daysRemaining: 0,
      expiryDate: null
    };
  }
}

/**
 * Login or Register user with Email/Mobile + 4-digit PIN
 */
export async function authenticateSubscriptionUser(
  type: 'email' | 'mobile',
  rawId: string,
  pin: string,
  forceSwitch: boolean = false
): Promise<{
  success: boolean;
  user?: UserSubscriptionData;
  notRegistered?: boolean;
  alreadyUsed?: boolean;
  alreadyLoggedInAnotherDevice?: boolean;
  currentDeviceModel?: string;
  lastActiveAt?: string;
  usedAt?: string;
  error?: string;
}> {
  const safeId = sanitizeSubscriptionId(rawId);
  let userRef = ref(subscriptionDb, `users/${safeId}`);

  try {
    let snapshot = await get(userRef);
    let resolvedSafeId = safeId;

    // Also check rawId if safeId didn't match and rawId doesn't contain forbidden chars
    if (!snapshot.exists() && !/[.#$\[\]]/.test(rawId.trim())) {
      const altRef = ref(subscriptionDb, `users/${rawId.trim()}`);
      const altSnap = await get(altRef);
      if (altSnap.exists()) {
        snapshot = altSnap;
        userRef = altRef;
        resolvedSafeId = rawId.trim();
      }
    }

    // Explicit Firebase Query: check child key "identifier" across users collection
    if (!snapshot.exists()) {
      try {
        const idQuery = query(ref(subscriptionDb, 'users'), orderByChild('identifier'), equalTo(rawId.trim()));
        const idSnap = await get(idQuery);
        if (idSnap.exists()) {
          idSnap.forEach((child) => {
            snapshot = child;
            userRef = child.ref;
            resolvedSafeId = child.key || safeId;
          });
        }
      } catch (queryErr) {
        console.warn('[Subscription] Query by identifier fallback:', queryErr);
      }
    }

    if (snapshot.exists()) {
      const user = snapshot.val() as UserSubscriptionData;
      const targetIdentifier = user.identifier || rawId.trim();

      // Check expiry upon login
      if (user.expires_at) {
        const expiryDate = new Date(user.expires_at);
        const now = new Date();
        if (now > expiryDate) {
          // Delete subkey on login if already expired
          await update(userRef, {
            expires_at: null,
            subscription_status: null,
            plan_days: null,
            purchased_at: null,
            subscription: null,
            transactions: null,
            createdAt: null
          });
          user.subscription_status = 'expired';
          delete user.expires_at;
        }
      }

      const userPin = user.pin !== undefined ? String(user.pin) : (user.password !== undefined ? String(user.password) : '');
      if (userPin !== String(pin)) {
        return { success: false, notRegistered: false, error: 'Incorrect Password or PIN! Please try again.' };
      }

      const currentDeviceId = getOrCreateDeviceId();
      const existingDeviceId = user.device_id || user.bound_device_id || user.active_device_id;
      const isAlreadyUsed = user.is_used === true || user.already_used === true;

      // 🔒 SINGLE ACTIVE DEVICE CHECK:
      // If active on another device, require explicit user confirmation to logout the previous device
      if ((isAlreadyUsed || existingDeviceId) && existingDeviceId && existingDeviceId !== currentDeviceId) {
        if (!forceSwitch) {
          console.warn(`[Subscription] Account ${rawId} is active on another device (${existingDeviceId}). Awaiting user logout confirmation.`);
          return {
            success: false,
            alreadyLoggedInAnotherDevice: true,
            currentDeviceModel: user.device_model || 'Another Device',
            lastActiveAt: user.last_active_at || user.purchased_at,
            error: 'This account is currently logged in on another device.'
          };
        } else {
          console.log(`[Subscription] User confirmed logout of previous device (${existingDeviceId}). Switching active device to ${currentDeviceId}.`);
        }
      }

      // 🔥 Minimal, clean save to Firebase RTDB:
      // Only 4 to 5 keys total! (identifier, pin, balance, device_id, is_used, expires_at)
      // Delete all bulky/redundant fields from Firebase by setting them to null:
      await update(userRef, {
        is_used: true,
        device_id: currentDeviceId,
        last_switched_at: new Date().toISOString(),
        session_version: Date.now(),
        // Purge bulky keys to keep Firebase minimal:
        active_device_id: null,
        bound_device_id: null,
        already_used: null,
        active_session_token: null,
        device_model: null,
        used_at: null,
        last_active_at: null,
        last_logout_at: null,
        createdAt: null,
        plan_days: null,
        purchased_at: null,
        subscription: null,
        subscription_status: null,
        transactions: null
      });

      // Save locally
      localStorage.setItem('sub_wallet_user', rawId);
      localStorage.setItem('sub_wallet_safe_id', resolvedSafeId);

      user.is_used = true;
      user.device_id = currentDeviceId;

      return { success: true, user };
    } else {
      // User is NOT registered in database
      return {
        success: false,
        notRegistered: true,
        error: 'User not registered'
      };
    }
  } catch (err: any) {
    return { success: false, notRegistered: false, error: err.message || 'Authentication error' };
  }
}

export async function loginOrRegisterSubscriptionUser(
  rawId: string,
  pin: string,
  forceSwitch: boolean = false
): Promise<{
  success: boolean;
  user?: UserSubscriptionData;
  notRegistered?: boolean;
  alreadyUsed?: boolean;
  alreadyLoggedInAnotherDevice?: boolean;
  currentDeviceModel?: string;
  lastActiveAt?: string;
  usedAt?: string;
  error?: string;
}> {
  const type = rawId.includes('@') ? 'email' : 'mobile';
  return authenticateSubscriptionUser(type, rawId, pin, forceSwitch);
}

/**
 * Handle payment from wallet balance and activate subscription
 */
export async function paySubscriptionFromWallet(
  safeId: string,
  plan: SubscriptionPlan
): Promise<{ success: boolean; error?: string; finalLink?: string; expiresAt?: string }> {
  let userRef = ref(subscriptionDb, `users/${safeId}`);

  try {
    let snapshot = await get(userRef);

    // Fallback lookup if safeId didn't match directly
    if (!snapshot.exists() && !/[.#$\[\]]/.test(safeId)) {
      const altRef = ref(subscriptionDb, `users/${safeId.trim()}`);
      const altSnap = await get(altRef);
      if (altSnap.exists()) {
        snapshot = altSnap;
        userRef = altRef;
      }
    }

    if (!snapshot.exists()) {
      return { success: false, error: 'User wallet account not found in database.' };
    }

    const userData = snapshot.val() as UserSubscriptionData;
    const currentBalance = Number(userData.balance ?? 0);

    if (currentBalance < plan.price) {
      return {
        success: false,
        error: `Insufficient wallet balance! Current balance is ₹${currentBalance.toFixed(2)}, but this plan requires ₹${plan.price}. Please recharge your wallet.`
      };
    }

    const newBalance = Number((currentBalance - plan.price).toFixed(2));
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + plan.days);
    const expiresAtIso = expiryDate.toISOString();

    // Atomically update balance and expires_at only (keeping Firebase at 4 to 5 lines total)
    await update(userRef, {
      balance: newBalance,
      expires_at: expiresAtIso,
      // Purge bulky/extra fields:
      subscription_status: null,
      plan_days: null,
      purchased_at: null,
      subscription: null,
      transactions: null,
      createdAt: null
    });

    localStorage.setItem('vdosky_sub_active', '1');
    localStorage.setItem('vdosky_sub_expires_at', expiresAtIso);

    return {
      success: true,
      finalLink: plan.link,
      expiresAt: expiresAtIso
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Payment failed' };
  }
}

/**
 * Subscribe to balance changes in real-time
 */
export function listenToUserBalance(safeId: string, callback: (balance: number) => void): Unsubscribe {
  const balanceRef = ref(subscriptionDb, `users/${safeId}/balance`);
  return onValue(balanceRef, (snapshot) => {
    const val = snapshot.val();
    callback(Number(val || 0));
  });
}

/**
 * Listen in real-time to active device / session changes.
 * If another phone logs into this account, terminates immediately!
 */
export function listenToActiveSession(
  safeId: string,
  onTerminated: (reason: string) => void
): Unsubscribe {
  const currentDeviceId = getOrCreateDeviceId();
  const userRef = ref(subscriptionDb, `users/${safeId}`);

  return onValue(userRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.val() as UserSubscriptionData;
    if (!data) return;

    // Check if device was bound or transferred
    const userDeviceId = data.device_id || data.bound_device_id || data.active_device_id;
    if (userDeviceId && userDeviceId !== currentDeviceId) {
      logoutSubscriptionUserLocalOnly();
      onTerminated('This subscription was activated on another device.');
      return;
    }
  });
}

/**
 * Logout user from subscription (local state only, preserves is_used in Firebase)
 */
export async function logoutSubscriptionUser() {
  logoutSubscriptionUserLocalOnly();
}

export function logoutSubscriptionUserLocalOnly() {
  localStorage.removeItem('sub_wallet_user');
  localStorage.removeItem('sub_wallet_safe_id');
  localStorage.removeItem('sub_wallet_session_token');
  localStorage.removeItem('vdosky_sub_active');
  localStorage.removeItem('vdosky_sub_expires_at');
}
