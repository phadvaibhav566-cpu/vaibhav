'use strict';
/**
 * Standalone Android APK Builder for Green Corridor System
 * Compiles resources, Java sources, converts to DEX, packages, aligns, and signs with v1, v2, v3 schemes
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const ANDROID_DIR = path.join(ROOT, 'android');
const BUILD_TOOLS = path.join(ROOT, 'build_tools');
const AAPT2 = path.join(BUILD_TOOLS, 'aapt2.exe');
const R8_JAR = path.join(BUILD_TOOLS, 'r8.jar');
const ANDROID_JAR = path.join(BUILD_TOOLS, 'android.jar');
const APKSIG_JAR = path.join(BUILD_TOOLS, 'apksig.jar');
const JAVA_HOME = 'C:\\Program Files\\Microsoft\\jdk-17.0.20.101-hotspot';
const JAVAC = path.join(JAVA_HOME, 'bin', 'javac.exe');
const JAVA = path.join(JAVA_HOME, 'bin', 'java.exe');
const KEYTOOL = path.join(JAVA_HOME, 'bin', 'keytool.exe');
const JAR = path.join(JAVA_HOME, 'bin', 'jar.exe');

const OUT_APK = path.join(ROOT, 'GreenCorridor.apk');
const KEYSTORE = path.join(BUILD_TOOLS, 'release.keystore');
const KEY_PASS = 'greencorridor2026';
const KEY_ALIAS = 'greencorridor';

console.log('================================================================');
console.log('📱 BUILDING ANDROID APK: GreenCorridor.apk');
console.log('================================================================');

// 1. Setup android project directories
const dirs = [
  path.join(ANDROID_DIR, 'res', 'values'),
  path.join(ANDROID_DIR, 'res', 'drawable'),
  path.join(ANDROID_DIR, 'src', 'com', 'greencorridor', 'app'),
  path.join(ANDROID_DIR, 'assets'),
  path.join(ANDROID_DIR, 'build', 'compiled_res'),
  path.join(ANDROID_DIR, 'build', 'classes'),
  path.join(ANDROID_DIR, 'build', 'gen')
];
dirs.forEach(d => fs.mkdirSync(d, { recursive: true }));

// 2. AndroidManifest.xml
const manifestContent = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.greencorridor.app"
    android:versionCode="1"
    android:versionName="1.0.0">

    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.location.gps" android:required="false" />

    <application
        android:label="@string/app_name"
        android:icon="@drawable/ic_launcher"
        android:hardwareAccelerated="true">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;
fs.writeFileSync(path.join(ANDROID_DIR, 'AndroidManifest.xml'), manifestContent, 'utf8');

// 3. strings.xml
fs.writeFileSync(path.join(ANDROID_DIR, 'res', 'values', 'strings.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Green Corridor</string>
</resources>`, 'utf8');

// 4. ic_launcher (Vector / XML shape)
const icLauncherPath = path.join(ANDROID_DIR, 'res', 'drawable', 'ic_launcher.xml');
fs.writeFileSync(icLauncherPath, `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="oval">
    <solid android:color="#EF4B54" />
    <size android:width="48dp" android:height="48dp" />
</shape>`, 'utf8');

// 5. MainActivity.java
const mainActivityJava = `package com.greencorridor.app;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.GeolocationPermissions;
import android.view.Window;
import android.view.WindowManager;

public class MainActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }
        });

        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
`;
fs.writeFileSync(path.join(ANDROID_DIR, 'src', 'com', 'greencorridor', 'app', 'MainActivity.java'), mainActivityJava, 'utf8');

// 6. Copy web files to android assets
const publicIndex = path.join(ROOT, 'public', 'index.html');
fs.copyFileSync(publicIndex, path.join(ANDROID_DIR, 'assets', 'index.html'));
console.log('✓ Assets synced: public/index.html -> android/assets/index.html');

// 7. Compile resources with aapt2
console.log('[Step 1/5] Compiling resources with aapt2...');
const compiledResZip = path.join(ANDROID_DIR, 'build', 'compiled_res.zip');
execSync(`"${AAPT2}" compile --dir "${path.join(ANDROID_DIR, 'res')}" -o "${compiledResZip}"`, { stdio: 'inherit' });

// 8. Link APK with aapt2
console.log('[Step 2/5] Linking APK and generating R.java...');
const unalignedApk = path.join(ANDROID_DIR, 'build', 'unaligned.apk');
execSync(`"${AAPT2}" link -o "${unalignedApk}" -I "${ANDROID_JAR}" --manifest "${path.join(ANDROID_DIR, 'AndroidManifest.xml')}" --java "${path.join(ANDROID_DIR, 'build', 'gen')}" -A "${path.join(ANDROID_DIR, 'assets')}" "${compiledResZip}" --auto-add-overlay`, { stdio: 'inherit' });

// 9. Compile Java sources (MainActivity.java + R.java)
console.log('[Step 3/5] Compiling Java sources with javac...');
const rJava = path.join(ANDROID_DIR, 'build', 'gen', 'com', 'greencorridor', 'app', 'R.java');
const mainJava = path.join(ANDROID_DIR, 'src', 'com', 'greencorridor', 'app', 'MainActivity.java');
const classesDir = path.join(ANDROID_DIR, 'build', 'classes');
execSync(`"${JAVAC}" -source 1.8 -target 1.8 -cp "${ANDROID_JAR}" -d "${classesDir}" "${rJava}" "${mainJava}"`, { stdio: 'inherit' });

// 10. Dex with D8 (R8 jar)
console.log('[Step 4/5] Converting classes to classes.dex using D8...');
const classPkgDir = path.join(classesDir, 'com', 'greencorridor', 'app');
const classFiles = fs.readdirSync(classPkgDir).filter(f => f.endsWith('.class')).map(f => path.join(classPkgDir, f));

const dexDir = path.join(ANDROID_DIR, 'build', 'dex');
fs.mkdirSync(dexDir, { recursive: true });
execSync(`"${JAVA}" -cp "${R8_JAR}" com.android.tools.r8.D8 --lib "${ANDROID_JAR}" --output "${dexDir}" ${classFiles.map(c => `"${c}"`).join(' ')}`, { stdio: 'inherit' });

// Add classes.dex into unaligned.apk
console.log('[Step 5/5] Adding classes.dex and packing APK...');
const classesDex = path.join(dexDir, 'classes.dex');
process.chdir(dexDir);
execSync(`"${JAR}" -uf "${unalignedApk}" classes.dex`, { stdio: 'inherit' });
process.chdir(ROOT);

// Create release keystore if not exists
if (!fs.existsSync(KEYSTORE)) {
  console.log('Generating release signing keystore...');
  execSync(`"${KEYTOOL}" -genkey -v -keystore "${KEYSTORE}" -storepass ${KEY_PASS} -alias ${KEY_ALIAS} -keypass ${KEY_PASS} -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=GreenCorridor, OU=Emergency, O=Kolhapur, L=Kolhapur, ST=Maharashtra, C=IN"`, { stdio: 'inherit' });
}

// 4-byte zip alignment
console.log('Aligning APK (4-byte zip alignment)...');
const alignedApk = path.join(ANDROID_DIR, 'build', 'aligned.apk');
execSync(`"${JAVA}" -cp "${BUILD_TOOLS}" ZipAlignHelper "${unalignedApk}" "${alignedApk}"`, { stdio: 'inherit' });

// Cryptographic signing with v1, v2 and v3 schemes using official apksig
console.log('Cryptographically signing APK with v1, v2, v3 signature schemes...');
execSync(`"${JAVA}" -cp "${BUILD_TOOLS};${APKSIG_JAR}" SignHelper "${alignedApk}" "${OUT_APK}" "${KEYSTORE}" "${KEY_PASS}" "${KEY_ALIAS}"`, { stdio: 'inherit' });

// Verify signature
console.log('Verifying APK signature schemes...');
execSync(`"${JAVA}" -cp "${BUILD_TOOLS};${APKSIG_JAR}" VerifyHelper "${OUT_APK}"`, { stdio: 'inherit' });

console.log('\n================================================================');
console.log('🎉 ANDROID APK SUCCESSFULLY GENERATED & VERIFIED FOR ANDROID 11, 12, 13, 14, 15!');
console.log('📁 Output: ' + OUT_APK);
console.log('📦 Size:   ' + (fs.statSync(OUT_APK).size / 1024).toFixed(1) + ' KB');
console.log('================================================================\n');
