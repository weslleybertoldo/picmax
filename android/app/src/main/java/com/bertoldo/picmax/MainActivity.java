package com.bertoldo.picmax;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // registerPlugin precisa rodar ANTES de super.onCreate: é ali que o BridgeActivity chama
    // load() e constrói a bridge a partir dos plugins acumulados no builder (ver
    // node_modules/@capacitor/android BridgeActivity.java) — registrar depois seria tarde demais.
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImageEnhancerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
