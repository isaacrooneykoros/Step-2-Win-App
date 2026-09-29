package com.step2win.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;

import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(DeviceStepCounterPlugin.class);
		registerPlugin(AppSystemPlugin.class);
		super.onCreate(savedInstanceState);

		// Debug builds only: let the https://localhost WebView reach a plain-HTTP QA backend
		// (e.g. http://10.0.2.2:8000). Release builds keep the default (mixed content blocked).
		boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
		if (debuggable && getBridge() != null && getBridge().getWebView() != null) {
			getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
		}
		openRequestedRoute(getIntent(), 2_500L);
	}

	@Override
	protected void onNewIntent(Intent intent) {
		super.onNewIntent(intent);
		openRequestedRoute(intent, 300L);
	}

	/**
	 * Phase 1c: Health Connect's privacy screen ("Open Step2Win") asks for an in-app page
	 * (the privacy policy). Only fixed, known routes; best effort after the web app loaded.
	 */
	private void openRequestedRoute(Intent intent, long delayMs) {
		if (intent == null) return;
		String route = intent.getStringExtra(HealthPermissionsRationaleActivity.EXTRA_OPEN_ROUTE);
		intent.removeExtra(HealthPermissionsRationaleActivity.EXTRA_OPEN_ROUTE);
		if (!"/legal/privacy-policy".equals(route) || getBridge() == null || getBridge().getWebView() == null) return;
		final android.webkit.WebView webView = getBridge().getWebView();
		webView.postDelayed(() -> webView.evaluateJavascript(
			"(function(){var r='/legal/privacy-policy';if(location.pathname!==r){history.pushState({},'',r);"
				+ "dispatchEvent(new PopStateEvent('popstate'));}})()", null), delayMs);
	}

	/**
	 * Sign in with Google (@capgo/capacitor-social-login): after Credential Manager returns the
	 * ID token, Google's AuthorizationClient may need a consent screen; its result comes back
	 * here and must be handed to the plugin or the login() promise never settles.
	 */
	@Override
	public void onActivityResult(int requestCode, int resultCode, Intent data) {
		super.onActivityResult(requestCode, resultCode, data);
		if (requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN
			|| requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
			return;
		}
		PluginHandle handle = getBridge() != null ? getBridge().getPlugin("SocialLogin") : null;
		Plugin plugin = handle != null ? handle.getInstance() : null;
		if (plugin instanceof SocialLoginPlugin) {
			((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
		}
	}

	/** Marker required by the social-login plugin once onActivityResult is wired as above. */
	@Override
	public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
