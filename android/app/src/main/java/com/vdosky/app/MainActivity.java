package com.vdosky.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.URLUtil;
import android.content.SharedPreferences;
import org.json.JSONObject;
import android.widget.FrameLayout;
import androidx.core.content.FileProvider;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Start.io (StartApp) InApp SDK Integration
import com.startapp.sdk.adsbase.StartAppSDK;
import com.startapp.sdk.adsbase.StartAppAd;
import com.startapp.sdk.adsbase.Ad;
import com.startapp.sdk.adsbase.adlisteners.AdEventListener;
import com.startapp.sdk.adsbase.adlisteners.AdDisplayListener;
import com.startapp.sdk.adsbase.adlisteners.VideoListener;
import com.startapp.sdk.ads.banner.Banner;
import com.startapp.sdk.ads.banner.BannerListener;
import com.startapp.sdk.ads.banner.Mrec;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.HashMap;

public class MainActivity extends BridgeActivity {

    @CapacitorPlugin(name = "AppUpdate")
    public static class AppUpdatePlugin extends Plugin {
        @PluginMethod
        public void installApk(PluginCall call) {
            String url = call.getString("url");
            String fileName = call.getString("fileName");
            MainActivity activity = (MainActivity) getActivity();
            if (activity != null) {
                activity.startDirectApkDownload(url, fileName);
            }
            call.resolve();
        }
    }

    private AndroidNativeInterface nativeInterface;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);

        // Keep mobile screen always on while VDOSky app is open
        try {
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } catch (Exception e) {
            e.printStackTrace();
        }

        // Apply true edge-to-edge fullscreen immersive mode hiding status bar & system navigation
        hideSystemBars();

        // Request Camera and Audio permissions for Shorts Studio & QR Scanner
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (checkSelfPermission(android.Manifest.permission.CAMERA) != android.content.pm.PackageManager.PERMISSION_GRANTED ||
                    checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{
                        android.Manifest.permission.CAMERA,
                        android.Manifest.permission.RECORD_AUDIO
                    }, 101);
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }

        nativeInterface = new AndroidNativeInterface();
        setupJavascriptBridge();
        handlePaymentIntent(getIntent());
        // Ads removed: completely ad-free experience
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handlePaymentIntent(intent);
    }

    private void handlePaymentIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = intent.getData();
        if (uri != null) {
            String scheme = uri.getScheme();
            String host = uri.getHost();
            String path = uri.getPath() != null ? uri.getPath().toLowerCase() : "";

            boolean isPaymentMatch = 
                ("vdosky".equalsIgnoreCase(scheme)) ||
                ("com.vdosky.app".equalsIgnoreCase(scheme)) ||
                (host != null && host.contains("debasispatra.com")) ||
                (path.contains("2day") || path.contains("1month") || path.contains("6month") || path.contains("1year") || path.contains("payment"));

            if (isPaymentMatch) {
                String plan = uri.getQueryParameter("plan");
                String durationStr = uri.getQueryParameter("duration");
                String paymentId = uri.getQueryParameter("payment_id");
                if (paymentId == null) paymentId = uri.getQueryParameter("razorpay_payment_id");

                long days = 30;

                // Smart path detection: e.g. /2day, /1month, /6month, /1year
                if (path.contains("2day")) {
                    days = 2;
                    if (plan == null) plan = "Basic Plan";
                } else if (path.contains("1month") || path.contains("30day")) {
                    days = 30;
                    if (plan == null) plan = "Premium Plan";
                } else if (path.contains("6month")) {
                    days = 180;
                    if (plan == null) plan = "Platinum Plan";
                } else if (path.contains("1year") || path.contains("year")) {
                    days = 365;
                    if (plan == null) plan = "Diamond Plan";
                }

                try {
                    if (durationStr != null) days = Long.parseLong(durationStr);
                } catch (Exception ignored) {}

                if (plan == null || plan.trim().isEmpty()) {
                    plan = (days == 2) ? "Basic Plan" : ((days == 180) ? "Platinum Plan" : ((days == 365) ? "Diamond Plan" : "Premium Plan"));
                }
                if (paymentId == null || paymentId.trim().isEmpty()) {
                    paymentId = "pay_auto_" + System.currentTimeMillis();
                }

                if (nativeInterface != null) {
                    nativeInterface.saveSubscription(plan, days, paymentId);
                }

                final String finalPlan = plan;
                final long finalDays = days;
                final String finalPaymentId = paymentId;

                runOnUiThread(() -> {
                    if (getBridge() != null && getBridge().getWebView() != null) {
                        WebView wv = getBridge().getWebView();
                        String js = String.format(
                            "javascript:(function(){" +
                            "localStorage.setItem('vdosky_subscribed', 'true');" +
                            "localStorage.setItem('vdosky_sub_plan', '%s');" +
                            "localStorage.setItem('vdosky_sub_expiry', '%d');" +
                            "localStorage.setItem('vdosky_sub_payment_id', '%s');" +
                            "if(typeof window.refreshSubscriptionState === 'function') window.refreshSubscriptionState();" +
                            "if(typeof window.updateVipAdSuppression === 'function') window.updateVipAdSuppression();" +
                            "if(typeof window.showCustomAlert === 'function') window.showCustomAlert('Subscription Activated!', 'Payment successful! Your %s is active for %d days. All content unlocked!', true);" +
                            "})();",
                            finalPlan.replace("'", "\\'"),
                            System.currentTimeMillis() + (finalDays * 24L * 60L * 60L * 1000L),
                            finalPaymentId.replace("'", "\\'"),
                            finalPlan.replace("'", "\\'"),
                            finalDays
                        );
                        wv.evaluateJavascript(js, null);
                    }
                });
            }
        }
    }

    // ==========================================
    // ALL ADS REMOVED - 100% AD-FREE EXPERIENCE
    // ==========================================
    public void initStartIoMrecAd() {}
    public void loadMrecAdForSlot(final String slotId) {}
    public void ensureBannerFixedSize() {}
    public void hideBannerInternal() {
        runOnUiThread(() -> {
            try {
                if (adContainerLayout != null) {
                    adContainerLayout.setVisibility(View.GONE);
                }
            } catch (Exception ignored) {}
        });
    }
    public void showBannerInternal() {}
    public void refreshStartIoBannerAd() {}
    public void loadStartIoInterstitialAd() {}
    public void showStartIoInterstitialAd() {}
    public void loadStartIoRewardedVideoAd() {}
    public void showStartIoRewardedVideoAd() {}

    @Override
    public void onStart() {
        super.onStart();
        setupJavascriptBridge();
        hideSystemBars();
    }

    @Override
    public void onResume() {
        super.onResume();
        try {
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } catch (Exception e) {
            e.printStackTrace();
        }
        setupJavascriptBridge();
        hideSystemBars();
        runOnUiThread(() -> {
            try {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().evaluateJavascript(
                        "javascript:if(typeof window.handleAppResumeFromPayment === 'function') window.handleAppResumeFromPayment();",
                        null
                    );
                }
            } catch (Exception ignored) {}
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemBars();
        }
    }

    public void hideSystemBars() {
        runOnUiThread(() -> {
            try {
                Window window = getWindow();
                if (window == null) return;

                // Configure cutout display mode to render edge-to-edge behind camera notches on Android 9+
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    WindowManager.LayoutParams lp = window.getAttributes();
                    lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                    window.setAttributes(lp);
                }

                // Explicitly add FLAG_FULLSCREEN and FLAG_LAYOUT_NO_LIMITS for uncompromising edge-to-edge
                window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                window.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);

                // WindowCompat setup for modern Android (Android 11 / API 30+)
                WindowCompat.setDecorFitsSystemWindows(window, false);
                WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
                if (controller != null) {
                    controller.hide(WindowInsetsCompat.Type.systemBars());
                    controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }

                // Sticky immersive flags
                View decorView = window.getDecorView();
                if (decorView != null) {
                    decorView.setFitsSystemWindows(false);
                    decorView.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    );
                    
                    // Re-apply whenever visibility changes
                    decorView.setOnSystemUiVisibilityChangeListener(visibility -> {
                        if ((visibility & View.SYSTEM_UI_FLAG_FULLSCREEN) == 0) {
                            decorView.setSystemUiVisibility(
                                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            );
                        }
                    });

                    // Zero out all system insets so no padding or gap is added on top/bottom
                    ViewCompat.setOnApplyWindowInsetsListener(decorView, (v, insets) -> {
                        return WindowInsetsCompat.CONSUMED;
                    });
                }

                // Ensure the underlying Capacitor WebView fitsSystemWindows is set to false and zero insets
                if (getBridge() != null && getBridge().getWebView() != null) {
                    View webView = getBridge().getWebView();
                    webView.setFitsSystemWindows(false);
                    ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
                        return WindowInsetsCompat.CONSUMED;
                    });
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    private void setupJavascriptBridge() {
        runOnUiThread(() -> {
            try {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    WebView webView = getBridge().getWebView();
                    if (nativeInterface == null) {
                        nativeInterface = new AndroidNativeInterface();
                    }
                    webView.addJavascriptInterface(nativeInterface, "Android");

                    // 1. Third-Party Cookies Support
                    try {
                        CookieManager cookieManager = CookieManager.getInstance();
                        cookieManager.setAcceptCookie(true);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                            cookieManager.setAcceptThirdPartyCookies(webView, true);
                        }
                    } catch (Exception ignored) {}

                    WebSettings settings = webView.getSettings();

                    // 2. JavaScript Execution & Optimization
                    settings.setJavaScriptEnabled(true);

                    // 3. Pop-up & Redirect Handling
                    settings.setJavaScriptCanOpenWindowsAutomatically(true);
                    settings.setSupportMultipleWindows(true);

                    // 4. Sound & Unrestricted Media Playback
                    settings.setMediaPlaybackRequiresUserGesture(false);

                    // 5. Intrusive Ads Protection & Safe Browsing
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        settings.setSafeBrowsingEnabled(true);
                    }

                    // 6. Protected Content (DRM, Mixed Content & Key Systems)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                    }

                    // 7. On-Device Site Data & Data Store (DOM Storage & Web SQL / Databases)
                    settings.setDomStorageEnabled(true);
                    settings.setDatabaseEnabled(true);

                    // 8. Automatic Download Handler
                    webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
                        startDirectApkDownload(url, URLUtil.guessFileName(url, contentDisposition, mimetype));
                    });

                    // 9. JavaScript Optimisation and Security
                    settings.setCacheMode(WebSettings.LOAD_DEFAULT);
                    settings.setAllowFileAccess(true);
                    settings.setAllowContentAccess(true);
                    settings.setLoadsImagesAutomatically(true);

                    // 10. Embedded Content Support (YouTube / Plyr Hardware Acceleration)
                    webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        });
    }

    public class AndroidNativeInterface {

        @JavascriptInterface
        public void saveSubscription(String planName, long durationDays, String paymentId) {
            try {
                SharedPreferences prefs = getSharedPreferences("vdosky_sub_prefs", MODE_PRIVATE);
                long expiry = System.currentTimeMillis() + (durationDays * 24L * 60L * 60L * 1000L);
                prefs.edit()
                    .putBoolean("is_subscribed", true)
                    .putString("plan_name", planName)
                    .putLong("expiry_time", expiry)
                    .putString("payment_id", paymentId)
                    .apply();
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public boolean isUserSubscribed() {
            try {
                SharedPreferences prefs = getSharedPreferences("vdosky_sub_prefs", MODE_PRIVATE);
                boolean isSub = prefs.getBoolean("is_subscribed", false);
                long expiry = prefs.getLong("expiry_time", 0);
                if (isSub && expiry > System.currentTimeMillis()) {
                    return true;
                } else if (isSub && expiry <= System.currentTimeMillis()) {
                    prefs.edit().putBoolean("is_subscribed", false).apply();
                    return false;
                }
                return false;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String getSubscriptionInfo() {
            try {
                SharedPreferences prefs = getSharedPreferences("vdosky_sub_prefs", MODE_PRIVATE);
                JSONObject json = new JSONObject();
                json.put("isSubscribed", isUserSubscribed());
                json.put("planName", prefs.getString("plan_name", "Free"));
                json.put("expiryTime", prefs.getLong("expiry_time", 0));
                json.put("paymentId", prefs.getString("payment_id", ""));
                return json.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public boolean autoVerifySubscription(String paymentId) {
            if (paymentId != null && !paymentId.trim().isEmpty()) {
                saveSubscription("Verified Plan", 30, paymentId.trim());
                return true;
            }
            return false;
        }

        @JavascriptInterface
        public void showRewardedVideo() {}

        @JavascriptInterface
        public void showRewardedVideoAd() {}

        @JavascriptInterface
        public void showInterstitial() {}

        @JavascriptInterface
        public void showInterstitialAd() {}

        @JavascriptInterface
        public void showBanner() {}

        @JavascriptInterface
        public void refreshBanner() {}

        @JavascriptInterface
        public void refreshBannerAd() {}

        @JavascriptInterface
        public void hideBanner() {
            MainActivity.this.hideBannerInternal();
        }

        @JavascriptInterface
        public void loadMrecAd() {}

        @JavascriptInterface
        public void loadMrecAdForSlot(final String slotId) {}

        @JavascriptInterface
        public void updateMrecSlotPosition(final String slotId, final float x, final float y, final float width, final float height, final boolean visible) {}

        @JavascriptInterface
        public void hideAllMrecAds() {}

        @JavascriptInterface
        public void destroyMrecSlot(final String slotId) {}

        @JavascriptInterface
        public void showMrecAd(final float x, final float y, final float width, final float height) {}

        @JavascriptInterface
        public void hideMrecAd() {}

        @JavascriptInterface
        public boolean isMrecAdLoaded() {
            return false;
        }

        @JavascriptInterface
        public String getStartIoAppId() {
            return "";
        }

        @JavascriptInterface
        public String getFacebookMrecPlacementId() {
            return "";
        }

        @JavascriptInterface
        public void trackImpression(String adId) {
        }

        @JavascriptInterface
        public void trackClick(String adId) {
        }

        @JavascriptInterface
        public void setLandscape() {
            runOnUiThread(() -> {
                try {
                    setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                    MainActivity.this.ensureBannerFixedSize();
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });
        }

        @JavascriptInterface
        public void setPortrait() {
            runOnUiThread(() -> {
                try {
                    setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                    MainActivity.this.ensureBannerFixedSize();
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });
        }

        @JavascriptInterface
        public void unlockOrientation() {
            runOnUiThread(() -> {
                try {
                    setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                    MainActivity.this.ensureBannerFixedSize();
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });
        }

        @JavascriptInterface
        public void keepScreenOn(final boolean enable) {
            runOnUiThread(() -> {
                try {
                    if (enable) {
                        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });
        }

        @JavascriptInterface
        public void hideSystemBars() {
            MainActivity.this.hideSystemBars();
        }

        @JavascriptInterface
        public void shareApp(final String text, final String url) {
            runOnUiThread(() -> {
                try {
                    Intent shareIntent = new Intent(Intent.ACTION_SEND);
                    shareIntent.setType("text/plain");
                    String finalBody = (text != null && !text.trim().isEmpty()) ? text.trim() + "\n" + url : url;
                    shareIntent.putExtra(Intent.EXTRA_SUBJECT, "VDOSky App");
                    shareIntent.putExtra(Intent.EXTRA_TEXT, finalBody);
                    Intent chooser = Intent.createChooser(shareIntent, "Share VDOSky App via");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(chooser);
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });
        }

        @JavascriptInterface
        public void openInChrome(final String url) {
            openExternalUrl(url);
        }

        @JavascriptInterface
        public void openChromeDirectly(final String url) {
            openExternalUrl(url);
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            openExternalUrl(url);
        }

        @JavascriptInterface
        public void openExternalUrl(final String url) {
            if (url == null || url.trim().isEmpty()) return;
            runOnUiThread(() -> {
                try {
                    Uri uri = Uri.parse(url.trim());
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        intent.setPackage("com.android.chrome");
                        startActivity(intent);
                    } catch (Exception chromeNotInstalled) {
                        Intent fallbackIntent = new Intent(Intent.ACTION_VIEW, uri);
                        fallbackIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(fallbackIntent);
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });
        }

        @JavascriptInterface
        public void downloadAndInstallApk(final String downloadUrl, final String fileName) {
            startDirectApkDownload(downloadUrl, fileName);
        }
    }

    public void startDirectApkDownload(final String downloadUrl, final String fileName) {
        if (downloadUrl == null || downloadUrl.trim().isEmpty()) return;

        new Thread(() -> {
            HttpURLConnection connection = null;
            InputStream in = null;
            FileOutputStream out = null;
            try {
                final String apkFileName = (fileName != null && !fileName.trim().isEmpty())
                        ? fileName.trim()
                        : "VDOSKy_latest.apk";

                // Save to app-specific external files dir (NO storage permission required on any Android version)
                File downloadDir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates");
                if (!downloadDir.exists()) {
                    downloadDir.mkdirs();
                }

                File apkFile = new File(downloadDir, apkFileName);
                if (apkFile.exists()) {
                    apkFile.delete();
                }

                // Connect with redirect support (GitHub / CDN 301/302 redirects)
                URL url = new URL(downloadUrl);
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setInstanceFollowRedirects(true);
                connection.connect();

                int responseCode = connection.getResponseCode();
                // Handle manual redirect if needed
                if (responseCode == HttpURLConnection.HTTP_MOVED_PERM ||
                    responseCode == HttpURLConnection.HTTP_MOVED_TEMP ||
                    responseCode == 307 || responseCode == 308) {
                    String newUrl = connection.getHeaderField("Location");
                    connection.disconnect();
                    url = new URL(newUrl);
                    connection = (HttpURLConnection) url.openConnection();
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(30000);
                    connection.connect();
                }

                int fileLength = connection.getContentLength();
                in = connection.getInputStream();
                out = new FileOutputStream(apkFile);

                byte[] buffer = new byte[8192];
                long total = 0;
                int count;
                int lastReportedPercent = -1;

                while ((count = in.read(buffer)) != -1) {
                    total += count;
                    out.write(buffer, 0, count);

                    if (fileLength > 0) {
                        int percent = (int) ((total * 100) / fileLength);
                        if (percent != lastReportedPercent && percent % 5 == 0) {
                            lastReportedPercent = percent;
                            dispatchProgressToWebView(percent);
                        }
                    }
                }

                out.flush();
                dispatchProgressToWebView(100);

                // APK download complete! Trigger native package installer directly
                if (apkFile.exists() && apkFile.length() > 0) {
                    runOnUiThread(() -> launchPackageInstaller(apkFile));
                }

            } catch (Exception e) {
                e.printStackTrace();
            } finally {
                try {
                    if (out != null) out.close();
                    if (in != null) in.close();
                    if (connection != null) connection.disconnect();
                } catch (Exception ignored) {}
            }
        }).start();
    }

    private void dispatchProgressToWebView(final int percent) {
        runOnUiThread(() -> {
            try {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    String script = "window.dispatchEvent(new CustomEvent('apkDownloadProgress', { detail: { progress: " + percent + " } }));";
                    getBridge().getWebView().evaluateJavascript(script, null);
                }
            } catch (Exception ignored) {}
        });
    }

    private void launchPackageInstaller(File apkFile) {
        try {
            Uri apkUri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                apkUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
            } else {
                apkUri = Uri.fromFile(apkFile);
            }

            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);

            startActivity(installIntent);
        } catch (Exception ex) {
            ex.printStackTrace();
        }
    }

    @Override
    public void startActivity(Intent intent) {
        if (isYouTubeIntent(intent)) {
            // Block launching external YouTube app from VDOSky
            return;
        }
        super.startActivity(intent);
    }

    @Override
    public void startActivityForResult(Intent intent, int requestCode, Bundle options) {
        if (isYouTubeIntent(intent)) {
            // Block launching external YouTube app from VDOSky
            return;
        }
        super.startActivityForResult(intent, requestCode, options);
    }

    private boolean isYouTubeIntent(Intent intent) {
        if (intent == null) return false;
        try {
            Uri data = intent.getData();
            if (data != null) {
                String scheme = data.getScheme();
                String host = data.getHost();
                if ("vnd.youtube".equalsIgnoreCase(scheme)) return true;
                if (host != null && (host.contains("youtube.com") || host.contains("youtu.be"))) {
                    return true;
                }
            }
            String pkg = intent.getPackage();
            if (pkg != null && (pkg.contains("youtube") || pkg.contains("com.google.android.youtube"))) {
                return true;
            }
            if (intent.getComponent() != null) {
                String comp = intent.getComponent().flattenToString();
                if (comp.contains("youtube")) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        try {
            ensureBannerFixedSize();
        } catch (Exception ignored) {}
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
    }
}
