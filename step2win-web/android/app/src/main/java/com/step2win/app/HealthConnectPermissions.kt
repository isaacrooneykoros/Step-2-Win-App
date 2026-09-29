package com.step2win.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/**
 * Phase 1c: Health Connect's own permission screen and settings, callable from Java.
 * Health Connect shows the permission prompt; we only ask for read permissions.
 */
object HealthConnectPermissions {
    /** Intent for Health Connect's permission screen (started for a result). */
    @JvmStatic
    fun requestIntent(context: Context, permissions: Set<String>): Intent =
        PermissionController.createRequestPermissionResultContract(HealthSourceCore.HC_PACKAGE)
            .createIntent(context, permissions)

    @JvmStatic
    fun parseResult(resultCode: Int, data: Intent?): Set<String> =
        PermissionController.createRequestPermissionResultContract(HealthSourceCore.HC_PACKAGE)
            .parseResult(resultCode, data)

    /** "Disconnect": gives back every Health Connect permission this app holds. */
    @JvmStatic
    fun revokeAll(context: Context) {
        runBlocking(Dispatchers.IO) {
            withTimeout(10_000L) {
                HealthConnectClient.getOrCreate(context).permissionController.revokeAllPermissions()
            }
        }
    }

    /** Health Connect's own "manage data" / settings screen. */
    @JvmStatic
    fun settingsIntent(context: Context): Intent =
        HealthConnectClient.getHealthConnectManageDataIntent(context, HealthSourceCore.HC_PACKAGE)

    /**
     * Play Store page of the Health Connect app (Android 9-13), with Health Connect's
     * onboarding as the deep link after install.
     */
    @JvmStatic
    fun installIntent(): Intent {
        val uri = Uri.parse(
            "market://details?id=${HealthSourceCore.HC_PACKAGE}&url=healthconnect%3A%2F%2Fonboarding"
        )
        return Intent(Intent.ACTION_VIEW, uri).apply {
            setPackage("com.android.vending")
            putExtra("overlay", true)
            putExtra("callerId", "com.step2win.app")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    @JvmStatic
    fun installWebIntent(): Intent = Intent(
        Intent.ACTION_VIEW,
        Uri.parse("https://play.google.com/store/apps/details?id=${HealthSourceCore.HC_PACKAGE}")
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
