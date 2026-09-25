package com.step2win.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * After a reboot or an app update: re-arm the background sync and walking triggers.
 *
 * It does NOT start the walking service (that only happens when the user actually walks
 * during a challenge). The step counter restarted at 0 on boot; the ledger detects that
 * through Settings.Global.BOOT_COUNT on its next reading, so no steps are double counted
 * and the steps taken since boot are kept. WorkManager itself survives reboots.
 */
public class StepBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        if (SyncPolicy.apiBase(context).isEmpty()) {
            return; // never configured (not signed in yet)
        }
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                StepSyncScheduler.ensurePeriodic(context);
                MotionTriggers.refresh(context);
                // Record the post-boot baseline soon (and upload anything left from before).
                StepSyncScheduler.scheduleSoon(context, 2 * 60_000L, "boot");
            } catch (RuntimeException ignored) {
                // Next app start re-arms everything.
            } finally {
                pending.finish();
            }
        }, "Step2WinBoot").start();
    }
}
