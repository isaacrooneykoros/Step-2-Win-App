package com.step2win.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.TimeZone;
import java.util.UUID;

/**
 * install_id (a random UUID made on the first run of this install) and the phone's time zone.
 *
 * The install id lives in its own SharedPreferences file, which is excluded from Android
 * backup / device transfer (res/xml/backup_rules.xml, data_extraction_rules.xml), so a
 * reinstall or a new phone always gets a new id.
 */
public final class InstallInfo {
    static final String PREFS = "step2win_install";
    private static final String KEY_INSTALL_ID = "install_id";
    private static volatile String cached;

    private InstallInfo() {}

    static String installId(Context context) {
        String id = cached;
        if (id != null) return id;
        synchronized (InstallInfo.class) {
            if (cached != null) return cached;
            SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            id = prefs.getString(KEY_INSTALL_ID, null);
            if (id == null || id.isEmpty()) {
                id = UUID.randomUUID().toString();
                prefs.edit().putString(KEY_INSTALL_ID, id).commit();
            }
            cached = id;
            return id;
        }
    }

    /** Minutes EAST of UTC right now (EAT = 180), DST included. */
    static int tzOffsetMinutes() {
        return TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000;
    }

    /** IANA name ("Africa/Nairobi"), at most 64 chars. */
    static String tzName() {
        String id = TimeZone.getDefault().getID();
        if (id == null) return "";
        return id.length() > 64 ? id.substring(0, 64) : id;
    }
}
