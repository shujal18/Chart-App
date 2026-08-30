package com.chartapp.temporarychats;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.view.ViewTreeObserver;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int PERMS_REQUEST_CODE = 1001;
    private static boolean openedFromHead = false;
    private static boolean everCreatedActivity = false;
    private static boolean thisInstanceIsCold = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        openedFromHead = getIntent() != null && "true".equals(getIntent().getStringExtra("from_head"));

        thisInstanceIsCold = !everCreatedActivity;
        everCreatedActivity = true;

        SecretVibeService.enabled = false;
        SecretVibeService.taskRemoved = false;
        SecretVibeService.sUrl = "";
        SecretVibeService.sUser = "";

        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();

        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setDomStorageEnabled(true);
        settings.setJavaScriptEnabled(true);
        settings.setAllowUniversalAccessFromFileURLs(true);

        webView.setWebContentsDebuggingEnabled(true);
        webView.addJavascriptInterface(new NativeBridge(), "AndroidNative");

        final ViewTreeObserver observer = webView.getViewTreeObserver();
        observer.addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
            private int lastHeight = -1;
            @Override
            public void onGlobalLayout() {
                Rect r = new Rect();
                webView.getWindowVisibleDisplayFrame(r);
                int curHeight = r.height();
                if (curHeight != lastHeight) {
                    lastHeight = curHeight;
                    final int visibleH = curHeight;
                    webView.post(new Runnable() {
                        @Override
                        public void run() {
                            webView.evaluateJavascript(
                                "if(window._onNativeKeyboard)window._onNativeKeyboard(" + visibleH + ");",
                                null
                            );
                        }
                    });
                }
            }
        });

        requestAppPermissions();
    }

    @Override
    public void onPause() {
        super.onPause();
        if (SecretVibeService.enabled) {
            Intent i = new Intent(this, SecretVibeService.class);
            i.putExtra(SecretVibeService.EXTRA_URL, SecretVibeService.sUrl);
            i.putExtra(SecretVibeService.EXTRA_USER, SecretVibeService.sUser);
            i.putExtra(SecretVibeService.EXTRA_AVATAR, SecretVibeService.sAvatar);
            try {
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
                else startService(i);
            } catch (Exception e) {
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        SecretVibeService.taskRemoved = false;
        stopService(new Intent(this, SecretVibeService.class));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && "true".equals(intent.getStringExtra("from_head"))) {
            openedFromHead = true;
        }
    }

    private void requestAppPermissions() {
        String[] perms;
        if (Build.VERSION.SDK_INT >= 33) {
            perms = new String[]{
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.CAMERA,
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.POST_NOTIFICATIONS
            };
        } else {
            perms = new String[]{
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.CAMERA,
                Manifest.permission.READ_EXTERNAL_STORAGE
            };
        }

        boolean needsRequest = false;
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                needsRequest = true;
                break;
            }
        }
        if (needsRequest) {
            ActivityCompat.requestPermissions(this, perms, PERMS_REQUEST_CODE);
        }
    }

    public class NativeBridge {

        @JavascriptInterface
        public boolean consumeColdStart() {
            return thisInstanceIsCold;
        }

        @JavascriptInterface
        public void setSecretMode(boolean active, final String url, final String user, final String avatar) {
            SecretVibeService.enabled = active;
            if (active) {
                SecretVibeService.sUrl = url == null ? "" : url;
                SecretVibeService.sUser = user == null ? "" : user;
                SecretVibeService.sAvatar = avatar == null ? "\uD83D\uDC64" : avatar;
            }
        }

        @JavascriptInterface
        public void vibrate(final String patternStr) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        long[] pattern;
                        try {
                            String[] parts = patternStr.split(",");
                            pattern = new long[parts.length];
                            for (int i = 0; i < parts.length; i++) pattern[i] = Long.parseLong(parts[i].trim());
                        } catch (Exception e) {
                            pattern = new long[]{0, 350, 120, 350, 120, 350};
                        }
                        Vibrator vib;
                        if (Build.VERSION.SDK_INT >= 31) {
                            VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                            vib = vm.getDefaultVibrator();
                        } else {
                            vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                        }
                        if (vib != null && vib.hasVibrator()) {
                            if (Build.VERSION.SDK_INT >= 26) {
                                vib.vibrate(VibrationEffect.createWaveform(pattern, -1));
                            } else {
                                vib.vibrate(pattern, -1);
                            }
                        }
                    } catch (Exception e) {
                    }
                }
            });
        }

        @JavascriptInterface
        public boolean consumeOpenedFromHead() {
            boolean v = openedFromHead;
            openedFromHead = false;
            return v;
        }

        @JavascriptInterface
        public boolean canDrawOverlay() {
            return Settings.canDrawOverlays(MainActivity.this);
        }

        @JavascriptInterface
        public void openOverlaySettings() {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        }

        @JavascriptInterface
        public void showChatHead(final String avatar, final String name, final int unread) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent s = new Intent(MainActivity.this, ChatHeadService.class);
                    s.setAction("SHOW");
                    s.putExtra("avatar", avatar);
                    s.putExtra("name", name);
                    s.putExtra("unread", unread);
                    startService(s);
                }
            });
        }

        @JavascriptInterface
        public void hideChatHead() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startService(new Intent(MainActivity.this, ChatHeadService.class).setAction("HIDE"));
                }
            });
        }
    }
}
