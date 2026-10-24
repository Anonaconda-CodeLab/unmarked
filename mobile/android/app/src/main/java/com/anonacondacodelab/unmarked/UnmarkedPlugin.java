// Copyright (C) 2026 Anonaconda Code Lab · SPDX-License-Identifier: GPL-3.0-or-later
package com.anonacondacodelab.unmarked;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** Native stand-ins for what Android's WebView lacks: saving files, sharing them, and receiving files shared to the
    app. Nothing here uses the network (the app has no internet permission). File data crosses the bridge as base64
    in pieces, because Android limits the size of a single call. */
@CapacitorPlugin(name = "Unmarked")
public class UnmarkedPlugin extends Plugin {

    // ---------- files shared to Unmarked ("Share -> Unmarked") ----------
    private final List<Uri> shared = new ArrayList<>();
    private InputStream reading;
    private int readingId = -1;
    private long readingPos = 0;

    @Override
    public void load() {
        if (getActivity() != null) takeIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (takeIntent(intent)) notifyListeners("shared", new JSObject(), true);
    }

    @SuppressWarnings("deprecation")
    private boolean takeIntent(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        List<Uri> got = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND.equals(action)) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) got.add(u);
            } else {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) for (Uri u : list) if (u != null) got.add(u);
            }
        } catch (Exception ignored) { }
        ClipData clip = intent.getClipData();
        if (got.isEmpty() && clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) { Uri u = clip.getItemAt(i).getUri(); if (u != null) got.add(u); }
        }
        intent.setAction(Intent.ACTION_MAIN);   // handled: don't take the same files again if the screen is rebuilt
        synchronized (shared) { shared.addAll(got); }
        return !got.isEmpty();
    }

    @PluginMethod
    public void getShared(PluginCall call) {
        JSArray files = new JSArray();
        ContentResolver cr = getContext().getContentResolver();
        synchronized (shared) {
            for (int i = 0; i < shared.size(); i++) {
                Uri u = shared.get(i);
                JSObject f = new JSObject();
                f.put("id", i);
                String name = null; long size = -1;
                try (Cursor c = cr.query(u, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), s = c.getColumnIndex(OpenableColumns.SIZE);
                        if (n >= 0) name = c.getString(n);
                        if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
                    }
                } catch (Exception ignored) { }
                if (name == null) name = u.getLastPathSegment();
                f.put("name", name != null ? name : "shared-file");
                f.put("size", size);
                String mime = null;
                try { mime = cr.getType(u); } catch (Exception ignored) { }
                f.put("mime", mime != null ? mime : "");
                files.put(f);
            }
        }
        JSObject r = new JSObject();
        r.put("files", files);
        call.resolve(r);
    }

    @PluginMethod
    public void readShared(PluginCall call) {
        int id = call.getInt("id", -1);
        long offset = call.getData().optLong("offset", 0L);   // getLong() ignores values that arrive as Integer
        int length = Math.max(1, Math.min(call.getInt("length", 393216), 4 * 1024 * 1024));
        Uri u;
        synchronized (shared) { u = id >= 0 && id < shared.size() ? shared.get(id) : null; }
        if (u == null) { call.reject("no such file"); return; }
        try {
            if (reading == null || readingId != id || readingPos != offset) {
                closeReading();
                reading = getContext().getContentResolver().openInputStream(u);
                if (reading == null) throw new Exception("could not open the file");
                readingId = id; readingPos = 0;
                while (readingPos < offset) { long k = reading.skip(offset - readingPos); if (k <= 0) break; readingPos += k; }
            }
            byte[] buf = new byte[length];
            int n = 0;
            while (n < length) { int k = reading.read(buf, n, length - n); if (k < 0) break; n += k; }
            readingPos += n;
            boolean eof = n < length;
            if (eof) closeReading();
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
            r.put("eof", eof);
            call.resolve(r);
        } catch (Exception e) {
            closeReading();
            call.reject(e.getMessage() != null ? e.getMessage() : "read failed");
        }
    }

    @PluginMethod
    public void clearShared(PluginCall call) {
        closeReading();
        synchronized (shared) { shared.clear(); }
        call.resolve();
    }

    private void closeReading() {
        if (reading != null) { try { reading.close(); } catch (Exception ignored) { } }
        reading = null; readingId = -1; readingPos = 0;
    }

    // ---------- saving: Android's "save as" screen, then the data in pieces ----------
    /* pickSaveLocation passes only the file name: Capacitor keeps the pending call in the app's saved state while the
       screen is open, and Android limits that state to about 1 MB. */
    @PluginMethod
    public void pickSaveLocation(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(call.getString("mime", "application/octet-stream"));
        i.putExtra(Intent.EXTRA_TITLE, call.getString("name", "unmarked-file"));
        startActivityForResult(call, i, "pickSaveLocationResult");
    }

    @ActivityCallback
    private void pickSaveLocationResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        Uri uri = result.getData() != null ? result.getData().getData() : null;
        r.put("uri", result.getResultCode() == Activity.RESULT_OK && uri != null ? uri.toString() : "");
        call.resolve(r);
    }

    private OutputStream openFile;   // stays open from the first piece to the last, so every storage provider works

    @PluginMethod
    public void writeChunk(PluginCall call) {
        String u = call.getString("uri", "");
        boolean first = Boolean.TRUE.equals(call.getBoolean("first", false)), last = Boolean.TRUE.equals(call.getBoolean("last", false));
        try {
            if (first) {
                if (openFile != null) { try { openFile.close(); } catch (Exception ignored) { } }
                openFile = getContext().getContentResolver().openOutputStream(Uri.parse(u), "wt");
            }
            if (openFile == null) throw new Exception("could not open the file");
            openFile.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            if (last) { openFile.close(); openFile = null; }
            call.resolve();
        } catch (Exception e) {
            if (openFile != null) { try { openFile.close(); } catch (Exception ignored) { } openFile = null; }
            call.reject(e.getMessage() != null ? e.getMessage() : "write failed");
        }
    }

    // ---------- sharing: copy into the private share folder, then open the share sheet ----------
    private File shareDir() { return new File(getContext().getCacheDir(), "share"); }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static String safeName(String n) {
        String s = (n == null ? "" : n).replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (s.isEmpty() || s.equals(".") || s.equals("..")) s = "file";
        return s.length() > 120 ? s.substring(s.length() - 120) : s;
    }

    @PluginMethod
    public void shareBegin(PluginCall call) {
        File d = shareDir();
        deleteTree(d);   // nothing from an earlier share is kept
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        call.resolve();
    }

    @PluginMethod
    public void shareChunk(PluginCall call) {
        int index = call.getInt("index", 0);
        boolean first = Boolean.TRUE.equals(call.getBoolean("first", false));
        try {
            File dir = new File(shareDir(), String.valueOf(index));
            if (first) { deleteTree(dir); }
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File f = new File(dir, safeName(call.getString("name", "file")));
            try (FileOutputStream out = new FileOutputStream(f, !first)) {
                out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "write failed");
        }
    }

    @PluginMethod
    public void shareSend(PluginCall call) {
        int count = call.getInt("count", 0);
        JSArray mimes = call.getArray("mimes", new JSArray());
        try {
            ArrayList<Uri> uris = new ArrayList<>();
            String type = null;
            for (int i = 0; i < count; i++) {
                File[] files = new File(shareDir(), String.valueOf(i)).listFiles();
                if (files == null || files.length == 0) continue;
                uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", files[0]));
                String m = i < mimes.length() ? mimes.getString(i) : "application/octet-stream";
                type = type == null ? m : type.equals(m) ? type : (type.startsWith("image/") && m.startsWith("image/")) ? "image/*" : "*/*";
            }
            if (uris.isEmpty()) { call.reject("nothing to share"); return; }
            Intent send;
            if (uris.size() == 1) {
                send = new Intent(Intent.ACTION_SEND);
                send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                send = new Intent(Intent.ACTION_SEND_MULTIPLE);
                send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }
            send.setType(type != null ? type : "*/*");
            ClipData clip = ClipData.newRawUri("", uris.get(0));
            for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
            send.setClipData(clip);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, null);
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "share failed");
        }
    }

    /* Open a web or email link in the phone's browser or mail app. Only https: and mailto: links are accepted. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String u = call.getString("url", "");
        if (!(u.startsWith("https://") || u.startsWith("mailto:"))) { call.reject("unsupported link"); return; }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "no app can open this link");
        }
    }
}
