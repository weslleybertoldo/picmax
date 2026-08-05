package com.bertoldo.picmax;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Atualização in-app: baixa o APK da release dentro do próprio app (com
 * progresso) e dispara o instalador do sistema. No Android, instalar um APK
 * sempre passa pela tela "Instalar?" do PackageInstaller — não há instalação
 * silenciosa para apps fora da Play Store (só device-owner/root).
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    private static final String APK_NAME = "update.apk";

    /** Baixa o APK pro cacheDir emitindo "downloadProgress" {percent}. */
    @PluginMethod()
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("missing_url");
            return;
        }
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(60000);
                conn.connect();

                int code = conn.getResponseCode();
                // Redirect manual (GitHub release -> CDN objects.githubusercontent.com)
                if (code == HttpURLConnection.HTTP_MOVED_PERM
                        || code == HttpURLConnection.HTTP_MOVED_TEMP
                        || code == 307 || code == 308) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = (HttpURLConnection) new URL(loc).openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setConnectTimeout(30000);
                    conn.setReadTimeout(60000);
                    conn.connect();
                    code = conn.getResponseCode();
                }
                if (code != HttpURLConnection.HTTP_OK) {
                    call.reject("http_" + code);
                    return;
                }

                int total = conn.getContentLength();
                File outFile = new File(getContext().getCacheDir(), APK_NAME);
                if (outFile.exists()) {
                    outFile.delete();
                }

                InputStream in = conn.getInputStream();
                FileOutputStream out = new FileOutputStream(outFile);
                byte[] buf = new byte[8192];
                int read;
                long downloaded = 0;
                int lastPct = -1;
                while ((read = in.read(buf)) != -1) {
                    out.write(buf, 0, read);
                    downloaded += read;
                    if (total > 0) {
                        int pct = (int) (downloaded * 100 / total);
                        if (pct != lastPct) {
                            lastPct = pct;
                            JSObject p = new JSObject();
                            p.put("percent", pct);
                            notifyListeners("downloadProgress", p);
                        }
                    }
                }
                out.flush();
                out.close();
                in.close();

                JSObject ret = new JSObject();
                ret.put("path", outFile.getAbsolutePath());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("download_failed: " + e.getMessage());
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }).start();
    }

    /** Permissão de instalar apps de fontes desconhecidas (Android 8+). */
    @PluginMethod()
    public void canInstall(PluginCall call) {
        boolean can = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            can = getContext().getPackageManager().canRequestPackageInstalls();
        }
        JSObject ret = new JSObject();
        ret.put("granted", can);
        call.resolve(ret);
    }

    /** Abre as configurações pra liberar instalação de fontes desconhecidas. */
    @PluginMethod()
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    /** Dispara o instalador do sistema pro APK já baixado. */
    @PluginMethod()
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("missing_path");
            return;
        }
        try {
            File apk = new File(path);
            Uri uri = FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("install_failed: " + e.getMessage());
        }
    }
}
