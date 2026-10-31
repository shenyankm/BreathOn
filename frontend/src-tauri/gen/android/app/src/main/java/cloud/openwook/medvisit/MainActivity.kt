package cloud.openwook.medvisit

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.util.Log
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import java.io.ByteArrayInputStream

private val APP_BACK_SCRIPT = """
  (() => {
    const overlay = document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="listbox"]');
    if (overlay) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return true;
    }
    const hash = location.hash.slice(1);
    const page = hash.split('?')[0];
    if (hash.includes('?')) {
      location.replace('#' + page);
      return true;
    }
    if (['records', 'visits'].includes(page)) {
      location.replace('#me');
      return true;
    }
    if (['library', 'products', 'practice', 'me', 'start'].includes(page)) {
      location.replace('#home');
      return true;
    }
    return false;
  })()
""".trimIndent()

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  private var backCallback: OnBackPressedCallback? = null
  private var unregisterGestureBack: (() -> Unit)? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  private fun handleAppBack() {
    if (BuildConfig.DEBUG) Log.d("BreathOnBack", "App handler received Back")
    val webView = appWebView
    if (webView == null) {
      moveTaskToBack(true)
      return
    }
    if (ViewCompat.getRootWindowInsets(webView)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
      (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
        .hideSoftInputFromWindow(webView.windowToken, 0)
      return
    }
    webView.evaluateJavascript(APP_BACK_SCRIPT) { handled ->
      if (BuildConfig.DEBUG) Log.d("BreathOnBack", "Page handled Back: $handled")
      if (handled == "false") moveTaskToBack(true)
    }
  }

  private fun installBackHandling() {
    backCallback?.remove()
    backCallback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = handleAppBack()
    }.also { onBackPressedDispatcher.addCallback(this, it) }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      unregisterGestureBack?.invoke()
      val dispatcher = window.onBackInvokedDispatcher
      val callback = OnBackInvokedCallback { handleAppBack() }
      dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_OVERLAY, callback)
      unregisterGestureBack = { dispatcher.unregisterOnBackInvokedCallback(callback) }
    }
  }

  override fun onDestroy() {
    unregisterGestureBack?.invoke()
    super.onDestroy()
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    // Consume Back before WebView can traverse its own browsing history.
    if (event.keyCode == KeyEvent.KEYCODE_BACK) {
      if (BuildConfig.DEBUG) Log.d("BreathOnBack", "Back key action: ${event.action}, canceled: ${event.isCanceled}")
      if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) {
        handleAppBack()
      }
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    val domains = if (BuildConfig.DEBUG) listOf("openwook.cloud", "127.0.0.1", "localhost") else listOf("openwook.cloud")
    val loaders = domains.map { domain ->
      WebViewAssetLoader.Builder()
        .setDomain(domain)
        .setHttpAllowed(BuildConfig.DEBUG)
        .addPathHandler("/_android/", WebViewAssetLoader.AssetsPathHandler(this))
        .build()
    }
    // Wry installs its clients after this hook; preserve the final Rust client.
    fun attach(attempts: Int) {
      val delegate = WebViewCompat.getWebViewClient(webView)
      if (delegate !is RustWebViewClient) {
        if (attempts > 0) webView.postDelayed({ attach(attempts - 1) }, 16)
        else Log.e("BreathOnAssets", "Tauri WebView client was not initialized")
        return
      }
      if (BuildConfig.DEBUG) Log.d("BreathOnAssets", "Packaged UI client installed")
      ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val params = view.layoutParams
        if (params is ViewGroup.MarginLayoutParams &&
          (params.topMargin != bars.top || params.bottomMargin != bars.bottom ||
            params.leftMargin != bars.left || params.rightMargin != bars.right)) {
          params.setMargins(bars.left, bars.top, bars.right, bars.bottom)
          view.layoutParams = params
        }
        insets
      }
      ViewCompat.requestApplyInsets(webView)
      webView.stopLoading()
      webView.webViewClient = AndroidAssetsClient(delegate, loaders)
      installBackHandling()
      webView.reload()
    }
    webView.post { attach(60) }
  }
}

@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
private class AndroidAssetsClient(
  private val delegate: WebViewClient,
  private val loaders: List<WebViewAssetLoader>
) : WebViewClient() {
  private fun bundledAsset(url: Uri): WebResourceResponse? {
    // AndroidX matches the authority, including a debug proxy's port.
    val assetUrl = if (BuildConfig.DEBUG && url.host in setOf("127.0.0.1", "localhost")) {
      url.buildUpon().authority(url.host).build()
    } else url
    for (loader in loaders) {
      val response = loader.shouldInterceptRequest(assetUrl) ?: continue
      if (BuildConfig.DEBUG) Log.d("BreathOnAssets", "APK asset: ${url.path}")
      return if (response.data != null) response else WebResourceResponse(
        "text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0))
      )
    }
    return null
  }

  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
    bundledAsset(request.url) ?: delegate.shouldInterceptRequest(view, request)

  override fun shouldInterceptRequest(view: WebView, url: String) =
    bundledAsset(Uri.parse(url)) ?: delegate.shouldInterceptRequest(view, url)

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
    delegate.shouldOverrideUrlLoading(view, request)

  override fun shouldOverrideUrlLoading(view: WebView, url: String) =
    delegate.shouldOverrideUrlLoading(view, url)

  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) =
    delegate.onPageStarted(view, url, favicon)

  override fun onPageFinished(view: WebView, url: String) = delegate.onPageFinished(view, url)
  override fun onPageCommitVisible(view: WebView, url: String) = delegate.onPageCommitVisible(view, url)
  override fun onLoadResource(view: WebView, url: String) = delegate.onLoadResource(view, url)
  override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) =
    delegate.doUpdateVisitedHistory(view, url, isReload)

  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
    delegate.onReceivedError(view, request, error)

  override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) =
    delegate.onReceivedError(view, errorCode, description, failingUrl)

  override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) =
    delegate.onReceivedHttpError(view, request, response)

  override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) =
    delegate.onReceivedSslError(view, handler, error)

  override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) =
    delegate.onReceivedClientCertRequest(view, request)

  override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) =
    delegate.onReceivedHttpAuthRequest(view, handler, host, realm)

  override fun onReceivedLoginRequest(view: WebView, realm: String, account: String?, args: String) =
    delegate.onReceivedLoginRequest(view, realm, account, args)

  override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) =
    delegate.onFormResubmission(view, dontResend, resend)

  override fun onTooManyRedirects(view: WebView, cancelMsg: Message, continueMsg: Message) =
    delegate.onTooManyRedirects(view, cancelMsg, continueMsg)

  override fun shouldOverrideKeyEvent(view: WebView, event: KeyEvent) = delegate.shouldOverrideKeyEvent(view, event)
  override fun onUnhandledKeyEvent(view: WebView, event: KeyEvent) = delegate.onUnhandledKeyEvent(view, event)
  override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) =
    delegate.onScaleChanged(view, oldScale, newScale)

  override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail) =
    delegate.onRenderProcessGone(view, detail)

  override fun onSafeBrowsingHit(view: WebView, request: WebResourceRequest, threatType: Int, response: SafeBrowsingResponse) =
    delegate.onSafeBrowsingHit(view, request, threatType, response)
}
