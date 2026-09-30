package com.step2win.app;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Phase 1c: the privacy explanation Health Connect shows from its permission screen
 * ("Read privacy policy"). Required by Health Connect: Android 13 and lower open it with
 * androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE, Android 14+ with
 * VIEW_PERMISSION_USAGE (activity-alias in the manifest).
 *
 * <p>Plain native views on purpose: it must open quickly without starting the web app,
 * and must work even when the user isn't signed in. The full privacy policy is in the
 * app (Settings > Legal > Privacy policy); "Open Step2Win" goes there.</p>
 */
public class HealthPermissionsRationaleActivity extends Activity {
    static final String EXTRA_OPEN_ROUTE = "s2w_open_route";

    private static final String[][] SECTIONS = {
        {"What Step2Win reads",
            "Only if you turn on Connected sources in Settings: your steps and your workouts "
                + "(walks, runs and hikes, with their route if you allow it) from the last few days, "
                + "and which app or device recorded them. Step2Win never writes to Health Connect "
                + "and never reads anything else."},
        {"Why",
            "To count steps your watch or fitness band recorded while your phone wasn't with you, "
                + "and to confirm the steps your phone counted, so your challenges are fair. "
                + "Steps typed in by hand and steps from apps Step2Win can't check are never counted."},
        {"What is sent to Step2Win",
            "For each hour: the number of steps each app recorded, the kind of device (phone, watch, "
                + "band) and whether it was recorded automatically or typed in. For workouts: the start "
                + "and end time, the type, the distance and the number of route points. Route "
                + "coordinates stay on your phone."},
        {"How long it is kept",
            "With your step history, and deleted when you delete your account. You can remove "
                + "the imported data at any time in Settings > Connected sources."},
        {"Your choice",
            "Connected sources are optional. Step2Win counts your steps with your phone's own "
                + "sensor either way. You can turn access off in Step2Win or in Health Connect at any "
                + "time. Health data is never sold or used for advertising."},
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
        int page = dark ? Color.parseColor("#0E1113") : Color.parseColor("#F7F8F8");
        int ink = dark ? Color.parseColor("#E8ECEE") : Color.parseColor("#14191C");
        int muted = dark ? Color.parseColor("#A3ADB3") : Color.parseColor("#4F5B61");

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(page);
        scroll.setFitsSystemWindows(true);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        col.setPadding(pad, dp(28), pad, dp(28));
        scroll.addView(col, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        col.addView(text("Step2Win and Health Connect", 22, ink, true, 0));
        col.addView(text("How Step2Win uses the health data you allow it to read.", 15, muted, false, dp(6)));
        for (String[] s : SECTIONS) {
            col.addView(text(s[0], 16, ink, true, dp(22)));
            col.addView(text(s[1], 15, muted, false, dp(6)));
        }

        Button open = new Button(this);
        open.setText("Open Step2Win");
        open.setAllCaps(false);
        open.setOnClickListener(v -> {
            Intent intent = new Intent(this, MainActivity.class);
            intent.putExtra(EXTRA_OPEN_ROUTE, "/legal/privacy-policy");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(intent);
            finish();
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(28);
        col.addView(open, lp);
        setContentView(scroll);
    }

    private TextView text(String value, int sp, int color, boolean bold, int topMargin) {
        TextView t = new TextView(this);
        t.setText(value);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.START);
        t.setLineSpacing(0, 1.2f);
        if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = topMargin;
        t.setLayoutParams(lp);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
