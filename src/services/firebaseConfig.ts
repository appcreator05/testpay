import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getDatabase, Database } from 'firebase/database';

// Official Firebase Project Config provided by the user
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCyDd6rCV7WaQe8sMF0Xmob3dpm6z6wEEQ",
  authDomain: "myapps-4a8eb.firebaseapp.com",
  databaseURL: "https://myapps-4a8eb-default-rtdb.firebaseio.com",
  projectId: "myapps-4a8eb",
  storageBucket: "myapps-4a8eb.appspot.com",
  messagingSenderId: "342267842050",
  appId: "1:342267842050:web:ed2b51fb9d0a9f7894611b"
};

// Robust singleton initialization for Firebase default app (preventing collision when other named apps exist)
export const firebaseApp: FirebaseApp = (() => {
  const defaultApp = getApps().find((a) => a.name === '[DEFAULT]');
  if (defaultApp) return defaultApp;
  try {
    return initializeApp(firebaseConfig);
  } catch (e) {
    const existing = getApps().find((a) => a.name === 'mainApp');
    if (existing) return existing;
    return initializeApp(firebaseConfig, 'mainApp');
  }
})();

export const firebaseDb: Database = getDatabase(firebaseApp);
