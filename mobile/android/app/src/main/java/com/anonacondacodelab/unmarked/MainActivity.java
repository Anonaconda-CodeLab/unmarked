// Copyright (C) 2026 Anonaconda Code Lab · SPDX-License-Identifier: GPL-3.0-or-later
package com.anonacondacodelab.unmarked;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UnmarkedPlugin.class);
        super.onCreate(savedInstanceState);
        // Back goes back inside the app (About, manual); on the home screen the app moves to the background, so files
        // being cleaned are not lost by an accidental Back.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge == null || bridge.getWebView() == null) { moveTaskToBack(true); return; }
                bridge.getWebView().evaluateJavascript("(window.unmarkedBack && window.unmarkedBack()) ? 1 : 0", r -> {
                    if (!"1".equals(r)) moveTaskToBack(true);
                });
            }
        });
    }
}
